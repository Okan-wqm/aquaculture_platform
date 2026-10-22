/**
 * Department Badge Component
 * Displays the department an employee is placed in (the `departmentHr` shape the
 * employee selections return) with custom color, and optionally its module.
 */

import React from 'react';
import { cn, colors, useI18n } from '@aquaculture/shared-ui';
import type { EmployeeDepartment } from '../../types';
import { moduleLabel } from '../../utils/moduleLabels';

interface DepartmentBadgeProps {
  department: Pick<EmployeeDepartment, 'name' | 'code' | 'moduleCode'>;
  colorCode?: string | null;
  size?: 'sm' | 'md' | 'lg';
  showCode?: boolean;
  /** Print the module the department belongs to after its name. */
  showModule?: boolean;
  className?: string;
}

const sizeStyles = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function getContrastColor(hexColor: string): string {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return colors.black;

  // Calculate relative luminance
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? colors.black : colors.white;
}

export function DepartmentBadge({
  department,
  colorCode,
  size = 'md',
  showCode = false,
  showModule = false,
  className,
}: DepartmentBadgeProps) {
  const { t } = useI18n();
  const bgColor = colorCode || colors.primary[500];
  const textColor = getContrastColor(bgColor);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium',
        sizeStyles[size],
        className,
      )}
      style={{
        backgroundColor: bgColor,
        color: textColor,
      }}
    >
      {showCode && <span className="opacity-75">{department.code}</span>}
      <span>{department.name}</span>
      {showModule && <span className="opacity-75">· {moduleLabel(department.moduleCode, t)}</span>}
    </span>
  );
}

export default DepartmentBadge;
