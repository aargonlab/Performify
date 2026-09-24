// ---------------------------------------------------------------------------
// Rule-based, deterministic narrative generation. Pure logic.
// Locales "en" (default) and "it" are fully supported via two string
// dictionaries with identical structure. Every number is guarded so no
// "null"/"NaN" ever leaks into the copy.
// ---------------------------------------------------------------------------

import type { NarrativeSection, PageTypeKey, RunNarrative } from "../types";
import type {
  CategoryAverages,
  RunAggregates,
  RunComparison,
  RunSummary,
} from "./types";
import { compareRuns, computeAggregates } from "./compare";
import { buildRecommendations } from "./recommendations";

// --- Thresholds for "notable" findings ---------------------------------------

const SCORE_DELTA_THRESHOLD = 2; // points, per category
const LCP_DELTA_THRESHOLD_MS = 200;
const CLS_DELTA_THRESHOLD = 0.02;
const FIELD_VS_LAB_RATIO = 1.5;
const FIELD_VS_LAB_MIN_GAP_MS = 1000;
const SLICE_GAP_THRESHOLD = 5; // points between best and worst market/page type

// --- Small exported helpers (unit-test targets) -------------------------------

export type NarrativeLocale = "en" | "it";

export type ScoreRating = "excellent" | "good" | "needsImprovement" | "poor";

export type DeltaDirection = "improved" | "worsened" | "stable";

/** Normalizes any locale string to a supported dictionary locale. */
export function resolveLocale(locale?: string): NarrativeLocale {
  return locale && locale.toLowerCase().startsWith("it") ? "it" : "en";
}

/** excellent ≥90, good ≥70, needs improvement ≥50, poor <50. */
export function rateScore(score: number): ScoreRating {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "needsImprovement";
  return "poor";
}

/** "450 ms" below one second, "1.2 s" from one second up. Guarded vs NaN. */
export function fmtMsHuman(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  if (Math.abs(ms) >= 1000) {
    return `${Math.round(ms / 100) / 10} s`;
  }
  return `${Math.round(ms)} ms`;
}

/** CLS-style unitless value, max 3 decimals. Guarded vs NaN. */
export function fmtCls(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 1000) / 1000}`;
}

/** Plain number with FP noise removed (max 1 decimal). Guarded vs NaN. */
export function fmtNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 10) / 10}`;
}

