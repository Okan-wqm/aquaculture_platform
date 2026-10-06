/**
 * Widget Dashboard Page
 *
 * Customizable dashboard with drag-and-drop widgets for sensor data visualization.
 * Uses GridStack for responsive grid layout. Layouts persist per user in the
 * sensor-service dashboard_layouts table through useDashboardLayout inside
 * GridStackDashboard — the page itself holds no layout state.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Activity, Settings } from 'lucide-react';
import { GridStackDashboard } from '../components/dashboard/GridStackDashboard';

// ============================================================================
// Widget Dashboard Page
// ============================================================================

const WidgetDashboardPage: React.FC = () => {
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
        <GridStackDashboard />
      </div>
    </div>
  );
};

export default WidgetDashboardPage;
