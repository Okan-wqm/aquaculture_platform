/**
 * Hand a CSV to the browser as a download. The byte-order mark makes
 * spreadsheet programs read the file as UTF-8 (Turkish letters, °C).
 */
export function downloadCsv(content: string, fileStem: string): void {
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileStem}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
