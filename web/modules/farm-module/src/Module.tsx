/**
 * Sites Module (formerly Farm Module)
 *
 * Site yönetimi modülünün ana routing bileşeni.
 * /sites/* route'larını yönetir.
 */

import './styles.css';
import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useFarmRealtimeStream } from './hooks/useFarmRealtimeStream';
import { BrandLoader, chartChrome } from '@aquaculture/shared-ui';

// PERF-HIGH-004: every page-level route is code-split with React.lazy so the
// farm-module remote no longer ships all page code (the heavy 8-tab regulatory
// reporting UI in particular) eagerly in one bundle. Each route becomes its own
// async chunk fetched on navigation; a Suspense boundary shows a light fallback
// while the chunk loads.
//
// E2E-FLAKE (sidebar click flakiness): each chunk loader is now a named,
// EXPORTED function shared with its React.lazy call. The shell calls these on
// sidebar hover (see preloadFarmRoute below) so by the time the user clicks,
// the target chunk is already resolved/in-flight and the page renders without
// falling into the Suspense fallback — Playwright's click no longer races a
// chunk download that unmounts the button it just found.
export const preloadEnvironmentPage = () => import('./pages/environment/EnvironmentPage');
export const preloadSetupPage = () => import('./pages/setup/SetupPage');
export const preloadReportsPage = () => import('./pages/reports/ReportsPage');
export const preloadTanksPage = () => import('./pages/tanks/TanksPage');
export const preloadFeedingPage = () => import('./pages/feeding/FeedingPage');
export const preloadStoragePage = () => import('./pages/storage/StoragePage');
export const preloadHealthEventsPage = () => import('./pages/health/HealthEventsPage');
export const preloadHarvestPlansPage = () => import('./pages/harvest/HarvestPlansPage');
export const preloadTasksPage = () => import('./pages/tasks/TasksPage');
export const preloadCompanyPage = () => import('./pages/company/CompanyPage');
export const preloadWaterChemistryPage = () => import('./pages/water-chemistry/WaterChemistryPage');
export const preloadAnalyticsPage = () => import('./pages/analytics/AnalyticsPage');
export const preloadBatchDetailPage = () => import('./pages/production/BatchDetailPage');
export const preloadMaintenancePage = () => import('./pages/maintenance/MaintenancePage');
// From main: the finance page, also code-split to keep the PERF-HIGH-004 budget.
export const preloadFinancePage = () => import('./pages/finance/FinancePage');

const EnvironmentPage = React.lazy(preloadEnvironmentPage);
const SetupPage = React.lazy(preloadSetupPage);
const ReportsPage = React.lazy(preloadReportsPage);
const TanksPage = React.lazy(preloadTanksPage);
const FeedingPage = React.lazy(preloadFeedingPage);
const StoragePage = React.lazy(preloadStoragePage);
const HealthEventsPage = React.lazy(preloadHealthEventsPage);
const HarvestPlansPage = React.lazy(preloadHarvestPlansPage);
const TasksPage = React.lazy(preloadTasksPage);
const CompanyPage = React.lazy(preloadCompanyPage);
const WaterChemistryPage = React.lazy(preloadWaterChemistryPage);
const AnalyticsPage = React.lazy(preloadAnalyticsPage);
const BatchDetailPage = React.lazy(preloadBatchDetailPage);
const MaintenancePage = React.lazy(preloadMaintenancePage);
const FinancePage = React.lazy(preloadFinancePage);

// ============================================================================
// Route preload manifest
// ============================================================================

/**
 * Map the farm-module's route segments (relative to the `/sites` mount the
 * shell gives this remote) to the chunk that renders them. Redirect source
 * segments (`cleaner-fish`, `feeding/records`, …) map to the chunk their
 * Navigate TARGET needs — preloading the source's own chunk would be
 * pointless because no page ever renders there.
 */
type PreloadResult = Promise<unknown>;
type RoutePreloadFn = () => PreloadResult;

