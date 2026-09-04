// Plans: what the kernel decided to do about a pressure, and how far it got.
//
// WHY: a plan is the bridge between a pressure and the work that answers it, so
// the operator reads the state distribution first (how many plans are still
// moving, how many ended) and then follows one plan back to the pressure event
// that caused it. WHAT: a read-only table over GET /api/v1/plans. Plan states
// and terminal states are kernel values and render verbatim.
import type { ReactNode } from 'react';
import type { PlanView } from '../../../../shared/api-contract.ts';
import { getPlans } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
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

/** The server-side row cap; the footer states it so a truncated list is never read as the whole ledger. */
const ROW_LIMIT = 500;

const COLUMNS: ReadonlyArray<ColumnDef<PlanView>> = [
  {
    id: 'state',
    header: 'State',
    headerTitle: 'state — where the plan currently sits',
    render: (row) => <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>,
    sortValue: (row) => row.state,
    filterValue: (row) => row.state,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'planId',
    header: 'Plan',
    headerTitle: 'plan_id — the key the plan carries in plans/',
    render: (row) => row.planId,
    sortValue: (row) => row.planId,
    filterValue: (row) => row.planId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'round',
    header: 'Round',
    headerTitle: 'round — how many planning rounds this plan has been through',
    render: (row) => formatNumber(row.round),
    sortValue: (row) => row.round,
    align: 'end',
    nowrap: true,
    width: '10ch',
  },
  {
    id: 'pressure',
    header: 'Pressure event',
    headerTitle: 'pressure_event_id — the pressure this plan answers',
    render: (row) => textOrEmpty(row.pressureEventId),
    sortValue: (row) => row.pressureEventId,
    filterValue: (row) => row.pressureEventId ?? '',
    mono: true,
    nowrap: true,
  },
  {
    id: 'terminal',
    header: 'Terminal state',
    headerTitle: 'terminal_state — the state the plan ended in, empty while it is still moving',
    render: (row) => (row.terminalState === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.terminalState)}>{row.terminalState}</Badge>),
    sortValue: (row) => row.terminalState,
    filterValue: (row) => row.terminalState ?? '',
    nowrap: true,
  },
  {
    id: 'updatedAt',
    header: 'Updated',
    headerTitle: 'updated_at — when the plan last moved',
    render: (row) => <Timestamp value={row.updatedAt} />,
    sortValue: (row) => row.updatedAt,
    nowrap: true,
    width: '16ch',
  },
];

export function PlansPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getPlans({ limit: ROW_LIMIT }, signal), []);
  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="plans/"
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load plans">
        {(data) => {
          const open = data.plans.filter((plan) => plan.terminalState === null).length;
          return (
            <div className="stack">
              <Card title="States" subtitle="Every loaded plan, counted by the state it currently sits in.">
                <ByCountStats
                  counts={data.byState}
                  kind="status"
                  emptyTitle="No states to count"
                  emptyMessage="Each state the plan ledger recorded would be counted here; no plan was loaded."
                />
              </Card>
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.plans}
                  rowKey={(row) => row.planId}
                  caption="Plans recorded by the kernel, most recently updated first"
                  emptyTitle="No plans yet"
                  emptyMessage="Every plan the kernel writes in answer to a pressure is listed here; plans/ has no records."
                  filter={{
                    placeholder: 'Search plan_id, state or pressure event…',
                    predicate: (row, query) =>
                      `${row.planId} ${row.state} ${row.pressureEventId ?? ''} ${row.terminalState ?? ''}`.toLowerCase().includes(query),
                  }}
                  initialSort={{ columnId: 'updatedAt', direction: 'desc' }}
                  // WHY: a plan that ended in a failure state is the only row
                  // whose colour tells the operator something the badge cannot
                  // already say at a glance while scanning a long list.
                  rowClassName={(row) => (toneForStatus(row.terminalState) === 'danger' ? 'row-danger' : row.terminalState === null ? undefined : 'row-muted')}
                  maxHeight="62vh"
                  countNoun="plans"
                  footer={`${formatNumber(open)} of ${formatNumber(data.plans.length)} loaded plans have no terminal state. At most ${formatNumber(ROW_LIMIT)} plans are loaded.`}
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
