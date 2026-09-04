import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgentRequestView } from '../../../../shared/api-contract.ts';
import { getAgentRequests } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { toneForStatus } from './tones.ts';

const STATES = ['pending', 'claimed', 'submitted', 'accepted', 'rejected', 'expired', 'unknown'] as const;

const COLUMNS: ReadonlyArray<ColumnDef<AgentRequestView>> = [
  { id: 'id', header: 'request_id', render: (row) => <span className="mono">{row.requestId}</span>, sortValue: (row) => row.requestId, nowrap: true },
  { id: 'state', header: 'state', render: (row) => <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>, sortValue: (row) => row.state, nowrap: true },
  { id: 'role', header: 'role', render: (row) => <span className="mono">{textOrEmpty(row.role)}</span>, sortValue: (row) => row.role, nowrap: true },
  { id: 'agent', header: 'target_agent', render: (row) => <span className="mono">{textOrEmpty(row.targetAgent)}</span>, sortValue: (row) => row.targetAgent, nowrap: true },
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
  { id: 'createdAt', header: 'Oluşturuldu', render: (row) => <Timestamp value={row.createdAt} />, sortValue: (row) => row.createdAt, nowrap: true },
  { id: 'claimedAt', header: 'Sahiplenildi', render: (row) => <Timestamp value={row.claimedAt} />, sortValue: (row) => row.claimedAt, nowrap: true },
  { id: 'submittedAt', header: 'Teslim', render: (row) => <Timestamp value={row.submittedAt} />, sortValue: (row) => row.submittedAt, nowrap: true },
  {
    id: 'result',
    header: 'result_status',
    render: (row) => (row.resultStatus === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.resultStatus)}>{row.resultStatus}</Badge>),
    sortValue: (row) => row.resultStatus,
    nowrap: true,
  },
];

export function AgentsPage(): ReactNode {
  const [stateFilter, setStateFilter] = useState('');
  const { state, reload } = useRequest((signal) => getAgentRequests({ state: stateFilter === '' ? undefined : stateFilter, limit: 500 }, signal), [stateFilter]);
  return (
    <>
      <PageHeader
        title="Ajanlar"
        subtitle="agent-invocations/{requests,claims,results}.jsonl"
        actions={
          <>
            <label className="field field--inline" htmlFor="agents-state">
              <span>state</span>
              <select id="agents-state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="">(hepsi)</option>
                {STATES.map((entry) => (
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
          <div className="stack">
            <ByCountStats counts={data.byState} kind="status" emptyMessage="Durum dağılımı yok." />
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.requests}
                rowKey={(row) => row.requestId}
                caption="Ajan istekleri"
                emptyMessage="Bu filtreyle ajan isteği yok."
                filter={{
                  placeholder: 'id / role / agent ara…',
                  predicate: (row, query) => `${row.requestId} ${row.role ?? ''} ${row.targetAgent ?? ''} ${row.state}`.toLocaleLowerCase('tr').includes(query),
                }}
                initialSort={{ columnId: 'createdAt', direction: 'desc' }}
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
