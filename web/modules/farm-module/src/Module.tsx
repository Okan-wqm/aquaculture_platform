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
import CleanerFishPage from './pages/cleaner-fish/CleanerFishPage';
import SentinelHubSettingsPage from './pages/settings/SentinelHubSettingsPage';

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

      {/* Cleaner Fish Management - Lumpfish, Wrasse */}
      <Route path="cleaner-fish/*" element={<CleanerFishPage />} />

      {/* Kurulum Sayfası - Sites, Departments, Equipment, Suppliers, Chemicals, Feeds */}
      <Route path="setup/*" element={<SetupPage />} />

      {/* Üretim Sayfası - Batch, Tank Operations, Feeding, Growth */}
      <Route path="production/*" element={<ProductionPage />} />

      {/* Regulatory Reports - Norwegian compliance reports */}
      <Route path="reports/*" element={<ReportsPage />} />

      {/* Ayarlar - Sentinel Hub */}
      <Route path="settings/sentinel-hub" element={<SentinelHubSettingsPage />} />

      {/* Bilinmeyen route'lar -> map'e yönlendir */}
      <Route path="*" element={<Navigate to="/sites/map" replace />} />
    </Routes>
  );
};

export default FarmModule;
