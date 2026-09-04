// The triage queue: every decision the kernel refused to take alone.
//
// WHY: this is the one screen where the console asks the operator to act, so
// the ordering is a triage ordering — the deadline that has already passed
// leads, and a breached SLA is unmistakable at three levels (a danger stat, a
// danger callout, a tinted row) because missing one is the failure mode.
// WHAT: a read-only master/detail over GET /api/v1/human-required. Severities
// are kernel values and render verbatim; the decision itself is written to the
// adjudications ledger by the kernel CLI, never by this console.
import { useState, type ReactNode } from 'react';
import type { HumanRequiredItem } from '../../../../shared/api-contract.ts';
import { getHumanRequired } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EmptyState } from '../../design/EmptyState.tsx';
import { Icon } from '../../design/Icon.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { StatusDot } from '../../design/StatusDot.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatNumber } from '../../design/format.ts';
import { toneForSeverity } from './tones.ts';

/**
 * The queue state of one item, in the kernel's own words.
 *
 * WHY: `resolved` is a boolean on the wire but reads as a state on screen, and
 * the two words the ledger uses for it are `open` and `resolved` — the console
 * shows those, it does not invent a third vocabulary.
 */
function queueState(item: HumanRequiredItem): 'open' | 'resolved' {
  return item.resolved ? 'resolved' : 'open';
}

const COLUMNS: ReadonlyArray<ColumnDef<HumanRequiredItem>> = [
  {
    id: 'severity',
    header: 'Severity',
    headerTitle: 'severity — how the kernel classified the decision it escalated',
    render: (row) => <Badge tone={toneForSeverity(row.severity)}>{row.severity}</Badge>,
    sortValue: (row) => row.severity,
    filterValue: (row) => row.severity,
    nowrap: true,
    width: '14ch',
  },
  {
    id: 'sla',
    header: 'SLA deadline',
    headerTitle: 'sla_deadline — the moment by which an operator decision was due',
    render: (row) => (
      <span className="row">
        <Timestamp value={row.slaDeadline} />
        {row.slaBreached && !row.resolved ? <Badge tone="danger" title="The SLA deadline passed before a decision was recorded">breached</Badge> : null}
      </span>
    ),
    sortValue: (row) => row.slaDeadline,
    nowrap: true,
  },
  {
    id: 'reason',
    header: 'Reason',
    headerTitle: 'reason — why the kernel could not decide this alone',
    render: (row) => row.reason,
    sortValue: (row) => row.reason,
    filterValue: (row) => row.reason,
  },
  {
    id: 'requestId',
    header: 'Request',
    headerTitle: 'request_id — the key this item carries in adjudications.jsonl',
    render: (row) => row.requestId,
    sortValue: (row) => row.requestId,
    filterValue: (row) => row.requestId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'recordedAt',
    header: 'Recorded',
    headerTitle: 'recorded_at — when the kernel escalated the decision',
    render: (row) => <Timestamp value={row.recordedAt} />,
    sortValue: (row) => row.recordedAt,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'state',
    header: 'Status',
    render: (row) => <StatusDot tone={row.resolved ? 'success' : 'warning'}>{queueState(row)}</StatusDot>,
    sortValue: (row) => (row.resolved ? 1 : 0),
    filterValue: (row) => queueState(row),
    nowrap: true,
    width: '12ch',
  },
];

export interface HumanRequiredDetailProps {
  readonly item: HumanRequiredItem | null;
}

/**
 * The context the kernel attached to one escalated decision.
 *
 * WHY: the reason line is a summary; the operator decides on the context — the
 * cycle, the pressure, the proof the kernel could not settle — so the raw
 * record renders key by key rather than as a sentence someone rewrote.
 */
