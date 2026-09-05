// Parties tab: who the adapter read out of this archive, and on what basis.
//
// WHY: identity resolution is the easiest place for a machine to invent a fact —
// two spellings merged into one person, or one person split into two. So every
// row carries the SHAPE the name was read from (an e-mail header, an
// organisation form, an organisation number, the "v/ advokat" construction, a
// labelled party line, a court naming itself), the organisation number as its
// own field, the roles a document assigned with the line it did so on, and the
// documents the identity was read from. MEASURED 2026-09-04: the basis was not
// shown at all, and the organisation number was rendered in a column titled
// "other spellings merged into this identity" — the one statement the adapter
// never makes. Nothing here is merged; a low identity confidence is a reading
// a human still has to confirm.
// WHAT: one row per party with kind, basis, organisation number, roles, other
// spellings and addresses, mention count, identity confidence, evidence and the
// review marker.
import type { ReactNode } from 'react';
import type { LegalParty, LegalPartyBasis } from '../../../../shared/legal-contract.ts';
import { getLegalParties } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EMPTY, formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ConfidenceMeter, EvidenceRefList, ReviewMarker } from './legal-badges.tsx';

/** What each basis means, in the words a reader needs to judge the reading. */
const BASIS_GLOSS: Readonly<Record<LegalPartyBasis, string>> = {
  header_address: 'Read from an e-mail From/To/Cc header: an address, and the display name beside it',
  organisation_form: 'Read from an organisation form in running text (AS, ASA, ANS, GmbH, …): a name, not a role',
  organisation_number: 'Read from an organisation number stated beside the name',
  counsel_construction: 'Read from the "v/ advokat" construction: counsel for the party named before it',
  party_label: 'Read from a labelled party line (Byggherre:, Saksøker:, …)',
  court_name: 'A court naming itself in the text',
};

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

/** The roles a document assigned, each chip carrying the line it was read on. */
function RoleChips({ row }: { readonly row: LegalParty }): ReactNode {
  if (row.roleEvidence.length === 0) {
    return (
      <span className="muted" title="No document labelled a role for this party; an organisation form is not a role">
        {EMPTY}
      </span>
    );
  }
  return (
    <ul className="chip-list">
      {row.roleEvidence.map((entry) => (
        <li key={`${entry.role}:${entry.evidence.documentId}:${entry.evidence.locator ?? ''}`} className="chip" title={`${entry.role} — read at ${entry.evidence.locator ?? 'document'} of ${entry.evidence.documentId}`}>
          {entry.role}
        </li>
      ))}
    </ul>
  );
}

const COLUMNS: ReadonlyArray<ColumnDef<LegalParty>> = [
  {
    id: 'name',
    header: 'Party',
    headerTitle: 'displayName — the spelling this identity was read as; another spelling is another row',
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
    id: 'basis',
    header: 'Basis',
    headerTitle: 'basis — the shape this name was read from, so the reading can be judged',
    render: (row) => (
      <Badge tone="muted" title={BASIS_GLOSS[row.basis]} mono>
        {row.basis}
      </Badge>
    ),
    sortValue: (row) => row.basis,
    filterValue: (row) => row.basis,
    nowrap: true,
  },
  {
    id: 'orgNumber',
    header: 'Org. no.',
    headerTitle: 'organisationNumber — the organisation number a document stated beside the name',
    render: (row) => (row.organisationNumber === null ? <span className="muted">{EMPTY}</span> : <span className="mono">{row.organisationNumber}</span>),
    sortValue: (row) => row.organisationNumber ?? '',
    filterValue: (row) => row.organisationNumber ?? '',
    nowrap: true,
  },
  {
    id: 'roles',
    header: 'Roles',
    headerTitle: 'roles — the parts a document assigned to this party, each backed by the line it was read on',
    render: (row) => <RoleChips row={row} />,
    sortValue: (row) => row.roles.length,
    filterValue: (row) => row.roles.join(' '),
  },
  {
    id: 'aliases',
    header: 'Spellings & addresses',
    headerTitle: 'aliases — other spellings and addresses read for this identity; nothing is merged across rows',
    render: (row) => <Chips values={row.aliases.filter((alias) => alias !== row.displayName)} emptyTitle="No other spelling or address was read for this identity" />,
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
    headerTitle: 'identityConfidence — how strongly the adapter holds this reading; never above 0.5 for a name read from text',
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
          subtitle="Every name is read from a document on a stated basis; two spellings are two rows until a lawyer decides they are one party"
          flush
        >
          <DataTable
            columns={COLUMNS}
            rows={data.parties}
            rowKey={(row) => row.partyId}
            caption="Parties in this case"
            countNoun="parties"
            emptyTitle="No parties yet"
            emptyMessage="A party appears here once the adapter reads a name out of a document; this case recorded none."
            filter={{
              placeholder: 'Search name, role, spelling, organisation number, basis or kind…',
              predicate: (row, query) =>
                `${row.displayName} ${row.roles.join(' ')} ${row.aliases.join(' ')} ${row.organisationNumber ?? ''} ${row.basis} ${row.kind}`.toLowerCase().includes(query),
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
