// The tool registry, read against the run history that should back it up.
//
// WHY: the registry states what a tool is allowed to do; runs.jsonl states what
// it actually did. The interesting rows are the ones where those two disagree —
// an ACTIVE tool that has never run, or a tool whose last run failed — so the
// page counts that disagreement above the table instead of leaving the operator
// to spot it row by row. WHAT: a read-only table over GET /api/v1/tools.
// Lifecycle statuses (DRAFT, SANDBOX, SHADOW, ACTIVE, CALIBRATE, QUARANTINED,
// ARCHIVED) and run statuses are kernel values and render verbatim.
import type { ReactNode } from 'react';
import type { ToolView } from '../../../../shared/api-contract.ts';
import { getTools } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { toneForStatus } from './tones.ts';

/** The registry status that grants a tool the right to run unattended. */
const ACTIVE = 'ACTIVE';

const COLUMNS: ReadonlyArray<ColumnDef<ToolView>> = [
  {
    id: 'status',
    header: 'Status',
    headerTitle: 'status — the lifecycle stage the registry records for this tool',
    render: (row) => <Badge tone={toneForStatus(row.status)} mono>{row.status}</Badge>,
    sortValue: (row) => row.status,
    filterValue: (row) => row.status,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'toolId',
    header: 'Tool',
    headerTitle: 'tool_id — the key the tool carries in registry.json and runs.jsonl',
    render: (row) => row.toolId,
    sortValue: (row) => row.toolId,
    filterValue: (row) => row.toolId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'kind',
    header: 'Kind',
    headerTitle: 'kind — what class of work the tool performs',
    render: (row) => textOrEmpty(row.kind),
    sortValue: (row) => row.kind,
    filterValue: (row) => row.kind ?? '',
    nowrap: true,
  },
  {
    id: 'version',
    header: 'Version',
    headerTitle: 'version — the registered revision of the tool',
    render: (row) => textOrEmpty(row.version),
    sortValue: (row) => row.version,
    filterValue: (row) => row.version ?? '',
    mono: true,
    nowrap: true,
  },
  {
    id: 'scope',
    header: 'Declared scope',
    headerTitle: 'declared_scope — the paths and capabilities the tool declared it needs',
    render: (row) =>
      row.declaredScope.length === 0 ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <ul className="chip-list">
          {row.declaredScope.map((scope) => (
            <li key={scope} className="chip mono" title={scope}>
              {scope}
            </li>
          ))}
        </ul>
      ),
    filterValue: (row) => row.declaredScope.join(' '),
  },
  {
    id: 'runCount',
    header: 'Runs',
    headerTitle: 'run_count — how many runs this tool has in runs.jsonl',
    render: (row) => formatNumber(row.runCount),
    sortValue: (row) => row.runCount,
    align: 'end',
    nowrap: true,
    width: '9ch',
  },
  {
    id: 'lastRunAt',
    header: 'Last run',
    headerTitle: 'last_run_at — when the tool last ran',
    render: (row) => <Timestamp value={row.lastRunAt} />,
    sortValue: (row) => row.lastRunAt,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'lastRunStatus',
    header: 'Last run status',
    headerTitle: 'last_run_status — how that run ended',
    render: (row) => (row.lastRunStatus === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.lastRunStatus)}>{row.lastRunStatus}</Badge>),
    sortValue: (row) => row.lastRunStatus,
    filterValue: (row) => row.lastRunStatus ?? '',
    nowrap: true,
  },
];

/**
 * Counts the registry statuses present in the response.
 *
 * WHY: the tools endpoint returns rows, not a distribution, and the operator's
 * first question of a registry is how the population is spread across the
 * lifecycle. WHAT: keys are kernel status words and stay verbatim.
 */
function countByStatus(tools: ReadonlyArray<ToolView>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tool of tools) {
    counts[tool.status] = (counts[tool.status] ?? 0) + 1;
  }
  return counts;
}

export function ToolsPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getTools(signal), []);
  return (
    <>
      <PageHeader
        title="Tools"
        subtitle="registry.json + runs.jsonl"
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the tool registry">
        {(data) => {
          const neverRun = data.tools.filter((tool) => tool.runCount === 0);
          const activeNeverRun = neverRun.filter((tool) => tool.status === ACTIVE);
          const lastRunFailed = data.tools.filter((tool) => toneForStatus(tool.lastRunStatus) === 'danger');
          const totalRuns = data.tools.reduce((sum, tool) => sum + tool.runCount, 0);
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat label="Registered tools" value={formatNumber(data.tools.length)} hint="Rows in registry.json" />
                <Stat label="Recorded runs" value={formatNumber(totalRuns)} hint="Summed across runs.jsonl" />
                <Stat
                  label="Never run"
                  value={formatNumber(neverRun.length)}
                  hint="Registered with no run history"
                  tone={activeNeverRun.length > 0 ? 'warning' : 'default'}
                />
                <Stat
                  label="Last run failed"
                  value={formatNumber(lastRunFailed.length)}
                  hint="Most recent run did not succeed"
                  tone={lastRunFailed.length > 0 ? 'danger' : 'default'}
                />
              </div>
              {activeNeverRun.length > 0 ? (
                <Callout tone="warning" title="The registry and the run history disagree">
                  {formatNumber(activeNeverRun.length)} {activeNeverRun.length === 1 ? 'tool carries' : 'tools carry'} status {ACTIVE} in registry.json and{' '}
                  {activeNeverRun.length === 1 ? 'has' : 'have'} no run in runs.jsonl: {activeNeverRun.map((tool) => tool.toolId).join(', ')}. Either the tool is
                  never selected during a cycle, or its runs are not reaching the ledger.
                </Callout>
              ) : null}
              <Card title="Lifecycle" subtitle="Every registered tool, counted by the status the registry records for it.">
                <ByCountStats
                  counts={countByStatus(data.tools)}
                  kind="status"
                  emptyTitle="No statuses to count"
                  emptyMessage="Each lifecycle status in the registry would be counted here; the registry holds no tools."
                />
              </Card>
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.tools}
                  rowKey={(row) => row.toolId}
                  caption="Registered tools and their run history"
                  emptyTitle="No tools registered"
                  emptyMessage="Every tool the kernel may select during a cycle is registered here; registry.json holds no entries."
                  filter={{
                    placeholder: 'Search tool_id, kind, status or scope…',
                    predicate: (row, query) =>
                      `${row.toolId} ${row.kind ?? ''} ${row.status} ${row.declaredScope.join(' ')}`.toLowerCase().includes(query),
                  }}
                  filterRow
                  initialSort={{ columnId: 'toolId', direction: 'asc' }}
                  // WHY: a quarantined tool or a failed last run is a registry
                  // entry the operator must act on; a tool with no run history
                  // is inert rather than broken, so it recedes instead.
                  rowClassName={(row) =>
                    toneForStatus(row.status) === 'danger' || toneForStatus(row.lastRunStatus) === 'danger'
                      ? 'row-danger'
                      : row.runCount === 0
                        ? 'row-muted'
                        : undefined
                  }
                  maxHeight="62vh"
                  countNoun="tools"
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
