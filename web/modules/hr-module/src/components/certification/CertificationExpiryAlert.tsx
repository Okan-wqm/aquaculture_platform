/**
 * Certification Expiry Alert Component
 * Displays expiring and expired certifications with urgency indicators
 */

import React from 'react';
import { AlertTriangle, AlertCircle, Clock, RefreshCw, ChevronRight } from 'lucide-react';
import { cn } from '@shared-ui/utils';
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
    bg: 'bg-red-50 dark:bg-red-900/20',
    border: 'border-red-200 dark:border-red-800',
    text: 'text-red-800 dark:text-red-200',
    icon: <AlertCircle className="h-5 w-5 text-red-600" />,
  },
  high: {
    bg: 'bg-orange-50 dark:bg-orange-900/20',
    border: 'border-orange-200 dark:border-orange-800',
    text: 'text-orange-800 dark:text-orange-200',
    icon: <AlertTriangle className="h-5 w-5 text-orange-600" />,
  },
  medium: {
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
    border: 'border-yellow-200 dark:border-yellow-800',
    text: 'text-yellow-800 dark:text-yellow-200',
    icon: <Clock className="h-5 w-5 text-yellow-600" />,
  },
  low: {
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    border: 'border-blue-200 dark:border-blue-800',
    text: 'text-blue-800 dark:text-blue-200',
    icon: <Clock className="h-5 w-5 text-blue-600" />,
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
    departmentId
  );
  const { data: expiredCerts, isLoading: loadingExpired } = useExpiredCertifications(
    departmentId
  );

  const isLoading = loadingExpiring || loadingExpired;

  if (isLoading) {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
        </div>
      </div>
    );
  }

  const allCerts = [
    ...(showExpired && expiredCerts ? expiredCerts.map((c) => ({ ...c, daysUntilExpiry: -c.daysSinceExpiry })) : []),
    ...(expiringCerts || []),
  ].slice(0, maxItems);

  const totalCount = (expiredCerts?.length || 0) + (expiringCerts?.length || 0);

  if (allCerts.length === 0) {
    return (
      <div className={cn('rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20', className)}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
            <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h3 className="font-medium text-green-800 dark:text-green-200">All Clear</h3>
            <p className="text-sm text-green-600 dark:text-green-400">
              No certifications expiring within {daysUntilExpiry} days
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Certification Alerts
          </h3>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            {totalCount}
          </span>
        </div>
        {onViewAll && totalCount > maxItems && (
          <button
            onClick={onViewAll}
            className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            View All <ChevronRight className="h-4 w-4" />
          </button>
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
            <div
              key={cert.id}
              className={cn('p-4', styles.bg)}
            >
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
                          avatarUrl={cert.employee.avatarUrl}
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
                          <span className="text-gray-500"> ({new Date(cert.expiryDate).toLocaleDateString()})</span>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {onRenew && (
                  <button
                    onClick={() => onRenew(cert.id)}
                    className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-sm font-medium text-indigo-600 shadow-sm hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700"
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
          <span className="text-gray-500">
            {expiredCerts?.length || 0} expired
          </span>
          <span className="text-gray-500">
            {expiringCerts?.length || 0} expiring soon
          </span>
        </div>
      </div>
    </div>
  );
}

export default CertificationExpiryAlert;
