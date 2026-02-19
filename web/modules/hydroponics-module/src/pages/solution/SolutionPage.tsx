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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Nutrient Solution Calculator</h1>
        <p className="text-sm text-gray-500 mt-1">
          Configure nutrient solution parameters for your hydroponic systems
        </p>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-0 -mb-px overflow-x-auto" role="tablist">
          {tabs.map((tab) => {
            const isActive = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => navigate(`/hydroponics/solution/${tab.path}`)}
                className={`
                  whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors
                  ${isActive
                    ? 'border-green-500 text-green-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

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
