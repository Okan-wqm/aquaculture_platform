// Timeline tab: when an event is said to have happened, and when that became known.
//
// WHY: collapsing Occurred and Learned into one date destroys the question a
// legal reader actually asks — was this known at the time? So the two are
// separate columns and are never merged, and datePrecision stays beside Occurred
// because a value such as `2026-03` is a month, not the first of March.
// WHAT: one dense row per timeline event with its asserting source, confidence,
// evidence anchors and human-review marker.
import type { ReactNode } from 'react';
import type { LegalTimelineEvent } from '../../../../shared/legal-contract.ts';
import { getLegalTimeline } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { AssertedByBadge, ConfidenceMeter, EvidenceRefList, LegalDate, PrecisionBadge, ReviewMarker } from './legal-badges.tsx';

const COLUMNS: ReadonlyArray<ColumnDef<LegalTimelineEvent>> = [
  {
    id: 'kind',
    header: 'Kind',
    headerTitle: 'kind — the record vocabulary term the adapter assigned',
    render: (row) => (
      <Badge tone="neutral" mono>
        {row.kind}
      </Badge>
    ),
    sortValue: (row) => row.kind,
    nowrap: true,
  },
  {
    id: 'occurredAt',
    header: 'Occurred',
    headerTitle: 'occurredAt — the date the event is said to have taken place',
    render: (row) => <LegalDate value={row.occurredAt} />,
    sortValue: (row) => row.occurredAt,
    nowrap: true,
  },
  {
    id: 'precision',
    header: 'Precision',
    headerTitle: 'datePrecision — how precisely the occurred date is known',
    render: (row) => <PrecisionBadge precision={row.datePrecision} />,
    sortValue: (row) => row.datePrecision,
    nowrap: true,
  },
  {
    id: 'learnedAt',
    header: 'Learned',
    headerTitle: 'learnedAt — the date this event became known in the archive',
    render: (row) => <LegalDate value={row.learnedAt} />,
    sortValue: (row) => row.learnedAt,
    nowrap: true,
  },
  {
    id: 'summary',
    header: 'Summary',
    headerTitle: 'summary — the adapter’s wording of the event, not a finding',
    render: (row) => <span className="statement-text">{row.summary}</span>,
    sortValue: (row) => row.summary,
  },
  {
    id: 'assertedBy',
    header: 'Asserted by',
    headerTitle: 'assertedBy — who put this event into the record',
    render: (row) => <AssertedByBadge source={row.assertedBy} />,
    sortValue: (row) => row.assertedBy,
    nowrap: true,
  },
  {
    id: 'confidence',
    header: 'Confidence',
    headerTitle: 'confidence — how strongly the adapter holds this reading',
    render: (row) => <ConfidenceMeter value={row.confidence} />,
    sortValue: (row) => row.confidence,
    nowrap: true,
  },
  {
    id: 'evidence',
    header: 'Evidence',
    headerTitle: 'evidence — the documents this event is anchored to',
    render: (row) => <EvidenceRefList refs={row.evidence} />,
    sortValue: (row) => row.evidence.length,
  },
  {
    id: 'review',
    header: 'Human review',
    headerTitle: 'humanReviewRequired — whether this event still needs a human reviewer',
    render: (row) => <ReviewMarker required={row.humanReviewRequired} />,
    sortValue: (row) => (row.humanReviewRequired ? 0 : 1),
    nowrap: true,
  },
];

export function TimelineTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalTimeline(caseId, signal), [caseId]);
  return (
    <div className="stack">
      <Callout tone="neutral" title="Two dates, never one">
        <strong>Occurred</strong> is the date the event is said to have taken place; <strong>Learned</strong> is the date it entered this archive. They may
        differ, and that difference is often the point. <strong>Precision</strong> says whether the occurred date is known to the day, the month or only the
        year.
      </Callout>
      <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load the timeline of this case">
        {(data) => (
          <Card title="Timeline" subtitle={`${formatNumber(data.events.length)} recorded in timeline.json`} flush>
            <DataTable
              columns={COLUMNS}
              rows={data.events}
              rowKey={(row) => row.eventId}
              caption="Timeline of this case"
              countNoun="events"
              emptyTitle="No timeline events yet"
              emptyMessage="An event appears here once the adapter reads a dated occurrence out of a document; this case recorded none."
              filter={{
                placeholder: 'Search summary, kind or asserting source…',
                predicate: (row, query) => `${row.summary} ${row.kind} ${row.assertedBy}`.toLowerCase().includes(query),
              }}
              initialSort={{ columnId: 'occurredAt', direction: 'asc' }}
              rowClassName={(row) => (row.humanReviewRequired ? 'row-warning' : undefined)}
              maxHeight="70vh"
            />
          </Card>
        )}
      </AsyncState>
    </div>
  );
}
