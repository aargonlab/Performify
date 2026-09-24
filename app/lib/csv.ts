// ---------------------------------------------------------------------------
// Minimal RFC 4180 CSV serializer — pure logic, no I/O.
// ---------------------------------------------------------------------------

export interface CsvColumn {
  key: string;
  header: string;
}

/**
 * Serialize rows to CSV (RFC 4180): header row, CRLF line endings, fields
 * quoted when they contain a comma, quote or newline (inner quotes doubled).
 * null/undefined become empty fields.
 *
 * When `columns` is omitted, the column set is the union of the row keys in
 * first-seen order. With no rows and no columns, returns an empty string.
 */
export function toCsv(
  rows: Record<string, string | number | null | undefined>[],
  columns?: CsvColumn[],
): string {
  const cols = columns ?? inferColumns(rows);
  if (cols.length === 0) return "";

  const lines: string[] = [];
  lines.push(cols.map((c) => escapeField(c.header)).join(","));
  for (const row of rows) {
    lines.push(cols.map((c) => escapeField(row[c.key])).join(","));
  }
  return lines.join("\r\n");
}

function inferColumns(
  rows: Record<string, string | number | null | undefined>[],
): CsvColumn[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys.map((key) => ({ key, header: key }));
}

function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
