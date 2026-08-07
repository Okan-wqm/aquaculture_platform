import { lazy, Suspense, type ReactElement } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';

import { ErrorBoundary } from './components/ErrorBoundary';
import { InstallPrompt } from './components/InstallPrompt';
import { MultiFeatureRoute } from './components/MultiFeatureRoute';
import { useAuth } from './hooks/useAuth';
import {
  MobilePermissionsProvider,
  useMobilePermissions,
  type MobileFeature,
} from './hooks/useMobilePermissions';
import { useSwNavigation } from './hooks/useSwNavigation';
import { AppShell } from './layouts/AppShell';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { isFeatureAccessible } from './utils/feature-access';

/**
 * BUG-16: Redirect component that captures :tankId param and forwards it to /cull/record/:tankId.
 * React Router's Navigate component treats the `to` prop as a static string and does not
 * interpolate route parameters. This component reads the matched :tankId from useParams
 * and builds the correct target path dynamically.
 */
function CullingToTankRedirect(): ReactElement {
  const { tankId } = useParams<{ tankId: string }>();
  return <Navigate to={`/cull/record/${tankId}`} replace />;
}

// PERF-02: Lazy-load page components so the initial bundle only contains the
// login and home pages. Feature pages are code-split and loaded on demand.
const RecordMortalityPage = lazy(() =>
  import('./pages/mortality/RecordMortalityPage').then((m) => ({ default: m.RecordMortalityPage })),
);
const RecordCullPage = lazy(() =>
  import('./pages/cull/RecordCullPage').then((m) => ({ default: m.RecordCullPage })),
);
const RecordHarvestPage = lazy(() =>
  import('./pages/harvest/RecordHarvestPage').then((m) => ({ default: m.RecordHarvestPage })),
);
const RecordFeedingPage = lazy(() =>
  import('./pages/feeding/RecordFeedingPage').then((m) => ({ default: m.RecordFeedingPage })),
);
const SyncStatusPage = lazy(() =>
  import('./pages/sync/SyncStatusPage').then((m) => ({ default: m.SyncStatusPage })),
);
const MySchedulePage = lazy(() =>
  import('./pages/schedule/MySchedulePage').then((m) => ({ default: m.MySchedulePage })),
);
const AttendancePage = lazy(() =>
  import('./pages/attendance/AttendancePage').then((m) => ({ default: m.AttendancePage })),
);
const LeaveRequestPage = lazy(() =>
  import('./pages/leave/LeaveRequestPage').then((m) => ({ default: m.LeaveRequestPage })),
);
const MyLeavesPage = lazy(() =>
  import('./pages/leave/MyLeavesPage').then((m) => ({ default: m.MyLeavesPage })),
);

