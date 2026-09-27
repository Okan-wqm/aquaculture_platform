import React from 'react';
import { Routes, Route, Navigate, useNavigate, useMatch } from 'react-router-dom';
import { SolutionProvider, useSolution } from '../../context/SolutionContext';
import { useVisibleTabs } from '../../hooks/useVisibleTabs';
import GeneralOptionsTab from './tabs/GeneralOptionsTab';
import WaterAnalysisTab from './tabs/WaterAnalysisTab';
import UserOptionsTab from './tabs/UserOptionsTab';
import ResultTab from './tabs/ResultTab';
import DrainageCompositionTab from './tabs/DrainageCompositionTab';
import PreviousDrainageTab from './tabs/PreviousDrainageTab';
import CurrentNsFormulaTab from './tabs/CurrentNsFormulaTab';
import ReadjustmentSettingsTab from './tabs/ReadjustmentSettingsTab';
import { PageHeader, Tabs } from '@aquaculture/shared-ui';

// Always-visible tabs
const BASE_TAB_COMPONENTS: Record<string, React.FC> = {
  general_options: GeneralOptionsTab,
  water_analysis: WaterAnalysisTab,
  user_options: UserOptionsTab,
  result: ResultTab,
};

// BUG-HYD-007: Adjusting-only tabs are registered separately so they can be
// conditionally mounted based on nsType, preventing writes to undefined state
// slices in standard mode.
const ADJUSTING_TAB_COMPONENTS: Record<string, React.FC> = {
  drainage_composition: DrainageCompositionTab,
  previous_drainage: PreviousDrainageTab,
  current_ns_formula: CurrentNsFormulaTab,
  readjustment: ReadjustmentSettingsTab,
};

const SolutionPageInner: React.FC = () => {
  const navigate = useNavigate();
  // BUG-HYD-011: Use useMatch instead of pathname.split('/').pop() to reliably
  // identify the active tab regardless of trailing slashes or nested routes.
  const tabMatch = useMatch('/hydroponics/solution/:tab');
  const currentTab = tabMatch?.params.tab ?? 'general_options';
  const { mode } = useSolution();
  const tabs = useVisibleTabs(mode);
  const isAdjusting = mode.nsType === 'adjusting';

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Nutrient Solution Calculator"
        description="Configure nutrient solution parameters for your hydroponic systems"
        className="mb-6"
      />

      {/* Tab Bar — each tab is a route; the strip navigates */}
      <Tabs
        items={tabs}
        value={currentTab}
        onChange={(id) => {
          const target = tabs.find((tab) => tab.id === id);
          if (target) navigate(`/hydroponics/solution/${target.path}`);
        }}
        tabsId="hydro-solution"
        aria-label="Nutrient solution steps"
        scrollable
        className="mb-6"
      />

      {/* Tab Content */}
      <Routes>
        <Route index element={<Navigate to="general_options" replace />} />
        {Object.entries(BASE_TAB_COMPONENTS).map(([path, Component]) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {/* BUG-HYD-007: Adjusting-only routes only registered when nsType === 'adjusting'.
            This prevents stale drainageComposition writes contaminating subsequent sessions. */}
        {isAdjusting && Object.entries(ADJUSTING_TAB_COMPONENTS).map(([path, Component]) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {/* Redirect adjusting-only routes back to general_options in non-adjusting mode */}
        {!isAdjusting && Object.keys(ADJUSTING_TAB_COMPONENTS).map((path) => (
          <Route key={path} path={path} element={<Navigate to="/hydroponics/solution/general_options" replace />} />
        ))}
      </Routes>
    </div>
  );
};

const SolutionPage: React.FC = () => {
  return (
    <SolutionProvider>
      <SolutionPageInner />
    </SolutionProvider>
  );
};

export default SolutionPage;
