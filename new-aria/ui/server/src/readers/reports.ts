// Daily report anchors — reports/daily/<date>.md.
//
// WHY: the reflection phase writes the operator's daily report; the console
// lists and renders them as escaped text (the SPA never injects HTML).
// WHAT: list markdown files whose name is a date; read one by validated date.

import type { DailyReportResponse, DailyReportsResponse } from '../../../shared/api-contract.ts';
import { LEDGER_SOURCES } from '../../../shared/api-contract.ts';
import { HttpError } from '../errors.ts';
import { listDirectory, readTextFile, resolveInside, statSize } from '../fsafe.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listDailyReports(toolsDir: string): Promise<DailyReportsResponse> {
  const dir = resolveInside(toolsDir, LEDGER_SOURCES.reports_daily_dir);
  const reports: { date: string; bytes: number }[] = [];
  for (const name of await listDirectory(dir)) {
    if (!name.endsWith('.md')) continue;
    const date = name.slice(0, -3);
    if (!DATE.test(date)) continue;
    reports.push({ date, bytes: (await statSize(resolveInside(dir, name))) ?? 0 });
  }
  reports.sort((a, b) => b.date.localeCompare(a.date));
  return { reports };
}

export async function readDailyReport(toolsDir: string, date: string): Promise<DailyReportResponse> {
  if (!DATE.test(date)) throw new HttpError(400, 'report_date_invalid');
  const markdown = await readTextFile(resolveInside(toolsDir, LEDGER_SOURCES.reports_daily_dir, `${date}.md`));
  if (markdown === null) throw new HttpError(404, 'report_not_found');
  return { date, markdown };
}
