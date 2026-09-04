import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PressureView } from '../../../../shared/api-contract.ts';
import { getPressures } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const COLUMNS: ReadonlyArray<ColumnDef<PressureView>> = [
  { id: 'id', header: 'pressure_id', render: (row) => <span className="mono">{row.pressureId}</span>, sortValue: (row) => row.pressureId, nowrap: true },
  { id: 'source', header: 'source', render: (row) => <span className="mono">{textOrEmpty(row.source)}</span>, sortValue: (row) => row.source, nowrap: true },
  { id: 'score', header: 'Skor', render: (row) => formatNumber(row.score), sortValue: (row) => row.score, align: 'end' },
  { id: 'state', header: 'state', render: (row) => (row.state === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>), sortValue: (row) => row.state, nowrap: true },
  { id: 'occurrences', header: 'Tekrar', render: (row) => formatNumber(row.occurrenceCount), sortValue: (row) => row.occurrenceCount, align: 'end' },
  { id: 'summary', header: 'Özet', render: (row) => textOrEmpty(row.summary) },
  {
    id: 'cycle',
    header: 'cycle_id',
    render: (row) =>
      row.cycleId === null ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <Link className="mono" to={ROUTES.cycle(row.cycleId)}>
          {row.cycleId}
        </Link>
      ),
    nowrap: true,
  },
  { id: 'at', header: 'Zaman', render: (row) => <Timestamp value={row.at} />, sortValue: (row) => row.at, nowrap: true },
];

export function PressuresPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getPressures({ limit: 500 }, signal), []);
  return (
    <>
      <PageHeader
        title="Basınçlar"
        subtitle={state.status === 'success' ? `${formatNumber(state.data.total)} toplam basınç` : 'pressure/pressure-log.jsonl'}
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
              rows={data.pressures}
              rowKey={(row) => row.pressureId}
              caption="Basınç listesi"
              emptyMessage="Kayıtlı basınç yok."
              filter={{
                placeholder: 'kaynak / özet ara…',
                predicate: (row, query) => `${row.pressureId} ${row.source ?? ''} ${row.summary ?? ''} ${row.state ?? ''}`.toLocaleLowerCase('tr').includes(query),
              }}
              initialSort={{ columnId: 'score', direction: 'desc' }}
            />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
