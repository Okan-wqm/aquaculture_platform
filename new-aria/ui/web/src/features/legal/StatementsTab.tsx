// Statements tab: the claim-evidence matrix.
//
// WHY: this is the table where a machine-produced claim is most likely to be
// misread as a fact, so the row itself carries every qualifier — the status word
// verbatim, who asserted it, how many sources support it against how many
// contradict it, what evidence is missing, and whether a human reviewer has
// signed off. `verified` is the only status a human earns; the adapter never
// emits it, and no colour is allowed to imply it.
// WHY (order): the default sort puts the review backlog on top, because the rows
// that still need a person are the reason to open this tab.
// WHAT: the status distribution, the review backlog count, and one row per
// statement, filterable by status and by review requirement.
import { useState, type ReactNode } from 'react';
import { STATEMENT_STATUSES, type LegalStatement, type LegalStatementsResponse } from '../../../../shared/legal-contract.ts';
import { getLegalStatements } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { Toolbar } from '../../design/Toolbar.tsx';
import { EMPTY, formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { AssertedByBadge, ConfidenceMeter, EvidenceRefList, ReviewMarker, StatementStatusBadge } from './legal-badges.tsx';

/** Sentinel for "no server-side status filter"; the empty string is what an unset <select> carries. */
const ANY_STATUS = '';

/** Sources are countable evidence anchors, so the unit is spelled out next to the number. */
function sourceCount(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? 'source' : 'sources'}`;
}

const COLUMNS: ReadonlyArray<ColumnDef<LegalStatement>> = [
  {
    id: 'statement',
    header: 'Statement',
    headerTitle: 'statement — what was asserted, in the words of the record',
    render: (row) => (
      <div className="statement-text">
        <div>{row.statement}</div>
        {row.relatedClaimIds.length > 0 ? (
          <ul className="chip-list" aria-label="Related claims">
            {row.relatedClaimIds.map((claimId) => (
              <li key={claimId} className="chip" title={`relatedClaimId ${claimId}`}>
                {claimId}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    ),
    sortValue: (row) => row.statement,
  },
  {
    id: 'status',
    header: 'Status',
    headerTitle: 'status — only `verified` carries a human verification',
    render: (row) => <StatementStatusBadge status={row.status} />,
    sortValue: (row) => row.status,
    nowrap: true,
  },
  {
    id: 'assertedBy',
    header: 'Asserted by',
    headerTitle: 'assertedBy + assertedByPartyId — who put this statement into the world',
    render: (row) => <AssertedByBadge source={row.assertedBy} partyId={row.assertedByPartyId} />,
    sortValue: (row) => row.assertedBy,
    nowrap: true,
  },
  {
    id: 'supporting',
    header: 'Supporting',
    headerTitle: 'supportingSources — evidence anchors that back this statement',
    render: (row) => (
      <div className="stack stack--tight">
        <Badge tone={row.supportingSources.length > 0 ? 'info' : 'muted'}>{sourceCount(row.supportingSources.length)}</Badge>
        <EvidenceRefList refs={row.supportingSources} max={2} />
      </div>
    ),
    sortValue: (row) => row.supportingSources.length,
  },
  {
    id: 'contradicting',
    header: 'Contradicting',
    headerTitle: 'contradictingSources — evidence anchors that cut against this statement',
    render: (row) => (
      <div className="stack stack--tight">
        <Badge tone={row.contradictingSources.length > 0 ? 'danger' : 'muted'}>{sourceCount(row.contradictingSources.length)}</Badge>
        <EvidenceRefList refs={row.contradictingSources} max={2} />
      </div>
    ),
    sortValue: (row) => row.contradictingSources.length,
  },
  {
    id: 'missing',
    header: 'Missing evidence',
    headerTitle: 'missingEvidence — what would settle this statement and is not in the archive',
    render: (row) =>
      row.missingEvidence.length === 0 ? (
        <span className="muted" title="Nothing was named as missing for this statement">
          {EMPTY}
        </span>
      ) : (
        <ul className="missing-list">
          {row.missingEvidence.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ),
    sortValue: (row) => row.missingEvidence.length,
  },
  {
    id: 'confidence',
    header: 'Confidence',
    headerTitle: 'confidence — how strongly the adapter holds this reading, never a probability of truth',
    render: (row) => <ConfidenceMeter value={row.confidence} />,
    sortValue: (row) => row.confidence,
    nowrap: true,
  },
  {
    id: 'review',
    header: 'Human review',
    headerTitle: 'humanReviewRequired — whether this statement still needs a human reviewer',
    render: (row) => <ReviewMarker required={row.humanReviewRequired} />,
    sortValue: (row) => (row.humanReviewRequired ? 0 : 1),
    nowrap: true,
  },
  {
    id: 'verified',
    header: 'Verified by',
    headerTitle: 'verifiedBy + verifiedAt — the human reviewer who recorded the verification',
    render: (row) =>
      row.verifiedBy === null ? (
        <span className="muted" title="No human review recorded yet">
          Not reviewed
        </span>
      ) : (
        <span className="row">
          <Badge tone="success">{row.verifiedBy}</Badge>
          <Timestamp value={row.verifiedAt} />
        </span>
      ),
    sortValue: (row) => row.verifiedBy,
    nowrap: true,
  },
];

export interface StatementsMatrixProps {
  readonly response: LegalStatementsResponse;
  /** True when a server-side status or review filter is narrowing the response. */
  readonly filtered?: boolean | undefined;
}

/**
 * Pure matrix renderer.
 *
 * WHY: exported separately from the tab so the epistemic markers this module
 * exists to guarantee — status verbatim, the review marker, supporting against
 * contradicting counts — can be tested without a network.
 */
export function StatementsMatrix({ response, filtered = false }: StatementsMatrixProps): ReactNode {
  // Kernel status keys, ordered by how many statements carry them: the shape of
  // the case leads, and the words themselves stay exactly as the API returned.
  const statusEntries = Object.entries(response.byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="Statements" value={formatNumber(response.statements.length)} hint="Rows returned for this case" />
        <Stat
          label="Awaiting human review"
          value={formatNumber(response.needingReview)}
          tone={response.needingReview > 0 ? 'warning' : 'default'}
          hint="Marked humanReviewRequired"
        />
        {statusEntries.map(([status, count]) => (
          <Stat
            key={status}
            label={status}
            value={formatNumber(count)}
            hint={
              STATEMENT_STATUSES.includes(status as (typeof STATEMENT_STATUSES)[number]) ? (
                <StatementStatusBadge status={status as (typeof STATEMENT_STATUSES)[number]} />
              ) : (
                <Badge tone="muted">{status}</Badge>
              )
            }
          />
        ))}
      </div>
      <Card title="Claim-evidence matrix" subtitle="Sorted so the statements still waiting for a human reviewer come first" flush>
        <DataTable
          columns={COLUMNS}
          rows={response.statements}
          rowKey={(row) => row.statementId}
          caption="Claim-evidence matrix"
          countNoun="statements"
          emptyTitle={filtered ? 'No statements match these filters' : 'No statements yet'}
          emptyMessage={
            filtered
              ? 'Every statement the adapter recorded appears here; none carries the status and review requirement selected above.'
              : 'A statement appears here once the adapter reads an assertion out of a document; this case recorded none.'
          }
          filter={{
            placeholder: 'Search statement text, status or asserting source…',
            predicate: (row, query) => `${row.statement} ${row.status} ${row.assertedBy}`.toLowerCase().includes(query),
          }}
          initialSort={{ columnId: 'review', direction: 'asc' }}
          rowClassName={(row) => (row.status === 'contradicted' ? 'row-danger' : row.humanReviewRequired ? 'row-warning' : undefined)}
          maxHeight="70vh"
        />
      </Card>
    </div>
  );
}

export function StatementsTab(): ReactNode {
  const { caseId } = useCaseContext();
  const [status, setStatus] = useState(ANY_STATUS);
  const [reviewOnly, setReviewOnly] = useState(false);
  const { state, reload } = useRequest(
    (signal) => getLegalStatements(caseId, { status: status === ANY_STATUS ? undefined : status, humanReview: reviewOnly ? true : undefined }, signal),
    [caseId, status, reviewOnly],
  );
  const filtered = status !== ANY_STATUS || reviewOnly;
  return (
    <div className="stack">
      <Callout tone="warning" title="A statement is not a fact">
        These rows are what parties, courts, counsel or a machine <em>asserted</em>. Neither <code>asserted</code> nor <code>supported</code> carries a human
        verification — only <code>verified</code> records that a human reviewer checked it. Statements sourced from <code>ai_inference</code> are not evidence
        and cannot be used as such.
      </Callout>
      <Toolbar align="end">
        <label className="field" htmlFor="statements-status">
          <span>Status</span>
          <select id="statements-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value={ANY_STATUS}>All</option>
            {STATEMENT_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline" htmlFor="statements-review">
          <input id="statements-review" type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
          <span>Human review required only</span>
        </label>
        <button type="button" className="button" onClick={reload}>
          <Icon name="refresh" />
          Refresh
        </button>
      </Toolbar>
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the statements of this case">
        {(data) => <StatementsMatrix response={data} filtered={filtered} />}
      </AsyncState>
    </div>
  );
}
