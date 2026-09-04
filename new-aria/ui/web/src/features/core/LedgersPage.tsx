import type { ReactNode } from 'react';
import type { LedgerSurfaceView } from '../../../../shared/api-contract.ts';
import { getLedgers } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { formatBytes, formatNumber, shortHash } from '../../design/format.ts';

const COLUMNS: ReadonlyArray<ColumnDef<LedgerSurfaceView>> = [
  { id: 'name', header: 'Yüzey', render: (row) => <span className="mono">{row.name}</span>, sortValue: (row) => row.name, nowrap: true },
  { id: 'path', header: 'Göreli yol', render: (row) => <span className="mono">{row.relativePath}</span>, sortValue: (row) => row.relativePath },
  {
    id: 'present',
    header: 'Mevcut',
    render: (row) => <Badge tone={row.present ? 'success' : 'muted'}>{row.present ? 'present' : 'absent'}</Badge>,
    sortValue: (row) => (row.present ? 1 : 0),
    nowrap: true,
  },
  { id: 'rows', header: 'Satır', render: (row) => formatNumber(row.rows), sortValue: (row) => row.rows, align: 'end' },
  { id: 'bytes', header: 'Boyut', render: (row) => formatBytes(row.bytes), sortValue: (row) => row.bytes, align: 'end' },
  {
    id: 'hash',
    header: 'Son hash',
    render: (row) => (
      <span className="mono" title={row.lastHash ?? undefined}>
        {shortHash(row.lastHash, 16)}
      </span>
    ),
    nowrap: true,
  },
  {
    id: 'indexed',
    header: 'integrity_index',
    render: (row) => <Badge tone={row.indexed ? 'success' : 'warning'}>{row.indexed ? 'indexed' : 'not indexed'}</Badge>,
    sortValue: (row) => (row.indexed ? 1 : 0),
    nowrap: true,
  },
];

export function LedgersPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getLedgers(signal), []);
  return (
    <>
      <PageHeader
        title="Defterler (ledger)"
        subtitle="state_manifest yüzeyleri · integrity_index.json"
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => {
          const present = data.surfaces.filter((surface) => surface.present).length;
          const totalBytes = data.surfaces.reduce((sum, surface) => sum + (surface.bytes ?? 0), 0);
          const totalRows = data.surfaces.reduce((sum, surface) => sum + (surface.rows ?? 0), 0);
          const unindexed = data.surfaces.filter((surface) => surface.present && !surface.indexed).length;
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat label="Yüzey" value={`${formatNumber(present)} / ${formatNumber(data.surfaces.length)}`} hint="mevcut / tanımlı" />
                <Stat label="Toplam satır" value={formatNumber(totalRows)} />
                <Stat label="Toplam boyut" value={formatBytes(totalBytes)} />
                <Stat label="İndekslenmemiş" value={formatNumber(unindexed)} tone={unindexed > 0 ? 'warning' : 'default'} hint="mevcut ama integrity_index dışında" />
              </div>
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.surfaces}
                  rowKey={(row) => row.name}
                  caption="Ledger yüzeyleri"
                  emptyMessage="Yüzey tanımı yok."
                  filter={{ placeholder: 'yüzey / yol ara…', predicate: (row, query) => `${row.name} ${row.relativePath}`.toLocaleLowerCase('tr').includes(query) }}
                  initialSort={{ columnId: 'name', direction: 'asc' }}
                  rowClassName={(row) => (!row.present ? 'row-muted' : undefined)}
                />
              </Card>
            </div>
          );
        }}
      </AsyncState>
    </>
  );
}
