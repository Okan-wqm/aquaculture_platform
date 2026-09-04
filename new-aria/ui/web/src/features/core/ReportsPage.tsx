import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DailyReportMeta } from '../../../../shared/api-contract.ts';
import { getDailyReports } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { formatBytes } from '../../design/format.ts';

const COLUMNS: ReadonlyArray<ColumnDef<DailyReportMeta>> = [
  {
    id: 'date',
    header: 'Tarih',
    render: (row) => (
      <Link to={ROUTES.report(row.date)} className="mono">
        {row.date}
      </Link>
    ),
    sortValue: (row) => row.date,
    nowrap: true,
  },
  { id: 'bytes', header: 'Boyut', render: (row) => formatBytes(row.bytes), sortValue: (row) => row.bytes, align: 'end' },
];

export function ReportsPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getDailyReports(signal), []);
  return (
    <>
      <PageHeader
        title="Raporlar"
        subtitle="reports/daily/"
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <Card flush>
            <DataTable
              columns={COLUMNS}
              rows={data.reports}
              rowKey={(row) => row.date}
              caption="Günlük raporlar"
              emptyMessage="Henüz günlük rapor yok."
              filter={{ placeholder: 'tarih ara…', predicate: (row, query) => row.date.includes(query) }}
              initialSort={{ columnId: 'date', direction: 'desc' }}
            />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
