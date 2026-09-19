/**
 * Severity — one vocabulary and one palette for alarm severity (FE-HIGH-085).
 *
 * WHY: the sensor module re-defined alarm severity in ten independent colour
 * maps over three vocabularies (`critical|high|warning|info` in the operator,
 * `critical|high|medium|low|info` in the builder, `EMERGENCY|CRITICAL|WARNING|
 * INFO` from the PLC), so one alarm rendered coral in a widget, orange in the
 * operator panel and light red on the PLC page. Severity is a product concept:
 * it has one set of names, one order and one colour per name, painted from the
 * theme scales — error for critical, accent for high, warning for medium and
 * warning, info for low, neutral for info.
 *
 * `severityClasses` returns literal class strings (Tailwind sees them here) in
 * five tones; `severityColor` returns the same palette as values for canvases
 * and SVG; `SeverityBadge` is the pill.
 */
import React from 'react';

import { colors } from '../../styles/theme';

export type Severity = 'critical' | 'high' | 'medium' | 'warning' | 'low' | 'info';

/** Most to least severe. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'warning', 'low', 'info'];

/**
 * Accepts any of the three historical vocabularies (case-insensitive;
 * `emergency` → critical) and returns the product's; unknown → `info`.
 */
export function normalizeSeverity(value: string | null | undefined): Severity {
  const key = (value ?? '').toLowerCase();
  if (key === 'emergency' || key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  if (key === 'warning' || key === 'warn') return 'warning';
  if (key === 'low') return 'low';
  return 'info';
}

export type SeverityTone = 'solid' | 'soft' | 'row' | 'bar' | 'text';

type Scale = 'error' | 'accent' | 'warning' | 'info' | 'neutral';
const SCALE_OF: Record<Severity, Scale> = {
  critical: 'error',
  high: 'accent',
  medium: 'warning',
  warning: 'warning',
  low: 'info',
  info: 'neutral',
};

// Literal strings on purpose: Tailwind only emits utilities it can read here.
const TONES: Record<Scale, Record<SeverityTone, string>> = {
  error: {
    solid: 'bg-error-600 text-white',
    soft: 'bg-error-100 text-error-800 border-error-200 dark:bg-error-900/30 dark:text-error-200 dark:border-error-800',
    row: 'bg-error-50 dark:bg-error-900/20',
    bar: 'border-l-error-500',
    text: 'text-error-600 dark:text-error-400',
  },
  accent: {
    solid: 'bg-accent-600 text-white',
    soft: 'bg-accent-100 text-accent-800 border-accent-200 dark:bg-accent-900/30 dark:text-accent-200 dark:border-accent-800',
    row: 'bg-accent-50 dark:bg-accent-900/20',
    bar: 'border-l-accent-500',
    text: 'text-accent-600 dark:text-accent-400',
  },
  warning: {
    solid: 'bg-warning-500 text-gray-900',
    soft: 'bg-warning-100 text-warning-800 border-warning-200 dark:bg-warning-900/30 dark:text-warning-200 dark:border-warning-800',
    row: 'bg-warning-50 dark:bg-warning-900/20',
    bar: 'border-l-warning-500',
    text: 'text-warning-600 dark:text-warning-400',
  },
  info: {
    solid: 'bg-info-500 text-white',
    soft: 'bg-info-100 text-info-800 border-info-200 dark:bg-info-900/30 dark:text-info-200 dark:border-info-800',
    row: 'bg-info-50 dark:bg-info-900/20',
    bar: 'border-l-info-500',
    text: 'text-info-600 dark:text-info-400',
  },
  neutral: {
    solid: 'bg-neutral-500 text-white',
    soft: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700',
    row: 'bg-gray-50 dark:bg-gray-800/40',
    bar: 'border-l-gray-400',
    text: 'text-gray-600 dark:text-gray-400',
  },
};

/** Tailwind classes for a severity in one tone. `soft` needs `border` from the caller if a border is wanted. */
export function severityClasses(severity: Severity, tone: SeverityTone = 'soft'): string {
  return TONES[SCALE_OF[severity]][tone];
}

/** The same palette as values, for canvases and SVG. */
export function severityColor(severity: Severity): { bg: string; text: string } {
  switch (SCALE_OF[severity]) {
    case 'error':
      return { bg: colors.error[600], text: colors.white };
    case 'accent':
      return { bg: colors.accent[600], text: colors.white };
    case 'warning':
      return { bg: colors.warning[500], text: colors.black };
    case 'info':
      return { bg: colors.info[500], text: colors.white };
    case 'neutral':
      return { bg: colors.neutral[500], text: colors.white };
  }
}

const DEFAULT_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  warning: 'Warning',
  low: 'Low',
  info: 'Info',
};

export interface SeverityBadgeProps {
  severity: Severity | string;
  /** Text inside the pill; defaults to the severity's English name */
  label?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'solid' | 'soft';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const SIZES = { xs: 'px-1.5 py-0.5 text-[11px]', sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-0.5 text-sm' };

/** The severity pill: colour, icon and text together, never colour alone. */
export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity, label, icon, tone = 'soft', size = 'sm', className = '' }) => {
  const level = normalizeSeverity(severity);
  return (
    <span
      data-severity={level}
      className={`inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap ${tone === 'soft' ? 'border' : ''} ${severityClasses(level, tone)} ${SIZES[size]} ${className}`}
    >
      {icon}
      {label ?? DEFAULT_LABEL[level]}
    </span>
  );
};