/** Signed variant for deltas: "+6" / "-3.5". */
export function fmtSigned(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

/** Direction of a score delta with a stability band (default ±2 points). */
export function scoreDeltaDirection(
  delta: number,
  threshold: number = SCORE_DELTA_THRESHOLD,
): DeltaDirection {
  if (!Number.isFinite(delta)) return "stable";
  if (delta > threshold) return "improved";
  if (delta < -threshold) return "worsened";
  return "stable";
}

// --- String dictionaries -------------------------------------------------------

interface NarrativeStrings {
  monthNames: string[];
  formatDate(day: number, month: string, year: number): string;
  defaultMarketLabel: string;
  ratingLabels: Record<ScoreRating, string>;
  categoryLabels: Record<CategoryScoreField, string>;
  pageTypeLabels: Record<PageTypeKey, string>;
  summary: {
    score(score: string, rating: string): string;
    scoreWithTheme(score: string, rating: string, themeName: string): string;
    scoreMissing: string;
    coverage(pages: number, markets: number, devices: number): string;
    deltaImproved(points: string, date: string | null): string;
    deltaWorsened(points: string, date: string | null): string;
    deltaStable(date: string | null): string;
  };
  sections: {
    categoryImprovedHeading(category: string): string;
    categoryWorsenedHeading(category: string): string;
    categoryBody(
      category: string,
      from: string,
      to: string,
      signedDelta: string,
    ): string;
    lcpImprovedHeading: string;
    lcpWorsenedHeading: string;
    lcpImprovedBody(current: string, diff: string): string;
    lcpWorsenedBody(current: string, diff: string): string;
    clsImprovedHeading: string;
    clsWorsenedHeading: string;
    clsImprovedBody(from: string, to: string): string;
    clsWorsenedBody(from: string, to: string): string;
    fieldVsLabHeading: string;
    fieldVsLabBody(fieldLcp: string, labLcp: string): string;
    worstMarketHeading(market: string): string;
    worstMarketBody(
      market: string,
      score: string,
      gap: string,
      best: string,
    ): string;
    worstPageTypeHeading(pageType: string): string;
    worstPageTypeBody(
      pageType: string,
      score: string,
      gap: string,
      best: string,
    ): string;
    failedPagesHeading: string;
    failedPagesBody(count: number): string;
  };
}

type CategoryScoreField =
  "performanceScore" | "accessibilityScore" | "bestPracticesScore" | "seoScore";

const EN: NarrativeStrings = {
  monthNames: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  formatDate: (day, month, year) => `${month} ${day}, ${year}`,
  defaultMarketLabel: "default market",
  ratingLabels: {
    excellent: "an excellent result",
    good: "a good result",
    needsImprovement: "a result that needs improvement",
    poor: "a poor result",
  },
  categoryLabels: {
    performanceScore: "performance",
    accessibilityScore: "accessibility",
    bestPracticesScore: "best practices",
    seoScore: "SEO",
  },
  pageTypeLabels: {
    HOME: "homepage",
    COLLECTION: "collection pages",
    PRODUCT: "product pages",
    CART: "cart page",
    PAGE: "content pages",
    BLOG: "blog pages",
    ARTICLE: "blog articles",
    CUSTOM: "custom URLs",
  },
  summary: {
    score: (score, rating) =>
      `The average performance score across the audited pages is ${score} out of 100 — ${rating}.`,
    scoreWithTheme: (score, rating, themeName) =>
      `After publishing the theme "${themeName}", the average performance score across the audited pages is ${score} out of 100 — ${rating}.`,
    scoreMissing:
      "This audit did not produce any completed results, so no performance score is available.",
    coverage: (pages, markets, devices) =>
      `We audited ${pages} ${pages === 1 ? "page" : "pages"} across ${markets} ${
        markets === 1 ? "market" : "markets"
      } and ${devices} ${devices === 1 ? "device type" : "device types"}.`,
    deltaImproved: (points, date) =>
      date
        ? `Performance improved by ${points} points since the last audit on ${date}.`
        : `Performance improved by ${points} points since the last audit.`,
    deltaWorsened: (points, date) =>
      date
        ? `Performance worsened by ${points} points since the last audit on ${date}.`
        : `Performance worsened by ${points} points since the last audit.`,
    deltaStable: (date) =>
      date
        ? `Performance is stable compared with the last audit on ${date}.`
        : `Performance is stable compared with the last audit.`,
  },
  sections: {
    categoryImprovedHeading: (category) =>
      `${capitalize(category)} score improved`,
    categoryWorsenedHeading: (category) =>
      `${capitalize(category)} score dropped`,
    categoryBody: (category, from, to, signedDelta) =>
      `The ${category} score went from ${from} to ${to} (${signedDelta} points).`,
    lcpImprovedHeading: "Loading speed improved",
    lcpWorsenedHeading: "Loading speed got worse",
    lcpImprovedBody: (current, diff) =>
      `The main content now appears in ${current} on average, ${diff} faster than in the previous audit.`,
    lcpWorsenedBody: (current, diff) =>
      `The main content now appears in ${current} on average, ${diff} slower than in the previous audit.`,
    clsImprovedHeading: "Visual stability improved",
    clsWorsenedHeading: "Visual stability got worse",
    clsImprovedBody: (from, to) =>
      `The layout shift score went from ${from} to ${to}, so pages move around less while they load.`,
    clsWorsenedBody: (from, to) =>
      `The layout shift score went from ${from} to ${to}, so pages move around more while they load.`,
    fieldVsLabHeading: "Real users experience slower loading",
    fieldVsLabBody: (fieldLcp, labLcp) =>
      `Field data shows real visitors wait about ${fieldLcp} for the main content, while lab tests measure ${labLcp}. This gap is usually related to slower networks and devices than the lab environment.`,
    worstMarketHeading: (market) => `Slowest market: ${market}`,
    worstMarketBody: (market, score, gap, best) =>
      `${capitalize(market)} has an average performance score of ${score}, ${gap} points below your best market (${best}).`,
    worstPageTypeHeading: (pageType) => `Slowest page type: ${pageType}`,
    worstPageTypeBody: (pageType, score, gap, best) =>
      `The average performance score for ${pageType} is ${score}, ${gap} points below your best page type (${best}).`,
    failedPagesHeading: "Some pages could not be audited",
    failedPagesBody: (count) =>
      count === 1
        ? "1 page failed during this audit and is not included in the averages."
        : `${count} pages failed during this audit and are not included in the averages.`,
  },
};

const IT: NarrativeStrings = {
  monthNames: [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ],
  formatDate: (day, month, year) => `${day} ${month} ${year}`,
  defaultMarketLabel: "mercato principale",
  ratingLabels: {
    excellent: "un risultato eccellente",
    good: "un buon risultato",
    needsImprovement: "un risultato da migliorare",
    poor: "un risultato scarso",
  },
  categoryLabels: {
    performanceScore: "prestazioni",
    accessibilityScore: "accessibilità",
    bestPracticesScore: "best practice",
    seoScore: "SEO",
  },
  pageTypeLabels: {
    HOME: "homepage",
    COLLECTION: "pagine collezione",
    PRODUCT: "pagine prodotto",
    CART: "pagina carrello",
    PAGE: "pagine di contenuto",
    BLOG: "pagine blog",
    ARTICLE: "articoli del blog",
    CUSTOM: "URL personalizzati",
  },
  summary: {
    score: (score, rating) =>
      `Il punteggio medio di performance delle pagine analizzate è ${score} su 100 — ${rating}.`,
    scoreWithTheme: (score, rating, themeName) =>
      `Dopo la pubblicazione del tema "${themeName}", il punteggio medio di performance delle pagine analizzate è ${score} su 100 — ${rating}.`,
    scoreMissing:
      "Questo audit non ha prodotto risultati completati, quindi non è disponibile un punteggio di performance.",
    coverage: (pages, markets, devices) =>
      `Abbiamo analizzato ${pages} ${pages === 1 ? "pagina" : "pagine"} su ${markets} ${
        markets === 1 ? "mercato" : "mercati"
      } e ${devices} ${
        devices === 1 ? "tipo di dispositivo" : "tipi di dispositivo"
      }.`,
    deltaImproved: (points, date) =>
      date
        ? `Le prestazioni sono migliorate di ${points} punti rispetto all'ultimo audit del ${date}.`
        : `Le prestazioni sono migliorate di ${points} punti rispetto all'ultimo audit.`,
    deltaWorsened: (points, date) =>
      date
        ? `Le prestazioni sono peggiorate di ${points} punti rispetto all'ultimo audit del ${date}.`
        : `Le prestazioni sono peggiorate di ${points} punti rispetto all'ultimo audit.`,
    deltaStable: (date) =>
      date
        ? `Le prestazioni sono stabili rispetto all'ultimo audit del ${date}.`
        : `Le prestazioni sono stabili rispetto all'ultimo audit.`,
  },
  sections: {
    categoryImprovedHeading: (category) => `Punteggio ${category} migliorato`,
    categoryWorsenedHeading: (category) => `Punteggio ${category} peggiorato`,
    categoryBody: (category, from, to, signedDelta) =>
      `Il punteggio ${category} è passato da ${from} a ${to} (${signedDelta} punti).`,
    lcpImprovedHeading: "Velocità di caricamento migliorata",
    lcpWorsenedHeading: "Velocità di caricamento peggiorata",
    lcpImprovedBody: (current, diff) =>
      `Il contenuto principale ora appare in ${current} in media, ${diff} più velocemente rispetto all'audit precedente.`,
    lcpWorsenedBody: (current, diff) =>
      `Il contenuto principale ora appare in ${current} in media, ${diff} più lentamente rispetto all'audit precedente.`,
    clsImprovedHeading: "Stabilità visiva migliorata",
    clsWorsenedHeading: "Stabilità visiva peggiorata",
    clsImprovedBody: (from, to) =>
      `L'indice di spostamento del layout è passato da ${from} a ${to}: le pagine si muovono meno durante il caricamento.`,
    clsWorsenedBody: (from, to) =>
      `L'indice di spostamento del layout è passato da ${from} a ${to}: le pagine si muovono di più durante il caricamento.`,
    fieldVsLabHeading: "Gli utenti reali sperimentano caricamenti più lenti",
    fieldVsLabBody: (fieldLcp, labLcp) =>
      `I dati sul campo mostrano che i visitatori reali attendono circa ${fieldLcp} per il contenuto principale, mentre i test di laboratorio misurano ${labLcp}. Questo divario è di solito legato a reti e dispositivi più lenti rispetto all'ambiente di test.`,
    worstMarketHeading: (market) => `Mercato più lento: ${market}`,
    worstMarketBody: (market, score, gap, best) =>
      `${capitalize(market)} ha un punteggio medio di performance di ${score}, ${gap} punti sotto il tuo mercato migliore (${best}).`,
    worstPageTypeHeading: (pageType) =>
      `Tipologia di pagina più lenta: ${pageType}`,
    worstPageTypeBody: (pageType, score, gap, best) =>
      `Il punteggio medio di performance per ${pageType} è ${score}, ${gap} punti sotto la migliore tipologia di pagina (${best}).`,
    failedPagesHeading: "Alcune pagine non sono state analizzate",
    failedPagesBody: (count) =>
      count === 1
        ? "1 pagina non è stata completata durante questo audit e non è inclusa nelle medie."
        : `${count} pagine non sono state completate durante questo audit e non sono incluse nelle medie.`,
  },
};

const DICTIONARIES: Record<NarrativeLocale, NarrativeStrings> = {
  en: EN,
  it: IT,
};

// --- Internal helpers ----------------------------------------------------------

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fmtDate(iso: string, strings: NarrativeStrings): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const month =
    strings.monthNames[date.getUTCMonth()] ?? `${date.getUTCMonth() + 1}`;
  return strings.formatDate(date.getUTCDate(), month, date.getUTCFullYear());
}

