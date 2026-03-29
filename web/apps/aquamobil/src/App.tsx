import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { MobilePermissionsProvider, useMobilePermissions, type MobileFeature } from './hooks/useMobilePermissions';
import { MobileLayout } from './layouts/MobileLayout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { InstallPrompt } from './components/InstallPrompt';
import { MultiFeatureRoute } from './components/MultiFeatureRoute';

// PERF-02: Lazy-load page components so the initial bundle only contains the
// login and home pages. Feature pages are code-split and loaded on demand.
const RecordMortalityPage = lazy(() =>
  import('./pages/mortality/RecordMortalityPage').then((m) => ({ default: m.RecordMortalityPage }))
);
const RecordCullPage = lazy(() =>
  import('./pages/cull/RecordCullPage').then((m) => ({ default: m.RecordCullPage }))
);
const RecordHarvestPage = lazy(() =>
  import('./pages/harvest/RecordHarvestPage').then((m) => ({ default: m.RecordHarvestPage }))
);
const RecordFeedingPage = lazy(() =>
  import('./pages/feeding/RecordFeedingPage').then((m) => ({ default: m.RecordFeedingPage }))
);
const SyncStatusPage = lazy(() =>
  import('./pages/sync/SyncStatusPage').then((m) => ({ default: m.SyncStatusPage }))
);
const MySchedulePage = lazy(() =>
  import('./pages/schedule/MySchedulePage').then((m) => ({ default: m.MySchedulePage }))
);
const AttendancePage = lazy(() =>
  import('./pages/attendance/AttendancePage').then((m) => ({ default: m.AttendancePage }))
);
const LeaveRequestPage = lazy(() =>
  import('./pages/leave/LeaveRequestPage').then((m) => ({ default: m.LeaveRequestPage }))
);
const MyLeavesPage = lazy(() =>
  import('./pages/leave/MyLeavesPage').then((m) => ({ default: m.MyLeavesPage }))
);

const MyTasksPage = lazy(() =>
  import('./pages/tasks/MyTasksPage').then((m) => ({ default: m.MyTasksPage }))
);
const TaskDetailPage = lazy(() =>
  import('./pages/tasks/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage }))
);
// New primary tab destinations — Operations merges Record + HR, Account replaces More
const OperationsHubPage = lazy(() =>
  import('./pages/operations/OperationsHubPage').then((m) => ({ default: m.OperationsHubPage }))
);
const AccountPage = lazy(() =>
  import('./pages/account/AccountPage').then((m) => ({ default: m.AccountPage }))
);
const NotificationsPage = lazy(() =>
  import('./pages/notifications/NotificationsPage').then((m) => ({ default: m.NotificationsPage }))
);
const RecordTransferPage = lazy(() =>
  import('./pages/transfer/RecordTransferPage').then((m) => ({ default: m.RecordTransferPage }))
);
const WaterQualityRecordPage = lazy(() =>
  import('./pages/water-quality/WaterQualityRecordPage').then((m) => ({ default: m.WaterQualityRecordPage }))
);
// Storage pages — warehouse floor operations for receiving, dispensing, transferring, and viewing stock
const StorageHubPage = lazy(() =>
  import('./pages/storage/StorageHubPage').then((m) => ({ default: m.StorageHubPage }))
);
const StockMovementPage = lazy(() =>
  import('./pages/storage/StockMovementPage').then((m) => ({ default: m.StockMovementPage }))
);
const StockTransferPage = lazy(() =>
  import('./pages/storage/StockTransferPage').then((m) => ({ default: m.StockTransferPage }))
);
const StockViewPage = lazy(() =>
  import('./pages/storage/StockViewPage').then((m) => ({ default: m.StockViewPage }))
);
// BUG-06: Tank detail page — navigated to from TankCard
const TankDetailPage2 = lazy(() =>
  import('./pages/tank/TankDetailPage').then((m) => ({ default: m.TankDetailPage }))
);

// Messaging pages — in-app messaging (ADR-012)
const ChannelListPage = lazy(() =>
  import('./pages/messaging/ChannelListPage').then((m) => ({ default: m.ChannelListPage }))
);
const ChatRoomPage = lazy(() =>
  import('./pages/messaging/ChatRoomPage').then((m) => ({ default: m.ChatRoomPage }))
);
const NewChatPage = lazy(() =>
  import('./pages/messaging/NewChatPage').then((m) => ({ default: m.NewChatPage }))
);
const ChannelSettingsPage = lazy(() =>
  import('./pages/messaging/ChannelSettingsPage').then((m) => ({ default: m.ChannelSettingsPage }))
);
const MediaViewerPage = lazy(() =>
  import('./pages/messaging/MediaViewerPage').then((m) => ({ default: m.MediaViewerPage }))
);

// Operations hub sub-pages — enterprise-grade dedicated hubs per ADR-011
const DailyOpsHubPage = lazy(() =>
  import('./pages/operations/DailyOpsHubPage').then((m) => ({ default: m.DailyOpsHubPage }))
);
const StockEventsHubPage = lazy(() =>
  import('./pages/operations/StockEventsHubPage').then((m) => ({ default: m.StockEventsHubPage }))
);
const StaffHubPage = lazy(() =>
  import('./pages/operations/StaffHubPage').then((m) => ({ default: m.StaffHubPage }))
);

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-aqua-500" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-aqua-500" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function FeatureRoute({ feature, children }: { feature: MobileFeature; children: React.ReactNode }) {
  // PERF-03: Reads from context — no independent fetch per FeatureRoute instance.
  // BUG-05: isLoaded is only true after auth has resolved (authLoading guard in provider).
  const { canAccess, isLoaded } = useMobilePermissions();

  if (!isLoaded) {
    return <PageLoader />;
  }

  if (!canAccess(feature)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export function App() {
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
                <MobileLayout>
                  <Suspense fallback={<PageLoader />}>
                    <Routes>
                      <Route path="/" element={<HomePage />} />
                      <Route path="/tank/:tankId" element={<TankDetailPage2 />} />
                      {/* New primary routes for the 4-tab navigation */}
                      <Route path="/operations" element={<OperationsHubPage />} />

                      {/* Operations Hub sub-pages — dedicated enterprise hubs (ADR-011) */}
                      <Route
                        path="/operations/daily"
                        element={
                          <MultiFeatureRoute features={['attendance', 'mortality', 'waterQuality', 'feeding']}>
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
                      <Route path="/messages/:channelId" element={<ChatRoomPage />} />
                      <Route path="/messages/:channelId/settings" element={<ChannelSettingsPage />} />
                      <Route path="/messages/media/:attachmentId" element={<MediaViewerPage />} />

                      <Route path="/account" element={<AccountPage />} />

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
                      <Route path="/sync" element={<SyncStatusPage />} />

                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </Suspense>
                </MobileLayout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MobilePermissionsProvider>
    </>
  );
}