const MyTasksPage = lazy(() =>
  import('./pages/tasks/MyTasksPage').then((m) => ({ default: m.MyTasksPage })),
);
const TaskDetailPage = lazy(() =>
  import('./pages/tasks/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })),
);
// New primary tab destinations — Operations merges Record + HR, Account replaces More
const OperationsHubPage = lazy(() =>
  import('./pages/operations/OperationsHubPage').then((m) => ({ default: m.OperationsHubPage })),
);
const AccountPage = lazy(() =>
  import('./pages/account/AccountPage').then((m) => ({ default: m.AccountPage })),
);
const NotificationsPage = lazy(() =>
  import('./pages/notifications/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
// MOB-HIGH-006: mobile alarm surface (alert-engine history + acknowledge)
const AlertsPage = lazy(() =>
  import('./pages/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);
const RecordTransferPage = lazy(() =>
  import('./pages/transfer/RecordTransferPage').then((m) => ({ default: m.RecordTransferPage })),
);
const WaterQualityRecordPage = lazy(() =>
  import('./pages/water-quality/WaterQualityRecordPage').then((m) => ({
    default: m.WaterQualityRecordPage,
  })),
);
// Storage pages — warehouse floor operations for receiving, dispensing, transferring, and viewing stock
const StorageHubPage = lazy(() =>
  import('./pages/storage/StorageHubPage').then((m) => ({ default: m.StorageHubPage })),
);
const StockMovementPage = lazy(() =>
  import('./pages/storage/StockMovementPage').then((m) => ({ default: m.StockMovementPage })),
);
const StockTransferPage = lazy(() =>
  import('./pages/storage/StockTransferPage').then((m) => ({ default: m.StockTransferPage })),
);
const StockViewPage = lazy(() =>
  import('./pages/storage/StockViewPage').then((m) => ({ default: m.StockViewPage })),
);
// BUG-06: Tank detail page — navigated to from TankCard
const TankDetailPage2 = lazy(() =>
  import('./pages/tank/TankDetailPage').then((m) => ({ default: m.TankDetailPage })),
);

// v4 dock destinations. Units is the app's central noun and had no route of its
// own before; Scan is the raised centre button that resolves a QR tag to a unit.
const UnitsPage = lazy(() =>
  import('./pages/units/UnitsPage').then((m) => ({ default: m.UnitsPage })),
);
const ScanPage = lazy(() => import('./pages/scan/ScanPage').then((m) => ({ default: m.ScanPage })));

// The VFD (drive) surface — feeders, pumps and blowers. Reached from Units and
// from a unit's own detail; the detail screen is where a drive is commanded.
const DrivesPage = lazy(() =>
  import('./pages/drives/DrivesPage').then((m) => ({ default: m.DrivesPage })),
);
const DriveDetailPage = lazy(() =>
  import('./pages/drives/DriveDetailPage').then((m) => ({ default: m.DriveDetailPage })),
);

// The tablet control board's three views. Lazy like every other destination: a
// phone never loads these chunks, because AppShell only routes to `/board/*`
// above the board threshold (src/hooks/useViewport.ts).
const BoardPage = lazy(() =>
  import('./pages/tablet/BoardPage').then((m) => ({ default: m.BoardPage })),
);
const ReportsBoardPage = lazy(() =>
  import('./pages/tablet/ReportsBoardPage').then((m) => ({ default: m.ReportsBoardPage })),
);
const ChatBoardPage = lazy(() =>
  import('./pages/tablet/ChatBoardPage').then((m) => ({ default: m.ChatBoardPage })),
);

// Messaging pages — in-app messaging (ADR-012)
const ChannelListPage = lazy(() =>
  import('./pages/messaging/ChannelListPage').then((m) => ({ default: m.ChannelListPage })),
);
const ChatRoomPage = lazy(() =>
  import('./pages/messaging/ChatRoomPage').then((m) => ({ default: m.ChatRoomPage })),
);
const NewChatPage = lazy(() =>
  import('./pages/messaging/NewChatPage').then((m) => ({ default: m.NewChatPage })),
);
const ChannelSettingsPage = lazy(() =>
  import('./pages/messaging/ChannelSettingsPage').then((m) => ({ default: m.ChannelSettingsPage })),
);
const MediaViewerPage = lazy(() =>
  import('./pages/messaging/MediaViewerPage').then((m) => ({ default: m.MediaViewerPage })),
);
const AiChatPage = lazy(() =>
  import('./pages/messaging/AiChatPage').then((m) => ({ default: m.AiChatPage })),
);

// Regulatory field capture + report surface (FARM-HIGH-214 / RPT-019)
const LiceCountPage = lazy(() =>
  import('./pages/lice/LiceCountPage').then((m) => ({ default: m.LiceCountPage })),
);
const WelfareScorePage = lazy(() =>
  import('./pages/welfare/WelfareScorePage').then((m) => ({ default: m.WelfareScorePage })),
);
const EscapeIncidentPage = lazy(() =>
  import('./pages/escape/EscapeIncidentPage').then((m) => ({ default: m.EscapeIncidentPage })),
);
const ReportsPage = lazy(() =>
  import('./pages/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const ReportReviewPage = lazy(() =>
  import('./pages/reports/ReportReviewPage').then((m) => ({ default: m.ReportReviewPage })),
);

// Operations hub sub-pages — enterprise-grade dedicated hubs per ADR-011
const DailyOpsHubPage = lazy(() =>
  import('./pages/operations/DailyOpsHubPage').then((m) => ({ default: m.DailyOpsHubPage })),
);
const StockEventsHubPage = lazy(() =>
  import('./pages/operations/StockEventsHubPage').then((m) => ({ default: m.StockEventsHubPage })),
);
const StaffHubPage = lazy(() =>
  import('./pages/operations/StaffHubPage').then((m) => ({ default: m.StaffHubPage })),
);

function PageLoader(): ReactElement {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-acc" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }): ReactElement {
  const { isAuthenticated, isLoading, isMobileDisabled, user } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-acc" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // SEC: Block PANEL_ONLY users and users with mobile disabled from accessing
  // any protected route. isMobileDisabled is set on login; accessType is a
  // hard server-side restriction for accounts without mobile entitlement.
  if (isMobileDisabled || user?.accessType === 'PANEL_ONLY') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function FeatureRoute({
  feature,
  children,
}: {
  feature: MobileFeature;
  children: React.ReactNode;
}): ReactElement {
  // PERF-03: Reads from context — no independent fetch per FeatureRoute instance.
  // BUG-05: isLoaded is only true after auth has resolved (authLoading guard in provider).
  const { canAccess, isLoaded } = useMobilePermissions();
  const { user } = useAuth();

  if (!isLoaded) {
    return <PageLoader />;
  }

  // SEC-MEDIUM-050: a single gate that enforces the entitlement flag AND any
  // feature role floor (e.g. harvest => MODULE_MANAGER) from the feature-access
  // SSoT. FAIL-CLOSED: no user or a sub-floor role is redirected away, so a
  // MODULE_USER never reaches a form the backend will 403 after submit.
  if (!isFeatureAccessible(canAccess, feature, user?.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export function App(): ReactElement {
  // WHY: Single registration point for all service-worker-to-client navigation
  // events. Must be inside BrowserRouter for useNavigate() access. The SW posts
  // NAVIGATE_TO_CHANNEL when a notification is clicked and an existing window is
  // focused — this hook translates that into a React Router navigation.
  useSwNavigation();

  return (
    <>
      <InstallPrompt />
      {/* PERF-03: MobilePermissionsProvider wraps all protected routes so permissions
          are fetched exactly once and shared to all consumers via context. */}
      <MobilePermissionsProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected routes with mobile layout */}
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                {/* AppShell is the ONE viewport-aware seam: the handheld dock on
                    a phone, the cabin control board on a tablet, swapped live on
                    resize and rotation. Everything below it is shell-agnostic. */}
                <AppShell>
                  {/* FE-HIGH-053: ROUTE-level ErrorBoundary wrapping the lazy
                      Routes + Suspense subtree. A chunk-load rejection or a
                      single-page render crash resets to this recoverable shell
                      (Try-Again) rather than propagating to the root boundary in
                      main.tsx, which is reserved for catastrophic top-of-tree
                      crashes. The 4 hub-page boundaries stay as inner granularity
                      — this composes with them, it does not replace them. */}
                  <ErrorBoundary>
                    <Suspense fallback={<PageLoader />}>
                      <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/tank/:tankId" element={<TankDetailPage2 />} />
                        {/* v4 dock: Units is unguarded (reading the unit list is
                          the baseline field capability); Scan sits behind the
                          union of the log features, since a resolved unit whose
                          every action is denied is a dead end. */}
                        <Route path="/units" element={<UnitsPage />} />
                        {/* The drive surface is UNGATED at the route for the
                          same reason /units is, and the reason is the server's:
                          the VFD read queries on the sensor resolver carry no
                          @Roles, so the drive inventory is a baseline field
                          capability. The COMMANDS are role-floored
                          (@Roles(TENANT_ADMIN, MODULE_MANAGER)), and that floor
                          is enforced on the detail screen where the buttons are
                          — through the same role-rank SSoT the harvest gate
                          uses, so the client never offers a button the server
                          will reject. There is no mobile feature FLAG for
                          drives: allowedFeatures is a server-owned set and this
                          client cannot invent a member of it. */}
                        <Route path="/drives" element={<DrivesPage />} />
                        <Route path="/drives/:vfdDeviceId" element={<DriveDetailPage />} />
                        {/* The tablet control board. Ungated for the same reason
                          /units is: reading unit, alarm and task state is the
                          baseline field capability, and each pane inside it
                          carries the phone's own gating. AppShell owns whether
                          this path is reachable at all — below the board
                          threshold it redirects to Today, so a phone cannot
                          land on a three-column grid. */}
                        <Route path="/board" element={<BoardPage />} />
                        {/* The board's other two views. They are UNGATED at the
                          route for the same reason /board is — and because
                          gating them here would be the wrong layer: the
                          regulatory column inside Reports self-gates on
                          canReach('reports') (the MODULE_MANAGER floor), and the
                          conversations a role may read are already decided
                          server-side by membership. Every path under /board is
                          unreachable below the board threshold: AppShell
                          redirects the whole prefix to Today, so a phone can
                          never land on a multi-column layout. */}
                        <Route path="/board/reports" element={<ReportsBoardPage />} />
                        <Route path="/board/chat" element={<ChatBoardPage />} />
                        <Route
                          path="/scan"
                          element={
                            <MultiFeatureRoute
                              features={[
                                'mortality',
                                'cull',
                                'harvest',
                                'feeding',
                                'transfer',
                                'waterQuality',
                              ]}
                            >
                              <ScanPage />
                            </MultiFeatureRoute>
                          }
                        />
                        {/* New primary routes for the 4-tab navigation */}
                        <Route path="/operations" element={<OperationsHubPage />} />

                        {/* Operations Hub sub-pages — dedicated enterprise hubs (ADR-011) */}
                        <Route
                          path="/operations/daily"
                          element={
                            <MultiFeatureRoute
                              features={['attendance', 'mortality', 'waterQuality', 'feeding']}
                            >
                              <DailyOpsHubPage />
                            </MultiFeatureRoute>
                          }
                        />
                        <Route
                          path="/operations/stock"
                          element={
                            <MultiFeatureRoute features={['cull', 'harvest', 'transfer']}>
                              <StockEventsHubPage />
                            </MultiFeatureRoute>
                          }
                        />
                        <Route
                          path="/operations/warehouse"
                          element={
                            <FeatureRoute feature="storage">
                              <StorageHubPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/operations/staff"
                          element={
                            <MultiFeatureRoute features={['attendance', 'leave', 'schedule']}>
                              <StaffHubPage />
                            </MultiFeatureRoute>
                          }
                        />

                        {/* Messaging routes — ADR-012 */}
                        <Route path="/messages" element={<ChannelListPage />} />
                        <Route path="/messages/new" element={<NewChatPage />} />
                        <Route path="/messages/ai/:channelId" element={<AiChatPage />} />
                        <Route path="/messages/:channelId" element={<ChatRoomPage />} />
                        <Route
                          path="/messages/:channelId/media/:attachmentId"
                          element={<MediaViewerPage />}
                        />
                        <Route
                          path="/messages/:channelId/settings"
                          element={<ChannelSettingsPage />}
                        />
                        <Route path="/messages/media/:attachmentId" element={<MediaViewerPage />} />

                        <Route path="/account" element={<AccountPage />} />

                        {/* BUG-16: Backward-compatible redirect: /culling/* -> /cull/*
                          Users and bookmarks may reference the longer "culling" path form
                          (e.g. /mobile/culling/record) which has no matching route, causing
                          the catch-all to redirect to home. Map the common variants so both
                          "cull" and "culling" resolve correctly. */}
                        <Route path="/culling/record/:tankId" element={<CullingToTankRedirect />} />
                        <Route
                          path="/culling/record"
                          element={<Navigate to="/cull/record" replace />}
                        />
                        <Route path="/culling" element={<Navigate to="/cull/record" replace />} />

                        {/* Backward-compatible redirect: old /record tab now goes to /operations */}
                        <Route path="/record" element={<Navigate to="/operations" replace />} />
                        <Route
                          path="/tasks"
                          element={
                            <FeatureRoute feature="tasks">
                              <MyTasksPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/tasks/:taskId"
                          element={
                            <FeatureRoute feature="tasks">
                              <TaskDetailPage />
                            </FeatureRoute>
                          }
                        />
                        {/* Backward-compatible redirects: old HR and More tabs */}
                        <Route path="/hr" element={<Navigate to="/operations" replace />} />
                        <Route path="/more" element={<Navigate to="/account" replace />} />
                        <Route path="/notifications" element={<NotificationsPage />} />
                        <Route path="/alerts" element={<AlertsPage />} />
                        <Route
                          path="/mortality/record"
                          element={
                            <FeatureRoute feature="mortality">
                              <RecordMortalityPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/mortality/record/:tankId"
                          element={
                            <FeatureRoute feature="mortality">
                              <RecordMortalityPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/cull/record"
                          element={
                            <FeatureRoute feature="cull">
                              <RecordCullPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/cull/record/:tankId"
                          element={
                            <FeatureRoute feature="cull">
                              <RecordCullPage />
                            </FeatureRoute>
                          }
                        />
                        {/* SEC-MEDIUM-050: FeatureRoute auto-enforces the harvest
                          MODULE_MANAGER role floor (feature-access SSoT), matching
                          the backend @Roles(TENANT_ADMIN, MODULE_MANAGER) on
                          createHarvestRecord — a MODULE_USER cannot enter the form
                          and hit the after-success 403. */}
                        <Route
                          path="/harvest/record"
                          element={
                            <FeatureRoute feature="harvest">
                              <RecordHarvestPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/harvest/record/:tankId"
                          element={
                            <FeatureRoute feature="harvest">
                              <RecordHarvestPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/feeding/record"
                          element={
                            <FeatureRoute feature="feeding">
                              <RecordFeedingPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/feeding/record/:tankId"
                          element={
                            <FeatureRoute feature="feeding">
                              <RecordFeedingPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/transfer/record"
                          element={
                            <FeatureRoute feature="transfer">
                              <RecordTransferPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/transfer/record/:tankId"
                          element={
                            <FeatureRoute feature="transfer">
                              <RecordTransferPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/water-quality/record"
                          element={
                            <FeatureRoute feature="waterQuality">
                              <WaterQualityRecordPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/water-quality/record/:equipmentId"
                          element={
                            <FeatureRoute feature="waterQuality">
                              <WaterQualityRecordPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/storage"
                          element={
                            <FeatureRoute feature="storage">
                              <StorageHubPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/storage/movement"
                          element={
                            <FeatureRoute feature="storage">
                              <StockMovementPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/storage/transfer"
                          element={
                            <FeatureRoute feature="storage">
                              <StockTransferPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/storage/view"
                          element={
                            <FeatureRoute feature="storage">
                              <StockViewPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/schedule"
                          element={
                            <FeatureRoute feature="schedule">
                              <MySchedulePage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/attendance"
                          element={
                            <FeatureRoute feature="attendance">
                              <AttendancePage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/leave"
                          element={
                            <FeatureRoute feature="leave">
                              <MyLeavesPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/leave/request"
                          element={
                            <FeatureRoute feature="leave">
                              <LeaveRequestPage />
                            </FeatureRoute>
                          }
                        />
                        {/* Regulatory field capture (FARM-HIGH-214 / RPT-019) —
                          offline-first writes into the Phase-2 source entities */}
                        <Route
                          path="/lice/record"
                          element={
                            <FeatureRoute feature="liceCount">
                              <LiceCountPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/lice/record/:tankId"
                          element={
                            <FeatureRoute feature="liceCount">
                              <LiceCountPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/welfare/record"
                          element={
                            <FeatureRoute feature="welfare">
                              <WelfareScorePage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/welfare/record/:tankId"
                          element={
                            <FeatureRoute feature="welfare">
                              <WelfareScorePage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/escape/record"
                          element={
                            <FeatureRoute feature="escape">
                              <EscapeIncidentPage />
                            </FeatureRoute>
                          }
                        />
                        <Route
                          path="/escape/record/:tankId"
                          element={
                            <FeatureRoute feature="escape">
                              <EscapeIncidentPage />
                            </FeatureRoute>
                          }
                        />
                        {/* Reports is UNGATED at the route: it leads with the farm
                          summary, which every field role may read. The regulatory
                          draft section inside self-gates on the same MODULE_MANAGER
                          floor, so a MODULE_USER gets a useful screen rather than a
                          redirect. Review/approve below stays guarded — that one IS
                          manager-only, mirroring the draft resolver's @Roles matrix,
                          and is ONLINE-ONLY because a regulator filing is never
                          queued on the device. */}
                        <Route path="/reports" element={<ReportsPage />} />
                        <Route
                          path="/reports/:draftId"
                          element={
                            <FeatureRoute feature="reports">
                              <ReportReviewPage />
                            </FeatureRoute>
                          }
                        />
                        <Route path="/sync" element={<SyncStatusPage />} />

                        {/* MOB-LOW-001: unknown paths render a 404 page instead of a
                          silent redirect home — broken deep links stay observable
                          (BUG-16 was hidden by the old catch-all). */}
                        <Route path="*" element={<NotFoundPage />} />
                      </Routes>
                    </Suspense>
                  </ErrorBoundary>
                </AppShell>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MobilePermissionsProvider>
    </>
  );
}
