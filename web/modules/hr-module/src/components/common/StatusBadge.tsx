/**
 * Status Badge Component
 * Displays status with appropriate styling based on variant
 */

import React from 'react';
import { cn } from '@aquaculture/shared-ui';
import type { BadgeVariant } from '../../types';

interface StatusBadgeProps {
  label: string;
  variant: BadgeVariant | string;
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  className?: string;
}

const variantStyles: Record<string, string> = {
  success: 'bg-success-100 text-success-800 dark:bg-success-900/30 dark:text-success-400',
  warning: 'bg-warning-100 text-warning-800 dark:bg-warning-900/30 dark:text-warning-400',
  error: 'bg-error-100 text-error-800 dark:bg-error-900/30 dark:text-error-400',
  info: 'bg-info-100 text-info-800 dark:bg-info-900/30 dark:text-info-400',
  default: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
  primary: 'bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-400',
};

const sizeStyles = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

export function StatusBadge({ label, variant, size = 'md', icon, className }: StatusBadgeProps) {
  const variantStyle = variantStyles[variant] || variantStyles.default;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        variantStyle,
        sizeStyles[size],
        className,
      )}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {label}
    </span>
  );
}

export default StatusBadge;
