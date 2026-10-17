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
    icon: <SensorIcon />,
  },
  {
    id: 'create-task',
    label: 'Görev Oluştur',
    description: 'Yeni görev',
    path: '/tasks/new',
    icon: <TaskIcon />,
  },
  {
    id: 'new-report',
    label: 'Rapor Oluştur',
    description: 'Yeni rapor',
    path: '/reports/new',
    icon: <FileChartColumn className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'new-process',
    label: 'Süreç Başlat',
    description: 'Yeni süreç',
    // The sensor module is mounted at /sensor and the new-process editor route is
    // `process/new` (singular) — `/processes/new` resolves to no route (blank).
    path: '/sensor/process/new',
    icon: <CirclePlay className="w-5 h-5" aria-hidden="true" />,
  },
  {
    id: 'manage-users',
    label: 'Kullanıcılar',
    description: 'Kullanıcı yönet',
    path: '/admin/users',
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
              border border-gray-200 dark:border-gray-700
              hover:border-primary-300 dark:hover:border-primary-700
              hover:bg-primary-50 dark:hover:bg-primary-900/30 transition-all duration-200
            "
          >
            {/* Industry tile (README §7.7, §7.8): a square hairline box with
                the glyph in the workspace accent. The tiles used to be filled
                circles in one hue each — one of them the `accent` scale, the
                design system's High alarm tier, which paints amber in the
                tenant console: a shortcut is not an alarm. */}
            <div
              data-testid="quick-action-icon"
              className="
                w-10 h-10 rounded flex items-center justify-center
                border border-gray-200 dark:border-gray-700
                text-primary-700 dark:text-primary-300
                group-hover:border-primary-300 dark:group-hover:border-primary-700
                motion-safe:group-hover:scale-110 transition-transform duration-200
              "
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
