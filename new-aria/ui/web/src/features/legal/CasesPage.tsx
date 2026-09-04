// Legal case index.
//
// WHY: the first question an operator or a lawyer asks of this list is "where is
// the drift" — which archives still hold unreadable files and which cases carry a
// human-review backlog. Those two numbers lead the page and tint the rows; the
// title is only the address.
// WHAT: portfolio totals, the reading-discipline notice, and one dense row per
// case artifact under packs/legal/cases/.
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LegalCaseSummary } from '../../../../shared/legal-contract.ts';
import { createLegalCase, getLegalCases } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { useHealth } from '../../app/HealthProvider.tsx';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { Toolbar } from '../../design/Toolbar.tsx';
import { EMPTY, formatNumber } from '../../design/format.ts';
import './legal.css';

const COLUMNS: ReadonlyArray<ColumnDef<LegalCaseSummary>> = [
  {
    id: 'case',
    header: 'Case',
    render: (row) => (
      <div>
        <div>{row.title}</div>
        <div className="mono faint">{row.caseId}</div>
      </div>
    ),
    sortValue: (row) => row.title,
    filterValue: (row) => `${row.title} ${row.caseId}`,
  },
  { id: 'documents', header: 'Documents', render: (row) => formatNumber(row.documents), sortValue: (row) => row.documents, align: 'end', headerTitle: 'Files the adapter recorded a fate for' },
  {
    id: 'unreadable',
    header: 'Unreadable',
    render: (row) => (row.unreadable === 0 ? <span className="muted">{EMPTY}</span> : <Badge tone="danger">{formatNumber(row.unreadable)}</Badge>),
    sortValue: (row) => row.unreadable,
    align: 'end',
    headerTitle: 'Files whose bytes could not be read — each one raises a pressure record',
  },
  {
    id: 'statements',
    header: 'Statements',
    render: (row) => formatNumber(row.statements),
    sortValue: (row) => row.statements,
    align: 'end',
    headerTitle: 'Rows in the claim-evidence matrix of this case',
  },
  {
    id: 'review',
    header: 'Human required',
    render: (row) => (row.statementsNeedingReview === 0 ? <span className="muted">{EMPTY}</span> : <Badge tone="warning">{formatNumber(row.statementsNeedingReview)}</Badge>),
    sortValue: (row) => row.statementsNeedingReview,
    align: 'end',
    headerTitle: 'Statements carrying human_review_required = true',
  },
  {
    id: 'timeline',
    header: 'Timeline',
    render: (row) => formatNumber(row.timelineEvents),
    sortValue: (row) => row.timelineEvents,
    align: 'end',
    headerTitle: 'Dated events the adapter read out of this archive',
  },
  {
    id: 'parties',
    header: 'Parties',
    render: (row) => formatNumber(row.parties),
    sortValue: (row) => row.parties,
    align: 'end',
    headerTitle: 'Identities the adapter resolved in this archive',
  },
  {
    id: 'created',
    header: 'Created',
    render: (row) => <Timestamp value={row.createdAt} />,
    sortValue: (row) => row.createdAt,
    nowrap: true,
    headerTitle: 'createdAt — when the adapter wrote this case artifact',
  },
];

/** Row tint carries state only: an unreadable file outranks a review backlog. */
function rowTone(row: LegalCaseSummary): string | undefined {
  if (row.unreadable > 0) {
    return 'row-danger';
  }
  if (row.statementsNeedingReview > 0) {
    return 'row-warning';
  }
  return undefined;
}

/**
 * Opening a case is the console's only creation act. It asks for a custodian
 * because an archive nobody is answerable for cannot support a chain-of-custody
 * claim later, and the server refuses one without it.
 */
