/**
 * Widget Dashboard Page
 *
 * Customizable dashboard with drag-and-drop widgets for sensor data visualization.
 * Uses GridStack for responsive grid layout.
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Activity, Settings } from 'lucide-react';
import { GridStackDashboard, DashboardLayout } from '../components/dashboard/GridStackDashboard';

// ============================================================================
// Types
// ============================================================================

const STORAGE_KEY = 'sensor-dashboard-layout';

// ============================================================================
// Widget Dashboard Page
// ============================================================================

const WidgetDashboardPage: React.FC = () => {
  const [initialLayout, setInitialLayout] = useState<DashboardLayout | undefined>(undefined);
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  // Load saved layout from localStorage
  useEffect(() => {
    try {
      const savedLayout = localStorage.getItem(STORAGE_KEY);
      if (savedLayout) {
        const parsed = JSON.parse(savedLayout) as DashboardLayout;
        setInitialLayout(parsed);
      }
    } catch (error) {
      console.error('Failed to load dashboard layout:', error);
    }
    setLayoutLoaded(true);
  }, []);

  // Handle layout changes
  const handleLayoutChange = (layout: DashboardLayout) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch (error) {
      console.error('Failed to save dashboard layout:', error);
    }
  };

  if (!layoutLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Left: Back and title */}
          <div className="flex items-center gap-4">
            <Link
              to="/sensor"
              className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft size={20} />
              <span className="text-sm">SCADA</span>
            </Link>
            <div className="h-8 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <LayoutGrid size={24} className="text-cyan-600" />
              <div>
                <h1 className="text-xl font-bold text-gray-900">Widget Dashboard</h1>
                <p className="text-xs text-gray-500">
                  Sürükle-bırak özelleştirilebilir sensör gösterge paneli
                </p>
              </div>
            </div>
          </div>

          {/* Right: Navigation */}
          <div className="flex items-center gap-3">
            <Link
              to="/sensor/scada"
              className="flex items-center gap-2 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Activity size={16} />
              <span className="text-sm">SCADA Görünümü</span>
            </Link>
            <Link
              to="/sensor/devices"
              className="flex items-center gap-2 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Settings size={16} />
              <span className="text-sm">Cihazlar</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content - GridStack Dashboard */}
      <div className="flex-1 overflow-hidden">
        <GridStackDashboard
          initialLayout={initialLayout}
          onLayoutChange={handleLayoutChange}
        />
      </div>
    </div>
  );
};

export default WidgetDashboardPage;