const ROUTE_PRELOADS: ReadonlyArray<readonly [prefix: string, preload: RoutePreloadFn]> = [
  // Order matters only where one segment prefixes another; none here do.
  ['/environment', preloadEnvironmentPage],
  ['/setup', preloadSetupPage],
  ['/tanks', preloadTanksPage],
  ['/cleaner-fish', preloadTanksPage], // redirects to /sites/tanks?tab=cleanerFish
  ['/feeding/records', preloadFeedingPage], // redirects to /sites/feeding?tab=records
  ['/feeding/protocols', preloadFeedingPage], // redirects to /sites/feeding?tab=protocols-v2
  ['/feeding', preloadFeedingPage],
  ['/batch', preloadBatchDetailPage],
  ['/water-chemistry', preloadWaterChemistryPage],
  ['/storage', preloadStoragePage],
  ['/production', preloadTanksPage], // production/* redirects into tanks/feeding hubs
  ['/reports', preloadReportsPage],
  ['/health', preloadHealthEventsPage],
  ['/harvest', preloadHarvestPlansPage],
  ['/maintenance', preloadMaintenancePage],
  ['/company', preloadCompanyPage],
  ['/tasks', preloadTasksPage],
  ['/finance', preloadFinancePage],
  ['/analytics', preloadAnalyticsPage],
];

/**
 * Warm the route chunk for a `/sites/...` path before navigation (E2E-FLAKE).
 *
 * Called speculatively — from the shell's sidebar hover, or any future
 * link-prefetch — so the click lands on an already-loaded page instead of a
 * Suspense fallback. Unknown paths are a no-op (nothing to warm); a failed
 * fetch is swallowed because it is speculative: the real navigation re-attempts
 * through React.lazy, where errors belong.
 */
export function preloadFarmRoute(path: string): void {
  // Strip any query (e.g. `/sites/feeding?tab=records`) — matching is on the
  // pathname only — and the shell's `/sites` mount prefix, so the manifest
  // entries can stay identical to the relative routes declared above.
  const pathname = (path.split('?')[0] as string).replace(/\/+$/, '') || '/';
  const relative =
    pathname === '/sites' || pathname.startsWith('/sites/')
      ? pathname.slice('/sites'.length) || '/'
      : pathname;

  for (const [prefix, preload] of ROUTE_PRELOADS) {
    if (relative === prefix || relative.startsWith(`${prefix}/`)) {
      void preload().catch(() => {
        /* Speculative fetch: never surface a network failure as an unhandled
           rejection — navigation itself retries and reports through the lazy
           boundary's error path. */
      });
      return;
    }
  }
}

// ============================================================================
// Sites Module
// ============================================================================

