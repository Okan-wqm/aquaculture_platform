// Agent requests: the lifecycle of every task the kernel handed to an agent.
//
// WHY: an agent request moves pending → claimed → submitted → accepted, and the
// operator's first question is where the population currently sits — a pile of
// `pending` means nothing is picking work up, a pile of `expired` means work is
// being dropped. So the state distribution leads and the rows follow.
// WHAT: a read-only table over GET /api/v1/agent-requests. States, roles and
// result statuses are kernel values and render verbatim; the state select
// filters server-side so the distribution above always describes the response.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgentRequestState, AgentRequestView } from '../../../../shared/api-contract.ts';
import { getAgentRequests } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { toneForStatus } from './tones.ts';

/** The lifecycle states the projection can report, in lifecycle order. */
const STATES: ReadonlyArray<AgentRequestState> = ['pending', 'claimed', 'submitted', 'accepted', 'rejected', 'expired', 'unknown'];

/** Sentinel for "no state filter"; it can never collide with a kernel state. */
const ALL_STATES = '*';

const COLUMNS: ReadonlyArray<ColumnDef<AgentRequestView>> = [
  {
    id: 'state',
    header: 'State',
    headerTitle: 'state — where the request currently sits in the agent lifecycle',
    render: (row) => <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>,
    sortValue: (row) => STATES.indexOf(row.state),
    filterValue: (row) => row.state,
    nowrap: true,
    width: '14ch',
  },
  {
    id: 'role',
    header: 'Role',
    headerTitle: 'role — the role the kernel asked an agent to fill',
    render: (row) => textOrEmpty(row.role),
    sortValue: (row) => row.role,
    filterValue: (row) => row.role ?? '',
    mono: true,
    nowrap: true,
  },
  {
    id: 'agent',
    header: 'Agent',
    headerTitle: 'target_agent — the agent the request was addressed to',
    render: (row) => textOrEmpty(row.targetAgent),
    sortValue: (row) => row.targetAgent,
    filterValue: (row) => row.targetAgent ?? '',
    mono: true,
    nowrap: true,
  },
  {
    id: 'requestId',
    header: 'Request',
    headerTitle: 'request_id — the key this request carries across the three agent ledgers',
    render: (row) => row.requestId,
    sortValue: (row) => row.requestId,
    filterValue: (row) => row.requestId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'cycle',
    header: 'Cycle',
    headerTitle: 'cycle_id — the cycle the request was issued in',
    render: (row) =>
      row.cycleId === null ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <Link className="mono" to={ROUTES.cycle(row.cycleId)}>
          {row.cycleId}
        </Link>
      ),
    sortValue: (row) => row.cycleId,
    filterValue: (row) => row.cycleId ?? '',
    nowrap: true,
  },
  {
    id: 'createdAt',
    header: 'Created',
    headerTitle: 'created_at — when the kernel issued the request',
    render: (row) => <Timestamp value={row.createdAt} />,
    sortValue: (row) => row.createdAt,
    nowrap: true,
    width: '15ch',
  },
  {
    id: 'claimedAt',
    header: 'Claimed',
    headerTitle: 'claimed_at — when an agent took the request',
    render: (row) => <Timestamp value={row.claimedAt} />,
    sortValue: (row) => row.claimedAt,
    nowrap: true,
    width: '15ch',
  },
  {
    id: 'submittedAt',
    header: 'Submitted',
    headerTitle: 'submitted_at — when the agent returned a result',
    render: (row) => <Timestamp value={row.submittedAt} />,
    sortValue: (row) => row.submittedAt,
    nowrap: true,
    width: '15ch',
  },
  {
    id: 'result',
    header: 'Result',
    headerTitle: 'result_status — the verdict recorded against the submitted result',
    render: (row) => (row.resultStatus === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.resultStatus)}>{row.resultStatus}</Badge>),
    sortValue: (row) => row.resultStatus,
    filterValue: (row) => row.resultStatus ?? '',
    nowrap: true,
  },
];

export function AgentsPage(): ReactNode {
  const [stateFilter, setStateFilter] = useState<string>(ALL_STATES);
  const { state, reload } = useRequest(
    (signal) => getAgentRequests({ state: stateFilter === ALL_STATES ? undefined : stateFilter, limit: 500 }, signal),
    [stateFilter],
  );
  const filtered = stateFilter !== ALL_STATES;
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="agent-invocations/{requests,claims,results}.jsonl"
        actions={
          <>
            <label className="field field--inline" htmlFor="agents-state">
              <span>State</span>
              <select id="agents-state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value={ALL_STATES}>All</option>
                {STATES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
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
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load agent requests">
        {(data) => (
          <div className="stack">
            <Card
              title="Lifecycle"
              subtitle={
                filtered
                  ? `Requests in state ${stateFilter}, counted across the response below.`
                  : 'Every agent request the kernel issued, counted by the state it currently sits in.'
              }
            >
              <ByCountStats
                counts={data.byState}
                kind="status"
                emptyTitle="No states to count"
                emptyMessage="Each lifecycle state the agent ledgers recorded would be counted here; no request matched this filter."
              />
            </Card>
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.requests}
                rowKey={(row) => row.requestId}
                caption="Agent requests, newest first"
                emptyTitle={filtered ? 'No requests in this state' : 'No agent requests yet'}
                emptyMessage={
                  filtered
                    ? `No loaded request sits in state ${stateFilter}; clear the state filter to see the rest.`
                    : 'Every task the kernel hands to an agent is recorded here; the agent ledgers have no rows.'
                }
                filter={{
                  placeholder: 'Search request_id, role or agent…',
                  predicate: (row, query) => `${row.requestId} ${row.role ?? ''} ${row.targetAgent ?? ''} ${row.state}`.toLowerCase().includes(query),
                }}
                initialSort={{ columnId: 'createdAt', direction: 'desc' }}
                // WHY: a rejected request (danger) or an expired one (warning)
                // is work the kernel lost; the ordinary lifecycle states carry
                // no tint, so the tinted rows stay the exceptions on the page.
                rowClassName={(row) => {
                  const tone = toneForStatus(row.state);
                  return tone === 'danger' ? 'row-danger' : tone === 'warning' ? 'row-warning' : undefined;
                }}
                maxHeight="62vh"
                countNoun="requests"
                footer={`${formatNumber(data.requests.length)} of at most 500 requests loaded.`}
                dense
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
