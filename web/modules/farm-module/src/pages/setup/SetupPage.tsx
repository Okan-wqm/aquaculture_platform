/**
 * Farm Setup Page
 * Main setup page with tabbed navigation for Sites, Departments, Equipment, etc.
 */
import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';

// Tab Components (will be imported)
import { SitesTab } from './tabs/SitesTab';
import { DepartmentsTab } from './tabs/DepartmentsTab';
import { SystemsTab } from './tabs/SystemsTab';
import { EquipmentTab } from './tabs/EquipmentTab';
import { SpeciesTab } from './tabs/SpeciesTab';
import { SuppliersTab } from './tabs/SuppliersTab';
import { SlaughterFacilitiesTab } from './tabs/SlaughterFacilitiesTab';
import { ChemicalsTab } from './tabs/ChemicalsTab';
import { ConsumablesTab } from './tabs/ConsumablesTab';
import { FishHealthChemicalsTab } from './tabs/FishHealthChemicalsTab';
import { FeedsTab } from './tabs/FeedsTab';
import { WorkersTab } from './tabs/WorkersTab';
import { PageHeader } from '@aquaculture/shared-ui';
import {
  Box,
  Building2,
  Download,
  FlaskConical,
  Heart,
  Layers,
  LayoutGrid,
  Settings,
  Upload,
  Users,
} from 'lucide-react';

interface SetupTab {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  description: string;
}

const setupTabs: SetupTab[] = [
  {
    id: 'sites',
    label: 'Sites',
    path: 'sites',
    icon: <Building2 className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage farm locations and sites',
  },
  {
    id: 'departments',
    label: 'Departments',
    path: 'departments',
    icon: <LayoutGrid className="w-5 h-5" aria-hidden="true" />,
    description: 'Configure departments within sites',
  },
  {
    id: 'systems',
    label: 'Systems',
    path: 'systems',
    icon: <Layers className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage production systems (RAS, Ponds, etc.)',
  },
  {
    id: 'equipment',
    label: 'Equipment',
    path: 'equipment',
    icon: <Settings className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage tanks, pumps, and other equipment',
  },
  {
    id: 'species',
    label: 'Species',
    path: 'species',
    icon: <Box className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage aquaculture species and optimal conditions',
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    path: 'suppliers',
    icon: <Download className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage equipment and feed suppliers',
  },
  {
    id: 'slaughter-facilities',
    label: 'Slaughter Facilities',
    path: 'slaughter-facilities',
    icon: <Building2 className="w-5 h-5" aria-hidden="true" />,
    description: 'Slaughter facility approval numbers for regulatory reports',
  },
  {
    id: 'chemicals',
    label: 'Chemicals',
    path: 'chemicals',
    icon: <FlaskConical className="w-5 h-5" aria-hidden="true" />,
    description: 'Configure chemicals and treatments',
  },
  {
    id: 'consumables',
    label: 'Consumables',
    path: 'consumables',
    icon: <Box className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage consumable materials and supplies',
  },
  {
    id: 'fish-health',
    label: 'Fish Health',
    path: 'fish-health',
    icon: <Heart className="w-5 h-5" aria-hidden="true" />,
    description: 'Fish health chemicals and treatments',
  },
  {
    id: 'feeds',
    label: 'Feeds',
    path: 'feeds',
    icon: <Box className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage feed types and feeding tables',
  },
  {
    id: 'workers',
    label: 'Workers',
    path: 'workers',
    icon: <Users className="w-5 h-5" aria-hidden="true" />,
    description: 'Manage farm workers and staff',
  },
];

export const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Determine active tab from URL
  const currentPath = location.pathname.split('/').pop() || 'sites';
  const activeTab = setupTabs.find((tab) => tab.path === currentPath)?.id || 'sites';

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/setup/${tabPath}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Page Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 py-6">
          <PageHeader
            title="Farm Setup"
            description="Configure your farm infrastructure, equipment, and resources"
            actions={
              <div className="flex items-center space-x-3">
                <div className="relative group">
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800 cursor-not-allowed"
                  >
                    <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                    Import
                  </button>
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 rounded shadow-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    Coming Soon
                  </span>
                </div>
                <div className="relative group">
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800 cursor-not-allowed"
                  >
                    <Download className="w-4 h-4 mr-2" aria-hidden="true" />
                    Export
                  </button>
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 rounded shadow-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    Coming Soon
                  </span>
                </div>
              </div>
            }
          />
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-8 overflow-x-auto" aria-label="Tabs">
            {setupTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.path)}
                className={`
                  group inline-flex items-center py-4 px-1 border-b-2 font-medium text-sm whitespace-nowrap
                  ${
                    activeTab === tab.id
                      ? 'border-info-500 text-info-600 dark:text-info-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
                  }
                `}
              >
                <span
                  className={`mr-2 ${activeTab === tab.id ? 'text-info-500' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-300'}`}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        <Routes>
          <Route index element={<Navigate to="sites" replace />} />
          <Route path="sites" element={<SitesTab />} />
          <Route path="departments" element={<DepartmentsTab />} />
          <Route path="systems" element={<SystemsTab />} />
          <Route path="equipment" element={<EquipmentTab />} />
          <Route path="species" element={<SpeciesTab />} />
          <Route path="suppliers" element={<SuppliersTab />} />
          <Route path="slaughter-facilities" element={<SlaughterFacilitiesTab />} />
          <Route path="chemicals" element={<ChemicalsTab />} />
          <Route path="consumables" element={<ConsumablesTab />} />
          <Route path="fish-health" element={<FishHealthChemicalsTab />} />
          <Route path="feeds" element={<FeedsTab />} />
          <Route path="workers" element={<WorkersTab />} />
          <Route path="*" element={<Navigate to="sites" replace />} />
        </Routes>
      </div>
    </div>
  );
};

export default SetupPage;
