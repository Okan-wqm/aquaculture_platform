/**
 * Recent Activity List Bileşeni
 *
 * Son aktivitelerin listesi.
 */

import React from 'react';
import { Card, Badge, formatRelativeTime } from '@aquaculture/shared-ui';

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

const activityIcons: Record<Activity['type'], React.ReactNode> = {
  sensor: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  alert: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
  task: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  system: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  user: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  ),
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
        <span className="text-sm text-primary-600 font-medium cursor-pointer hover:underline">
          Tümünü Gör
        </span>
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
                      <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
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

export default RecentActivityList;
