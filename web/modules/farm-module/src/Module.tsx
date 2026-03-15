/**
 * Sites Module (formerly Farm Module)
 *
 * Site yönetimi modülünün ana routing bileşeni.
 * /sites/* route'larını yönetir.
 */

import './styles.css';
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import FarmDetailPage from './pages/FarmDetailPage';
import FarmFormPage from './pages/FarmFormPage';
import SensorDashboardPage from './pages/SensorDashboardPage';
import MapViewPage from './pages/MapViewPage';
import SetupPage from './pages/setup/SetupPage';
import ReportsPage from './pages/reports/ReportsPage';
import TanksPage from './pages/tanks/TanksPage';
import SentinelHubSettingsPage from './pages/settings/SentinelHubSettingsPage';
import FeedingPage from './pages/feeding/FeedingPage';
import FeedingProgramForm from './pages/feeding/FeedingProgramForm';
import FeedingRecordsPage from './pages/feeding/FeedingRecordsPage';
import StoragePage from './pages/storage/StoragePage';
import HealthEventsPage from './pages/health/HealthEventsPage';
import HarvestPlansPage from './pages/harvest/HarvestPlansPage';
import TasksPage from './pages/tasks/TasksPage';
import CompanyPage from './pages/company/CompanyPage';
import WaterChemistryPage from './pages/water-chemistry/WaterChemistryPage';
import AnalyticsPage from './pages/analytics/AnalyticsPage';

// ============================================================================
// Sites Module
// ============================================================================

const FarmModule: React.FC = () => {
  return (
    <Routes>
      {/* Index -> Map'e yönlendir */}
      <Route index element={<Navigate to="map" replace />} />

      {/* Site Harita Görünümü (Ana Sayfa) */}
      <Route path="map" element={<MapViewPage />} />

      {/* Site Detayı */}
      <Route path=":siteId" element={<FarmDetailPage />} />

      {/* Yeni Site */}
      <Route path="new" element={<FarmFormPage />} />

      {/* Site Düzenleme */}
      <Route path=":siteId/edit" element={<FarmFormPage />} />

      {/* Sensör Dashboard */}
      <Route path="sensors" element={<SensorDashboardPage />} />
      <Route path=":siteId/sensors" element={<SensorDashboardPage />} />

      {/* Tanks & Ponds Listesi */}
      <Route path="tanks" element={<TanksPage />} />

      {/* Cleaner Fish - redirect to Tanks page Cleaner Fish tab */}
      <Route path="cleaner-fish/*" element={<Navigate to="/sites/tanks?tab=cleanerFish" replace />} />

      {/* Feeding Management - Protocols (must be before catch-all) */}
      <Route path="feeding/protocols/new" element={<FeedingProgramForm />} />
      <Route path="feeding/protocols/:programId/edit" element={<FeedingProgramForm />} />

      {/* Feeding Records & Inventory - records, daily plan, summary, inventory */}
      <Route path="feeding/records/*" element={<FeedingRecordsPage />} />

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
  );
};

export default FarmModule;
