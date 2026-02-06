/**
 * Sites Module (formerly Farm Module)
 *
 * Site yönetimi modülünün ana routing bileşeni.
 * /sites/* route'larını yönetir.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import FarmDetailPage from './pages/FarmDetailPage';
import FarmFormPage from './pages/FarmFormPage';
import SensorDashboardPage from './pages/SensorDashboardPage';
import MapViewPage from './pages/MapViewPage';
import SetupPage from './pages/setup/SetupPage';
import ProductionPage from './pages/production/ProductionPage';
import ReportsPage from './pages/reports/ReportsPage';
import TanksPage from './pages/tanks/TanksPage';
import SentinelHubSettingsPage from './pages/settings/SentinelHubSettingsPage';
import FeedingPage from './pages/feeding/FeedingPage';
import StoragePage from './pages/storage/StoragePage';
import HealthEventsPage from './pages/health/HealthEventsPage';
import HarvestPlansPage from './pages/harvest/HarvestPlansPage';
import TasksPage from './pages/tasks/TasksPage';

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

      {/* Feeding Management - Daily Plan, Growth Forecast, Stock, FCR Analysis */}
      <Route path="feeding/*" element={<FeedingPage />} />

      {/* Storage & Stock Management */}
      <Route path="storage/*" element={<StoragePage />} />

      {/* Kurulum Sayfası - Sites, Departments, Equipment, Suppliers, Chemicals, Feeds */}
      <Route path="setup/*" element={<SetupPage />} />

      {/* Üretim Sayfası - Batch, Tank Operations, Feeding, Growth */}
      <Route path="production/*" element={<ProductionPage />} />

      {/* Regulatory Reports - Norwegian compliance reports */}
      <Route path="reports/*" element={<ReportsPage />} />

      {/* Fish Health Events - Disease tracking, treatment, quarantine */}
      <Route path="health/*" element={<HealthEventsPage />} />

      {/* Harvest Plans - Planning, scheduling, workflow management */}
      <Route path="harvest/*" element={<HarvestPlansPage />} />

      {/* Task Management - Daily tasks, recurring, auto rules, calendar */}
      <Route path="tasks/*" element={<TasksPage />} />

      {/* Ayarlar - Sentinel Hub */}
      <Route path="settings/sentinel-hub" element={<SentinelHubSettingsPage />} />

      {/* Bilinmeyen route'lar -> map'e yönlendir */}
      <Route path="*" element={<Navigate to="/sites/map" replace />} />
    </Routes>
  );
};

export default FarmModule;
