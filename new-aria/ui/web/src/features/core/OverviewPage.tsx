// The landing screen of the operator console.
//
// WHY: the first question an operator asks is "is the kernel allowed to act
// right now?" — so the two stop conditions (kill switch, budget breaker) are
// announced above everything else, then the runtime profile and its scheduler
// ceiling, then what the last cycle did, then the ledger totals.
// WHAT: one read-only view over GET /api/v1/overview. Every kernel-emitted word
// (profile, cycle status, breaker state) renders verbatim; only its colour and
// its title attribute carry the English explanation.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { OverviewResponse } from '../../../../shared/api-contract.ts';
import { getOverview } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState, EmptyBlock } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { StatusDot } from '../../design/StatusDot.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatDuration, formatNumber, shortHash, textOrEmpty } from '../../design/format.ts';
import { glossForProfile, toneForProfile, toneForStatus } from './tones.ts';

type Breaker = OverviewResponse['breakers'][number];

const BREAKER_COLUMNS: ReadonlyArray<ColumnDef<Breaker>> = [
  {
    id: 'name',
    header: 'Breaker',
    render: (row) => row.name,
    sortValue: (row) => row.name,
    mono: true,
    nowrap: true,
  },
  {
    id: 'state',
    header: 'State',
    render: (row) => (
      <StatusDot tone={toneForStatus(row.state)} mono>
        {row.state}
      </StatusDot>
    ),
    sortValue: (row) => row.state,
    nowrap: true,
  },
  {
    id: 'rows',
    header: 'Rows',
    headerTitle: 'Ledger rows recorded for this breaker',
    render: (row) => formatNumber(row.rows),
    sortValue: (row) => row.rows,
    align: 'end',
  },
];

