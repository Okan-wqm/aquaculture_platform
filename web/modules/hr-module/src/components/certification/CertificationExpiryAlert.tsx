/**
 * Certification Expiry Alert Component
 * Displays expiring and expired certifications with urgency indicators
 */

import React from 'react';
import { AlertCircle, AlertTriangle, Check, ChevronRight, Clock, RefreshCw } from 'lucide-react';
import { cn, Spinner, Button } from '@aquaculture/shared-ui';
import { useExpiringCertifications, useExpiredCertifications } from '../../hooks';
import { getCertificationUrgency, CERTIFICATION_CATEGORY_CONFIG } from '../../types';
import { EmployeeAvatar } from '../common/EmployeeAvatar';

interface CertificationExpiryAlertProps {
  daysUntilExpiry?: number;
  departmentId?: string;
  showExpired?: boolean;
  maxItems?: number;
  onViewAll?: () => void;
  onRenew?: (certificationId: string) => void;
  className?: string;
}

const urgencyStyles = {
  critical: {
    bg: 'bg-error-50 dark:bg-error-900/20',
    border: 'border-error-200 dark:border-error-800',
    text: 'text-error-800 dark:text-error-200',
    icon: <AlertCircle className="h-5 w-5 text-error-600 dark:text-error-400" />,
  },
  high: {
    bg: 'bg-accent-50 dark:bg-accent-900/20',
    border: 'border-accent-200 dark:border-accent-800',
    text: 'text-accent-800 dark:text-accent-200',
    icon: <AlertTriangle className="h-5 w-5 text-accent-600 dark:text-accent-400" />,
  },
  medium: {
    bg: 'bg-warning-50 dark:bg-warning-900/20',
    border: 'border-warning-200 dark:border-warning-800',
    text: 'text-warning-800 dark:text-warning-200',
    icon: <Clock className="h-5 w-5 text-warning-600 dark:text-warning-400" />,
  },
  low: {
    bg: 'bg-info-50 dark:bg-info-900/20',
    border: 'border-info-200 dark:border-info-800',
    text: 'text-info-800 dark:text-info-200',
    icon: <Clock className="h-5 w-5 text-info-600 dark:text-info-400" />,
  },
};

export function CertificationExpiryAlert({
  daysUntilExpiry = 90,
  departmentId,
  showExpired = true,
  maxItems = 5,
  onViewAll,
  onRenew,
  className,
}: CertificationExpiryAlertProps) {
  const { data: expiringCerts, isLoading: loadingExpiring } = useExpiringCertifications(
    daysUntilExpiry,
    departmentId,
  );
  const { data: expiredCerts, isLoading: loadingExpired } = useExpiredCertifications(departmentId);

  const isLoading = loadingExpiring || loadingExpired;

  if (isLoading) {
    return (
      <div
        className={cn(
          'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800',
          className,
        )}
      >
        <div className="flex items-center justify-center py-8">
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  const allCerts = [
    ...(showExpired && expiredCerts
      ? expiredCerts.map((c) => {
          // BUG-015: daysSinceExpiry may be undefined → NaN; compute from expiryDate
          // as the authoritative source so the negative value is always valid.
          const sinceExpiry =
            c.daysSinceExpiry != null
              ? c.daysSinceExpiry
              : c.expiryDate
                ? Math.floor((Date.now() - new Date(c.expiryDate).getTime()) / 86400000)
                : 0;
          return { ...c, daysUntilExpiry: -sinceExpiry };
        })
      : []),
    ...(expiringCerts || []),
  ].slice(0, maxItems);

  const totalCount = (expiredCerts?.length || 0) + (expiringCerts?.length || 0);

  if (allCerts.length === 0) {
    return (
      <div
        className={cn(
          'rounded-lg border border-success-200 bg-success-50 p-4 dark:border-success-800 dark:bg-success-900/20',
          className,
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success-100 dark:bg-success-900">
            <Check className="h-6 w-6 text-success-600 dark:text-success-400" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-medium text-success-800 dark:text-success-200">All Clear</h3>
            <p className="text-sm text-success-600 dark:text-success-400">
              No certifications expiring within {daysUntilExpiry} days
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-warning-500" />
          <h3 className="font-semibold text-gray-900 dark:text-white">Certification Alerts</h3>
          <span className="rounded-full bg-warning-100 px-2 py-0.5 text-xs font-medium text-warning-800 dark:bg-warning-900/30 dark:text-warning-400">
            {totalCount}
          </span>
        </div>
        {onViewAll && totalCount > maxItems && (
          <Button
            variant="ghost"
            rightIcon={<ChevronRight className="h-4 w-4" />}
            onClick={onViewAll}
          >
            View All
          </Button>
        )}
      </div>

      {/* Alerts List */}
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {allCerts.map((cert) => {
          const urgency = getCertificationUrgency(cert.daysUntilExpiry);
          const styles = urgencyStyles[urgency];
          const categoryConfig = cert.certificationType
            ? CERTIFICATION_CATEGORY_CONFIG[cert.certificationType.category]
            : null;

          return (
            <div key={cert.id} className={cn('p-4', styles.bg)}>
              <div className="flex items-start gap-3">
                {styles.icon}

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('font-medium', styles.text)}>
                      {cert.certificationType?.name}
                    </span>
                    {categoryConfig && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                        {categoryConfig.label}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 flex items-center gap-2">
                    {cert.employee && (
                      <>
                        <EmployeeAvatar
                          firstName={cert.employee.firstName}
                          lastName={cert.employee.lastName}
                          size="xs"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400">
                          {cert.employee.firstName} {cert.employee.lastName}
                        </span>
                      </>
                    )}
                  </div>

                  <div className={cn('mt-1 text-sm', styles.text)}>
                    {cert.daysUntilExpiry < 0 ? (
                      <span className="font-medium">
                        Expired {Math.abs(cert.daysUntilExpiry)} days ago
                      </span>
                    ) : cert.daysUntilExpiry === 0 ? (
                      <span className="font-medium">Expires today</span>
                    ) : (
                      <span>
                        Expires in {cert.daysUntilExpiry} days
                        {cert.expiryDate && (
                          <span className="text-gray-500 dark:text-gray-400">
                            {' '}
                            ({new Date(cert.expiryDate).toLocaleDateString()})
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {onRenew && (
                  <button
                    onClick={() => onRenew(cert.id)}
                    className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-sm font-medium text-primary-600 shadow-sm hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Renew
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary Footer */}
      <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            {expiredCerts?.length || 0} expired
          </span>
          <span className="text-gray-500 dark:text-gray-400">
            {expiringCerts?.length || 0} expiring soon
          </span>
        </div>
      </div>
    </div>
  );
}

export default CertificationExpiryAlert;
