import { useState, type ReactNode } from 'react';
import { STATEMENT_STATUSES, type LegalStatement, type LegalStatementsResponse } from '../../../../shared/legal-contract.ts';
import { getLegalStatements } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { AssertedByBadge, ConfidenceMeter, EvidenceRefList, ReviewMarker, StatementStatusBadge } from './legal-badges.tsx';

const COLUMNS: ReadonlyArray<ColumnDef<LegalStatement>> = [
  {
    id: 'statement',
    header: 'İfade (iddia)',
    render: (row) => (
      <div className="statement-text">
        <div>{row.statement}</div>
        {row.relatedClaimIds.length > 0 ? (
          <ul className="chip-list" aria-label="ilgili iddialar">
            {row.relatedClaimIds.map((claimId) => (
              <li key={claimId} className="chip" title={claimId}>
                {claimId}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    ),
    sortValue: (row) => row.statement,
  },
  { id: 'status', header: 'status', render: (row) => <StatementStatusBadge status={row.status} />, sortValue: (row) => row.status, nowrap: true },
  { id: 'assertedBy', header: 'assertedBy', render: (row) => <AssertedByBadge source={row.assertedBy} partyId={row.assertedByPartyId} />, sortValue: (row) => row.assertedBy, nowrap: true },
  {
    id: 'supporting',
    header: 'Destekleyen',
    render: (row) => (
      <div className="stack" data-count={row.supportingSources.length}>
        <Badge tone={row.supportingSources.length > 0 ? 'info' : 'muted'}>{formatNumber(row.supportingSources.length)} kaynak</Badge>
        <EvidenceRefList refs={row.supportingSources} max={2} />
      </div>
    ),
    sortValue: (row) => row.supportingSources.length,
  },
  {
    id: 'contradicting',
    header: 'Çelişen',
    render: (row) => (
      <div className="stack">
        <Badge tone={row.contradictingSources.length > 0 ? 'danger' : 'muted'}>{formatNumber(row.contradictingSources.length)} kaynak</Badge>
        <EvidenceRefList refs={row.contradictingSources} max={2} />
      </div>
    ),
    sortValue: (row) => row.contradictingSources.length,
  },
  {
    id: 'missing',
    header: 'Eksik kanıt',
    render: (row) =>
      row.missingEvidence.length === 0 ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <ul className="missing-list">
          {row.missingEvidence.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ),
    sortValue: (row) => row.missingEvidence.length,
  },
  { id: 'confidence', header: 'confidence', render: (row) => <ConfidenceMeter value={row.confidence} />, sortValue: (row) => row.confidence, nowrap: true },
  { id: 'review', header: 'İnsan doğrulaması', render: (row) => <ReviewMarker required={row.humanReviewRequired} />, sortValue: (row) => (row.humanReviewRequired ? 0 : 1), nowrap: true },
  {
    id: 'verified',
    header: 'verifiedBy',
    render: (row) =>
      row.verifiedBy === null ? (
        <span className="muted" title="Henüz insan doğrulaması kaydı yok">
          doğrulanmadı
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

/** Pure matrix renderer (unit-tested); the tab wrapper below wires it to the endpoint. */
export function StatementsMatrix({ response }: { readonly response: LegalStatementsResponse }): ReactNode {
  const statusEntries = Object.entries(response.byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="İfade" value={formatNumber(response.statements.length)} />
        <Stat label="İnsan doğrulaması bekleyen" value={formatNumber(response.needingReview)} tone={response.needingReview > 0 ? 'warning' : 'default'} />
        {statusEntries.map(([status, count]) => (
          <Stat
            key={status}
            label={status}
            value={formatNumber(count)}
            hint={STATEMENT_STATUSES.includes(status as (typeof STATEMENT_STATUSES)[number]) ? <StatementStatusBadge status={status as (typeof STATEMENT_STATUSES)[number]} /> : <Badge tone="muted">{status}</Badge>}
          />
        ))}
      </div>
      <Card title="İddia–kanıt matrisi" flush>
        <DataTable
          columns={COLUMNS}
          rows={response.statements}
          rowKey={(row) => row.statementId}
          caption="İddia–kanıt matrisi"
          emptyMessage="Bu filtrelerle ifade yok."
          filter={{ placeholder: 'ifade metni ara…', predicate: (row, query) => `${row.statement} ${row.status} ${row.assertedBy}`.toLocaleLowerCase('tr').includes(query) }}
          initialSort={{ columnId: 'review', direction: 'asc' }}
          rowClassName={(row) => (row.status === 'contradicted' ? 'row-danger' : row.humanReviewRequired ? 'row-warning' : undefined)}
        />
      </Card>
    </div>
  );
}

export function StatementsTab(): ReactNode {
  const { caseId } = useCaseContext();
  const [status, setStatus] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const { state, reload } = useRequest(
    (signal) => getLegalStatements(caseId, { status: status === '' ? undefined : status, humanReview: reviewOnly ? true : undefined }, signal),
    [caseId, status, reviewOnly],
  );
  return (
    <div className="stack">
      <Callout tone="warning" title="Bir ifade olgu değildir">
        Satırlar tarafların, mahkemenin veya yapay zekânın <em>beyanlarıdır</em>. <code>asserted</code> ve <code>supported</code> bile insan doğrulaması taşımaz; yalnızca{' '}
        <code>verified</code> bir insan denetçinin kaydını gösterir. <code>ai_inference</code> kaynaklı ifadeler kanıt olarak kullanılamaz.
      </Callout>
      <div className="toolbar">
        <label className="field" htmlFor="statements-status">
          <span>status</span>
          <select id="statements-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">(hepsi)</option>
            {STATEMENT_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline" htmlFor="statements-review">
          <input id="statements-review" type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
          <span>yalnızca insan doğrulaması gerekenler</span>
        </label>
        <button type="button" className="button" onClick={reload}>
          Yenile
        </button>
      </div>
      <AsyncState state={state} onRetry={reload}>
        {(data) => <StatementsMatrix response={data} />}
      </AsyncState>
    </div>
  );
}
