import React, { useState } from 'react';
import NutrientProfileManager from './setup/NutrientProfileManager';

const SETUP_TABS = [
  { id: 'sites', label: 'Sites' },
  { id: 'profiles', label: 'Nutrient Profiles' },
];

const SetupPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('sites');

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Hydroponics Setup</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage your hydroponic sites, systems, and nutrient profiles
        </p>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-0 -mb-px" role="tablist">
          {SETUP_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
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
      {activeTab === 'sites' && (
        <div className="bg-white rounded-lg border border-gray-200 p-8">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-50 mb-4">
              <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">No Sites Yet</h2>
            <p className="text-sm text-gray-500 mb-6 max-w-md mx-auto">
              Create your first hydroponic site to start managing systems, growing beds, and nutrient solutions.
            </p>
            {/* SEC-HYD-008 / BUG-HYD-014: Sites feature is not yet implemented.
                Button is disabled with a "Coming Soon" indicator instead of a console.log stub. */}
            <button
              disabled
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-400 bg-gray-100 rounded-lg cursor-not-allowed"
              title="Sites management is coming soon"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Site (Coming Soon)
            </button>
          </div>
        </div>
      )}

      {activeTab === 'profiles' && <NutrientProfileManager />}
    </div>
  );
};

export default SetupPage;
