/**
 * Quick Actions Bileşeni
 *
 * Hızlı işlem kısayolları.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Card, useAuthContext } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { PlusIcon, SensorIcon, TaskIcon } from './icons';
import { CirclePlay, FileChartColumn, Users } from 'lucide-react';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface QuickAction {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  color: string;
  /** Minimum role required to see this action */
  minRole?: 'TENANT_ADMIN' | 'SUPER_ADMIN';
}

// ============================================================================
// Quick Actions Data
// ============================================================================

// PERF-L4: use shared icon components for duplicated icons; unique icons remain inline
const quickActions: QuickAction[] = [
  {
    id: 'new-farm',
    label: 'Yeni Çiftlik',
    description: 'Çiftlik ekle',
    path: '/sites/new',
    color: 'bg-blue-500',
    icon: <PlusIcon />,
  },
  {
    id: 'add-sensor',
    label: 'Sensör Ekle',
    description: 'Yeni sensör',
    // Device management lives in the sensor module — the old
    // `/sites/sensors/new` target never had a route and fell through
    // to the farm catch-all (map page).
    path: '/sensor/devices',
    color: 'bg-green-500',
    icon: <SensorIcon />,
  },
  {
    id: 'create-task',
    label: 'Görev Oluştur',
    description: 'Yeni görev',
    path: '/tasks/new',
    color: 'bg-purple-500',
    icon: <TaskIcon />,
  },
  {
    id: 'new-report',
    label: 'Rapor Oluştur',
    description: 'Yeni rapor',
    path: '/reports/new',
    color: 'bg-orange-500',
    icon: <FileChartColumn className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'new-process',
    label: 'Süreç Başlat',
    description: 'Yeni süreç',
    // The sensor module is mounted at /sensor and the new-process editor route is
    // `process/new` (singular) — `/processes/new` resolves to no route (blank).
    path: '/sensor/process/new',
    color: 'bg-teal-500',
    icon: <CirclePlay className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'manage-users',
    label: 'Kullanıcılar',
    description: 'Kullanıcı yönet',
    path: '/admin/users',
    color: 'bg-pink-500',
    // DASH-SEC-004: Admin route only visible to admin roles
    minRole: 'TENANT_ADMIN',
    icon: <Users className="w-5 h-5" aria-hidden="true" />,
  },
];

// ============================================================================
// Role helpers
// ============================================================================

const ROLE_ORDER = ['MODULE_USER', 'MODULE_MANAGER', 'TENANT_ADMIN', 'SUPER_ADMIN'];

function roleAtLeast(userRole: string, minRole: string): boolean {
  return ROLE_ORDER.indexOf(userRole) >= ROLE_ORDER.indexOf(minRole);
}

// ============================================================================
// Quick Actions
// ============================================================================

const QuickActions: React.FC = () => {
  const { user } = useAuthContext();
  const userRole = user?.role ?? 'MODULE_USER';

  // DASH-SEC-004: filter actions by role before rendering
  const visibleActions = quickActions.filter((action) => {
    if (!action.minRole) return true;
    return roleAtLeast(userRole, action.minRole);
  });

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Hızlı İşlemler</h3>
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {visibleActions.map((action) => (
          <Link
            key={action.id}
            to={action.path}
            className="
              group flex flex-col items-center p-3 rounded-lg
              border border-gray-200 hover:border-primary-300
              hover:bg-primary-50 transition-all duration-200
            "
          >
            <div
              className={`
                w-10 h-10 rounded-full flex items-center justify-center
                text-white ${action.color}
                group-hover:scale-110 transition-transform duration-200
              `}
            >
              {action.icon}
            </div>
            <span className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100 text-center">
              {action.label}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">{action.description}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
};

export default React.memo(QuickActions);
