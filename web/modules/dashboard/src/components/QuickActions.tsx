/**
 * Quick Actions Bileşeni
 *
 * Hızlı işlem kısayolları.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@aquaculture/shared-ui';

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
}

// ============================================================================
// Quick Actions Data
// ============================================================================

const quickActions: QuickAction[] = [
  {
    id: 'new-farm',
    label: 'Yeni Çiftlik',
    description: 'Çiftlik ekle',
    path: '/sites/new',
    color: 'bg-blue-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    ),
  },
  {
    id: 'add-sensor',
    label: 'Sensör Ekle',
    description: 'Yeni sensör',
    path: '/sites/sensors/new',
    color: 'bg-green-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
      </svg>
    ),
  },
  {
    id: 'create-task',
    label: 'Görev Oluştur',
    description: 'Yeni görev',
    path: '/tasks/new',
    color: 'bg-purple-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    id: 'new-report',
    label: 'Rapor Oluştur',
    description: 'Yeni rapor',
    path: '/reports/new',
    color: 'bg-orange-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'new-process',
    label: 'Süreç Başlat',
    description: 'Yeni süreç',
    path: '/processes/new',
    color: 'bg-teal-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'manage-users',
    label: 'Kullanıcılar',
    description: 'Kullanıcı yönet',
    path: '/admin/users',
    color: 'bg-pink-500',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
  },
];

// ============================================================================
// Quick Actions
// ============================================================================

const QuickActions: React.FC = () => {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">Hızlı İşlemler</h3>
      </div>
      <div className="p-4 grid grid-cols-2 gap-3">
        {quickActions.map((action) => (
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
            <span className="mt-2 text-sm font-medium text-gray-900 text-center">
              {action.label}
            </span>
            <span className="text-xs text-gray-500">{action.description}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
};

export default QuickActions;
