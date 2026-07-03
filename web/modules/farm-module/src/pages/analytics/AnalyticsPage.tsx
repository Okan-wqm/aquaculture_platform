/**
 * Farm Analytics Page
 *
 * Tabbed page with performance metrics and operational insights.
 * Follows SetupPage tabbed pattern with nested routes.
 */

import React, { useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Select } from '@aquaculture/shared-ui';
import { TanksAnalyticsTab } from './tabs';

// ============================================================================
// Constants
// ============================================================================

const VALID_DATE_RANGES = ['7days', '30days', '90days', 'year'] as const;
type DateRange = typeof VALID_DATE_RANGES[number];

function safeValidateDateRange(value: string): DateRange {
  return (VALID_DATE_RANGES as readonly string[]).includes(value)
    ? (value as DateRange)
    : '30days';
}

interface AnalyticsTab {
  id: string;
  label: string;
  path: string;
}

const analyticsTabs: AnalyticsTab[] = [
  { id: 'tanks', label: 'Tanks & Ponds', path: 'tanks' },
];

// ============================================================================
// Component
// ============================================================================

const AnalyticsPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [dateRange, setDateRange] = useState<DateRange>('30days');

  const currentPath = location.pathname.split('/').pop() || 'tanks';
  const activeTab = analyticsTabs.find(tab => tab.path === currentPath)?.id || 'tanks';

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/analytics/${tabPath}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
              <p className="mt-1 text-sm text-gray-500">
                Performance metrics and operational insights
              </p>
            </div>
            <div className="mt-4 sm:mt-0">
              <Select
                value={dateRange}
                onChange={(e) => setDateRange(safeValidateDateRange(e.target.value))}
                options={[
                  { value: '7days', label: 'Last 7 Days' },
                  { value: '30days', label: 'Last 30 Days' },
                  { value: '90days', label: 'Last 90 Days' },
                  { value: 'year', label: 'This Year' },
                ]}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-8 overflow-x-auto" aria-label="Tabs">
            {analyticsTabs.map((tab) => (
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
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        <Routes>
          <Route path="tanks" element={<TanksAnalyticsTab dateRange={dateRange} />} />
          <Route path="*" element={<Navigate to="tanks" replace />} />
        </Routes>
      </div>
    </div>
  );
};

export default AnalyticsPage;
