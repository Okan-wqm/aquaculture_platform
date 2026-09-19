import React, { useState } from 'react';
import NutrientProfileManager from './setup/NutrientProfileManager';
import { PageHeader, Tabs, TabPanel } from '@aquaculture/shared-ui';
import { Building2, Plus } from 'lucide-react';

type SetupTab = 'sites' | 'profiles';
const SETUP_TABS: { id: SetupTab; label: string }[] = [
  { id: 'sites', label: 'Sites' },
  { id: 'profiles', label: 'Nutrient Profiles' },
];

const SetupPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SetupTab>('sites');

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Hydroponics Setup"
        description="Manage your hydroponic sites, systems, and nutrient profiles"
        className="mb-6"
      />

      {/* Tab Bar */}
      <Tabs
        items={SETUP_TABS}
        value={activeTab}
        onChange={setActiveTab}
        tabsId="hydro-setup"
        aria-label="Setup sections"
        className="mb-6"
      />

      {/* Tab Content */}
      <TabPanel tabsId="hydro-setup" value="sites" selected={activeTab}>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-8">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-50 mb-4">
              <Building2 className="w-8 h-8 text-green-500" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              No Sites Yet
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-md mx-auto">
              Create your first hydroponic site to start managing systems, growing beds, and
              nutrient solutions.
            </p>
            {/* SEC-HYD-008 / BUG-HYD-014: Sites feature is not yet implemented.
                Button is disabled with a "Coming Soon" indicator instead of a console.log stub. */}
            <button
              disabled
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 rounded-lg cursor-not-allowed"
              title="Sites management is coming soon"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Add Site (Coming Soon)
            </button>
          </div>
        </div>
      </TabPanel>

      <TabPanel tabsId="hydro-setup" value="profiles" selected={activeTab}>
        <NutrientProfileManager />
      </TabPanel>
    </div>
  );
};

export default SetupPage;