function NewCaseForm({ onCreated }: { readonly onCreated: () => void }): ReactNode {
  const navigate = useNavigate();
  const [caseId, setCaseId] = useState('');
  const [title, setTitle] = useState('');
  const [custodian, setCustodian] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [courtReference, setCourtReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const created = await createLegalCase({
          caseId: caseId.trim(),
          title: title.trim(),
          custodian: custodian.trim(),
          jurisdiction: jurisdiction.trim() === '' ? null : jurisdiction.trim(),
          courtReference: courtReference.trim() === '' ? null : courtReference.trim(),
        });
        onCreated();
        navigate(ROUTES.legalCase(created.caseMeta.caseId, 'intake'));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setBusy(false);
      }
    },
    [caseId, courtReference, custodian, jurisdiction, navigate, onCreated, title],
  );

  return (
    <Card title="Open a case" subtitle="Creates the archive directory and its custody record; documents are added on the case's Intake tab">
      <form className="case-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Case id</span>
          <input value={caseId} onChange={(event) => setCaseId(event.target.value)} required placeholder="sak-24-001" pattern="[a-z0-9][a-z0-9._-]{2,63}" />
        </label>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="Bergen Eiendom v Nordlys" />
        </label>
        <label className="field">
          <span>Custodian</span>
          <input value={custodian} onChange={(event) => setCustodian(event.target.value)} required placeholder="The person answerable for this archive" />
        </label>
        <label className="field">
          <span>Jurisdiction</span>
          <input value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)} placeholder="Optional" />
        </label>
        <label className="field">
          <span>Court reference</span>
          <input value={courtReference} onChange={(event) => setCourtReference(event.target.value)} placeholder="Optional" />
        </label>
        {error === null ? null : (
          <p className="case-form__error" role="alert">
            {error}
          </p>
        )}
        <Toolbar>
          <button type="submit" className="button button--primary" disabled={busy}>
            Open case
          </button>
        </Toolbar>
      </form>
    </Card>
  );
}

export function CasesPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getLegalCases(signal), []);
  const health = useHealth();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Cases"
        subtitle="packs/legal/cases/ — mechanical output of the legal adapter; it draws no legal conclusions"
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <div className="stack">
        <Callout tone="neutral" title="How to read this module">
          Every record here is a <em>statement</em> or a mechanical inference. No status other than <code>verified</code> is a fact, and rows sourced from{' '}
          <code>ai_inference</code> are not evidence. Occurred (<code>occurredAt</code>) and Learned (<code>learnedAt</code>) are kept in separate columns and never merged.
        </Callout>
        {health.actionsEnabled ? <NewCaseForm onCreated={reload} /> : null}
        <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load cases">
          {(data) => {
            const totals = data.cases.reduce(
              (sum, row) => ({
                documents: sum.documents + row.documents,
                unreadable: sum.unreadable + row.unreadable,
                statements: sum.statements + row.statements,
                review: sum.review + row.statementsNeedingReview,
              }),
              { documents: 0, unreadable: 0, statements: 0, review: 0 },
            );
            return (
              <div className="stack">
                <div className="stat-grid">
                  <Stat label="Cases" value={formatNumber(data.cases.length)} />
                  <Stat label="Documents" value={formatNumber(totals.documents)} />
                  <Stat label="Unreadable files" value={formatNumber(totals.unreadable)} tone={totals.unreadable > 0 ? 'danger' : 'default'} hint="Each one raises a pressure record" />
                  <Stat label="Statements" value={formatNumber(totals.statements)} />
                  <Stat label="Awaiting human review" value={formatNumber(totals.review)} tone={totals.review > 0 ? 'warning' : 'default'} hint="Statements marked human_review_required" />
                </div>
                <Card title="Case index" subtitle="Open a row to read its documents, timeline, parties, statements and coverage" flush>
                  <DataTable
                    columns={COLUMNS}
                    rows={data.cases}
                    rowKey={(row) => row.caseId}
                    caption="Legal cases"
                    countNoun="cases"
                    emptyTitle="No cases yet"
                    emptyMessage="A case appears here once the legal adapter has processed an archive and written it under packs/legal/cases/."
                    filter={{ placeholder: 'Search title or case id', predicate: (row, query) => `${row.title} ${row.caseId}`.toLowerCase().includes(query) }}
                    filterRow
                    initialSort={{ columnId: 'review', direction: 'desc' }}
                    onRowActivate={(row) => navigate(ROUTES.legalCase(row.caseId))}
                    rowClassName={rowTone}
                    maxHeight="60vh"
                  />
                </Card>
              </div>
            );
          }}
        </AsyncState>
      </div>
    </>
  );
}
