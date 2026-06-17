/**
 * Sites Module (formerly Farm Module)
 *
 * Site yönetimi modülünün ana routing bileşeni.
 * /sites/* route'larını yönetir.
 */

import './styles.css';
import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useFarmRealtimeStream } from './hooks/useFarmRealtimeStream';
// Only the default landing page (Map) is eager so the landing path has no
// Suspense fallback flash.
import MapViewPage from './pages/MapViewPage';

// fe-eager-imports (FARM-MEDIUM-060): route-level code splitting. Every
// non-landing page — especially the chart-heavy ones (recharts) — is lazy so
// its code stays out of the remote's main chunk and loads on navigation.
// Mirrors the sensor-module precedent. (recharts/lucide are also now MF shared
// singletons via vite.config, so they no longer bundle into this remote.)
const SetupPage = lazy(() => import('./pages/setup/SetupPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const TanksPage = lazy(() => import('./pages/tanks/TanksPage'));
const SentinelHubSettingsPage = lazy(
  () => import('./pages/settings/SentinelHubSettingsPage'),
);
const FeedingPage = lazy(() => import('./pages/feeding/FeedingPage'));
const FeedingProgramForm = lazy(() => import('./pages/feeding/FeedingProgramForm'));
const StoragePage = lazy(() => import('./pages/storage/StoragePage'));
const HealthEventsPage = lazy(() => import('./pages/health/HealthEventsPage'));
const HarvestPlansPage = lazy(() => import('./pages/harvest/HarvestPlansPage'));
const TasksPage = lazy(() => import('./pages/tasks/TasksPage'));
const CompanyPage = lazy(() => import('./pages/company/CompanyPage'));
const WaterChemistryPage = lazy(
  () => import('./pages/water-chemistry/WaterChemistryPage'),
);
const AnalyticsPage = lazy(() => import('./pages/analytics/AnalyticsPage'));
const BatchDetailPage = lazy(() => import('./pages/production/BatchDetailPage'));

/**
 * Suspense fallback for lazily-loaded routes. role="status" + aria-live so
 * assistive tech announces the load (improves on the sensor-module precedent's
 * bare spinner).
 */
function PageLoader(): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-64 items-center justify-center"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
      <span className="sr-only">Yükleniyor…</span>
    </div>
  );
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
    <Suspense fallback={<PageLoader />}>
    <Routes>
      {/* Index -> Map'e yönlendir */}
      <Route index element={<Navigate to="map" replace />} />

      {/* Site Harita Görünümü (Ana Sayfa) */}
      <Route path="map" element={<MapViewPage />} />

      {/* Site Detayı — FarmDetailPage removed (was mock data, not connected to API).
          Real site detail lives under Setup > Sites tab; redirect users there. */}
      <Route path=":siteId" element={<Navigate to="/sites/setup/sites" replace />} />

      {/* Yeni Site — FarmFormPage removed (was a stub that discarded user input).
          Site creation happens inside SetupPage > SitesTab via SiteFormModal. */}
      <Route path="new" element={<Navigate to="/sites/setup/sites" replace />} />

      {/* Site Düzenleme — same cleanup as above */}
      <Route path=":siteId/edit" element={<Navigate to="/sites/setup/sites" replace />} />

      {/* Sensör Dashboard — the farm-module SensorDashboardPage was REMOVED
          (fe-sensor-fake / FARM-CRITICAL-051): it rendered Math.random() mock
          telemetry as LIVE water quality. Real sensor telemetry is owned by
          sensor-module at /sensor; redirect there so no fabricated readings
          can render. Mirrors the FarmDetailPage/FarmFormPage retirement above. */}
      <Route path="sensors" element={<Navigate to="/sensor" replace />} />
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
      <Route path="cleaner-fish/*" element={<Navigate to="/sites/tanks?tab=cleanerFish" replace />} />

      {/* Feeding Management - Protocols (must be before catch-all) */}
      <Route path="feeding/protocols/new" element={<FeedingProgramForm />} />
      <Route path="feeding/protocols/:programId/edit" element={<FeedingProgramForm />} />

      {/* Feeding Records - redirect to unified hub */}
      <Route path="feeding/records" element={<Navigate to="/sites/feeding?tab=records" replace />} />
      <Route path="feeding/records/*" element={<Navigate to="/sites/feeding?tab=records" replace />} />

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
      <Route path="production/growth" element={<Navigate to="/sites/feeding?tab=sampling" replace />} />
      <Route path="production/*" element={<Navigate to="/sites/tanks" replace />} />

      {/* Regulatory Reports - Norwegian compliance reports */}
      <Route path="reports/*" element={<ReportsPage />} />

      {/* Fish Health Events - Disease tracking, treatment, quarantine */}
      <Route path="health/*" element={<HealthEventsPage />} />

      {/* Harvest Plans - Planning, scheduling, workflow management */}
      <Route path="harvest/*" element={<HarvestPlansPage />} />

      {/* Company Information - Top-level company page */}
      <Route path="company" element={<CompanyPage />} />

      {/* Task Management - Daily tasks, recurring, auto rules, calendar */}
      <Route path="tasks/*" element={<TasksPage />} />

      {/* Ayarlar - Sentinel Hub */}
      <Route path="settings/sentinel-hub" element={<SentinelHubSettingsPage />} />

      {/* Analytics - Performance metrics and insights */}
      <Route path="analytics/*" element={<AnalyticsPage />} />

      {/* Bilinmeyen route'lar -> map'e yönlendir */}
      <Route path="*" element={<Navigate to="/sites/map" replace />} />
    </Routes>
    </Suspense>
  );
};

export default FarmModule;
