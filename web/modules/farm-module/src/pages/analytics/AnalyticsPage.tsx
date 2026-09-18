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
    <div className="sd-page sd-f2">
      {/* Page Header (SUDERRA pattern) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Insights</span>
        <h1 className="sd-page-title">Analytics</h1>
        <span className="sd-page-sub">Performance metrics and operational insights</span>
      </div>
      <div className="sd-actions">
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

      {/* Tab Navigation */}
      <nav className="sd-tabs" aria-label="Tabs">
        {analyticsTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.path)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div>
        <Routes>
          <Route path="tanks" element={<TanksAnalyticsTab dateRange={dateRange} />} />
          <Route path="*" element={<Navigate to="tanks" replace />} />
        </Routes>
      </div>
    </div>
  );
};

export default AnalyticsPage;
