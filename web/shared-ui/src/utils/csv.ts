/**
 * CSV export — one implementation for every "Export" control (FE-MEDIUM-092).
 *
 * DataTable's client-side export owned the only correct CSV writer (formula
 * defang, quoting, the Firefox-safe download) while three hr pages rendered an
 * Export button that did nothing. The writer and the download live here so a
 * page that exports something other than a table (a metrics report, a
 * database schema) gets the same file the table would produce.
 */

/**
 * SEC-014: a cell that starts with a formula character is prefixed with a
 * quote so a spreadsheet opens it as text, never as a formula.
 */
export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quoteCsvCell(value: unknown): string {
  const text = sanitizeCsvCell(String(value ?? ''));
  return text.includes(',') || text.includes('"') || text.includes('\n')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** Headers and rows as one CSV document, every cell defanged and quoted as needed. */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    headers.map(quoteCsvCell).join(','),
    ...rows.map((row) => row.map(quoteCsvCell).join(',')),
  ].join('\n');
}

/** Hand the browser a file to save. Appended to the DOM before the click — Firefox needs it. */
export function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadCsv(
  fileName: string,
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): void {
  downloadTextFile(
    fileName.endsWith('.csv') ? fileName : `${fileName}.csv`,
    toCsv(headers, rows),
    'text/csv',
  );
}

export function downloadJson(fileName: string, value: unknown): void {
  downloadTextFile(
    fileName.endsWith('.json') ? fileName : `${fileName}.json`,
    JSON.stringify(value, null, 2),
    'application/json',
  );
}
