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
  { id: 'kind', header: 'kind', render: (row) => <Badge tone="neutral" mono>{row.kind}</Badge>, sortValue: (row) => row.kind, nowrap: true },
  { id: 'occurredAt', header: 'occurredAt (olay tarihi)', render: (row) => <LegalDate value={row.occurredAt} />, sortValue: (row) => row.occurredAt, nowrap: true },
  { id: 'precision', header: 'precision', render: (row) => <PrecisionBadge precision={row.datePrecision} />, sortValue: (row) => row.datePrecision, nowrap: true },
  { id: 'learnedAt', header: 'learnedAt (öğrenilme)', render: (row) => <LegalDate value={row.learnedAt} />, sortValue: (row) => row.learnedAt, nowrap: true },
  { id: 'summary', header: 'Özet', render: (row) => <span className="statement-text">{row.summary}</span> },
  { id: 'assertedBy', header: 'assertedBy', render: (row) => <AssertedByBadge source={row.assertedBy} />, sortValue: (row) => row.assertedBy, nowrap: true },
  { id: 'confidence', header: 'confidence', render: (row) => <ConfidenceMeter value={row.confidence} />, sortValue: (row) => row.confidence, nowrap: true },
  { id: 'evidence', header: 'Kanıt', render: (row) => <EvidenceRefList refs={row.evidence} /> },
  { id: 'review', header: 'İnsan doğrulaması', render: (row) => <ReviewMarker required={row.humanReviewRequired} />, sortValue: (row) => (row.humanReviewRequired ? 0 : 1), nowrap: true },
];

export function TimelineTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalTimeline(caseId, signal), [caseId]);
  return (
    <div className="stack">
      <Callout tone="neutral">
        <strong>occurredAt</strong> olayın gerçekleştiği (iddia edilen) tarih, <strong>learnedAt</strong> bu bilginin arşive girdiği tarihtir. İkisi farklı olabilir; <em>precision</em> tarihin gün/ay/yıl kesinliğini söyler.
      </Callout>
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <Card title={`Zaman çizelgesi (${formatNumber(data.events.length)})`} flush>
            <DataTable
              columns={COLUMNS}
              rows={data.events}
              rowKey={(row) => row.eventId}
              caption="Dava zaman çizelgesi"
              emptyMessage="Zaman çizelgesi olayı yok."
              filter={{ placeholder: 'özet / kind ara…', predicate: (row, query) => `${row.summary} ${row.kind} ${row.assertedBy}`.toLocaleLowerCase('tr').includes(query) }}
              initialSort={{ columnId: 'occurredAt', direction: 'asc' }}
              rowClassName={(row) => (row.humanReviewRequired ? 'row-warning' : undefined)}
            />
          </Card>
        )}
      </AsyncState>
    </div>
  );
}
