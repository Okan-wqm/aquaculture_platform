/**
 * Department Badge Component
 * Displays department with custom color
 */

import React from 'react';
import { cn } from '@aquaculture/shared-ui';

interface DepartmentBadgeProps {
  name: string;
  code?: string;
  colorCode?: string | null;
  size?: 'sm' | 'md' | 'lg';
  showCode?: boolean;
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
  if (!rgb) return '#000000';

  // Calculate relative luminance
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

export function DepartmentBadge({
  name,
  code,
  colorCode,
  size = 'md',
  showCode = false,
  className,
}: DepartmentBadgeProps) {
  const bgColor = colorCode || '#6366f1';
  const textColor = getContrastColor(bgColor);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md font-medium',
        sizeStyles[size],
        className
      )}
      style={{
        backgroundColor: bgColor,
        color: textColor,
      }}
    >
      {showCode && code && (
        <span className="opacity-75">{code}</span>
      )}
      <span>{name}</span>
    </span>
  );
}

export default DepartmentBadge;
