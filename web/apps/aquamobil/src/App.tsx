import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useMobilePermissions, type MobileFeature } from './hooks/useMobilePermissions';
import { MobileLayout } from './layouts/MobileLayout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { RecordMortalityPage } from './pages/mortality/RecordMortalityPage';
import { RecordCullPage } from './pages/cull/RecordCullPage';
import { RecordHarvestPage } from './pages/harvest/RecordHarvestPage';
import { SyncStatusPage } from './pages/sync/SyncStatusPage';
import { MySchedulePage } from './pages/schedule/MySchedulePage';
import { InstallPrompt } from './components/InstallPrompt';

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
  const { canAccess, isLoaded } = useMobilePermissions();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-aqua-500" />
      </div>
    );
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
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected routes with mobile layout */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <MobileLayout>
              <Routes>
                <Route path="/" element={<HomePage />} />
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
                  path="/schedule"
                  element={
                    <FeatureRoute feature="schedule">
                      <MySchedulePage />
                    </FeatureRoute>
                  }
                />
                <Route path="/sync" element={<SyncStatusPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </MobileLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
    </>
  );
}
