/**
 * QualityIndicator — OPC-UA tag quality as icon + text + colour (FE-HIGH-085,
 * FE-HIGH-080).
 *
 * WHY: quality was encoded three ways (a recoloured unit string, a light pill,
 * a themed dot) and on the live operator input widget colour was the only
 * signal, so a `bad` or `uncertain` reading driving a tag write was
 * indistinguishable without colour vision. One indicator always renders a
 * shape and a name beside the colour.
 */
import React from 'react';

import { colors } from '../../styles/theme';
import { CircleCheck, CircleMinus, CircleX, TriangleAlert } from 'lucide-react';

export type TagQuality = 'good' | 'uncertain' | 'bad' | 'comm_failure' | 'not_initialized';

export function normalizeQuality(value: string | null | undefined): TagQuality {
  const key = (value ?? '').toLowerCase();
  if (key === 'good') return 'good';
  if (key === 'uncertain') return 'uncertain';
  if (key === 'bad') return 'bad';
  if (key === 'comm_failure' || key === 'commfailure') return 'comm_failure';
  if (key === 'not_initialized' || key === 'notinitialized') return 'not_initialized';
  return 'good';
}

const TEXT: Record<TagQuality, string> = {
  good: 'text-success-600 dark:text-success-400',
  uncertain: 'text-warning-600 dark:text-warning-400',
  bad: 'text-error-600 dark:text-error-400',
  comm_failure: 'text-error-600 dark:text-error-400',
  not_initialized: 'text-gray-500 dark:text-gray-400',
};
const SOFT: Record<TagQuality, string> = {
  good: 'bg-success-100 text-success-800 dark:bg-success-900/30 dark:text-success-200',
  uncertain: 'bg-warning-100 text-warning-800 dark:bg-warning-900/30 dark:text-warning-200',
  bad: 'bg-error-100 text-error-800 dark:bg-error-900/30 dark:text-error-200',
  comm_failure: 'bg-error-100 text-error-800 dark:bg-error-900/30 dark:text-error-200',
  not_initialized: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export function qualityClasses(quality: TagQuality, tone: 'text' | 'soft' = 'text'): string {
  return tone === 'soft' ? SOFT[quality] : TEXT[quality];
}

/** The same palette as a value, for canvases and SVG. */
export function qualityColor(quality: TagQuality): string {
  switch (quality) {
    case 'good':
      return colors.success[500];
    case 'uncertain':
      return colors.warning[500];
    case 'bad':
    case 'comm_failure':
      return colors.error[500];
    case 'not_initialized':
      return colors.neutral[400];
  }
}

const LABEL: Record<TagQuality, string> = {
  good: 'Good',
  uncertain: 'Uncertain',
  bad: 'Bad',
  comm_failure: 'Comm failure',
  not_initialized: 'Not initialized',
};

const Glyph: React.FC<{ quality: TagQuality; className: string }> = ({ quality, className }) => {
  // Each quality has its own shape, so the state reads without colour.
  switch (quality) {
    case 'good':
      return <CircleCheck className={className} aria-hidden="true" />;
    case 'uncertain':
      return <TriangleAlert className={className} aria-hidden="true" />;
    case 'bad':
    case 'comm_failure':
      return <CircleX className={className} aria-hidden="true" />;
    case 'not_initialized':
      return <CircleMinus className={className} aria-hidden="true" />;
  }
};

export interface QualityIndicatorProps {
  quality: TagQuality | string;
  /** Override the visible name */
  label?: string;
  /** Hide the name visually (it stays for assistive technology) */
  showLabel?: boolean;
  tone?: 'text' | 'soft';
  size?: 'xs' | 'sm';
  className?: string;
}

export const QualityIndicator: React.FC<QualityIndicatorProps> = ({
  quality,
  label,
  showLabel = true,
  tone = 'text',
  size = 'sm',
  className = '',
}) => {
  const level = normalizeQuality(quality);
  const name = label ?? LABEL[level];
  const glyph = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span
      data-quality={level}
      title={name}
      className={`inline-flex items-center gap-1 font-medium ${size === 'xs' ? 'text-[10px]' : 'text-xs'} ${
        tone === 'soft' ? 'rounded-full px-1.5 py-0.5' : ''
      } ${qualityClasses(level, tone)} ${className}`}
    >
      <Glyph quality={level} className={`${glyph} flex-shrink-0`} />
      <span className={showLabel ? '' : 'sr-only'}>{name}</span>
    </span>
  );
};
