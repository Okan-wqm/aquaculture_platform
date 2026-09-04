// The cycle ledger: one row per kernel run, newest first.
//
// WHY: an operator scans this list for the run that changed something — so the
// status, the duration and the git HEAD the run observed are all on one line,
// and the status filter narrows a long ledger without a round trip.
// WHAT: a read-only table over GET /api/v1/cycles. Cycle statuses are kernel
// values and render verbatim.
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CycleSummary } from '../../../../shared/api-contract.ts';
import { getCycles } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatDuration, formatNumber, shortHash, textOrEmpty } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const LIMITS = [50, 100, 500, 1000] as const;

/** Sentinel for "no status filter"; it can never collide with a kernel status. */
const ALL_STATUSES = '*';

const COLUMNS: ReadonlyArray<ColumnDef<CycleSummary>> = [
  {
    id: 'cycleId',
    header: 'Cycle',
    headerTitle: 'cycle_id as the kernel recorded it',
    render: (row) => (
      <Link to={ROUTES.cycle(row.cycleId)} className="mono">
        {row.cycleId}
      </Link>
    ),
    sortValue: (row) => row.cycleId,
    nowrap: true,
  },
  {
    id: 'status',
    header: 'Status',
    render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge>,
    sortValue: (row) => row.status,
    nowrap: true,
  },
  {
    id: 'startedAt',
    header: 'Started',
    render: (row) => <Timestamp value={row.startedAt} />,
    sortValue: (row) => row.startedAt,
    nowrap: true,
  },
  {
    id: 'endedAt',
    header: 'Ended',
    render: (row) => <Timestamp value={row.endedAt} />,
    sortValue: (row) => row.endedAt,
    nowrap: true,
  },
  {
    id: 'duration',
    header: 'Duration',
    render: (row) => formatDuration(row.durationSeconds),
    sortValue: (row) => row.durationSeconds,
    align: 'end',
    nowrap: true,
  },
  {
    id: 'sha',
    header: 'git HEAD',
    headerTitle: 'The commit the kernel observed during this cycle',
    render: (row) => (
      <span className="mono" title={textOrEmpty(row.gitHeadSha)}>
        {shortHash(row.gitHeadSha, 10)}
      </span>
    ),
    sortValue: (row) => row.gitHeadSha,
    nowrap: true,
  },
  {
    id: 'decisions',
    header: 'Tool decisions',
    headerTitle: 'Tool lifecycle decisions taken in this cycle',
    render: (row) => formatNumber(row.toolDecisionCount),
    sortValue: (row) => row.toolDecisionCount,
    align: 'end',
  },
];

export function CyclesPage(): ReactNode {
  const [limit, setLimit] = useState<number>(100);
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const { state, reload } = useRequest((signal) => getCycles({ limit }, signal), [limit]);

  // WHAT: the status options come from the loaded rows, so the console never
  // invents a status the kernel does not emit.
  const cycles = state.status === 'success' ? state.data.cycles : [];
  const statuses = useMemo(() => Array.from(new Set(cycles.map((row) => row.status))).sort(), [cycles]);
  const visible = status === ALL_STATUSES ? cycles : cycles.filter((row) => row.status === status);

  return (
    <>
      <PageHeader
        title="Cycles"
        subtitle={state.status === 'success' ? `${formatNumber(state.data.total)} cycles recorded in cycles.jsonl` : 'cycles.jsonl'}
        actions={
          <>
            <label className="field field--inline" htmlFor="cycles-limit">
              <span>Rows</span>
              <select id="cycles-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                {LIMITS.map((entry) => (
                  <option key={entry} value={entry}>
                    {formatNumber(entry)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={reload}>
              <Icon name="refresh" />
              Refresh
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load cycles">
        {() => (
          <Card flush>
            <DataTable
              columns={COLUMNS}
              rows={visible}
              rowKey={(row) => row.cycleId}
              caption="Cycles recorded by the kernel, newest first"
              emptyTitle={status === ALL_STATUSES ? 'No cycles yet' : 'No cycles with this status'}
              emptyMessage={
                status === ALL_STATUSES
                  ? 'Every kernel run appends a row to cycles.jsonl; the ledger has no rows.'
                  : `No loaded cycle carries the status ${status}; widen the row limit or clear the status filter.`
              }
              filter={{
                placeholder: 'Search cycle, status or git HEAD…',
                predicate: (row, query) => `${row.cycleId} ${row.status} ${row.gitHeadSha ?? ''}`.toLowerCase().includes(query),
              }}
              toolbar={
                <label className="field field--inline" htmlFor="cycles-status">
                  <span>Status</span>
                  <select id="cycles-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value={ALL_STATUSES}>All</option>
                    {statuses.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
              }
              initialSort={{ columnId: 'startedAt', direction: 'desc' }}
              rowClassName={(row) => (toneForStatus(row.status) === 'danger' ? 'row-danger' : undefined)}
              maxHeight="66vh"
              countNoun="cycles"
              dense
            />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
