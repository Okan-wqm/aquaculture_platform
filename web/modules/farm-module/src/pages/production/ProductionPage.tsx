/**
 * Production Page
 * Main production management page with tabbed navigation for Batch, Tank Operations, Feeding, Growth
 */
import React from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';

// Tab Components
import { BatchInputTab } from './tabs/BatchInputTab';
import { TankOperationsTab } from './tabs/TankOperationsTab';
import { FeedingTab } from './tabs/FeedingTab';
import { GrowthTab } from './tabs/GrowthTab';

interface ProductionTab {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  description: string;
}

const productionTabs: ProductionTab[] = [
  {
    id: 'batch-input',
    label: 'Batch Input',
    path: 'batch-input',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
    description: 'Manage batch entries and allocations',
  },
  {
    id: 'tank-operations',
    label: 'Tank Operations',
    path: 'tank-operations',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
      </svg>
    ),
    description: 'Mortality, culling, transfers and harvests',
  },
  {
    id: 'feeding',
    label: 'Feeding',
    path: 'feeding',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
    description: 'Feed records and inventory',
  },
  {
    id: 'growth',
    label: 'Growth',
    path: 'growth',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
    ),
    description: 'Growth samples and metrics',
  },
];

export const ProductionPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Determine active tab from URL
  const currentPath = location.pathname.split('/').pop() || 'batch-input';
  const activeTab = productionTabs.find(tab => tab.path === currentPath)?.id || 'batch-input';

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/production/${tabPath}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Production Management</h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage batches, tank operations, feeding and growth tracking
              </p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                type="button"
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Reports
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-8 overflow-x-auto" aria-label="Tabs">
            {productionTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.path)}
                className={`
                  group inline-flex items-center py-4 px-1 border-b-2 font-medium text-sm whitespace-nowrap
                  ${activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                <span className={`mr-2 ${activeTab === tab.id ? 'text-blue-500' : 'text-gray-400 group-hover:text-gray-500'}`}>
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
          <Route path="batch-input" element={<BatchInputTab />} />
          <Route path="tank-operations" element={<TankOperationsTab />} />
          <Route path="feeding" element={<FeedingTab />} />
          <Route path="growth" element={<GrowthTab />} />
          <Route path="*" element={<BatchInputTab />} />
        </Routes>
      </div>
    </div>
  );
};

export default ProductionPage;
