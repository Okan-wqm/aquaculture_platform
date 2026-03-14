/**
 * Recent Activity List Bileseni
 *
 * Son aktivitelerin listesi -- gercek API verisiyle.
 * Alert history + gorev verilerinden birlestirilerek olusturulur.
 */

import React from 'react';
import { Card, Badge, formatRelativeTime } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components -- eliminates duplicate inline SVG bytes
import { SensorIcon, BellIcon, TaskIcon, SettingsIcon, UserIcon } from './icons';
import { useRecentActivity } from '../hooks/useDashboardData';
import type { RecentActivity } from '../hooks/useDashboardData';

// ============================================================================
// Activity Ikonlari
// ============================================================================

// PERF-L4: use shared icon components instead of duplicating inline SVG bytes
const activityIcons: Record<RecentActivity['type'], React.ReactNode> = {
  sensor: <SensorIcon />,
  alert: <BellIcon />,
  task: <TaskIcon />,
  system: <SettingsIcon />,
  user: <UserIcon />,
};

const severityColors: Record<NonNullable<RecentActivity['severity']>, string> = {
  info: 'bg-blue-100 text-blue-600',
  warning: 'bg-yellow-100 text-yellow-600',
  error: 'bg-red-100 text-red-600',
  success: 'bg-green-100 text-green-600',
};

// ============================================================================
// Skeleton
// ============================================================================

const ActivitySkeleton: React.FC = () => (
  <div className="px-4 py-3">
    <div className="flex items-start space-x-3 animate-pulse">
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-200" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-gray-200 rounded w-3/4" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    </div>
  </div>
);

// ============================================================================
// Recent Activity List
// ============================================================================

const RecentActivityList: React.FC = () => {
  const { data: activities, isLoading, isError, refetch } = useRecentActivity(8);

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
          Tumunu Gor
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="divide-y divide-gray-100">
          {[1, 2, 3, 4].map((i) => (
            <ActivitySkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error State */}
      {isError && (
        <div className="p-8 text-center">
          <p className="text-sm text-red-500 mb-2">Aktiviteler yuklenemedi</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs text-primary-600 font-medium hover:underline"
          >
            Tekrar Dene
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isError && (!activities || activities.length === 0) && (
        <div className="p-8 text-center">
          <p className="text-sm text-gray-500">Henuz aktivite yok</p>
          <p className="text-xs text-gray-500 mt-1">
            Sistem aktiviteleri burada gorunecektir.
          </p>
        </div>
      )}

      {/* Activity List */}
      {!isLoading && !isError && activities && activities.length > 0 && (
        <div className="divide-y divide-gray-100">
          {activities.map((activity) => (
            <div
              key={activity.id}
              className="px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
            >
              <div className="flex items-start space-x-3">
                {/* Ikon */}
                <div
                  className={`
                    flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center
                    ${severityColors[activity.severity || 'info']}
                  `}
                >
                  {activityIcons[activity.type]}
                </div>

                {/* Icerik */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-900">{activity.title}</p>
                    <span className="text-xs text-gray-500">
                      {formatRelativeTime(activity.timestamp)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 truncate">{activity.description}</p>
                  {activity.user && (
                    <p className="text-xs text-gray-500 mt-1">
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
      )}
    </Card>
  );
};

// PERF-M4: React.memo prevents re-render on parent context changes
export default React.memo(RecentActivityList);
