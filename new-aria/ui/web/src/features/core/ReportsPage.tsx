// The daily report index: one markdown file per day under reports/daily/.
//
// WHY: the operator's first question of a report archive is whether today's
// report exists at all — a missing day means a cycle produced no narrative, and
// that gap is invisible in a bare file list. WHAT: the newest report date and
// the size of the archive sit above the table, and the table itself is sorted
// newest first so the top row answers the question without a scroll.
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DailyReportMeta } from '../../../../shared/api-contract.ts';
import { getDailyReports } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { EMPTY, formatBytes, formatNumber } from '../../design/format.ts';

const COLUMNS: ReadonlyArray<ColumnDef<DailyReportMeta>> = [
  {
    id: 'date',
    header: 'Date',
    headerTitle: 'The day the report covers; it is also the file name under reports/daily/',
    render: (row) => (
      <Link to={ROUTES.report(row.date)} className="mono">
        {row.date}
      </Link>
    ),
    sortValue: (row) => row.date,
    filterValue: (row) => row.date,
    nowrap: true,
    width: '18ch',
  },
  {
    id: 'bytes',
    header: 'Size',
    headerTitle: 'Size of the markdown file on disk',
    render: (row) => formatBytes(row.bytes),
    sortValue: (row) => row.bytes,
    align: 'end',
    nowrap: true,
    width: '12ch',
  },
];

/** The most recent report date, used as the archive's headline fact. */
function latestDate(reports: ReadonlyArray<DailyReportMeta>): string {
  return reports.reduce((latest, report) => (report.date > latest ? report.date : latest), '');
}

export function ReportsPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getDailyReports(signal), []);
  const navigate = useNavigate();
  // The row-activation handler is stable so DataTable's keyboard path (Enter on
  // a focused row) opens the same route as the date link inside the row.
  const openReport = useMemo(() => (row: DailyReportMeta) => navigate(ROUTES.report(row.date)), [navigate]);
  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="reports/daily/"
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load reports">
        {(data) => {
          const latest = latestDate(data.reports);
          const totalBytes = data.reports.reduce((sum, report) => sum + report.bytes, 0);
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat label="Latest report" value={<span className="mono">{latest === '' ? EMPTY : latest}</span>} hint="Newest day in the archive" compact />
                <Stat label="Total" value={formatNumber(data.reports.length)} hint="Daily report files" />
                <Stat label="Total size" value={formatBytes(totalBytes)} hint="Markdown on disk" />
              </div>
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.reports}
                  rowKey={(row) => row.date}
                  caption="Daily reports, newest first"
                  emptyTitle="No reports yet"
                  emptyMessage="The kernel writes one markdown report per day it runs; reports/daily/ holds no files."
                  filter={{ placeholder: 'Search date…', predicate: (row, query) => row.date.toLowerCase().includes(query) }}
                  initialSort={{ columnId: 'date', direction: 'desc' }}
                  onRowActivate={openReport}
                  maxHeight="60vh"
                  countNoun="reports"
                  dense
                />
              </Card>
            </div>
          );
        }}
      </AsyncState>
    </>
  );
}
