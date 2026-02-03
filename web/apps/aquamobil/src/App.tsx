import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { MobileLayout } from './layouts/MobileLayout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { RecordMortalityPage } from './pages/mortality/RecordMortalityPage';
import { RecordCullPage } from './pages/cull/RecordCullPage';
import { RecordHarvestPage } from './pages/harvest/RecordHarvestPage';
import { SyncStatusPage } from './pages/sync/SyncStatusPage';

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

export function App() {
  return (
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
                <Route path="/mortality/record" element={<RecordMortalityPage />} />
                <Route path="/mortality/record/:tankId" element={<RecordMortalityPage />} />
                <Route path="/cull/record" element={<RecordCullPage />} />
                <Route path="/cull/record/:tankId" element={<RecordCullPage />} />
                <Route path="/harvest/record" element={<RecordHarvestPage />} />
                <Route path="/harvest/record/:tankId" element={<RecordHarvestPage />} />
                <Route path="/sync" element={<SyncStatusPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </MobileLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
