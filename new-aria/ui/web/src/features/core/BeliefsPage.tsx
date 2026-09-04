import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { BeliefView } from '../../../../shared/api-contract.ts';
import { getBeliefs } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, formatPercent, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { EvidenceRefs } from './EvidenceRefs.tsx';
import { toneForStatus } from './tones.ts';

/** Kernel belief statuses; the values are sent to the server verbatim. */
const STATUSES = ['supported', 'contradicted', 'needs_revalidation', 'stale', 'withdrawn'] as const;

/**
 * Row tint for a belief.
 *
 * WHY: a contradicted belief invalidates whatever was built on it, and a stale
 * one is a claim nobody has rechecked — both are states worth spotting while
 * scrolling, so they earn a row tint rather than only a badge.
 */
function rowClassForBelief(status: string): string | undefined {
  if (status === 'contradicted' || status === 'withdrawn') {
    return 'row-danger';
  }
  return status === 'needs_revalidation' || status === 'stale' ? 'row-warning' : undefined;
}

const COLUMNS: ReadonlyArray<ColumnDef<BeliefView>> = [
  {
    id: 'id',
    header: 'Belief',
    headerTitle: 'belief_id — the kernel identifier of the belief',
    render: (row) => row.beliefId,
    sortValue: (row) => row.beliefId,
    mono: true,
    nowrap: true,
  },
  { id: 'statement', header: 'Statement', render: (row) => textOrEmpty(row.statement) },
  {
    id: 'status',
    header: 'Status',
    headerTitle: 'status — the kernel verdict on the belief',
    render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge>,
    sortValue: (row) => row.status,
    nowrap: true,
    width: '20ch',
  },
  {
    id: 'confidence',
    header: 'Confidence',
    headerTitle: 'confidence — how strongly the evidence carries the belief',
    render: (row) => formatPercent(row.confidence),
    sortValue: (row) => row.confidence,
    align: 'end',
    width: '12ch',
  },
  { id: 'evidence', header: 'Evidence', headerTitle: 'evidence_refs — pointers that make the belief checkable', render: (row) => <EvidenceRefs refs={row.evidenceRefs} /> },
  {
    id: 'verifiedAt',
    header: 'Verified',
    headerTitle: 'verified_at — when the belief was last rechecked',
    render: (row) => <Timestamp value={row.verifiedAt} />,
    sortValue: (row) => row.verifiedAt,
    nowrap: true,
    width: '16ch',
  },
  {
    id: 'cycle',
    header: 'Cycle',
    headerTitle: 'cycle_id — the cycle that last touched the belief',
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
];

export function BeliefsPage(): ReactNode {
  const [status, setStatus] = useState('');
  const { state, reload } = useRequest((signal) => getBeliefs({ status: status === '' ? undefined : status, limit: 500 }, signal), [status]);
  return (
    <>
      <PageHeader
        title="Beliefs"
        subtitle={<span className="mono">memory/beliefs.jsonl</span>}
        actions={
          <>
            <label className="field field--inline" htmlFor="beliefs-status">
              <span>Status</span>
              <select id="beliefs-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All</option>
                {STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={reload}>
              Refresh
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load beliefs">
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat
                label="Contradictions"
                value={formatNumber(data.contradictions)}
                tone={data.contradictions > 0 ? 'warning' : 'default'}
                hint="Beliefs the evidence now argues against"
              />
              <Stat label="Uncertainties" value={formatNumber(data.uncertainties)} hint="Open questions the kernel has not resolved" />
              <Stat label="Beliefs shown" value={formatNumber(data.beliefs.length)} hint="Rows returned for the selected status" />
            </div>
            <Card title="Status" subtitle="Counted across every belief the server matched.">
              <ByCountStats
                counts={data.byStatus}
                kind="status"
                emptyTitle="No statuses to count"
                emptyMessage="Each belief status the kernel recorded would be counted here; no belief matched this filter."
              />
            </Card>
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.beliefs}
                rowKey={(row) => row.beliefId}
                caption="Beliefs"
                emptyTitle={status === '' ? 'No beliefs yet' : `No belief is ${status}`}
                emptyMessage={
                  status === ''
                    ? 'Every claim the kernel holds about this repository, with the evidence behind it, is listed here; none has been recorded yet.'
                    : 'Beliefs with the selected status would be listed here; the server matched none. Choose All to see every belief.'
                }
                filter={{
                  placeholder: 'Search statement or belief id…',
                  predicate: (row, query) => `${row.beliefId} ${row.statement ?? ''} ${row.status}`.toLowerCase().includes(query),
                }}
                rowClassName={(row) => rowClassForBelief(row.status)}
                initialSort={{ columnId: 'verifiedAt', direction: 'desc' }}
                maxHeight="62vh"
                countNoun="beliefs"
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
