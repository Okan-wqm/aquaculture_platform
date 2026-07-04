/**
 * Feeding Management Page — Unified Feeding Hub
 *
 * Single entry point for all feeding management:
 * - Daily feeding plan (calculated per-tank plan + feed forecast)
 * - Daily execution (manual actual-fed entry + planned vs actual variance)
 * - Feeding records (CRUD)
 * - Feeding summary (batch FCR, cost, feed type breakdown)
 * - Growth forecast visualization
 * - FCR analysis (cross-batch comparison)
 * - Feeding protocols (most mature)
 * - Feed inventory management
 * - Sampling (placeholder)
 */
import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSiteList } from '../../hooks/useSites';
import { useBatchList, BatchStatus } from '../../hooks/useBatches';
import { useFeedConsumptionForecast } from '../../hooks/useFeeding';

// Shared filter component
import { FeedingFilters } from './components/FeedingFilters';

// Tab Components
import { DailyFeedPlan } from './components/DailyFeedPlan';
import { PlannedVsActualSection } from './components/PlannedVsActualSection';
import { DailyPlanTab } from './components/DailyPlanTab';
import { FeedingRecordsTab } from './components/FeedingRecordsTab';
import { FeedingSummaryTab } from './components/FeedingSummaryTab';
import { GrowthForecastChart } from './components/GrowthForecastChart';
import { FCRAnalysis } from './components/FCRAnalysis';
import { ProtocolsTab } from './components/ProtocolsTab';
import { FeedInventoryTab } from './components/FeedInventoryTab';

// ============================================================================
// TYPES
// ============================================================================

type TabId =
  | 'daily-plan'
  | 'execution'
  | 'records'
  | 'summary'
  | 'growth'
  | 'fcr'
  | 'protocols'
  | 'inventory'
  | 'sampling';

interface Tab {
  id: TabId;
  name: string;
  icon: React.ReactNode;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_TABS: TabId[] = [
  'daily-plan',
  'execution',
  'records',
  'summary',
  'growth',
  'fcr',
  'protocols',
  'inventory',
  'sampling',
];
const DEFAULT_TAB: TabId = 'daily-plan';

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'daily-plan',
    name: 'Daily Plan',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
        />
      </svg>
    ),
  },
  {
    id: 'execution',
    name: 'Daily Execution',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    id: 'records',
    name: 'Records',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
        />
      </svg>
    ),
  },
  {
    id: 'summary',
    name: 'Summary',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    ),
  },
  {
    id: 'growth',
    name: 'Growth',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
        />
      </svg>
    ),
  },
  {
    id: 'fcr',
    name: 'FCR',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    ),
  },
  {
    id: 'protocols',
    name: 'Protocols',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
      </svg>
    ),
  },
  {
    id: 'inventory',
    name: 'Inventory',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
        />
      </svg>
    ),
  },
  {
    id: 'sampling',
    name: 'Sampling',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
        />
      </svg>
    ),
  },
];

// ============================================================================
// HELPERS
// ============================================================================

function isValidTab(value: string | null): value is TabId {
  return value !== null && VALID_TABS.includes(value as TabId);
}

// ============================================================================
// COMPONENT
// ============================================================================

const FeedingPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSiteId, setSelectedSiteId] = React.useState<string>('');
  const [selectedBatchId, setSelectedBatchId] = React.useState<string>('');
  const [forecastDays, setForecastDays] = React.useState<number>(30);

  // Derive active tab from URL — single source of truth for browser back/forward sync
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isValidTab(tabParam) ? tabParam : DEFAULT_TAB;

  // Tab change handler — merge semantics to preserve other query params
  const handleTabChange = (tabId: TabId) => {
    setSearchParams((prev) => {
      prev.set('tab', tabId);
      return prev;
    });
  };

  // Data fetching
  const { data: sitesData, isLoading: sitesLoading } = useSiteList();
  /**
   * Fetch all production-relevant batches for the feeding page.
   * Includes ACTIVE, GROWING, and PRE_HARVEST statuses since all these
   * require feeding. QUARANTINE batches are excluded as they follow
   * separate feeding protocols.
   */
  const { data: batchesData, isLoading: batchesLoading } = useBatchList({
    siteId: selectedSiteId || undefined,
    status: ['ACTIVE', 'GROWING', 'PRE_HARVEST'] as BatchStatus[],
    isActive: true,
  });

  // Memoize forecast input to prevent stale-time bypass (PERF-003)
  const forecastInput = useMemo(
    () => ({ siteId: selectedSiteId || undefined, forecastDays }),
    [selectedSiteId, forecastDays],
  );
  const { data: forecastData, isLoading: forecastLoading } = useFeedConsumptionForecast(
    forecastInput,
    { enabled: activeTab === 'daily-plan' },
  );

  // Calculate summary stats
  const totalBiomass =
    batchesData?.items?.reduce((sum, batch) => {
      const biomass =
        batch.weight?.actual?.totalBiomass ?? batch.weight?.theoretical?.totalBiomass ?? 0;
      return sum + biomass;
    }, 0) ?? 0;

  const totalFishCount =
    batchesData?.items?.reduce((sum, batch) => {
      return sum + (batch.currentQuantity ?? 0);
    }, 0) ?? 0;

  const todaysFeed =
    forecastData?.byFeedType?.reduce((sum, feed) => {
      return sum + (feed.dailyConsumption?.[0] ?? 0);
    }, 0) ?? 0;

  const alertCount = forecastData?.alerts?.length ?? 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="px-4 sm:px-6 py-6">
          <div className="md:flex md:items-center md:justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Feeding Management
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Plan, monitor, and optimize feed consumption across your facilities
              </p>
            </div>

            {/* Forecast Days Selector */}
            <div className="mt-4 flex md:mt-0 md:ml-4 items-center space-x-4">
              <label className="text-sm text-gray-600">Forecast:</label>
              <select
                value={forecastDays}
                onChange={(e) => setForecastDays(Number(e.target.value))}
                className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 sm:px-6 py-4">
        <FeedingFilters
          selectedSiteId={selectedSiteId}
          selectedBatchId={selectedBatchId}
          onSiteChange={setSelectedSiteId}
          onBatchChange={setSelectedBatchId}
          sites={sitesData?.items ?? []}
          batches={batchesData?.items ?? []}
          sitesLoading={sitesLoading}
          batchesLoading={batchesLoading}
        />
      </div>

      {/* Summary Cards */}
      <div className="px-4 sm:px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Total Biomass */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-blue-100 rounded-lg p-3">
                <svg
                  className="w-6 h-6 text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3"
                  />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Total Biomass</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {(totalBiomass / 1000).toFixed(1)} t
                </p>
                <p className="text-xs text-gray-500">{totalFishCount.toLocaleString()} fish</p>
              </div>
            </div>
          </div>

          {/* Today's Feed */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-green-100 rounded-lg p-3">
                <svg
                  className="w-6 h-6 text-green-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Today's Feed</p>
                <p className="text-2xl font-semibold text-gray-900">{todaysFeed.toFixed(0)} kg</p>
                <p className="text-xs text-gray-500">
                  {totalBiomass > 0 ? ((todaysFeed / totalBiomass) * 100).toFixed(2) : 0}% of
                  biomass
                </p>
              </div>
            </div>
          </div>

          {/* Total Stock */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-purple-100 rounded-lg p-3">
                <svg
                  className="w-6 h-6 text-purple-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                  />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Feed Stock</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {((forecastData?.totalCurrentStock ?? 0) / 1000).toFixed(1)} t
                </p>
                <p className="text-xs text-gray-500">
                  {forecastData?.byFeedType?.length ?? 0} feed types
                </p>
              </div>
            </div>
          </div>

          {/* Alerts */}
          <div className={`rounded-lg shadow p-4 ${alertCount > 0 ? 'bg-red-50' : 'bg-white'}`}>
            <div className="flex items-center">
              <div
                className={`flex-shrink-0 rounded-lg p-3 ${alertCount > 0 ? 'bg-red-100' : 'bg-gray-100'}`}
              >
                <svg
                  className={`w-6 h-6 ${alertCount > 0 ? 'text-red-600' : 'text-gray-600'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Alerts</p>
                <p
                  className={`text-2xl font-semibold ${alertCount > 0 ? 'text-red-600' : 'text-gray-900'}`}
                >
                  {alertCount}
                </p>
                <p className="text-xs text-gray-500">
                  {alertCount === 0 ? 'All good' : 'Action required'}
                </p>
              </div>
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
                <span
                  className={`mr-2 ${activeTab === tab.id ? 'text-blue-500' : 'text-gray-400 group-hover:text-gray-500'}`}
                >
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
        {activeTab === 'daily-plan' && (
          <div className="space-y-8">
            {/* Calculated per-tank daily plan (read-only) — what each tank SHOULD
                be fed today, driven by the batch protocol rate SSoT. */}
            <DailyPlanTab siteId={selectedSiteId || undefined} />

            {/* Feed Forecast */}
            {forecastLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
              </div>
            ) : (
              <DailyFeedPlan
                siteId={selectedSiteId}
                batchId={selectedBatchId}
                forecastDays={forecastDays}
                forecastData={forecastData}
              />
            )}
          </div>
        )}
        {activeTab === 'execution' && (
          /* Manual execution entry — what was ACTUALLY fed (RecordFeedingModal),
             with planned-vs-actual variance. This is the operator's write path. */
          <PlannedVsActualSection siteId={selectedSiteId || undefined} />
        )}
        {activeTab === 'records' && (
          <FeedingRecordsTab
            siteId={selectedSiteId || undefined}
            batchId={selectedBatchId || undefined}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'summary' && (
          <FeedingSummaryTab
            batchId={selectedBatchId || undefined}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'growth' && (
          <GrowthForecastChart
            siteId={selectedSiteId}
            batchId={selectedBatchId}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'fcr' && (
          <FCRAnalysis
            siteId={selectedSiteId}
            batchId={selectedBatchId}
            batches={batchesData?.items ?? []}
          />
        )}
        {activeTab === 'protocols' && <ProtocolsTab siteId={selectedSiteId} />}
        {activeTab === 'inventory' && (
          <FeedInventoryTab siteId={selectedSiteId || undefined} sites={sitesData?.items ?? []} />
        )}
        {/* BUG-023: Sampling tab had no dedicated component — was incorrectly rendering GrowthTab.
            Replaced with a placeholder until a SamplingTab component is implemented. */}
        {activeTab === 'sampling' && (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <svg
              className="mx-auto h-12 w-12 text-gray-400 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
              />
            </svg>
            <h3 className="text-lg font-medium text-gray-900 mb-1">Sampling</h3>
            <p className="text-sm text-gray-500">
              Sampling data entry will be available in a future update.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FeedingPage;
