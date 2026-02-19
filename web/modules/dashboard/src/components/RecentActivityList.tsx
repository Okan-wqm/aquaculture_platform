/**
 * Recent Activity List Bileşeni
 *
 * Son aktivitelerin listesi.
 */

import React from 'react';
import { Card, Badge, formatRelativeTime } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { SensorIcon, BellIcon, TaskIcon, SettingsIcon, UserIcon } from './icons';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface Activity {
  id: string;
  type: 'sensor' | 'alert' | 'task' | 'system' | 'user';
  title: string;
  description: string;
  timestamp: Date;
  user?: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
}

// ============================================================================
// Mock Data
// ============================================================================

// PERF-H3: These timestamps are intentionally frozen at module load (mock data only).
// When real API data replaces mocks, timestamps will come from the server response
// and will be accurate.
const recentActivities: Activity[] = [
  {
    id: '1',
    type: 'alert',
    title: 'pH Uyarısı',
    description: 'Tank-05 pH seviyesi 8.7\'ye yükseldi',
    timestamp: new Date(Date.now() - 5 * 60 * 1000),
    severity: 'warning',
  },
  {
    id: '2',
    type: 'task',
    title: 'Görev Tamamlandı',
    description: 'Sabah yem kontrolü tamamlandı',
    timestamp: new Date(Date.now() - 30 * 60 * 1000),
    user: 'Ahmet Y.',
    severity: 'success',
  },
  {
    id: '3',
    type: 'sensor',
    title: 'Sensör Bakımı',
    description: 'DO sensörü kalibre edildi - Tank-02',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    user: 'Mehmet K.',
    severity: 'info',
  },
  {
    id: '4',
    type: 'alert',
    title: 'Sıcaklık Kritik',
    description: 'Tank-08 sıcaklık 29°C üzerinde',
    timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000),
    severity: 'error',
  },
  {
    id: '5',
    type: 'system',
    title: 'Sistem Güncellemesi',
    description: 'Yeni özellikler eklendi v2.1.0',
    timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000),
    severity: 'info',
  },
];

// ============================================================================
// Activity İkonları
// ============================================================================

// PERF-L4: use shared icon components instead of duplicating inline SVG bytes
const activityIcons: Record<Activity['type'], React.ReactNode> = {
  sensor: <SensorIcon />,
  alert: <BellIcon />,
  task: <TaskIcon />,
  system: <SettingsIcon />,
  user: <UserIcon />,
};

const severityColors: Record<NonNullable<Activity['severity']>, string> = {
  info: 'bg-blue-100 text-blue-600',
  warning: 'bg-yellow-100 text-yellow-600',
  error: 'bg-red-100 text-red-600',
  success: 'bg-green-100 text-green-600',
};

// ============================================================================
// Recent Activity List
// ============================================================================

const RecentActivityList: React.FC = () => {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Son Aktiviteler</h3>
        {/* BUG-M3: accessible button instead of non-interactive <span> */}
        <button
          type="button"
          className="text-sm text-primary-600 font-medium hover:underline"
          onClick={() => { /* TODO: navigate to /activities */ }}
        >
          Tümünü Gör
        </button>
      </div>
      <div className="divide-y divide-gray-100">
        {recentActivities.map((activity) => (
          <div
            key={activity.id}
            className="px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
          >
            <div className="flex items-start space-x-3">
              {/* İkon */}
              <div
                className={`
                  flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center
                  ${severityColors[activity.severity || 'info']}
                `}
              >
                {activityIcons[activity.type]}
              </div>

              {/* İçerik */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">{activity.title}</p>
                  <span className="text-xs text-gray-400">
                    {formatRelativeTime(activity.timestamp)}
                  </span>
                </div>
                <p className="text-sm text-gray-500 truncate">{activity.description}</p>
                {activity.user && (
                  <p className="text-xs text-gray-400 mt-1">
                    <span className="inline-flex items-center">
                      <UserIcon className="w-3 h-3 mr-1" />
                      {activity.user}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

// PERF-M4: React.memo prevents re-render on parent context changes
export default React.memo(RecentActivityList);
