import type { ReactNode } from 'react';
import type { LegalParty } from '../../../../shared/legal-contract.ts';
import { getLegalParties } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EMPTY, formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ConfidenceMeter, EvidenceRefList, ReviewMarker } from './legal-badges.tsx';

function Chips({ values }: { readonly values: ReadonlyArray<string> }): ReactNode {
  if (values.length === 0) {
    return <span className="muted">{EMPTY}</span>;
  }
  return (
    <ul className="chip-list">
      {values.map((value) => (
        <li key={value} className="chip" title={value}>
          {value}
        </li>
      ))}
    </ul>
  );
}

const COLUMNS: ReadonlyArray<ColumnDef<LegalParty>> = [
  { id: 'name', header: 'displayName', render: (row) => <strong>{row.displayName}</strong>, sortValue: (row) => row.displayName },
  { id: 'kind', header: 'kind', render: (row) => <Badge tone={row.kind === 'unknown' ? 'muted' : 'neutral'}>{row.kind}</Badge>, sortValue: (row) => row.kind, nowrap: true },
  { id: 'roles', header: 'roles', render: (row) => <Chips values={row.roles} /> },
  { id: 'aliases', header: 'aliases', render: (row) => <Chips values={row.aliases} /> },
  { id: 'mentions', header: 'Anılma', render: (row) => formatNumber(row.mentions), sortValue: (row) => row.mentions, align: 'end' },
  { id: 'identity', header: 'identityConfidence', render: (row) => <ConfidenceMeter value={row.identityConfidence} />, sortValue: (row) => row.identityConfidence, nowrap: true },
  { id: 'evidence', header: 'Kanıt', render: (row) => <EvidenceRefList refs={row.evidence} /> },
  { id: 'review', header: 'İnsan doğrulaması', render: (row) => <ReviewMarker required={row.humanReviewRequired} />, sortValue: (row) => (row.humanReviewRequired ? 0 : 1), nowrap: true },
];

export function PartiesTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalParties(caseId, signal), [caseId]);
  return (
    <AsyncState state={state} onRetry={reload}>
      {(data) => (
        <Card title={`Taraflar (${formatNumber(data.parties.length)})`} subtitle="Kimlik birleştirme mekaniktir; düşük identityConfidence insan doğrulaması ister" flush>
          <DataTable
            columns={COLUMNS}
            rows={data.parties}
            rowKey={(row) => row.partyId}
            caption="Dava tarafları"
            emptyMessage="Taraf kaydı yok."
            filter={{ placeholder: 'ad / rol / takma ad ara…', predicate: (row, query) => `${row.displayName} ${row.roles.join(' ')} ${row.aliases.join(' ')} ${row.kind}`.toLocaleLowerCase('tr').includes(query) }}
            initialSort={{ columnId: 'mentions', direction: 'desc' }}
            rowClassName={(row) => (row.humanReviewRequired ? 'row-warning' : undefined)}
          />
        </Card>
      )}
    </AsyncState>
  );
}