function marketLabel(
  key: string,
  run: RunSummary,
  strings: NarrativeStrings,
): string {
  if (key === "default") {
    const named = run.pageResults.find(
      (r) => r.marketHandle === null && r.marketName,
    );
    return named?.marketName ?? strings.defaultMarketLabel;
  }
  const named = run.pageResults.find(
    (r) => r.marketHandle === key && r.marketName,
  );
  return named?.marketName ?? key;
}

// --- Summary -------------------------------------------------------------------

function buildSummary(
  current: RunSummary,
  aggregates: RunAggregates,
  comparison: RunComparison | undefined,
  baseline: RunSummary | undefined,
  strings: NarrativeStrings,
): string {
  const sentences: string[] = [];

  const performance = aggregates.overall.performanceScore;
  if (performance === null) {
    sentences.push(strings.summary.scoreMissing);
  } else {
    const rating = strings.ratingLabels[rateScore(performance)];
    const score = fmtNumber(performance);
    sentences.push(
      current.themeName
        ? strings.summary.scoreWithTheme(score, rating, current.themeName)
        : strings.summary.score(score, rating),
    );
  }

  // "Pages" means unique audited URLs — overall.count is url × device ×
  // market result rows and would inflate the number.
  const uniquePages = new Set(
    current.pageResults
      .filter((r) => r.status === "COMPLETED")
      .map((r) => r.url),
  ).size;
  if (uniquePages > 0) {
    sentences.push(
      strings.summary.coverage(
        uniquePages,
        Object.keys(aggregates.byMarket).length,
        Object.keys(aggregates.byDevice).length,
      ),
    );
  }

  const performanceDelta = comparison?.deltas.performanceScore;
  if (typeof performanceDelta === "number") {
    const date = baseline ? fmtDate(baseline.createdAt, strings) : null;
    const direction = scoreDeltaDirection(performanceDelta);
    if (direction === "improved") {
      sentences.push(
        strings.summary.deltaImproved(fmtNumber(performanceDelta), date),
      );
    } else if (direction === "worsened") {
      sentences.push(
        strings.summary.deltaWorsened(
          fmtNumber(Math.abs(performanceDelta)),
          date,
        ),
      );
    } else {
      sentences.push(strings.summary.deltaStable(date));
    }
  }

  return sentences.join(" ");
}

