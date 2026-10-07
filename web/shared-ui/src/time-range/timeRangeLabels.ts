/**
 * The one place a time-range preset or range error gets its words. The
 * durations and the parsing live in
 * `@aquaculture/shared-contracts` (sensor-readings/time-range); the words live
 * in the locale maps, so the readings page, the widget dashboard and the
 * SCADA charts say the same thing in the user's language.
 */
import type { RelativePresetKey, TimeRangeError } from '@aquaculture/shared-contracts';

import { type MessageKey, useI18n } from '../i18n';

export const TIME_RANGE_PRESET_LABEL_KEYS: Readonly<Record<RelativePresetKey, MessageKey>> = {
  live: 'timeRange.preset.live',
  '1h': 'timeRange.preset.1h',
  '6h': 'timeRange.preset.6h',
  '8h': 'timeRange.preset.8h',
  '24h': 'timeRange.preset.24h',
  '3d': 'timeRange.preset.3d',
  '7d': 'timeRange.preset.7d',
  '30d': 'timeRange.preset.30d',
  '90d': 'timeRange.preset.90d',
  '365d': 'timeRange.preset.365d',
};

/** Compact words for presets, for toolbars too narrow for the full label. */
export const TIME_RANGE_SHORT_LABEL_KEYS: Readonly<Record<RelativePresetKey, MessageKey>> = {
  live: 'timeRange.short.live',
  '1h': 'timeRange.short.1h',
  '6h': 'timeRange.short.6h',
  '8h': 'timeRange.short.8h',
  '24h': 'timeRange.short.24h',
  '3d': 'timeRange.short.3d',
  '7d': 'timeRange.short.7d',
  '30d': 'timeRange.short.30d',
  '90d': 'timeRange.short.90d',
  '365d': 'timeRange.short.365d',
};

export const TIME_RANGE_ERROR_LABEL_KEYS: Readonly<Record<TimeRangeError, MessageKey>> = {
  empty: 'timeRange.error.empty',
  'too-long': 'timeRange.error.tooLong',
  invalid: 'timeRange.error.invalid',
};

export interface TimeRangeLabels {
  preset: (key: RelativePresetKey) => string;
  short: (key: RelativePresetKey) => string;
  error: (error: TimeRangeError) => string;
  custom: string;
}

/** Localised words for presets and range errors. */
export function useTimeRangeLabels(): TimeRangeLabels {
  const { t } = useI18n();
  return {
    preset: (key) => t(TIME_RANGE_PRESET_LABEL_KEYS[key]),
    short: (key) => t(TIME_RANGE_SHORT_LABEL_KEYS[key]),
    error: (error) => t(TIME_RANGE_ERROR_LABEL_KEYS[error]),
    custom: t('timeRange.custom'),
  };
}