const FarmModule: React.FC = () => {
  // Phase C: connect once to gateway-api `/farms` Socket.IO namespace and
  // invalidate React Query caches when farm domain events arrive from NATS.
  // This is the last link in the real-time pipeline:
  //   farm-service handler → outbox → NATS → FarmNatsBridgeService →
  //   FarmGateway → Socket.IO → this hook → queryClient.invalidateQueries
  //                                       → components re-fetch & re-render
  useFarmRealtimeStream();

  return (
    // A page loading is the one loading screen (BrandLoader, FE-MEDIUM-349).
    <Suspense fallback={<BrandLoader />}>
      <Routes>
        {/* The environment panel is the canonical site-monitoring surface. */}
        <Route index element={<Navigate to="environment" replace />} />
        <Route path="environment" element={<EnvironmentPage />} />
        <Route path="environment/:siteId" element={<EnvironmentPage />} />

        {/* Preserve old bookmarks without keeping the legacy global-layer map active. */}
        <Route path="map" element={<Navigate to="/sites/environment" replace />} />

        {/* Site Detayı — FarmDetailPage removed (was mock data, not connected to API).
          Real site detail lives under Setup > Sites tab; redirect users there. */}
        <Route path=":siteId" element={<Navigate to="/sites/setup/sites" replace />} />

        {/* Yeni Site — FarmFormPage removed (was a stub that discarded user input).
          Site creation happens inside SetupPage > SitesTab via SiteFormModal. */}
        <Route path="new" element={<Navigate to="/sites/setup/sites" replace />} />

        {/* Site Düzenleme — same cleanup as above */}
        <Route path=":siteId/edit" element={<Navigate to="/sites/setup/sites" replace />} />

        {/* Sensör izleme sensor-module'ün sorumluluğu — buradaki mock
          SensorDashboardPage kaldırıldı (FARM-MEDIUM-114). Eski
          linkler canlı sensör modülüne gitsin. */}
        <Route path="sensors/*" element={<Navigate to="/sensor" replace />} />
        <Route path=":siteId/sensors" element={<Navigate to="/sensor" replace />} />

        {/* Tanks & Ponds Listesi */}
        <Route path="tanks" element={<TanksPage />} />

        {/* Batch Detail — closes FE-HIGH-002 (BatchInputTab.tsx:218 navigated
          to /sites/batch/:id with no Route in place; clicks silently
          landed on the catch-all /sites/map). The page hosts three tabs
          (Overview / Tanks / Feeding) that wire the four orphan Tier 1
          modals (Close / UpdateStatus / AllocateToTank / AssignFeeds —
          FE-MEDIUM-001). Trailing /* lets the tab routes handle their
          own sub-paths. */}
        <Route path="batch/:batchId/*" element={<BatchDetailPage />} />

        {/* Cleaner Fish - redirect to Tanks page Cleaner Fish tab */}
        <Route
          path="cleaner-fish/*"
          element={<Navigate to="/sites/tanks?tab=cleanerFish" replace />}
        />

        {/* Faz 8: v1 program editörü emekli — v2 protokol builder'a yönlendir */}
        <Route
          path="feeding/protocols/new"
          element={<Navigate to="/sites/feeding?tab=protocols-v2" replace />}
        />
        <Route
          path="feeding/protocols/:programId/edit"
          element={<Navigate to="/sites/feeding?tab=protocols-v2" replace />}
        />

        {/* Feeding Records - redirect to unified hub */}
        <Route
          path="feeding/records"
          element={<Navigate to="/sites/feeding?tab=records" replace />}
        />
        <Route
          path="feeding/records/*"
          element={<Navigate to="/sites/feeding?tab=records" replace />}
        />

        {/* Feeding Management - Daily Plan, Growth Forecast, Stock, FCR Analysis */}
        <Route path="feeding/*" element={<FeedingPage />} />

        {/* Water Chemistry - Water quality monitoring and analysis */}
        <Route path="water-chemistry/*" element={<WaterChemistryPage />} />

        {/* Storage & Stock Management */}
        <Route path="storage/*" element={<StoragePage />} />

        {/* Kurulum Sayfası - Sites, Departments, Equipment, Suppliers, Chemicals, Feeds */}
        <Route path="setup/*" element={<SetupPage />} />

        {/* Production redirects (page removed, content moved to Tanks & Feeding) */}
        <Route path="production/batch-input" element={<Navigate to="/sites/tanks" replace />} />
        <Route path="production/feeding" element={<Navigate to="/sites/feeding" replace />} />
        <Route
          path="production/growth"
          element={<Navigate to="/sites/feeding?tab=sampling" replace />}
        />
        <Route path="production/*" element={<Navigate to="/sites/tanks" replace />} />

        {/* Regulatory Reports - Norwegian compliance reports */}
        <Route path="reports/*" element={<ReportsPage />} />

        {/* Fish Health Events - Disease tracking, treatment, quarantine */}
        <Route path="health/*" element={<HealthEventsPage />} />

        {/* Harvest Plans - Planning, scheduling, workflow management */}
        <Route path="harvest/*" element={<HarvestPlansPage />} />

        {/* Maintenance - Work orders, schedules, spare parts (FARM-MEDIUM-113) */}
        <Route path="maintenance/*" element={<MaintenancePage />} />

        {/* Company Information - Top-level company page */}
        <Route path="company" element={<CompanyPage />} />

        {/* Task Management - Daily tasks, recurring, auto rules, calendar */}
        <Route path="tasks/*" element={<TasksPage />} />

        {/* Finance - Operational cost/revenue ledger, categories, charts */}
        <Route path="finance/*" element={<FinancePage />} />

        {/* Analytics - Performance metrics and insights */}
        <Route path="analytics/*" element={<AnalyticsPage />} />

        {/* Bilinmeyen route'lar -> environment paneline yönlendir */}
        <Route path="*" element={<Navigate to="/sites/environment" replace />} />
      </Routes>
    </Suspense>
  );
};

export default FarmModule;
