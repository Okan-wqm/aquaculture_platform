// Case detail shell: identity band, section tabs, and the outlet each tab fills.
//
// WHY: every legal tab is read against the same provenance — which archive
// snapshot, which adapter build, and whether that adapter accounted for every
// file. Putting those in the header means a reader can never study a document,
// a date or a statement without the conditions under which it was produced being
// on screen. The review backlog is repeated here because it is the one number
// that changes what the reader should do next.
// WHAT: fetches the case record once, renders the identity subtitle and the five
// section tabs, and hands the fetched detail down through the router outlet so
// each tab loads only its own endpoint.
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { LegalCaseResponse } from '../../../../shared/legal-contract.ts';
import { getLegalCase } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { isLegalCaseTab, ROUTES, type LegalCaseTab } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Tabs, TabPanel } from '../../design/Tabs.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatNumber, shortHash } from '../../design/format.ts';

export interface CaseOutletContext {
  readonly caseId: string;
  readonly detail: LegalCaseResponse;
}

/** Tabs read the case through the router outlet so each tab fetches only its own endpoint. */
export function useCaseContext(): CaseOutletContext {
  return useOutletContext<CaseOutletContext>();
}

/** Section names. These are console labels, not kernel values, so they are English. */
const TAB_LABELS: Readonly<Record<LegalCaseTab, string>> = {
  intake: 'Intake',
  documents: 'Documents',
  timeline: 'Timeline',
  parties: 'Parties',
  statements: 'Statements',
  coverage: 'Coverage',
};

export function CaseDetailPage(): ReactNode {
  const { caseId } = useParams<{ caseId: string }>();
  const id = caseId ?? '';
  const navigate = useNavigate();
  const location = useLocation();
  const { state, reload } = useRequest((signal) => getLegalCase(id, signal), [id]);

  if (id === '') {
    return (
      <Callout tone="danger" title="No case id in this address" role="alert">
        This address carries no case id, so there is no archive to read. Open a case from the <Link to={ROUTES.legalCases}>Cases</Link> index.
      </Callout>
    );
  }

  const lastSegment = location.pathname.split('/').filter((segment) => segment !== '').at(-1);
  const activeTab: LegalCaseTab = isLegalCaseTab(lastSegment) ? lastSegment : 'documents';

  return (
    <>
      <PageHeader
        title={state.status === 'success' ? state.data.case.title : id}
        breadcrumb={<Link to={ROUTES.legalCases}>Cases</Link>}
        subtitle={
          state.status === 'success' ? (
            <>
              <span className="mono">{state.data.case.caseId}</span>
              {state.data.case.jurisdiction !== null ? <Badge tone="neutral">{state.data.case.jurisdiction}</Badge> : null}
              {state.data.case.courtReference !== null ? <span className="mono">{state.data.case.courtReference}</span> : null}
              <span>
                Snapshot{' '}
                <span className="mono" title={state.data.case.snapshotSha256}>
                  {shortHash(state.data.case.snapshotSha256, 12)}
                </span>
              </span>
              <span className="mono" title="adapterId@adapterVersion — the build that produced these records">
                {state.data.case.adapterId}@{state.data.case.adapterVersion}
              </span>
              <span>
                Created <Timestamp value={state.data.case.createdAt} />
              </span>
              <Badge
                tone={state.data.coverage.complete ? 'success' : 'danger'}
                title="coverage.complete — whether every file in the archive has a recorded fate"
              >
                coverage {state.data.coverage.complete ? 'complete' : 'incomplete'}
              </Badge>
            </>
          ) : (
            'Case detail'
          )
        }
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="detail" errorTitle="Could not load this case">
        {(detail) => (
          <>
            <Tabs
              label="Case sections"
              active={activeTab}
              onChange={(tab) => {
                if (isLegalCaseTab(tab)) {
                  navigate(ROUTES.legalCase(id, tab));
                }
              }}
              items={[
                { id: 'documents', label: TAB_LABELS.documents, count: detail.summary.documents },
                { id: 'timeline', label: TAB_LABELS.timeline, count: detail.summary.timelineEvents },
                { id: 'parties', label: TAB_LABELS.parties, count: detail.summary.parties },
                { id: 'statements', label: TAB_LABELS.statements, count: detail.summary.statements },
                { id: 'coverage', label: TAB_LABELS.coverage, count: detail.coverage.totalFiles },
              ]}
            />
            {detail.summary.statementsNeedingReview > 0 && activeTab !== 'statements' ? (
              <Callout tone="warning" title="This case has a human-review backlog">
                {formatNumber(detail.summary.statementsNeedingReview)}{' '}
                {detail.summary.statementsNeedingReview === 1 ? 'statement is waiting' : 'statements are waiting'} for a human reviewer. Read them on the{' '}
                <Link to={ROUTES.legalCase(id, 'statements')}>{TAB_LABELS.statements}</Link> tab.
              </Callout>
            ) : null}
            <TabPanel id={activeTab}>
              <Outlet context={{ caseId: id, detail } satisfies CaseOutletContext} />
            </TabPanel>
          </>
        )}
      </AsyncState>
    </>
  );
}
