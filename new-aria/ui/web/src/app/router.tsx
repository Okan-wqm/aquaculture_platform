// Route table. Exported separately from the browser router so tests can mount the
// same tree in a memory router.
import { KERNEL_READ_PERMISSION } from '../../../shared/api-contract.ts';
import { useHealth } from './HealthProvider.tsx';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { ActionsPage } from '../features/core/ActionsPage.tsx';
import { AgentsPage } from '../features/core/AgentsPage.tsx';
import { BeliefsPage } from '../features/core/BeliefsPage.tsx';
import { CycleDetailPage } from '../features/core/CycleDetailPage.tsx';
import { CyclesPage } from '../features/core/CyclesPage.tsx';
import { FindingsPage } from '../features/core/FindingsPage.tsx';
import { GovernancePage } from '../features/core/GovernancePage.tsx';
import { HumanRequiredPage } from '../features/core/HumanRequiredPage.tsx';
import { LedgersPage } from '../features/core/LedgersPage.tsx';
import { OverviewPage } from '../features/core/OverviewPage.tsx';
import { PlansPage } from '../features/core/PlansPage.tsx';
import { PressuresPage } from '../features/core/PressuresPage.tsx';
import { ReportReaderPage } from '../features/core/ReportReaderPage.tsx';
import { ReportsPage } from '../features/core/ReportsPage.tsx';
import { ToolsPage } from '../features/core/ToolsPage.tsx';
import { CaseDetailPage } from '../features/legal/CaseDetailPage.tsx';
import { CasesPage } from '../features/legal/CasesPage.tsx';
import { CoverageTab } from '../features/legal/CoverageTab.tsx';
import { DocumentsTab } from '../features/legal/DocumentsTab.tsx';
import { IntakeTab } from '../features/legal/IntakeTab.tsx';
import { PartiesTab } from '../features/legal/PartiesTab.tsx';
import { StatementsTab } from '../features/legal/StatementsTab.tsx';
import { TimelineTab } from '../features/legal/TimelineTab.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HealthProvider } from './HealthProvider.tsx';
import { LoginPage } from './LoginPage.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { RequireAuth } from './RequireAuth.tsx';
import { RouteErrorPage } from './RouteErrorPage.tsx';
import { ROUTES } from './routes.ts';

function RootShell(): ReactNode {
  return (
    <HealthProvider>
      <Outlet />
    </HealthProvider>
  );
}

function RequireKernelRead(): ReactNode {
  const health = useHealth();
  if (health.me === null) return <p>Reading permissions…</p>;
  return health.can(KERNEL_READ_PERMISSION) ? <Outlet /> : <Navigate to={ROUTES.legalCases} replace />;
}

export const appRoutes: RouteObject[] = [
  {
    element: <RootShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: ROUTES.login, element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/',
            element: <AppLayout />,
            children: [
              {
                element: <RequireKernelRead />,
                children: [
                  { index: true, element: <OverviewPage /> },
                  { path: 'cycles', element: <CyclesPage /> },
                  { path: 'cycles/:cycleId', element: <CycleDetailPage /> },
                  { path: 'governance', element: <GovernancePage /> },
                  { path: 'findings', element: <FindingsPage /> },
                  { path: 'beliefs', element: <BeliefsPage /> },
                  { path: 'pressures', element: <PressuresPage /> },
                  { path: 'human-required', element: <HumanRequiredPage /> },
                  { path: 'agents', element: <AgentsPage /> },
                  { path: 'plans', element: <PlansPage /> },
                  { path: 'tools', element: <ToolsPage /> },
                  { path: 'reports', element: <ReportsPage /> },
                  { path: 'reports/:date', element: <ReportReaderPage /> },
                  { path: 'ledgers', element: <LedgersPage /> },
                  { path: 'actions', element: <ActionsPage /> },
                ],
              },
              { path: 'legal', element: <Navigate to={ROUTES.legalCases} replace /> },
              { path: 'legal/cases', element: <CasesPage /> },
              {
                path: 'legal/cases/:caseId',
                element: <CaseDetailPage />,
                children: [
                  { index: true, element: <Navigate to="documents" replace /> },
                  { path: 'intake', element: <IntakeTab /> },
                  { path: 'documents', element: <DocumentsTab /> },
                  { path: 'timeline', element: <TimelineTab /> },
                  { path: 'parties', element: <PartiesTab /> },
                  { path: 'statements', element: <StatementsTab /> },
                  { path: 'coverage', element: <CoverageTab /> },
                ],
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export const appRouter = createBrowserRouter(appRoutes);
