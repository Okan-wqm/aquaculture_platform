/**
 * Feeding Management Page — Unified Feeding Hub (single feeding surface).
 *
 * Single entry point for all feeding management:
 * - Meal Board (daily execution) + Forecast (v2 protocol forecast)
 * - Feeding records (CRUD), Summary (batch FCR/cost), Growth, FCR analysis
 * - Protocol Builder v2 + Assignments
 * - Feed stock lives on the Storage page (single stock UI — stock SSoT Phase 2)
 *
 * CONSOLIDATION NOTE: the former duplicate sidebar entry ("Feed Records &
 * Inventory" → /sites/feeding/records) was removed; that path still works via
 * the Module.tsx redirect to ?tab=records. The never-built Sampling tab was
 * deleted; production/growth now redirects to ?tab=growth.
 *
 * SUDERRA restyle — hub shell only (pagehead / KPI stat cards / underline
 * tabs / filter bar); tab bodies keep their markup and are themed by the
 * scoped legacy-palette compat layer (`.sd-page …` rules in the shell
 * stylesheet) plus SUDERRA chart palettes in the chart components.
 *
 * DATA SOURCES (all real backend — no mocked data on this page):
 * - useSiteList / useBatchList (ACTIVE/GROWING/PRE_HARVEST, fetchAll) —
 *   biomass + fish counts.
 * - useProtocolFeedForecast (v2 snapshot, 30d, site-scoped) — Today's Feed /
 *   Feed Stock / Alerts KPIs; on failure the cards show '—' honestly
 *   (FARM-MEDIUM-233), never invented zeros.
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '@aquaculture/shared-ui';
import { useSiteList } from '../../hooks/useSites';
import { useBatchList, BatchStatus } from '../../hooks/useBatches';

// Shared filter component
import { FeedingFilters } from './components/FeedingFilters';

// KPI header (SUDERRA stat cards)
import { FeedingKpiCards } from './components/FeedingKpiCards';

// Tab components
import { FeedingRecordsTab } from './components/FeedingRecordsTab';
import { FeedingSummaryTab } from './components/FeedingSummaryTab';
import { GrowthForecastChart } from './components/GrowthForecastChart';
import { FCRAnalysis } from './components/FCRAnalysis';
import { ProtocolBuilderTab } from './components/ProtocolBuilderTab';
import { AssignmentsTab } from './components/AssignmentsTab';
import { MealBoardTab } from './components/MealBoardTab';
import { ForecastTab } from './components/ForecastTab';
import { useProtocolFeedForecast } from '../../hooks/useProtocolFeeding';

// Tab registry (ids, i18n labels, icons) — extracted config
import {
  feedingTabs,
  isValidTab,
  DEFAULT_TAB,
  FILTER_CONSUMING_TABS,
  type TabId,
} from './feedingTabs';

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

  // KPI forecast input (PERF-003 memoization; Faz 8 K-10: v2 snapshot only,
  // legacy feedConsumptionForecast retired). Site-scoped (D-9): first site
  // when none selected; the query is NOT fired before sites load
  // (FARM-MEDIUM-232).
  const kpiSiteId = selectedSiteId || sitesData?.items?.[0]?.id;
  const { data: kpiForecast, isError: kpiForecastFailed } = useProtocolFeedForecast(
    kpiSiteId,
    30,
    { enabled: !!kpiSiteId },
  );

  // KPI values — null on forecast failure so the cards show the honest '—'
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

  const todaysFeedKg = kpiForecastFailed
    ? null
    : (kpiForecast?.perFeed?.reduce((sum, feed) => {
        return sum + (feed.dailyConsumptionSeries?.[0] ?? 0);
      }, 0) ?? 0);

  const feedStockKg = kpiForecastFailed
    ? null
    : (kpiForecast?.perFeed?.reduce((sum, feed) => sum + feed.currentStockKg, 0) ?? 0);

  const feedTypeCount = kpiForecastFailed ? null : (kpiForecast?.perFeed?.length ?? 0);
  const alertCount = kpiForecastFailed ? null : (kpiForecast?.alerts?.length ?? 0);

  return (
    <div className="sd-page">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Environment</span>
        <h1 className="sd-page-title">Feeding Management</h1>
        <span className="sd-page-sub">Plan, monitor, and optimize feed consumption across your facilities</span>
      </div>

      {/* KPI row — SUDERRA stat cards (see FeedingKpiCards for data sources) */}
      <FeedingKpiCards
        totalBiomassKg={totalBiomass}
        totalFishCount={totalFishCount}
        todaysFeedKg={todaysFeedKg}
        feedStockKg={feedStockKg}
        feedTypeCount={feedTypeCount}
        alertCount={alertCount}
      />

      {/* Tabs — SUDERRA underline tabs (URL-synced) */}
      <nav className="sd-tabs" aria-label="Tabs">
        {feedingTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            {t(tab.i18nKey)}
          </button>
        ))}
      </nav>

      {/* Filters — yalnız filtreyi tüketen sekmelerde (FARM-LOW-234) */}
      {FILTER_CONSUMING_TABS.includes(activeTab) && (
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
      )}

      {/* Tab Content */}
      <div>
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
        {activeTab === 'assignments' && (
          <AssignmentsTab siteId={selectedSiteId || undefined} />
        )}
      </div>
    </div>
  );
};

export default FeedingPage;
