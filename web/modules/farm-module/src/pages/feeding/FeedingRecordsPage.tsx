/**
 * Feeding Records & Inventory Page
 *
 * Comprehensive feeding record and inventory management with:
 * - Feeding record list with filters (batch, date range)
 * - Create/edit feeding record form
 * - Daily feeding plan view for a batch
 * - Feeding summary (totals, FCR calculation)
 * - Feed inventory management (add, consume, adjust)
 */
import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSiteList } from '../../hooks/useSites';
import { useBatchList, BatchStatus } from '../../hooks/useBatches';
import { FeedingRecordsTab } from './components/FeedingRecordsTab';
import { DailyPlanTab } from './components/DailyPlanTab';
import { FeedingSummaryTab } from './components/FeedingSummaryTab';
import { FeedInventoryTab } from './components/FeedInventoryTab';

// ============================================================================
// TYPES
// ============================================================================

type TabId = 'records' | 'daily-plan' | 'summary' | 'inventory';

interface Tab {
  id: TabId;
  name: string;
  icon: React.ReactNode;
}

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'records',
    name: 'Feeding Records',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    id: 'daily-plan',
    name: 'Daily Plan',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'summary',
    name: 'Summary & FCR',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: 'inventory',
    name: 'Feed Inventory',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
  },
];

// ============================================================================
// COMPONENT
// ============================================================================

const FeedingRecordsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>((searchParams.get('tab') as TabId) || 'records');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');

  // Data fetching
  const { data: sitesData, isLoading: sitesLoading } = useSiteList();
  const { data: batchesData, isLoading: batchesLoading } = useBatchList(
    {
      siteId: selectedSiteId || undefined,
      status: ['ACTIVE'] as BatchStatus[],
    },
  );

  // Tab change handler
  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="px-4 sm:px-6 py-6">
          <div className="md:flex md:items-center md:justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Feeding Records & Inventory
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Track feeding records, daily plans, and manage feed inventory
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 sm:px-6 py-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Site Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Site
              </label>
              <select
                value={selectedSiteId}
                onChange={(e) => {
                  setSelectedSiteId(e.target.value);
                  setSelectedBatchId('');
                }}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                disabled={sitesLoading}
              >
                <option value="">All Sites</option>
                {sitesData?.items?.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </select>
            </div>

            {/* Batch Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Batch
              </label>
              <select
                value={selectedBatchId}
                onChange={(e) => setSelectedBatchId(e.target.value)}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                disabled={batchesLoading}
              >
                <option value="">All Batches</option>
                {batchesData?.items?.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.batchNumber} - {batch.name || 'Unnamed'}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 sm:px-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 overflow-x-auto" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`
                  group inline-flex items-center py-4 px-1 border-b-2 font-medium text-sm whitespace-nowrap
                  ${
                    activeTab === tab.id
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                <span className={`mr-2 ${activeTab === tab.id ? 'text-blue-500' : 'text-gray-400 group-hover:text-gray-500'}`}>
                  {tab.icon}
                </span>
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        {activeTab === 'records' && (
          <FeedingRecordsTab
            siteId={selectedSiteId || undefined}
            batchId={selectedBatchId || undefined}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'daily-plan' && (
          <DailyPlanTab
            siteId={selectedSiteId || undefined}
          />
        )}
        {activeTab === 'summary' && (
          <FeedingSummaryTab
            batchId={selectedBatchId || undefined}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'inventory' && (
          <FeedInventoryTab
            siteId={selectedSiteId || undefined}
            sites={sitesData?.items ?? []}
          />
        )}
      </div>
    </div>
  );
};

export default FeedingRecordsPage;
