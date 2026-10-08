/**
 * Where the calculator's measured values come from: the operator's entries
 * (Manual), or a measurement point — a system resolves the DOSING inputs, a
 * tank the TOXICITY inputs (waterChemistryInputs). For a point, each covered
 * field shows its value, where it was read, how old it is and whether it is
 * older than its window; a missing value stays missing (the calculator does
 * not run on it) unless the operator corrects it for this session.
 */
import {
  Button,
  formatAge,
  Input,
  ProblemChips,
  RESOLVABLE_FIELDS,
  useI18n,
  type AppliedInputs,
  type FieldProvenance,
  type InputSetResult,
  type PointRef,
  type ResolvableField,
} from '@aquaculture/shared-ui';
import React from 'react';

import { PointPicker } from './sources/PointPicker';

export interface ValuesSourceBarProps {
  point: PointRef | null;
  onPointChange: (point: PointRef | null) => void;
  /** The point's resolved inputs (undefined while loading or in manual mode). */
  inputSet: InputSetResult | undefined;
  applied: AppliedInputs | null;
  loadError: Error | null;
  now: number;
  onOverride: (field: ResolvableField, value: number | null) => void;
}

const FieldChip: React.FC<{
  entry: FieldProvenance;
  now: number;
  onOverride: (value: number | null) => void;
}> = ({ entry, now, onOverride }) => {
  const { t } = useI18n();
  const reading = entry.reading;
  const observed = reading === null ? null : reading.observedAt;
  const ageSeconds =
    observed === null ? null : Math.max(0, Math.floor((now - Date.parse(observed)) / 1000));
  const windowSeconds = entry.input === null ? null : entry.input.windowSeconds;
  const stale = ageSeconds !== null && windowSeconds !== null && ageSeconds > windowSeconds;
  const problems = entry.input === null ? [] : entry.input.problems;
  return (
    <div
      className={`rounded border px-2 py-1.5 text-xs ${
        entry.origin === 'missing'
          ? 'border-warning-300 bg-warning-50 dark:border-warning-700 dark:bg-warning-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
      }`}
      data-field={entry.field}
      data-origin={entry.origin}
    >
      <div className="font-medium text-gray-700 dark:text-gray-300">
        {t(`wqSource.field.${entry.field}`)}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
          {entry.value === null ? '—' : entry.value}
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          {t(`wqSource.origin.${entry.origin}`)}
        </span>
      </div>
      {reading !== null && reading.sourceKind !== null && (
        <div className="text-gray-500 dark:text-gray-400">
          {t(`wqSource.kind.${reading.sourceKind}`)}
          {ageSeconds !== null && ` · ${formatAge(t, ageSeconds)}`}
          {stale && ` · ${t('wqSource.tile.stale')}`}
        </div>
      )}
      {entry.input !== null && (
        <div className="text-gray-400 dark:text-gray-500">
          {t(`wqSource.window.${entry.input.coherenceWindow}`)}
        </div>
      )}
      <ProblemChips problems={problems} className="mt-1" />
      {entry.origin !== 'manual' && (
        <div className="mt-1">
          <Input
            type="number"
            step="any"
            size="xs"
            placeholder={t('wqSource.ui.correct')}
            aria-label={t('wqSource.ui.correctField', {
              field: t(`wqSource.field.${entry.field}`),
            })}
            value={entry.origin === 'override' && entry.value !== null ? entry.value : ''}
            onChange={(event) => {
              const raw = event.target.value;
              const parsed = Number(raw);
              onOverride(raw === '' || !Number.isFinite(parsed) ? null : parsed);
            }}
          />
        </div>
      )}
    </div>
  );
};

export const ValuesSourceBar: React.FC<ValuesSourceBarProps> = ({
  point,
  onPointChange,
  inputSet,
  applied,
  loadError,
  now,
  onOverride,
}) => {
  const { t } = useI18n();
  const [pointMode, setPointMode] = React.useState(point !== null);

  const switchToManual = (): void => {
    setPointMode(false);
    onPointChange(null);
  };

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
        {inputSet !== undefined && point !== null && (
          <span className="ml-2 text-gray-600 dark:text-gray-400">
            {inputSet.set === 'DOSING' ? 'Dosing' : 'Toxicity'} inputs:{' '}
            <strong>{t(`wqSource.verdict.${inputSet.verdict}`)}</strong>
          </span>
        )}
      </div>

      {pointMode && (
        <div className="mt-3 space-y-3">
          <PointPicker value={point} onChange={onPointChange} kinds={['system', 'tank']} />
          {loadError !== null && (
            <p role="alert" className="text-sm text-error-700 dark:text-error-300">
              The values at this point could not be read: {loadError.message}
            </p>
          )}
          {inputSet !== undefined && <ProblemChips problems={inputSet.problems} />}
          {applied !== null && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {RESOLVABLE_FIELDS.map((field) => applied.provenance[field])
                .filter((entry) => entry.origin !== 'manual')
                .map((entry) => (
                  <FieldChip
                    key={entry.field}
                    entry={entry}
                    now={now}
                    onOverride={(value) => onOverride(entry.field, value)}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