// --- Section builders ------------------------------------------------------------

const CATEGORY_FIELDS: CategoryScoreField[] = [
  "performanceScore",
  "accessibilityScore",
  "bestPracticesScore",
  "seoScore",
];

function categoryDeltaSections(
  comparison: RunComparison,
  strings: NarrativeStrings,
): NarrativeSection[] {
  const sections: NarrativeSection[] = [];
  for (const field of CATEGORY_FIELDS) {
    const delta = comparison.deltas[field];
    if (typeof delta !== "number") continue;
    const direction = scoreDeltaDirection(delta);
    if (direction === "stable") continue;
    const from = comparison.baseline.overall[field];
    const to = comparison.current.overall[field];
    if (from === null || to === null) continue;
    const label = strings.categoryLabels[field];
    sections.push({
      heading:
        direction === "improved"
          ? strings.sections.categoryImprovedHeading(label)
          : strings.sections.categoryWorsenedHeading(label),
      body: strings.sections.categoryBody(
        label,
        fmtNumber(from),
        fmtNumber(to),
        fmtSigned(delta),
      ),
      tone: direction === "improved" ? "positive" : "negative",
    });
  }
  return sections;
}

function lcpDeltaSection(
  comparison: RunComparison,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const delta = comparison.deltas.lcpMs;
  const currentLcp = comparison.current.overall.lcpMs;
  if (typeof delta !== "number" || currentLcp === null) return null;
  if (Math.abs(delta) <= LCP_DELTA_THRESHOLD_MS) return null;
  const improved = delta < 0;
  const diff = fmtMsHuman(Math.abs(delta));
  const now = fmtMsHuman(currentLcp);
  return {
    heading: improved
      ? strings.sections.lcpImprovedHeading
      : strings.sections.lcpWorsenedHeading,
    body: improved
      ? strings.sections.lcpImprovedBody(now, diff)
      : strings.sections.lcpWorsenedBody(now, diff),
    tone: improved ? "positive" : "negative",
  };
}

