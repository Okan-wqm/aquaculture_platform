/**
 * Employee Card Component
 * Displays employee summary in a card format
 */

import React from 'react';
import { Mail, Phone, MapPin, Briefcase, Building2 } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { EmployeeAvatar } from '../common/EmployeeAvatar';
import { StatusBadge } from '../common/StatusBadge';
import { DepartmentBadge } from '../common/DepartmentBadge';
import type { Employee } from '../../types';
import { EMPLOYEE_STATUS_CONFIG, PERSONNEL_CATEGORY_CONFIG } from '../../types';

interface EmployeeCardProps {
  employee: Employee;
  onClick?: () => void;
  showActions?: boolean;
  actions?: React.ReactNode;
  className?: string;
  variant?: 'default' | 'compact';
}

export function EmployeeCard({
  employee,
  onClick,
  showActions = false,
  actions,
  className,
  variant = 'default',
}: EmployeeCardProps) {
  const statusConfig = EMPLOYEE_STATUS_CONFIG[employee.status];
  const personnelConfig = employee.personnelCategory
    ? PERSONNEL_CATEGORY_CONFIG[employee.personnelCategory]
    : null;

  if (variant === 'compact') {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800',
          onClick && 'cursor-pointer hover:border-indigo-300 hover:shadow-sm',
          className
        )}
        onClick={onClick}
      >
        <EmployeeAvatar
          firstName={employee.firstName}
          lastName={employee.lastName}
          avatarUrl={employee.avatarUrl}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-gray-900 dark:text-white">
            {employee.firstName} {employee.lastName}
          </p>
          <p className="truncate text-sm text-gray-500 dark:text-gray-400">
            {employee.position?.title || employee.employeeNumber}
          </p>
        </div>
        <StatusBadge
          label={statusConfig.label}
          variant={statusConfig.variant}
          size="sm"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800',
        onClick && 'cursor-pointer hover:border-indigo-300 hover:shadow-md transition-shadow',
        className
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-4">
        <EmployeeAvatar
          firstName={employee.firstName}
          lastName={employee.lastName}
          avatarUrl={employee.avatarUrl}
          size="lg"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {employee.firstName} {employee.lastName}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {employee.employeeNumber}
              </p>
            </div>
            <div className="flex flex-col gap-1 items-end">
              <StatusBadge
                label={statusConfig.label}
                variant={statusConfig.variant}
                size="sm"
              />
              {personnelConfig && (
                <StatusBadge
                  label={personnelConfig.label}
                  variant={personnelConfig.variant}
                  size="sm"
                />
              )}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {employee.position && (
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <Briefcase className="h-4 w-4 flex-shrink-0" />
                <span>{employee.position.title}</span>
              </div>
            )}

            {employee.department && (
              <div className="flex items-center gap-2 text-sm">
                <Building2 className="h-4 w-4 flex-shrink-0 text-gray-600 dark:text-gray-300" />
                <DepartmentBadge
                  name={employee.department.name}
                  code={employee.department.code}
                  colorCode={employee.department.colorCode}
                  size="sm"
                />
              </div>
            )}

            {employee.email && (
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <Mail className="h-4 w-4 flex-shrink-0" />
                <a
                  href={`mailto:${employee.email}`}
                  className="truncate hover:text-indigo-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  {employee.email}
                </a>
              </div>
            )}

            {employee.phone && (
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <Phone className="h-4 w-4 flex-shrink-0" />
                <a
                  href={`tel:${employee.phone}`}
                  className="hover:text-indigo-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  {employee.phone}
                </a>
              </div>
            )}
          </div>

          {employee.seaWorthy && (
            <div className="mt-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                Sea Worthy Certified
              </span>
            </div>
          )}
        </div>
      </div>

      {showActions && actions && (
        <div className="mt-4 flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
          {actions}
        </div>
      )}
    </div>
  );
}

export default EmployeeCard;
