/**
 * Alert Summary Widget
 *
 * Real-time alert monitoring widget for the dashboard.
 * Shows active alerts with severity filtering, acknowledgment, and quick actions.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Card, Badge, Button, formatRelativeTime } from '@aquaculture/shared-ui';

// ============================================================================
// Type Definitions
// ============================================================================

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'warning' | 'low' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';

export interface AlertItem {
  id: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  status: AlertStatus;
  source: string;
  farmId?: string;
  farmName?: string;
  pondId?: string;
  pondName?: string;
  sensorId?: string;
  sensorType?: string;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  resolvedAt?: Date;
  resolvedBy?: string;
  occurrenceCount: number;
  ruleId: string;
  ruleName?: string;
  currentValue?: number;
  threshold?: number;
  unit?: string;
  /**
   * DASH-SEC-010: metadata carries arbitrary server-controlled JSON.
   * NEVER render metadata values directly — they must be sanitized before display.
   */
  metadata?: Record<string, unknown>;
}

export interface AlertSummaryWidgetProps {
  /** Alerts to display */
  alerts?: AlertItem[];
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string | null;
  /** Callback when alert is acknowledged */
  onAcknowledge?: (alertId: string) => Promise<void>;
  /** Callback when alert is resolved */
  onResolve?: (alertId: string) => Promise<void>;
  /** Callback when alert is clicked for details */
  onViewDetails?: (alert: AlertItem) => void;
  /** Callback when "View All" is clicked */
  onViewAll?: () => void;
  /** Maximum alerts to display */
  maxAlerts?: number;
  /** Filter by severity */
  severityFilter?: AlertSeverity[];
  /** Filter by status */
  statusFilter?: AlertStatus[];
  /** Show severity filter controls */
  showFilters?: boolean;
  /** Compact mode */
  compact?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Severity Configuration
// ============================================================================

export const severityConfig: Record<
  AlertSeverity,
  {
    bgColor: string;
    borderColor: string;
    iconColor: string;
    badgeVariant: 'error' | 'warning' | 'info' | 'default' | 'success';
    label: string;
    priority: number;
  }
> = {
  critical: {
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    iconColor: 'text-red-600',
    badgeVariant: 'error',
    label: 'Kritik',
    priority: 5,
  },
  high: {
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    iconColor: 'text-orange-600',
    badgeVariant: 'warning',
    label: 'Yüksek',
    priority: 4,
  },
  medium: {
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    iconColor: 'text-yellow-600',
    badgeVariant: 'warning',
    label: 'Orta',
    priority: 3,
  },
  warning: {
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    iconColor: 'text-amber-600',
    badgeVariant: 'warning',
    label: 'Uyari',
    priority: 3,
  },
  low: {
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    iconColor: 'text-blue-600',
    badgeVariant: 'info',
    label: 'Düşük',
    priority: 2,
  },
  info: {
    bgColor: 'bg-gray-50',
    borderColor: 'border-gray-200',
    iconColor: 'text-gray-600',
    badgeVariant: 'default',
    label: 'Bilgi',
    priority: 1,
  },
};

// BUG-L6: severity keys sorted by explicit priority field, not insertion order
const SEVERITY_KEYS_BY_PRIORITY = (Object.keys(severityConfig) as AlertSeverity[]).sort(
  (a, b) => severityConfig[b].priority - severityConfig[a].priority
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Sort alerts by severity and time
 */
export function sortAlerts(alerts: AlertItem[]): AlertItem[] {
  return [...alerts].sort((a, b) => {
    // First by severity priority (higher = more severe)
    const severityDiff =
      severityConfig[b.severity].priority - severityConfig[a.severity].priority;
    if (severityDiff !== 0) return severityDiff;

    // Then by triggered time (newest first)
    return new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime();
  });
}

/**
 * Filter alerts by criteria
 */
export function filterAlerts(
  alerts: AlertItem[],
  severityFilter?: AlertSeverity[],
  statusFilter?: AlertStatus[]
): AlertItem[] {
  return alerts.filter((alert) => {
    if (severityFilter?.length && !severityFilter.includes(alert.severity)) {
      return false;
    }
    if (statusFilter?.length && !statusFilter.includes(alert.status)) {
      return false;
    }
    return true;
  });
}

/**
 * Count alerts by severity
 */
export function countBySeverity(
  alerts: AlertItem[]
): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    warning: 0,
    low: 0,
    info: 0,
  };

