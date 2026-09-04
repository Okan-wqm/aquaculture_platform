import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CycleSummary } from '../../../../shared/api-contract.ts';
import { getCycles } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatDuration, formatNumber, shortHash } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const LIMITS = [50, 100, 500, 1000] as const;

const COLUMNS: ReadonlyArray<ColumnDef<CycleSummary>> = [
  {
    id: 'cycleId',
    header: 'cycle_id',
    render: (row) => (
      <Link to={ROUTES.cycle(row.cycleId)} className="mono">
        {row.cycleId}
      </Link>
    ),
    sortValue: (row) => row.cycleId,
    nowrap: true,
  },
  { id: 'status', header: 'status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge>, sortValue: (row) => row.status },
  { id: 'startedAt', header: 'Başladı', render: (row) => <Timestamp value={row.startedAt} />, sortValue: (row) => row.startedAt, nowrap: true },
  { id: 'endedAt', header: 'Bitti', render: (row) => <Timestamp value={row.endedAt} />, sortValue: (row) => row.endedAt, nowrap: true },
  { id: 'duration', header: 'Süre', render: (row) => formatDuration(row.durationSeconds), sortValue: (row) => row.durationSeconds, align: 'end' },
  {
    id: 'sha',
    header: 'git HEAD',
    render: (row) => (
      <span className="mono" title={row.gitHeadSha ?? undefined}>
        {shortHash(row.gitHeadSha, 10)}
      </span>
    ),
    nowrap: true,
  },
  { id: 'decisions', header: 'Araç kararı', render: (row) => formatNumber(row.toolDecisionCount), sortValue: (row) => row.toolDecisionCount, align: 'end' },
];

export function CyclesPage(): ReactNode {
  const [limit, setLimit] = useState<number>(100);
  const { state, reload } = useRequest((signal) => getCycles({ limit }, signal), [limit]);
  return (
    <>
      <PageHeader
        title="Döngüler"
        subtitle={state.status === 'success' ? `${formatNumber(state.data.total)} toplam döngü` : 'cycles.jsonl'}
        actions={
          <>
            <label className="field field--inline" htmlFor="cycles-limit">
              <span>Limit</span>
              <select id="cycles-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                {LIMITS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={reload}>
              Yenile
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <Card flush>
            <DataTable
              columns={COLUMNS}
              rows={data.cycles}
              rowKey={(row) => row.cycleId}
              caption="Döngü listesi"
              emptyMessage="Henüz döngü yok."
              filter={{
                placeholder: 'cycle_id / status / sha ara…',
                predicate: (row, query) => `${row.cycleId} ${row.status} ${row.gitHeadSha ?? ''}`.toLocaleLowerCase('tr').includes(query),
              }}
              initialSort={{ columnId: 'startedAt', direction: 'desc' }}
            />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