function clsDeltaSection(
  comparison: RunComparison,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const delta = comparison.deltas.cls;
  const from = comparison.baseline.overall.cls;
  const to = comparison.current.overall.cls;
  if (typeof delta !== "number" || from === null || to === null) return null;
  if (Math.abs(delta) <= CLS_DELTA_THRESHOLD) return null;
  const improved = delta < 0;
  return {
    heading: improved
      ? strings.sections.clsImprovedHeading
      : strings.sections.clsWorsenedHeading,
    body: improved
      ? strings.sections.clsImprovedBody(fmtCls(from), fmtCls(to))
      : strings.sections.clsWorsenedBody(fmtCls(from), fmtCls(to)),
    tone: improved ? "positive" : "negative",
  };
}

function fieldVsLabSection(
  aggregates: RunAggregates,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const lab = aggregates.overall.lcpMs;
  const field = aggregates.overall.fieldLcpMs;
  if (lab === null || field === null) return null;
  const muchWorse =
    field >= lab * FIELD_VS_LAB_RATIO && field - lab >= FIELD_VS_LAB_MIN_GAP_MS;
  if (!muchWorse) return null;
  return {
    heading: strings.sections.fieldVsLabHeading,
    body: strings.sections.fieldVsLabBody(fmtMsHuman(field), fmtMsHuman(lab)),
    tone: "negative",
  };
}

interface SliceEntry {
  key: string;
  performanceScore: number;
}

