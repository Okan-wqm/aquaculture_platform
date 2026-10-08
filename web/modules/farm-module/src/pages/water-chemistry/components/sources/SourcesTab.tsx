/**
 * Sources tab (FARM-HIGH-373): where every water-quality parameter is read at
 * a measurement point — the point in the URL (`?tab=sources&point=tank:<id>`,
 * the link a problem's fix opens), its sources as tiles, the calculation the
 * point resolves and its verdict, and the bind / backup / replace / unbind
 * actions for writers.
 */
import {
  formatPointRef,
  parsePointRef,
  ProblemChips,
  problemFixPath,
  Select,
  useI18n,
  type ParameterSourceRow,
  type PointRef,
  type ProblemFix,
  type SourceProblemCode,
} from '@aquaculture/shared-ui';
import type { MeasurementPosition } from '@platform/shared-ui/generated/graphql-types';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useParameterConfigList } from '../../../../hooks/useParameterConfigs';
import {
  useParameterSourcesAtPoint,
  useWaterChemistryInputs,
} from '../../../../hooks/useParameterSources';

import { PointPicker } from './PointPicker';
import { PointSourcesTable } from './PointSourcesTable';

const POSITIONS: readonly MeasurementPosition[] = ['REPRESENTATIVE', 'INLET', 'OUTLET'];

/** The clock tiles measure ages to, ticking with the 30 s refresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const SourcesTab: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Memoised on the URL string: a new object each render would re-key every
  // query (and the bind dialog's dry run) on every parent render.
  const pointParam = searchParams.get('point');
  const point = useMemo(() => parsePointRef(pointParam), [pointParam]);
  const [position, setPosition] = useState<MeasurementPosition>('REPRESENTATIVE');
  const [siteId, setSiteId] = useState<string | null>(
    point !== null && point.kind === 'site' ? point.id : null,
  );
  const now = useNow(30_000);

  const parameters = useParameterConfigList({ isActive: true });
  const sources = useParameterSourcesAtPoint(point);
  const inputs = useWaterChemistryInputs(point);

  const activeParameters = useMemo(
    () => (parameters.data ?? []).filter((parameter) => parameter.isActive),
    [parameters.data],
  );

  const choosePoint = (next: PointRef | null): void => {
    setSearchParams((prev) => {
      if (next === null) prev.delete('point');
      else prev.set('point', formatPointRef(next));
      return prev;
    });
  };

  // A fix opens where it is made (problemFixPath: one map with the sensor
  // view); a source fix is made here, at this point.
  const handleFix = (
    _code: SourceProblemCode,
    fix: ProblemFix,
    source: ParameterSourceRow | null,
  ): void => {
    if (fix === 'source') return;
    const path = problemFixPath(fix, {
      point,
      sensorId: source === null ? null : source.sensorId,
      channelKey: source === null ? null : source.channelKey,
    });
    if (path !== null) navigate(path);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <PointPicker value={point} onChange={choosePoint} onSiteChange={setSiteId} />
        <div className="mt-3 max-w-xs">
          <Select
            label={t('wqSource.ui.newChannelsAt')}
            value={position}
            onChange={(event) => {
              const next = POSITIONS.find((option) => option === event.target.value);
              if (next !== undefined) setPosition(next);
            }}
            options={POSITIONS.map((option) => ({
              value: option,
              label: t(`wqSource.ui.position.${option}`),
            }))}
          />
        </div>
      </div>

      {point === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('wqSource.ui.choosePoint')}</p>
      ) : (
        <>
          {inputs.data !== undefined && (
            <div
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="input-set-verdict"
            >
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {t('wqSource.ui.calcHere', {
                  set: t(`wqSource.set.${inputs.data.set}`),
                  verdict: t(`wqSource.verdict.${inputs.data.verdict}`),
                })}
              </span>
              <ProblemChips
                problems={inputs.data.problems}
                onFix={(code, fix) => handleFix(code, fix, null)}
              />
            </div>
          )}
          {sources.error !== null && (
            <p role="alert" className="text-sm text-error-700 dark:text-error-300">
              {t('wqSource.ui.sourcesReadFailed', { error: sources.error.message })}
            </p>
          )}
          {parameters.isLoading || sources.isLoading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
          ) : (
            <PointSourcesTable
              point={point}
              position={position}
              parameters={activeParameters}
              sources={sources.data ?? []}
              inputSet={inputs.data ?? null}
              siteId={siteId}
              now={now}
              onFix={handleFix}
            />
          )}
        </>
      )}
    </div>
  );
};