  for (const alert of alerts) {
    counts[alert.severity]++;
  }

  return counts;
}

/**
 * Count alerts by status
 */
export function countByStatus(alerts: AlertItem[]): Record<AlertStatus, number> {
  const counts: Record<AlertStatus, number> = {
    active: 0,
    acknowledged: 0,
    resolved: 0,
    suppressed: 0,
  };

  for (const alert of alerts) {
    counts[alert.status]++;
  }

  return counts;
}

// ============================================================================
// Sub-Components
// ============================================================================

interface AlertIconProps {
  severity: AlertSeverity;
  className?: string;
}

export const AlertIcon: React.FC<AlertIconProps> = ({ severity, className = '' }) => {
  const config = severityConfig[severity];

  return (
    <div
      className={`
        flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
        ${config.bgColor} ${config.iconColor}
        ${className}
      `}
      data-testid={`alert-icon-${severity}`}
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
  );
};

interface AlertItemCardProps {
  alert: AlertItem;
  onAcknowledge?: (alertId: string) => Promise<void>;
  onResolve?: (alertId: string) => Promise<void>;
  onViewDetails?: (alert: AlertItem) => void;
  compact?: boolean;
}

export const AlertItemCard: React.FC<AlertItemCardProps> = ({
  alert,
  onAcknowledge,
  onResolve,
  onViewDetails,
  compact = false,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const config = severityConfig[alert.severity];

  // BUG-H5: unmount guard prevents setState on unmounted component
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const handleAcknowledge = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onAcknowledge || isProcessing) return;

    setIsProcessing(true);
    try {
      await onAcknowledge(alert.id);
    } catch {
      // The callback owner (dashboard page) surfaces its own failure UX;
      // the widget's contract is to stay mounted and re-enable the button.
      // Without this catch the rejection escapes the onClick handler as an
      // unhandled promise rejection.
    } finally {
      if (isMounted.current) setIsProcessing(false);
    }
  };

  const handleResolve = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onResolve || isProcessing) return;

    setIsProcessing(true);
    try {
      await onResolve(alert.id);
    } catch {
      // Same contract as handleAcknowledge — never let a callback rejection
      // escape the click handler.
    } finally {
      if (isMounted.current) setIsProcessing(false);
    }
  };

  const handleClick = () => {
    if (onViewDetails) {
      onViewDetails(alert);
    }
  };

  return (
    <div
      className={`
        p-3 hover:bg-gray-50 transition-colors cursor-pointer
        ${alert.status === 'acknowledged' ? 'opacity-60' : ''}
        ${alert.status === 'resolved' ? 'opacity-40' : ''}
      `}
      onClick={handleClick}
      data-testid={`alert-item-${alert.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className="flex items-start space-x-3">
        <AlertIcon severity={alert.severity} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-900 truncate">{alert.title}</p>
            <Badge variant={config.badgeVariant} size="sm">
              {config.label}
            </Badge>
          </div>

          <p className="text-sm text-gray-600 truncate">{alert.description}</p>

          {!compact && alert.currentValue !== undefined && (
            <p className="text-xs text-gray-500 mt-1">
              Değer: {alert.currentValue}
              {alert.unit} (Eşik: {alert.threshold}
              {alert.unit})
            </p>
          )}

          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-gray-500">{alert.source}</span>
            <span className="text-xs text-gray-500">
              {formatRelativeTime(alert.triggeredAt)}
            </span>
          </div>

          {alert.occurrenceCount > 1 && (
            <span className="text-xs text-orange-600 mt-1 inline-block">
              {alert.occurrenceCount} kez tekrarlandı
            </span>
          )}
        </div>
      </div>

      {alert.status === 'active' && (onAcknowledge || onResolve) && (
        <div className="mt-2 ml-11 flex items-center space-x-2">
          {onAcknowledge && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAcknowledge}
              disabled={isProcessing}
              data-testid={`acknowledge-btn-${alert.id}`}
            >
              {isProcessing ? 'İşleniyor...' : 'Onayla'}
            </Button>
          )}
          {onResolve && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResolve}
              disabled={isProcessing}
              data-testid={`resolve-btn-${alert.id}`}
            >
              {isProcessing ? 'İşleniyor...' : 'Çöz'}
            </Button>
          )}
          {onViewDetails && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onViewDetails(alert);
              }}
              data-testid={`details-btn-${alert.id}`}
            >
              Detay
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

interface SeverityFilterProps {
  selectedSeverities: AlertSeverity[];
  onFilterChange: (severities: AlertSeverity[]) => void;
  alertCounts: Record<AlertSeverity, number>;
}

export const SeverityFilter: React.FC<SeverityFilterProps> = ({
  selectedSeverities,
  onFilterChange,
  alertCounts,
}) => {
  const toggleSeverity = (severity: AlertSeverity) => {
    if (selectedSeverities.includes(severity)) {
      onFilterChange(selectedSeverities.filter((s) => s !== severity));
    } else {
      onFilterChange([...selectedSeverities, severity]);
    }
  };

  return (
    <div className="flex flex-wrap gap-1" data-testid="severity-filter">
      {/* BUG-L6: use explicit priority-sorted keys, not insertion order */}
      {SEVERITY_KEYS_BY_PRIORITY.map((severity) => {
        const config = severityConfig[severity];
        const isSelected = selectedSeverities.includes(severity);
        const count = alertCounts[severity];

        return (
          <button
            key={severity}
            type="button"
            onClick={() => toggleSeverity(severity)}
            className={`
              px-2 py-1 text-xs rounded-full transition-colors
              ${isSelected ? `${config.bgColor} ${config.iconColor}` : 'bg-gray-100 text-gray-500'}
              ${count === 0 ? 'opacity-50' : ''}
            `}
            data-testid={`filter-${severity}`}
          >
            {config.label} ({count})
          </button>
        );
      })}
    </div>
  );
};

interface EmptyStateProps {
  message?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  message = 'Aktif uyarı bulunmuyor',
}) => (
  <div className="p-8 text-center" data-testid="empty-state">
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
    <p className="text-sm text-gray-500">{message}</p>
  </div>
);

interface LoadingStateProps {
  count?: number;
}

export const LoadingState: React.FC<LoadingStateProps> = ({ count = 3 }) => (
  <div className="p-4 space-y-3" data-testid="loading-state">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="animate-pulse flex space-x-3">
        <div className="w-8 h-8 bg-gray-200 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-gray-200 rounded w-3/4" />
          <div className="h-3 bg-gray-200 rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

// DASH-SEC-007: Map error codes/messages to safe, generic user-facing strings.
// Never render raw backend error strings — they may contain stack traces,
// SQL fragments, or internal IDs. Accept either a code or an arbitrary message
// and return a known safe display string.
const SAFE_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Oturum süreniz doldu. Lütfen tekrar giriş yapın.',
  FORBIDDEN: 'Bu işlem için yetkiniz bulunmamaktadır.',
  NOT_FOUND: 'İstenen kaynak bulunamadı.',
  NETWORK_ERROR: 'Sunucuya bağlanılamadı. Lütfen bağlantınızı kontrol edin.',
  TIMEOUT: 'İstek zaman aşımına uğradı. Lütfen tekrar deneyin.',
  GRAPHQL_ERROR: 'Veri yüklenirken bir hata oluştu.',
  REFRESH_FAILED: 'Oturum yenilenemedi. Lütfen tekrar giriş yapın.',
};

const GENERIC_ERROR_MESSAGE = 'Uyarılar yüklenirken bir hata oluştu. Lütfen tekrar deneyin.';

/**
 * Return a safe, user-facing display string for an error.
 * The input may be a backend error code (matched against SAFE_ERROR_MESSAGES)
 * or an arbitrary message string — in either case we never show it raw.
 */
function toSafeErrorMessage(raw: string): string {
  // Check if the raw value is a known error code key
  if (Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, raw)) {
    return SAFE_ERROR_MESSAGES[raw];
  }
  // Check if the raw value contains a known code keyword
  for (const [code, safeMsg] of Object.entries(SAFE_ERROR_MESSAGES)) {
    if (raw.toUpperCase().includes(code)) {
      return safeMsg;
    }
  }
  return GENERIC_ERROR_MESSAGE;
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="p-8 text-center" data-testid="error-state">
    <div className="mx-auto w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-3">
      <svg
        className="w-6 h-6 text-red-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
    {/* DASH-SEC-007: never render raw backend error string — map to safe message */}
    <p className="text-sm text-red-600 mb-2">{toSafeErrorMessage(message)}</p>
    {onRetry && (
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Tekrar Dene
      </Button>
    )}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const AlertSummaryWidget: React.FC<AlertSummaryWidgetProps> = ({
  alerts = [],
  isLoading = false,
  error = null,
  onAcknowledge,
  onResolve,
  onViewDetails,
  onViewAll,
  maxAlerts = 10,
  severityFilter: initialSeverityFilter,
  statusFilter = ['active', 'acknowledged'],
  showFilters = true,
  compact = false,
  className = '',
}) => {
  const [selectedSeverities, setSelectedSeverities] = useState<AlertSeverity[]>(
    initialSeverityFilter || []
  );

  // Filter and sort alerts
  const processedAlerts = useMemo(() => {
    let result = filterAlerts(alerts, selectedSeverities, statusFilter);
    result = sortAlerts(result);
    return result.slice(0, maxAlerts);
  }, [alerts, selectedSeverities, statusFilter, maxAlerts]);

  // Count by severity for filter display
  const severityCounts = useMemo(() => countBySeverity(alerts), [alerts]);

  // PERF-M2: derive active/acknowledged counts from a single countByStatus memo
  // instead of two separate O(n) filter passes
  const statusCounts = useMemo(() => countByStatus(alerts), [alerts]);
  const activeCount = statusCounts.active;
  const acknowledgedCount = statusCounts.acknowledged;

  const criticalCount = severityCounts.critical;
  const highCount = severityCounts.high;

  const handleFilterChange = useCallback((severities: AlertSeverity[]) => {
    setSelectedSeverities(severities);
  }, []);

  return (
    <Card className={className} data-testid="alert-summary-widget">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Aktif Uyarılar</h3>
          <div className="flex items-center space-x-2">
            {criticalCount > 0 && (
              <Badge variant="error" data-testid="critical-count">
                {criticalCount} Kritik
              </Badge>
            )}
            {highCount > 0 && (
              <Badge variant="warning" data-testid="high-count">
                {highCount} Yüksek
              </Badge>
            )}
            {activeCount === 0 && acknowledgedCount === 0 && (
              <Badge variant="success" data-testid="no-alerts">
                Temiz
              </Badge>
            )}
          </div>
        </div>

        {/* Severity Filters */}
        {showFilters && !isLoading && alerts.length > 0 && (
          <div className="mt-2">
            <SeverityFilter
              selectedSeverities={selectedSeverities}
              onFilterChange={handleFilterChange}
              alertCounts={severityCounts}
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} />
        ) : processedAlerts.length === 0 ? (
          <EmptyState
            message={
              selectedSeverities.length > 0
                ? 'Seçili kriterlere uygun uyarı bulunamadı'
                : 'Aktif uyarı bulunmuyor'
            }
          />
        ) : (
          processedAlerts.map((alert) => (
            <AlertItemCard
              key={alert.id}
              alert={alert}
              onAcknowledge={onAcknowledge}
              onResolve={onResolve}
              onViewDetails={onViewDetails}
              compact={compact}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {!isLoading && !error && alerts.length > 0 && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              Toplam: {alerts.length} uyarı ({activeCount} aktif, {acknowledgedCount}{' '}
              onaylı)
            </span>
            {onViewAll && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onViewAll}
                data-testid="view-all-btn"
              >
                Tümünü Görüntüle
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
};

export default AlertSummaryWidget;