function worstAndBest(
  slices: Record<string, CategoryAverages | undefined>,
): { worst: SliceEntry; best: SliceEntry } | null {
  const entries: SliceEntry[] = [];
  for (const [key, averages] of Object.entries(slices)) {
    if (averages && averages.performanceScore !== null) {
      entries.push({ key, performanceScore: averages.performanceScore });
    }
  }
  if (entries.length < 2) return null;
  let worst = entries[0];
  let best = entries[0];
  for (const entry of entries) {
    if (entry.performanceScore < worst.performanceScore) worst = entry;
    if (entry.performanceScore > best.performanceScore) best = entry;
  }
  if (best.performanceScore - worst.performanceScore < SLICE_GAP_THRESHOLD) {
    return null;
  }
  return { worst, best };
}

function worstMarketSection(
  current: RunSummary,
  aggregates: RunAggregates,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const found = worstAndBest(aggregates.byMarket);
  if (!found) return null;
  const worstLabel = marketLabel(found.worst.key, current, strings);
  const bestLabel = marketLabel(found.best.key, current, strings);
  const gap = found.best.performanceScore - found.worst.performanceScore;
  return {
    heading: strings.sections.worstMarketHeading(worstLabel),
    body: strings.sections.worstMarketBody(
      worstLabel,
      fmtNumber(found.worst.performanceScore),
      fmtNumber(gap),
      bestLabel,
    ),
    tone: "negative",
  };
}

function worstPageTypeSection(
  aggregates: RunAggregates,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const found = worstAndBest(aggregates.byPageType);
  if (!found) return null;
  const worstLabel =
    strings.pageTypeLabels[found.worst.key as PageTypeKey] ?? found.worst.key;
  const bestLabel =
    strings.pageTypeLabels[found.best.key as PageTypeKey] ?? found.best.key;
  const gap = found.best.performanceScore - found.worst.performanceScore;
  return {
    heading: strings.sections.worstPageTypeHeading(worstLabel),
    body: strings.sections.worstPageTypeBody(
      worstLabel,
      fmtNumber(found.worst.performanceScore),
      fmtNumber(gap),
      bestLabel,
    ),
    tone: "negative",
  };
}

function failedPagesSection(
  current: RunSummary,
  strings: NarrativeStrings,
): NarrativeSection | null {
  const failed = current.pageResults.filter(
    (r) => r.status === "FAILED",
  ).length;
  if (failed === 0) return null;
  return {
    heading: strings.sections.failedPagesHeading,
    body: strings.sections.failedPagesBody(failed),
    tone: "negative",
  };
}

function buildSections(
  current: RunSummary,
  aggregates: RunAggregates,
  comparison: RunComparison | undefined,
  strings: NarrativeStrings,
): NarrativeSection[] {
  const sections: NarrativeSection[] = [];
  if (comparison) {
    sections.push(...categoryDeltaSections(comparison, strings));
    const lcp = lcpDeltaSection(comparison, strings);
    if (lcp) sections.push(lcp);
    const cls = clsDeltaSection(comparison, strings);
    if (cls) sections.push(cls);
  }
  const divergence = fieldVsLabSection(aggregates, strings);
  if (divergence) sections.push(divergence);
  const market = worstMarketSection(current, aggregates, strings);
  if (market) sections.push(market);
  const pageType = worstPageTypeSection(aggregates, strings);
  if (pageType) sections.push(pageType);
  const failed = failedPagesSection(current, strings);
  if (failed) sections.push(failed);
  return sections;
}

// --- Entry point -----------------------------------------------------------------

export function generateNarrative(args: {
  current: RunSummary;
  baseline?: RunSummary;
  comparison?: RunComparison;
  locale?: string;
}): RunNarrative {
  const locale = resolveLocale(args.locale);
  const strings = DICTIONARIES[locale];

  const comparison =
    args.comparison ??
    (args.baseline ? compareRuns(args.current, args.baseline) : undefined);
  const aggregates =
    comparison?.current ?? computeAggregates(args.current.pageResults);

  return {
    locale,
    summary: buildSummary(
      args.current,
      aggregates,
      comparison,
      args.baseline,
      strings,
    ),
    sections: buildSections(args.current, aggregates, comparison, strings),
    recommendations: buildRecommendations(args.current.pageResults),
    comparedToRunId: args.baseline?.id,
    generatedAt: new Date().toISOString(),
  };
}
