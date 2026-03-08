import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthContext } from '@aquaculture/shared-ui';
import SetupPage from './pages/SetupPage';
import SolutionPage from './pages/solution/SolutionPage';
import PidSimulatorPage from './pages/pid-simulator/PidSimulatorPage';
// PERF-HYD-002: Provide a single shared nutrient-profiles instance that is
// shared by both SetupPage (NutrientProfileManager) and SolutionPage
// (useLookupValues inside UserOptionsTab / ResultTab).  Previously each call
// site instantiated its own useNutrientProfiles() hook, producing duplicate
// localStorage reads and a stale-read race condition after a save.
import { NutrientProfilesProvider } from './context/NutrientProfilesContext';

/**
 * SEC-HYD-004: Module-level authentication guard.
 *
 * In Module Federation the remote bundle can be fetched and instantiated
 * independently of the shell's route guard. This guard validates that a
 * session exists before rendering any route, providing a secondary enforcement
 * layer that is not bypassable by navigating directly to the remote entry point.
 */
const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Checking session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const HydroponicsModule: React.FC = () => (
  <RequireAuth>
    <NutrientProfilesProvider>
      <Routes>
        <Route index element={<Navigate to="setup" replace />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="solution/*" element={<SolutionPage />} />
        <Route path="pid-simulator" element={<PidSimulatorPage />} />
        <Route path="*" element={<Navigate to="/hydroponics/setup" replace />} />
      </Routes>
    </NutrientProfilesProvider>
  </RequireAuth>
);

export default HydroponicsModule;
