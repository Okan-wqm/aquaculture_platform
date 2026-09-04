// Parties tab: who the adapter believes appears in this archive.
//
// WHY: identity resolution is the easiest place for a machine to invent a fact —
// two spellings merged into one person, or one person split into two. So every
// row carries the confidence behind the merge and the documents the identity was
// read from, and a low-confidence identity is marked for human review rather
// than presented as settled.
// WHAT: one row per party with its kind, roles, aliases, mention count, identity
// confidence, evidence anchors and review marker.
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

/** Roles and aliases are free-form kernel strings, so they render verbatim as chips. */
function Chips({ values, emptyTitle }: { readonly values: ReadonlyArray<string>; readonly emptyTitle: string }): ReactNode {
  if (values.length === 0) {
    return (
      <span className="muted" title={emptyTitle}>
        {EMPTY}
      </span>
    );
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
  {
    id: 'name',
    header: 'Party',
    headerTitle: 'displayName — the spelling the adapter chose for this identity',
    render: (row) => (
      <span title={`partyId ${row.partyId}`}>
        <strong>{row.displayName}</strong>
      </span>
    ),
    sortValue: (row) => row.displayName,
    filterValue: (row) => `${row.displayName} ${row.partyId}`,
  },
  {
    id: 'kind',
    header: 'Kind',
    headerTitle: 'kind — person, organization, court, authority or unknown',
    render: (row) => <Badge tone={row.kind === 'unknown' ? 'muted' : 'neutral'}>{row.kind}</Badge>,
    sortValue: (row) => row.kind,
    filterValue: (row) => row.kind,
    nowrap: true,
  },
  {
    id: 'roles',
    header: 'Roles',
    headerTitle: 'roles — the parts this party plays in the case',
    render: (row) => <Chips values={row.roles} emptyTitle="No role recorded for this party" />,
    sortValue: (row) => row.roles.length,
    filterValue: (row) => row.roles.join(' '),
  },
  {
    id: 'aliases',
    header: 'Aliases',
    headerTitle: 'aliases — other spellings merged into this identity',
    render: (row) => <Chips values={row.aliases} emptyTitle="No alternative spelling was merged into this identity" />,
    sortValue: (row) => row.aliases.length,
    filterValue: (row) => row.aliases.join(' '),
  },
  {
    id: 'mentions',
    header: 'Mentions',
    headerTitle: 'mentions — how many times this party was read out of the archive',
    render: (row) => formatNumber(row.mentions),
    sortValue: (row) => row.mentions,
    align: 'end',
    width: '11ch',
  },
  {
    id: 'identity',
    header: 'Identity confidence',
    headerTitle: 'identityConfidence — how strongly the adapter holds this merge',
    render: (row) => <ConfidenceMeter value={row.identityConfidence} />,
    sortValue: (row) => row.identityConfidence,
    nowrap: true,
  },
  {
    id: 'evidence',
    header: 'Evidence',
    headerTitle: 'evidence — the documents this identity was read from',
    render: (row) => <EvidenceRefList refs={row.evidence} />,
    sortValue: (row) => row.evidence.length,
  },
  {
    id: 'review',
    header: 'Human review',
    headerTitle: 'humanReviewRequired — whether this identity still needs a human reviewer',
    render: (row) => <ReviewMarker required={row.humanReviewRequired} />,
    sortValue: (row) => (row.humanReviewRequired ? 0 : 1),
    nowrap: true,
  },
];

export function PartiesTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalParties(caseId, signal), [caseId]);
  return (
    <AsyncState state={state} onRetry={reload} skeleton="table" errorTitle="Could not load the parties of this case">
      {(data) => (
        <Card
          title="Parties"
          subtitle="Identity resolution is mechanical; a low identity confidence is a merge a human still has to confirm"
          flush
        >
          <DataTable
            columns={COLUMNS}
            rows={data.parties}
            rowKey={(row) => row.partyId}
            caption="Parties in this case"
            countNoun="parties"
            emptyTitle="No parties yet"
            emptyMessage="A party appears here once the adapter reads a name out of a document and resolves it to an identity; this case recorded none."
            filter={{
              placeholder: 'Search name, role, alias or kind…',
              predicate: (row, query) => `${row.displayName} ${row.roles.join(' ')} ${row.aliases.join(' ')} ${row.kind}`.toLowerCase().includes(query),
            }}
            filterRow
            initialSort={{ columnId: 'mentions', direction: 'desc' }}
            rowClassName={(row) => (row.humanReviewRequired ? 'row-warning' : undefined)}
            maxHeight="70vh"
          />
        </Card>
      )}
    </AsyncState>
  );
}
