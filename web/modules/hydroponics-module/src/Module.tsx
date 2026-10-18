import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from '@aquaculture/shared-ui';
import SetupPage from './pages/SetupPage';
import SolutionPage from './pages/solution/SolutionPage';
import PidSimulatorPage from './pages/pid-simulator/PidSimulatorPage';
// PERF-HYD-002: Provide a single shared nutrient-profiles instance that is
// shared by both SetupPage (NutrientProfileManager) and SolutionPage
// (useLookupValues inside UserOptionsTab / ResultTab).  Previously each call
// site instantiated its own useNutrientProfiles() hook, producing duplicate
// localStorage reads and a stale-read race condition after a save.
import { NutrientProfilesProvider } from './context/NutrientProfilesContext';

/*
 * SEC-HYD-004: module-level authentication guard. In Module Federation the
 * remote bundle can be instantiated independently of the shell's route guard,
 * so the session is re-checked here with the guard family's RequireAuth — the
 * one gate, whose session check shows the one loading screen (FE-MEDIUM-349).
 */

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