export function HumanRequiredDetail({ item }: HumanRequiredDetailProps): ReactNode {
  if (item === null) {
    return (
      <Card title="Details">
        <EmptyState
          title="No item selected"
          message="Select a row to read the reason, the SLA deadline and the context the kernel recorded with it."
          flush
        />
      </Card>
    );
  }
  return (
    <Card
      title="Details"
      subtitle={item.reason}
      tone={item.slaBreached && !item.resolved ? 'danger' : 'default'}
      actions={<CopyButton value={item.requestId} label="Copy request_id" />}
    >
      <div className="stack stack--tight">
        <div className="row">
          <Badge tone={toneForSeverity(item.severity)}>{item.severity}</Badge>
          <StatusDot tone={item.resolved ? 'success' : 'warning'}>{queueState(item)}</StatusDot>
          {item.slaBreached && !item.resolved ? <Badge tone="danger">breached</Badge> : null}
        </div>
        <KeyValueList
          data={{
            request_id: item.requestId,
            recorded_at: item.recordedAt,
            sla_deadline: item.slaDeadline,
            ...item.context,
          }}
          emptyMessage="The kernel recorded no context fields with this item."
          expandObjects
        />
      </div>
    </Card>
  );
}

export function HumanRequiredPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getHumanRequired(signal), []);
  const [showResolved, setShowResolved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Human required"
        subtitle="human-required/ · adjudications.jsonl"
        actions={
          <>
            <label className="field field--inline" htmlFor="hr-show-resolved">
              <input id="hr-show-resolved" type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />
              <span>Include resolved</span>
            </label>
            <button type="button" className="button" onClick={reload}>
              <Icon name="refresh" />
              Refresh
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the human-required queue">
        {(data) => {
          const rows = showResolved ? data.items : data.items.filter((item) => !item.resolved);
          const breached = data.items.filter((item) => !item.resolved && item.slaBreached).length;
          const resolved = data.items.filter((item) => item.resolved).length;
          const selected = data.items.find((item) => item.requestId === selectedId) ?? null;
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat label="Open" value={formatNumber(data.open)} hint="Awaiting an operator decision" tone={data.open > 0 ? 'warning' : 'default'} />
                <Stat label="SLA breached" value={formatNumber(breached)} hint="Open past the deadline" tone={breached > 0 ? 'danger' : 'default'} />
                <Stat label="Resolved" value={formatNumber(resolved)} hint="Decision recorded in the ledger" />
                <Stat label="Total" value={formatNumber(data.items.length)} hint="Items in the queue ledger" />
              </div>
              {breached > 0 ? (
                <Callout tone="danger" title="Open items are past their SLA deadline" role="alert">
                  {formatNumber(breached)} open {breached === 1 ? 'item is' : 'items are'} past the deadline the kernel set for an operator decision. A decision is
                  written to the adjudications ledger by the kernel CLI; this console shows the queue and does not record the verdict.
                </Callout>
              ) : null}
              <div className="split">
                <Card flush>
                  <DataTable
                    columns={COLUMNS}
                    rows={rows}
                    rowKey={(row) => row.requestId}
                    caption="Decisions the kernel escalated to an operator, most overdue first"
                    emptyTitle={showResolved ? 'No items yet' : 'Nothing awaiting a decision'}
                    emptyMessage={
                      showResolved
                        ? 'Every decision the kernel escalates to an operator is listed here; the queue ledger has no rows.'
                        : 'Open items awaiting an operator decision would be listed here; every recorded item has been resolved. Include resolved to see them.'
                    }
                    filter={{
                      placeholder: 'Search reason, request_id or severity…',
                      predicate: (row, query) => `${row.requestId} ${row.reason} ${row.severity}`.toLowerCase().includes(query),
                    }}
                    initialSort={{ columnId: 'sla', direction: 'asc' }}
                    onRowActivate={(row) => setSelectedId(row.requestId)}
                    selectedKey={selected?.requestId}
                    // WHY: only two row states earn a tint — a resolved item is
                    // history (muted) and a breached open item is the emergency
                    // (danger). Tinting ordinary open rows as well would spend
                    // the colour on the majority and hide the breach.
                    rowClassName={(row) => (row.resolved ? 'row-muted' : row.slaBreached ? 'row-danger' : undefined)}
                    maxHeight="62vh"
                    countNoun="items"
                    dense
                  />
                </Card>
                <div className="detail-panel">
                  <HumanRequiredDetail item={selected} />
                </div>
              </div>
            </div>
          );
        }}
      </AsyncState>
    </>
  );
}
