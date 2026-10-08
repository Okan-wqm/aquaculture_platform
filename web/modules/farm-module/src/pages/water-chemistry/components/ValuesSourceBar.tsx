/**
 * Where the calculator's measured values come from: the operator's entries
 * (Manual), or a measurement point. At a point the shared composition
 * (composePointInputs) decides every field — a system's DOSING set; a tank's
 * TOXICITY set with its loop's alkalinity, calcium and volume — and each
 * field shows its value, where it was read, its age and window, and why it is
 * not usable. A flagged or missing value is never used: the operator may
 * correct a covered field, or enter one no set covers, for this session.
 */
import {
  Button,
  FieldProvenanceChip,
  formatAge,
  ProblemChips,
  RESOLVABLE_FIELDS,
  useI18n,
  type ComposedInputs,
  type InputSetResult,
  type PointRef,
  type ResolvableField,
} from '@aquaculture/shared-ui';
import React from 'react';

import { PointPicker } from './sources/PointPicker';

export interface ValuesSourceBarProps {
  point: PointRef | null;
  onPointChange: (point: PointRef | null) => void;
  /** The point's own resolved set (null while it is read, or in manual mode). */
  ownSet: InputSetResult | null;
  composed: ComposedInputs | null;
  loading: boolean;
  loadError: Error | null;
  /** The shown values were resolved, and the last refresh failed. */
  refreshFailed: boolean;
  now: number;
  onEnter: (field: ResolvableField, value: number | null) => void;
}

export const ValuesSourceBar: React.FC<ValuesSourceBarProps> = ({
  point,
  onPointChange,
  ownSet,
  composed,
  loading,
  loadError,
  refreshFailed,
  now,
  onEnter,
}) => {
  const { t } = useI18n();
  const [pointMode, setPointMode] = React.useState(point !== null);

  const switchToManual = (): void => {
    setPointMode(false);
    onPointChange(null);
  };
  const resolvedAge =
    ownSet === null
      ? null
      : formatAge(t, Math.max(0, Math.floor((now - Date.parse(ownSet.asOf)) / 1000)));

  return (
    <div
      className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50"
      data-testid="values-source-bar"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {t('wqSource.ui.valuesFrom')}
        </span>
        <div role="group" aria-label={t('wqSource.ui.valuesFrom')} className="flex gap-1">
          <Button
            type="button"
            size="xs"
            variant={pointMode ? 'secondary' : 'primary'}
            aria-pressed={!pointMode}
            onClick={switchToManual}
          >
            {t('wqSource.ui.manualEntry')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={pointMode ? 'primary' : 'secondary'}
            aria-pressed={pointMode}
            onClick={() => setPointMode(true)}
          >
            {t('wqSource.ui.aPoint')}
          </Button>
        </div>
        {ownSet !== null && point !== null && (
          <span className="ml-2 text-gray-600 dark:text-gray-400">
            {t('wqSource.ui.inputsVerdict', {
              set: t(`wqSource.set.${ownSet.set}`),
              verdict: t(`wqSource.verdict.${ownSet.verdict}`),
            })}
            {resolvedAge !== null && ` · ${t('wqSource.ui.resolvedAt', { age: resolvedAge })}`}
          </span>
        )}
      </div>

      {pointMode && (
        <div className="mt-3 space-y-3">
          <PointPicker value={point} onChange={onPointChange} kinds={['system', 'tank']} />
          {point === null && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('wqSource.ui.chooseCalcPoint')}
            </p>
          )}
          {point !== null && loading && composed === null && (
            <p role="status" className="text-sm text-gray-500 dark:text-gray-400">
              {t('wqSource.ui.loadingPoint')}
            </p>
          )}
          {loadError !== null && (
            <p role="alert" className="text-sm text-error-700 dark:text-error-300">
              {t('wqSource.ui.readFailed', { error: loadError.message })}
            </p>
          )}
          {refreshFailed && resolvedAge !== null && (
            <p role="alert" className="text-sm text-warning-700 dark:text-warning-300">
              {t('wqSource.ui.refreshFailed', { age: resolvedAge })}
            </p>
          )}
          {ownSet !== null && <ProblemChips problems={ownSet.problems} />}
          {composed !== null && (
            <div
              className={`grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8 ${refreshFailed ? 'opacity-60' : ''}`}
            >
              {RESOLVABLE_FIELDS.map((field) => (
                <FieldProvenanceChip
                  key={field}
                  entry={composed.fields[field]}
                  now={now}
                  onEnter={(value) => onEnter(field, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
