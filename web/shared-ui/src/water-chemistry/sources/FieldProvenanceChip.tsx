/**
 * One field of a point's calculation as a chip: its value (at the field's
 * precision), what it is (measured, configured, the operator's, not usable,
 * missing), where it was read — the point, the loop, or a system/site it
 * inherits from — how old it is against its window, and why it cannot be
 * used. With `onEnter`, the operator may correct it (or enter an uncovered
 * one) for this session.
 */
import React from 'react';

import { Input } from '../../components/Form/Input';
import { useI18n } from '../../i18n';

import { FIELD_DECIMALS, type FieldProvenance } from './inputs-adapter';
import { formatAge } from './ParameterSourceTile';
import { pointKindOfResult } from './pointRef';
import { ProblemChips } from './ProblemChips';

export interface FieldProvenanceChipProps {
  entry: FieldProvenance;
  /** The clock ages are measured to (ms). */
  now: number;
  /** The operator's session value (null clears it); omitted, the chip is read-only. */
  onEnter?: (value: number | null) => void;
}

const FRAME: Readonly<Record<FieldProvenance['state'], string>> = {
  measured: 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
  configured: 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900',
  corrected: 'border-info-300 bg-info-50 dark:border-info-700 dark:bg-info-900/20',
  entered: 'border-info-300 bg-info-50 dark:border-info-700 dark:bg-info-900/20',
  blocked: 'border-warning-300 bg-warning-50 dark:border-warning-700 dark:bg-warning-900/20',
  missing: 'border-warning-300 bg-warning-50 dark:border-warning-700 dark:bg-warning-900/20',
};

export const FieldProvenanceChip: React.FC<FieldProvenanceChipProps> = ({
  entry,
  now,
  onEnter,
}) => {
  const { t } = useI18n();
  const decimals = FIELD_DECIMALS[entry.field];
  const reading = entry.reading;
  const observedAt = reading === null ? null : reading.observedAt;
  const ageSeconds =
    observedAt === null ? null : Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000));
  const windowSeconds = entry.input === null ? null : entry.input.windowSeconds;
  const stale = ageSeconds !== null && windowSeconds !== null && ageSeconds > windowSeconds;
  // A blocked field still shows the value the backend read, struck through.
  const shown = entry.value === null && reading !== null ? reading.value : entry.value;
  const inheritedFrom =
    reading === null || reading.inheritedFrom === null
      ? null
      : pointKindOfResult(reading.inheritedFrom);
  const label = t(`wqSource.field.${entry.field}`);

  return (
    <div
      className={`rounded border px-2 py-1.5 text-xs ${FRAME[entry.state]}`}
      data-field={entry.field}
      data-state={entry.state}
    >
      <div className="font-medium text-gray-700 dark:text-gray-300">{label}</div>
      <div className="flex items-baseline gap-1">
        <span
          className={`text-sm tabular-nums ${
            entry.value === null
              ? 'text-gray-400 line-through dark:text-gray-500'
              : 'text-gray-900 dark:text-gray-100'
          }`}
        >
          {shown === null ? '—' : shown.toFixed(decimals)}
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          {t(`wqSource.state.${entry.state}`)}
        </span>
      </div>
      <div className="text-gray-500 dark:text-gray-400">
        {reading !== null &&
          reading.sourceKind !== null &&
          t(`wqSource.kind.${reading.sourceKind}`)}
        {entry.from === 'loop' && ` · ${t('wqSource.fromLoop')}`}
        {inheritedFrom !== null &&
          ` · ${t('wqSource.inheritedFrom', { point: t(`wqSource.point.${inheritedFrom}`) })}`}
        {ageSeconds !== null && ` · ${formatAge(t, ageSeconds)}`}
        {stale && ` · ${t('wqSource.tile.stale')}`}
      </div>
      {entry.input !== null && (
        <div className="text-gray-400 dark:text-gray-500">
          {t(`wqSource.window.${entry.input.coherenceWindow}`)}
        </div>
      )}
      <ProblemChips problems={entry.problems} className="mt-1" />
      {onEnter !== undefined && (
        <div className="mt-1">
          <Input
            type="number"
            step="any"
            size="xs"
            placeholder={entry.from === null ? t('wqSource.ui.enter') : t('wqSource.ui.correct')}
            aria-label={
              entry.from === null
                ? t('wqSource.ui.enterField', { field: label })
                : t('wqSource.ui.correctField', { field: label })
            }
            value={
              (entry.state === 'corrected' || entry.state === 'entered') && entry.value !== null
                ? entry.value
                : ''
            }
            onChange={(event) => {
              const raw = event.target.value;
              const parsed = Number(raw);
              onEnter(raw === '' || !Number.isFinite(parsed) ? null : parsed);
            }}
          />
        </div>
      )}
    </div>
  );
};
