/**
 * Alerts Summary Bileşeni
 *
 * Aktif uyarıların özet gösterimi.
 */

import React from 'react';
import { Card, Badge, Button, formatRelativeTime } from '@aquaculture/shared-ui';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface Alert {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  timestamp: Date;
  acknowledged: boolean;
}

// ============================================================================
// Mock Data
// ============================================================================

const activeAlerts: Alert[] = [
  {
    id: '1',
    title: 'Sıcaklık Kritik',
    description: 'Tank-08 sıcaklık 29.5°C',
    severity: 'critical',
    source: 'Sensör: TEMP-08',
    timestamp: new Date(Date.now() - 10 * 60 * 1000),
    acknowledged: false,
  },
  {
    id: '2',
    title: 'pH Yüksek',
    description: 'Tank-05 pH 8.7',
    severity: 'warning',
    source: 'Sensör: PH-05',
    timestamp: new Date(Date.now() - 25 * 60 * 1000),
    acknowledged: false,
  },
  {
    id: '3',
    title: 'Oksijen Düşük',
    description: 'Tank-03 DO 5.2 mg/L',
    severity: 'warning',
    source: 'Sensör: DO-03',
    timestamp: new Date(Date.now() - 45 * 60 * 1000),
    acknowledged: true,
  },
];

// ============================================================================
// Severity Konfigürasyonu
// ============================================================================

const severityConfig = {
  critical: {
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    iconColor: 'text-red-600',
    badgeVariant: 'error' as const,
    label: 'Kritik',
  },
  warning: {
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    iconColor: 'text-yellow-600',
    badgeVariant: 'warning' as const,
    label: 'Uyarı',
  },
  info: {
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    iconColor: 'text-blue-600',
    badgeVariant: 'info' as const,
    label: 'Bilgi',
  },
};

// ============================================================================
// Alerts Summary
// ============================================================================

const AlertsSummary: React.FC = () => {
  const criticalCount = activeAlerts.filter((a) => a.severity === 'critical').length;
  const warningCount = activeAlerts.filter((a) => a.severity === 'warning').length;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Aktif Uyarılar</h3>
          <div className="flex items-center space-x-2">
            {criticalCount > 0 && (
              <Badge variant="error">{criticalCount} Kritik</Badge>
            )}
            {warningCount > 0 && (
              <Badge variant="warning">{warningCount} Uyarı</Badge>
            )}
          </div>
        </div>
      </div>

      <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {activeAlerts.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-3">
              <svg
                className="w-6 h-6 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-sm text-gray-500">Aktif uyarı bulunmuyor</p>
          </div>
        ) : (
          activeAlerts.map((alert) => {
            const config = severityConfig[alert.severity];

            return (
              <div
                key={alert.id}
                className={`
                  p-3 hover:bg-gray-50 transition-colors cursor-pointer
                  ${alert.acknowledged ? 'opacity-60' : ''}
                `}
              >
                <div className="flex items-start space-x-3">
                  {/* Severity indicator */}
                  <div
                    className={`
                      flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
                      ${config.bgColor} ${config.iconColor}
                    `}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-900">{alert.title}</p>
                      <Badge variant={config.badgeVariant} size="sm">
                        {config.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-600">{alert.description}</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-gray-400">{alert.source}</span>
                      <span className="text-xs text-gray-400">
                        {formatRelativeTime(alert.timestamp)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                {!alert.acknowledged && (
                  <div className="mt-2 ml-11 flex items-center space-x-2">
                    <Button variant="ghost" size="sm">
                      Onayla
                    </Button>
                    <Button variant="ghost" size="sm">
                      Detay
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {activeAlerts.length > 0 && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <Button variant="ghost" size="sm" fullWidth>
            Tüm Uyarıları Görüntüle
          </Button>
        </div>
      )}
    </Card>
  );
};

export default AlertsSummary;