export function OverviewContent({ data }: { readonly data: OverviewResponse }): ReactNode {
  const killSwitchEngaged = data.killSwitch.engaged;
  const budgetTripped = data.budget.tripped;
  return (
    <div className="stack">
      {killSwitchEngaged ? (
        <Callout tone="danger" title="Kill switch engaged" role="alert">
          <p>
            The <code className="mono">ARIA_STOP</code> file is present, so the kernel starts no new cycle. Only an operator can clear it, through the kernel
            CLI.
          </p>
        </Callout>
      ) : null}
      {budgetTripped ? (
        <Callout tone="warning" title="Budget breaker tripped" role="alert">
          <KeyValueList data={data.budget.detail} emptyMessage="The breaker recorded no detail with this trip." />
        </Callout>
      ) : null}

      <Card title="Runtime state" subtitle="runtime-profile.json · ARIA_STOP · budget/breaker_state.json">
        <div className="stat-grid">
          <Stat
            label="Profile"
            value={
              <Badge tone={toneForProfile(data.profile.current)} title={glossForProfile(data.profile.current)}>
                {data.profile.current ?? EMPTY}
              </Badge>
            }
            hint={
              data.profile.setBy === null ? (
                'Source not recorded'
              ) : (
                <>
                  Set by <span className="mono">{data.profile.setBy}</span> <Timestamp value={data.profile.setAt} />
                </>
              )
            }
            compact
          />
          <Stat
            label="Scheduler ceiling"
            value={
              <Badge tone={toneForProfile(data.profile.schedulerCeiling)} title={glossForProfile(data.profile.schedulerCeiling)}>
                {data.profile.schedulerCeiling ?? EMPTY}
              </Badge>
            }
            hint="The strongest profile the scheduler may select"
            compact
          />
          <Stat
            label="Kill switch"
            value={<Badge tone={killSwitchEngaged ? 'danger' : 'success'}>{killSwitchEngaged ? 'engaged' : 'clear'}</Badge>}
            hint={killSwitchEngaged ? 'No new cycle starts while this is engaged' : 'The kernel may start a cycle'}
            tone={killSwitchEngaged ? 'danger' : 'default'}
            compact
          />
          <Stat
            label="Budget breaker"
            value={<Badge tone={budgetTripped ? 'danger' : 'success'}>{budgetTripped ? 'tripped' : 'clear'}</Badge>}
            hint={budgetTripped ? 'Spend passed its ceiling' : 'Spend is under its ceiling'}
            tone={budgetTripped ? 'warning' : 'default'}
            compact
          />
        </div>
      </Card>

      <Card title="Ledger totals" subtitle="Rows appended across the kernel ledgers">
        <div className="stat-grid">
          <Stat label="Cycles" value={formatNumber(data.counts.cycles)} hint={<Link to={ROUTES.cycles}>Cycles</Link>} />
          <Stat label="Raw findings" value={formatNumber(data.counts.rawFindings)} hint={<Link to={ROUTES.findings}>Findings</Link>} />
          <Stat label="Beliefs" value={formatNumber(data.counts.beliefs)} hint={<Link to={ROUTES.beliefs}>Beliefs</Link>} />
          <Stat label="Pressures" value={formatNumber(data.counts.pressures)} hint={<Link to={ROUTES.pressures}>Pressures</Link>} />
          <Stat
            label="Human required (open)"
            value={formatNumber(data.counts.humanRequiredOpen)}
            tone={data.counts.humanRequiredOpen > 0 ? 'warning' : 'default'}
            hint={<Link to={ROUTES.humanRequired}>Human required</Link>}
          />
          <Stat label="Agent requests" value={formatNumber(data.counts.agentRequests)} hint={<Link to={ROUTES.agents}>Agents</Link>} />
          <Stat label="Governance rows" value={formatNumber(data.counts.governanceRows)} hint={<Link to={ROUTES.governance}>Governance</Link>} />
        </div>
      </Card>

      <div className="grid-2">
        <Card title="Last cycle" subtitle="cycles.jsonl">
          {data.lastCycle === null ? (
            <EmptyBlock
              flush
              title="No cycles yet"
              message="The most recent cycle appears here once the kernel completes one; cycles.jsonl has no rows."
            />
          ) : (
            <div className="stack">
              <div className="row">
                <Link to={ROUTES.cycle(data.lastCycle.cycleId)} className="mono">
                  {data.lastCycle.cycleId}
                </Link>
                <Badge tone={toneForStatus(data.lastCycle.status)}>{data.lastCycle.status}</Badge>
              </div>
              {/* WHAT: the same five facts the cycle detail page opens with, so the
                  operator can judge the last run without leaving the overview. */}
              <div className="stat-grid">
                <Stat label="Started" value={<Timestamp value={data.lastCycle.startedAt} />} compact />
                <Stat label="Ended" value={<Timestamp value={data.lastCycle.endedAt} />} compact />
                <Stat label="Duration" value={formatDuration(data.lastCycle.durationSeconds)} />
                <Stat
                  label="git HEAD"
                  value={<span className="mono">{shortHash(data.lastCycle.gitHeadSha)}</span>}
                  hint={<span className="mono">{textOrEmpty(data.lastCycle.gitHeadSha)}</span>}
                  compact
                />
                <Stat label="Tool decisions" value={formatNumber(data.lastCycle.toolDecisionCount)} />
              </div>
            </div>
          )}
        </Card>

        <Card title="Circuit breakers" subtitle="One row per breaker the kernel evaluates" flush>
          <DataTable
            columns={BREAKER_COLUMNS}
            rows={data.breakers}
            rowKey={(row) => row.name}
            caption="Circuit breakers and their current state"
            emptyTitle="No breakers recorded"
            emptyMessage="A breaker appears here after the kernel first evaluates it; none has been evaluated."
            rowClassName={(row) => (toneForStatus(row.state) === 'danger' ? 'row-danger' : undefined)}
            initialSort={{ columnId: 'name', direction: 'asc' }}
            countNoun="breakers"
            dense
          />
        </Card>

        <Card title="Gateway" subtitle="gateway/heartbeat.json · gateway/inbox.jsonl">
          {data.gateway === null ? (
            <EmptyBlock
              flush
              title="No gateway heartbeat"
              message="The heartbeat and inbox depth appear here once the gateway writes gateway/heartbeat.json; the file is absent."
            />
          ) : (
            <div className="stat-grid">
              <Stat label="Heartbeat" value={<Timestamp value={data.gateway.heartbeatAt} />} hint={<span className="mono">{textOrEmpty(data.gateway.heartbeatAt)}</span>} compact />
              <Stat
                label="Inbox pending"
                value={formatNumber(data.gateway.inboxPending)}
                hint="Messages waiting for the kernel to read them"
                tone={data.gateway.inboxPending > 0 ? 'warning' : 'default'}
              />
            </div>
          )}
        </Card>

        <Card title="Budget" subtitle="budget/breaker_state.json">
          <KeyValueList data={data.budget.detail} emptyMessage="Spend detail appears here once the budget breaker records a measurement." />
        </Card>

        <Card title="Sources" subtitle="Paths this view was read from">
          {/* WHY: the keys are the API's own field names, so they stay verbatim and
              monospace — the operator matches them against the kernel config. */}
          <KeyValueList data={{ toolsDir: data.toolsDir, workspaceRoot: data.workspaceRoot, generatedAt: data.generatedAt }} />
        </Card>
      </div>
    </div>
  );
}

export function OverviewPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getOverview(signal), []);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          state.status === 'success' ? (
            <>
              Generated <Timestamp value={state.data.generatedAt} />
            </>
          ) : (
            'Live state of the ARIA kernel'
          )
        }
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the overview">
        {(data) => <OverviewContent data={data} />}
      </AsyncState>
    </>
  );
}
