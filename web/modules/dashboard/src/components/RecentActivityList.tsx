/**
 * Recent Activity List Bileseni
 *
 * Son aktivitelerin listesi -- gercek API verisiyle.
 * Alert history + gorev verilerinden birlestirilerek olusturulur.
 */

import React from 'react';
import { Card, Badge, formatRelativeTime, Button } from '@aquaculture/shared-ui';
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
  info: 'bg-info-100 dark:bg-info-900/40 text-info-600 dark:text-info-400',
  warning: 'bg-warning-100 dark:bg-warning-900/40 text-warning-600 dark:text-warning-400',
  error: 'bg-error-100 dark:bg-error-900/40 text-error-600 dark:text-error-400',
  success: 'bg-success-100 dark:bg-success-900/40 text-success-600 dark:text-success-400',
};

// ============================================================================
// Skeleton
// ============================================================================

const ActivitySkeleton: React.FC = () => (
  <div className="px-4 py-3">
    <div className="flex items-start space-x-3 animate-pulse">
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-700" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
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
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Son Aktiviteler</h3>
        {/* BUG-M3: accessible button instead of non-interactive <span> */}
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            /* TODO: navigate to /activities */
          }}
        >
          Tumunu Gor
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {[1, 2, 3, 4].map((i) => (
            <ActivitySkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error State */}
      {isError && (
        <div className="p-8 text-center">
          <p className="text-sm text-error-500 mb-2">Aktiviteler yuklenemedi</p>
          <Button variant="ghost" size="xs" type="button" onClick={() => refetch()}>
            Tekrar Dene
          </Button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isError && (!activities || activities.length === 0) && (
        <div className="p-8 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Henuz aktivite yok</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Sistem aktiviteleri burada gorunecektir.
          </p>
        </div>
      )}

      {/* Activity List */}
      {!isLoading && !isError && activities && activities.length > 0 && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {activities.map((activity) => (
            <div
              key={activity.id}
              className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer"
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
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {activity.title}
                    </p>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formatRelativeTime(activity.timestamp)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                    {activity.description}
                  </p>
                  {activity.user && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
