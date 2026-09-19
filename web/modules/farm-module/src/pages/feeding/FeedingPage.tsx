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
 * - Feed stock lives on the Storage page (single stock UI — stock SSoT Phase 2)
 * - Sampling (placeholder)
 */
import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n, type MessageKey, PageHeader } from '@aquaculture/shared-ui';
import { useSiteList } from '../../hooks/useSites';
import { useBatchList, BatchStatus } from '../../hooks/useBatches';

// Shared filter component
import { FeedingFilters } from './components/FeedingFilters';

// Tab Components
import { FeedingRecordsTab } from './components/FeedingRecordsTab';
import { FeedingSummaryTab } from './components/FeedingSummaryTab';
import { GrowthForecastChart } from './components/GrowthForecastChart';
import { FCRAnalysis } from './components/FCRAnalysis';
import { ProtocolBuilderTab } from './components/ProtocolBuilderTab';
import { AssignmentsTab } from './components/AssignmentsTab';
import { MealBoardTab } from './components/MealBoardTab';
import { ForecastTab } from './components/ForecastTab';
import { useProtocolFeedForecast } from '../../hooks/useProtocolFeeding';
import {
  AlignLeft,
  Box,
  Calculator,
  ChartColumn,
  ClipboardList,
  FileChartColumn,
  FileText,
  FlaskConical,
  Presentation,
  Scale,
  TrendingUp,
  TriangleAlert,
  Users,
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

type TabId =
  | 'meal-board'
  | 'forecast'
  | 'records'
  | 'summary'
  | 'growth'
  | 'fcr'
  | 'protocols-v2'
  | 'assignments'
  | 'sampling';

interface Tab {
  id: TabId;
  /** Legacy sekmeler ham ad taşır; YENİ yüzeyler i18n anahtarı kullanır (P-17). */
  name: string;
  i18nKey?: MessageKey;
  icon: React.ReactNode;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_TABS: TabId[] = [
  'meal-board',
  'forecast',
  'records',
  'summary',
  'growth',
  'fcr',
  'protocols-v2',
  'assignments',
  'sampling',
];
const DEFAULT_TAB: TabId = 'meal-board';

/**
 * FeedingFilters'ı gerçekten TÜKETEN sekmeler — meal-board/forecast kendi
 * kapsam seçicilerini taşır, protocols-v2 site/batch bağımsızdır; onlarda
 * filtre çubuğu göstermek ölü UI olur (FARM-LOW-234).
 */
const FILTER_CONSUMING_TABS: TabId[] = ['records', 'summary', 'growth', 'fcr', 'assignments'];

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'meal-board',
    name: 'Meal Board',
    i18nKey: 'feedingV2.tab.mealBoard',
    icon: <AlignLeft className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'forecast',
    name: 'Forecast',
    i18nKey: 'feedingV2.tab.forecast',
    icon: <TrendingUp className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'records',
    name: 'Records',
    icon: <ClipboardList className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'summary',
    name: 'Summary',
    icon: <FileChartColumn className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'growth',
    name: 'Growth',
    icon: <Presentation className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'fcr',
    name: 'FCR',
    icon: <ChartColumn className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'protocols-v2',
    name: 'Protocols v2',
    i18nKey: 'feedingV2.tab.builder',
    icon: <FileText className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'assignments',
    name: 'Assignments',
    i18nKey: 'feedingV2.tab.assignments',
    icon: <Users className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'sampling',
    name: 'Sampling',
    icon: <FlaskConical className="w-5 h-5" aria-hidden="true" />,
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
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSiteId, setSelectedSiteId] = React.useState<string>('');
  const [selectedBatchId, setSelectedBatchId] = React.useState<string>('');

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
  const { data: batchesData, isLoading: batchesLoading } = useBatchList(
    {
      siteId: selectedSiteId || undefined,
      status: ['ACTIVE', 'GROWING', 'PRE_HARVEST'] as BatchStatus[],
      isActive: true,
    },
    // Fetch-all: the batch selector previously used the default limit of 20,
    // silently hiding every batch past the 20th.
    { fetchAll: true },
  );

  // Memoize forecast input to prevent stale-time bypass (PERF-003)
  // Faz 8: başlık KPI'ları v2 forecast snapshot'ından okur (K-10 dilimi) —
  // v1 forecast sorgusu emekli. Kapsam D-9 gereği site
  // bazlıdır; site seçilmediyse ilk site okunur (ForecastTab ile aynı kural).
  // Siteler yüklenmeden sorgu ATILMAZ (enabled — FARM-MEDIUM-232).
  const kpiSiteId = selectedSiteId || sitesData?.items?.[0]?.id;
  const { data: kpiForecast, isError: kpiForecastFailed } = useProtocolFeedForecast(kpiSiteId, 30, {
    enabled: !!kpiSiteId,
  });

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
    kpiForecast?.perFeed?.reduce((sum, feed) => {
      return sum + (feed.dailyConsumptionSeries?.[0] ?? 0);
    }, 0) ?? 0;

  const alertCount = kpiForecast?.alerts?.length ?? 0;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 shadow">
        <div className="px-4 sm:px-6 py-6">
          <PageHeader
            title="Feeding Management"
            description="Plan, monitor, and optimize feed consumption across your facilities"
          />
        </div>
      </div>

      {/* Filters — yalnız filtreyi tüketen sekmelerde (FARM-LOW-234) */}
      {FILTER_CONSUMING_TABS.includes(activeTab) && (
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
      )}

      {/* Summary Cards */}
      <div className="px-4 sm:px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Total Biomass */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-blue-100 rounded-lg p-3">
                <Scale className="w-6 h-6 text-blue-600" aria-hidden="true" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Total Biomass
                </p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {(totalBiomass / 1000).toFixed(1)} t
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {totalFishCount.toLocaleString()} fish
                </p>
              </div>
            </div>
          </div>

          {/* Today's Feed */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-green-100 rounded-lg p-3">
                <Calculator className="w-6 h-6 text-green-600" aria-hidden="true" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Today's Feed</p>
                {/* Hata durumunda 0 uydurulmaz — '—' + açık not (FARM-MEDIUM-233). */}
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {kpiForecastFailed ? '—' : `${todaysFeed.toFixed(0)} kg`}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {kpiForecastFailed
                    ? 'Forecast unavailable'
                    : `${totalBiomass > 0 ? ((todaysFeed / totalBiomass) * 100).toFixed(2) : 0}% of biomass`}
                </p>
              </div>
            </div>
          </div>

          {/* Total Stock */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <div className="flex items-center">
              <div className="flex-shrink-0 bg-purple-100 rounded-lg p-3">
                <Box className="w-6 h-6 text-purple-600" aria-hidden="true" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Feed Stock</p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {kpiForecastFailed
                    ? '—'
                    : `${((kpiForecast?.perFeed?.reduce((sum, feed) => sum + feed.currentStockKg, 0) ?? 0) / 1000).toFixed(1)} t`}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {kpiForecastFailed
                    ? 'Forecast unavailable'
                    : `${kpiForecast?.perFeed?.length ?? 0} feed types`}
                </p>
              </div>
            </div>
          </div>

          {/* Alerts */}
          <div
            className={`rounded-lg shadow p-4 ${alertCount > 0 ? 'bg-red-50' : 'bg-white dark:bg-gray-900'}`}
          >
            <div className="flex items-center">
              <div
                className={`flex-shrink-0 rounded-lg p-3 ${alertCount > 0 ? 'bg-red-100' : 'bg-gray-100 dark:bg-gray-800'}`}
              >
                <TriangleAlert
                  className={`w-6 h-6 ${alertCount > 0 ? 'text-red-600' : 'text-gray-600 dark:text-gray-400'}`}
                  aria-hidden="true"
                />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Alerts</p>
                <p
                  className={`text-2xl font-semibold ${alertCount > 0 ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}
                >
                  {kpiForecastFailed ? '—' : alertCount}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {kpiForecastFailed
                    ? 'Forecast unavailable'
                    : alertCount === 0
                      ? 'All good'
                      : 'Action required'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 sm:px-6">
        <div className="border-b border-gray-200 dark:border-gray-700">
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
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
                  }
                `}
              >
                <span
                  className={`mr-2 ${activeTab === tab.id ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-300'}`}
                >
                  {tab.icon}
                </span>
                {tab.i18nKey ? t(tab.i18nKey) : tab.name}
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
        {activeTab === 'meal-board' && <MealBoardTab />}
        {activeTab === 'forecast' && <ForecastTab />}
        {activeTab === 'protocols-v2' && <ProtocolBuilderTab />}
        {activeTab === 'assignments' && <AssignmentsTab siteId={selectedSiteId || undefined} />}
        {/* BUG-023: Sampling tab had no dedicated component — was incorrectly rendering GrowthTab.
            Replaced with a placeholder until a SamplingTab component is implemented. */}
        {activeTab === 'sampling' && (
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-12 text-center">
            <FlaskConical
              className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 mb-4"
              aria-hidden="true"
            />
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">Sampling</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Sampling data entry will be available in a future update.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FeedingPage;
