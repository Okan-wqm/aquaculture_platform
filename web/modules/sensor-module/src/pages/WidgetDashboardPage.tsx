/**
 * Widget Dashboard Page
 *
 * Customizable dashboard with drag-and-drop widgets for sensor data visualization.
 * Uses GridStack for responsive grid layout.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Activity, Settings } from 'lucide-react';
import { useAuth, tenantScopedStorageKey, Spinner } from '@aquaculture/shared-ui';
import { GridStackDashboard, DashboardLayout } from '../components/dashboard/GridStackDashboard';

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Widget Dashboard Page
// ============================================================================

const WidgetDashboardPage: React.FC = () => {
  const { tenantId } = useAuth();
  // null when no tenant is resolved → the dashboard degrades to its in-memory
  // default and never reads/writes a shared 'default' bucket (cross-tenant bleed).
  const storageKey = useMemo(
    () => tenantScopedStorageKey('sensor-dashboard-layout', tenantId),
    [tenantId],
  );

  const [initialLayout, setInitialLayout] = useState<DashboardLayout | undefined>(undefined);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  // Load saved layout from localStorage
  useEffect(() => {
    if (!storageKey) {
      setLayoutLoaded(true);
      return;
    }
    try {
      const savedLayout = localStorage.getItem(storageKey);
      if (savedLayout) {
        const parsed = JSON.parse(savedLayout) as DashboardLayout;
        setInitialLayout(parsed);
      }
    } catch (error) {
      console.error('Failed to load dashboard layout:', error);
    }
    setLayoutLoaded(true);
  }, [storageKey]);

  // Handle layout changes
  const handleLayoutChange = (layout: DashboardLayout) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout));
    } catch (error) {
      console.error('Failed to save dashboard layout:', error);
    }
  };

  if (!layoutLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-800">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Left: Back and title */}
          <div className="flex items-center gap-4">
            <Link
              to="/sensor"
              className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              <ArrowLeft size={20} />
              <span className="text-sm">SCADA</span>
            </Link>
            <div className="h-8 w-px bg-gray-200 dark:bg-gray-700" />
            <div className="flex items-center gap-2">
              <LayoutGrid size={24} className="text-info-600 dark:text-info-400" />
              <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  Widget Dashboard
                </h1>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Sürükle-bırak özelleştirilebilir sensör gösterge paneli
                </p>
              </div>
            </div>
          </div>

          {/* Right: Navigation */}
          <div className="flex items-center gap-3">
            <Link
              to="/sensor/scada"
              className="flex items-center gap-2 px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <Activity size={16} />
              <span className="text-sm">SCADA Görünümü</span>
            </Link>
            <Link
              to="/sensor/devices"
              className="flex items-center gap-2 px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <Settings size={16} />
              <span className="text-sm">Cihazlar</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content - GridStack Dashboard */}
      <div className="flex-1 overflow-hidden">
        <GridStackDashboard initialLayout={initialLayout} onLayoutChange={handleLayoutChange} />
      </div>
    </div>
  );
};

export default WidgetDashboardPage;
