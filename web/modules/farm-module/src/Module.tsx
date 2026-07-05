/**
 * Sites Module (formerly Farm Module)
 *
 * Site yönetimi modülünün ana routing bileşeni.
 * /sites/* route'larını yönetir.
 */

import './styles.css';
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useFarmRealtimeStream } from './hooks/useFarmRealtimeStream';
import MapViewPage from './pages/MapViewPage';
import SetupPage from './pages/setup/SetupPage';
import ReportsPage from './pages/reports/ReportsPage';
import TanksPage from './pages/tanks/TanksPage';
import SentinelHubSettingsPage from './pages/settings/SentinelHubSettingsPage';
import FeedingPage from './pages/feeding/FeedingPage';
import FeedingProgramForm from './pages/feeding/FeedingProgramForm';
import StoragePage from './pages/storage/StoragePage';
import HealthEventsPage from './pages/health/HealthEventsPage';
import HarvestPlansPage from './pages/harvest/HarvestPlansPage';
import TasksPage from './pages/tasks/TasksPage';
import CompanyPage from './pages/company/CompanyPage';
import WaterChemistryPage from './pages/water-chemistry/WaterChemistryPage';
import AnalyticsPage from './pages/analytics/AnalyticsPage';
import BatchDetailPage from './pages/production/BatchDetailPage';
import MaintenancePage from './pages/maintenance/MaintenancePage';

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

      {/* Maintenance - Work orders, schedules, spare parts (FARM-MEDIUM-113) */}
      <Route path="maintenance/*" element={<MaintenancePage />} />

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
  );
};

export default FarmModule;
