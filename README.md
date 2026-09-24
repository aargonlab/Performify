# Performify

Storefront performance monitoring for Shopify. Performify runs Lighthouse audits through
the Google PageSpeed Insights API across your Shopify Markets and page types, stores every
run as a comparable snapshot, and turns the numbers into plain-language reports, trends and
alerts inside the Shopify admin.

Built and maintained by [aargonlab](https://aargonlab.com). Licensed under Apache 2.0.

## Features

- **Automated audits** — monthly schedule (cron, timezone-aware, per profile) plus an
  automatic run every time a theme is published (`themes/publish` webhook), so each report
  is tied to a theme version.
- **Markets and page types** — audits the home page, collections, product pages, cart, CMS
  pages, blog posts or custom URLs, per active market and localized domain, on mobile and/or
  desktop. Pages can be picked explicitly or sampled automatically.
- **Lab and field data** — Lighthouse scores (Performance, Accessibility, Best Practices,
  SEO) and lab metrics (LCP, CLS, TBT, FCP, Speed Index, TTFB) next to real-user Core Web
  Vitals from CrUX (LCP, INP, CLS). Multiple runs per URL with median aggregation.
- **Comparable history** — trend charts, run-to-run and before/after-theme comparisons,
  filterable run history.
- **Readable reports** — a deterministic, rule-based narrative explains what improved,
  what regressed, the likely causes and prioritized recommendations.
- **Sharing and export** — PDF, CSV and JSON export, public read-only share links.
- **Alerts** — score and metric thresholds with email or outbound webhook notifications.
- **Audit profiles** — reusable, duplicable configurations (markets, pages, schedule,
  devices, thresholds, notifications).

## Stack

| Layer | Choice |
|---|---|
| App framework | React Router 7 on the official Shopify app template, TypeScript strict |
| Shopify | `@shopify/shopify-app-react-router` 3, managed installation + token exchange, GraphQL Admin API `2026-07` |
| UI | Polaris web components + App Bridge, dependency-free SVG charts |
| Data | Prisma 6 + PostgreSQL 17 |
| Jobs | BullMQ 6 + Redis 8 (rate-limited audit queue, job schedulers for cron) |
| Audit engine | PageSpeed Insights API v5 behind an `AuditEngine` interface |
| Tests | Vitest 5, always run in Docker against real Postgres and Redis |
| Runtime | Node.js 24 (22.12+ supported) |

### Architecture

```
                        ┌────────────────────── Shopify Admin ───────────┐
                        │  embedded iframe (App Bridge + session token)  │
                        └──────────────┬─────────────────────────────────┘
                                       │
┌─────────────┐   HTTPS   ┌────────────▼─────────────┐
│   Shopify   │  webhook  │   WEB (React Router 7)   │
│  Platform   ├──────────►│  routes /app/**  (UI)    │
│ themes/     │           │  routes /webhooks/**     │──────┐ enqueue
│  publish    │           │  routes /share/:token    │      │
│ compliance  │           └────────┬─────────┬───────┘      │
└─────────────┘             Prisma │         │ GraphQL      │
                          ┌────────▼───┐     │ Admin API    │
                          │ PostgreSQL │     │              │
                          └────────▲───┘     │        ┌─────▼──────┐
                                   │         │        │   Redis    │
                          ┌────────┴─────────▼───┐    │  (BullMQ)  │
                          │  WORKER (BullMQ)     │◄───┴────────────┘
                          │  audit-url → PSI API │
                          │  finalize / schedule │
                          └──────────────────────┘
```

Two processes share the same codebase:

- **web** — the embedded admin app, webhook handlers and the public share page.
- **worker** (`worker/index.ts`) — the rate-limited audit queue, the control queue
  (finalize, scheduled and theme-publish runs) and the per-profile cron schedulers.

How a run works:

1. `createRun()` freezes the audit profile into the run (`profileSnapshot`) so historical
   reports stay interpretable if the profile changes later.
2. Targets are resolved: active markets (GraphQL `markets` → `webPresences.rootUrls`) ×
   page types × device profiles. One `PageResult` row and one `audit-url` job per target,
   with the row id as job id for idempotency.
3. The worker calls PSI N times per URL (default 3), takes the median, stores the raw
   Lighthouse JSON and the normalized values.
4. The last job triggers `finalize`: comparison with the previous run, narrative
   generation, threshold evaluation, alerts and notifications.

Reliability notes: webhooks are deduplicated on `X-Shopify-Webhook-Id` and answered
immediately; job ids are deterministic; GraphQL throttling is handled from
`extensions.cost.throttleStatus`; the PSI queue is rate-limited per minute and by a shared
daily counter in Redis; runs with failed URLs end as `PARTIAL`, never lose good results.

### Access scopes

All scopes are read-only. The app never modifies a store.

| Scope | Why |
|---|---|
| `read_markets` | `markets` + `webPresences` (domains, root URLs, locales) to build per-market URLs |
| `read_locales` | web presence locales are `ShopLocale` objects |
| `read_products` | sampling of product and collection pages |
| `read_content` | sampling of CMS pages and blog articles |
| `read_themes` | required by the `themes/publish` webhook topic and to read the theme id/name |

## Getting started

Prerequisites: Node.js 24 (or 22.12+), Docker, a Shopify Partner / Dev Dashboard account,
and a free Google API key for the PageSpeed Insights API (Cloud Console → enable
"PageSpeed Insights API" → Credentials → Create API key).

```bash
npm install
cp .env.example .env            # set PSI_API_KEY
npm run docker:dev              # Postgres 17 + Redis 8
npx prisma migrate deploy

npm run config:link             # link the project to your app in the Dev Dashboard (once)

npm run dev                     # terminal 1: embedded app (tunnel + HMR via Shopify CLI)
npm run worker:dev              # terminal 2: queues + schedulers
```

`shopify app dev` updates the app URLs automatically. Scopes in `shopify.app.toml` are
applied through managed installation on first load.

## Tests

Tests always run in Docker against ephemeral Postgres and Redis instances:

```bash
npm run docker:test
```

The suite covers PSI response parsing, medians, URL building, comparisons, narrative and
recommendations, CSV export, threshold evaluation, the `themes/publish`, GDPR and uninstall
webhooks (real HMAC, idempotency), run finalization and the Redis quota. With
`npm run docker:dev` running you can also use `npm run test` locally; it targets a
dedicated `performify_test` database and refuses to truncate anything else.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | ✔ | app credentials (`npm run env -- pull`) |
| `SHOPIFY_APP_URL` | ✔ | public app URL |
| `SCOPES` | ✔ | `read_content,read_locales,read_markets,read_products,read_themes` |
| `DATABASE_URL` | ✔ | PostgreSQL connection string |
| `REDIS_URL` | ✔ | Redis connection string |
| `PSI_API_KEY` | ✔ | Google API key for PageSpeed Insights |
| `PSI_DAILY_QUOTA` | | default 20000 (Google default is ~25k/day per project) |
| `PSI_PER_MINUTE_LIMIT` | | default 100 (Google default is ~240/min) |
| `AUDIT_CONCURRENCY` | | default 4 concurrent PSI calls |
| `ALERT_SMTP_URL` | | `smtp://user:pass@host:587` for alert emails (empty = log only) |
| `ALERT_FROM_EMAIL` | | sender address for alert emails |

## Deployment

Four components: **web**, **worker**, **PostgreSQL**, **Redis**. The multi-stage
`Dockerfile` builds both images:

```bash
docker build --target web -t performify-web .
docker build --target worker -t performify-worker .
```

1. Provision managed Postgres and Redis; set the variables above on both services.
2. The web container runs `prisma migrate deploy` on start (`docker-start`).
3. In `shopify.app.toml` replace `application_url` and `redirect_urls` with the production
   host, then run `shopify app deploy` to publish scopes, webhooks and compliance topics.
4. Scaling: web is stateless; multiple workers share the queues, but the per-minute PSI
   limit is per worker, so lower `PSI_PER_MINUTE_LIMIT` accordingly (≤ 240/min per key).
5. Raw Lighthouse reports are stored as JSONB; if they grow large, move payloads to object
   storage and keep the pointer in `RawReport`.

### Adding a self-hosted engine

`app/lib/audit/engine-factory.server.ts` is the extension point. Implement
`LighthouseLocalEngine` (same `AuditEngine` interface) in a container with Chromium and the
`lighthouse` package, register it in the factory and select it from the profile. Useful for
password-protected theme previews, which PSI cannot reach.

## Troubleshooting

- **Run stuck on RUNNING** — make sure the worker is running and no system Redis
  (e.g. `brew services list`) is listening on 6379 in front of the Docker one. On start
  the worker re-enqueues jobs of orphaned runs.
- **Worker exits with "empty appUrl"** — `.env` is missing the app credentials; run
  `npm run env -- pull`.
- **PSI 429** — a per-minute burst pauses the audit queue for 90 s; a daily-quota response
  pauses it until the next UTC midnight. Both are logged by the worker.

## Project layout

```
app/
  lib/            # pure, unit-testable logic (no I/O)
    audit/        # AuditEngine types, PSI engine, parser, medians, quota
    urls/         # per-market / per-page URL building
    report/       # run comparison, narrative, recommendations
    alerts/       # threshold evaluation
  services/       # database + GraphQL Admin access (server only)
  queues/         # BullMQ queue definitions (shared by web and worker)
  routes/         # embedded UI (/app/**), webhooks, public share page, exports
worker/
  index.ts        # worker bootstrap + job schedulers
  processors/     # audit-url, finalize, scheduled, theme-publish
prisma/           # schema and migrations
tests/            # unit + integration (Vitest)
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright © aargonlab.
