import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { LegalCaseResponse } from '../../../../shared/legal-contract.ts';
import { getLegalCase } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { isLegalCaseTab, ROUTES, type LegalCaseTab } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
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

const TAB_LABELS: Readonly<Record<LegalCaseTab, string>> = {
  documents: 'Belgeler',
  timeline: 'Zaman çizelgesi',
  parties: 'Taraflar',
  statements: 'İfadeler',
  coverage: 'Kapsam',
};

export function CaseDetailPage(): ReactNode {
  const { caseId } = useParams<{ caseId: string }>();
  const id = caseId ?? '';
  const navigate = useNavigate();
  const location = useLocation();
  const { state, reload } = useRequest((signal) => getLegalCase(id, signal), [id]);

  if (id === '') {
    return <Callout tone="danger">Dava kimliği eksik.</Callout>;
  }

  const lastSegment = location.pathname.split('/').filter((segment) => segment !== '').at(-1);
  const activeTab: LegalCaseTab = isLegalCaseTab(lastSegment) ? lastSegment : 'documents';

  return (
    <>
      <PageHeader
        title={state.status === 'success' ? state.data.case.title : id}
        breadcrumb={<Link to={ROUTES.legalCases}>Davalar</Link>}
        subtitle={
          state.status === 'success' ? (
            <>
              <span className="mono">{state.data.case.caseId}</span>
              {state.data.case.jurisdiction !== null ? <Badge tone="neutral">{state.data.case.jurisdiction}</Badge> : null}
              {state.data.case.courtReference !== null ? <span className="mono">{state.data.case.courtReference}</span> : null}
              <span>
                snapshot <span className="mono" title={state.data.case.snapshotSha256}>{shortHash(state.data.case.snapshotSha256, 12)}</span>
              </span>
              <span className="mono">
                {state.data.case.adapterId}@{state.data.case.adapterVersion}
              </span>
              <span>
                oluşturuldu <Timestamp value={state.data.case.createdAt} />
              </span>
              <Badge tone={state.data.coverage.complete ? 'success' : 'danger'} title="coverage.complete — arşivdeki her dosyanın bir akıbeti var mı">
                coverage {state.data.coverage.complete ? 'complete' : 'incomplete'}
              </Badge>
            </>
          ) : (
            'Dava ayrıntısı'
          )
        }
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(detail) => (
          <>
            <Tabs
              label="Dava sekmeleri"
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
              <p className="muted">
                {formatNumber(detail.summary.statementsNeedingReview)} ifade insan doğrulaması bekliyor —{' '}
                <Link to={ROUTES.legalCase(id, 'statements')}>İfadeler sekmesi</Link>.
              </p>
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
