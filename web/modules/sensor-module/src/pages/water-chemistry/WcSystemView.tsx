/**
 * One system (loop) of the monitoring view: every measurement point of the
 * loop — the system itself and each of its tanks — overlaid on one Deffeyes
 * diagram, then the selected point's panel.
 *
 * Inputs per point are the backend's (waterChemistryInputs): the system
 * resolves DOSING (pH, alkalinity, temperature, salinity, calcium, volume);
 * a tank resolves TOXICITY (pH, temperature, salinity, TAN, H₂S) and reads
 * the loop's carbonate state — alkalinity, calcium, volume — from the
 * system's DOSING set, shown as the system's. A point is drawn only when
 * every input it needs has a measured value; the legend says what is missing
 * otherwise. Nothing is defaulted.
 */
import {
  applyResolved,
  buildDeffeyesData,
  Button,
  colors,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  useI18n,
  type InputSetResult,
  type PointRef,
} from '@aquaculture/shared-ui';
import {
  DeffeyesChart,
  type DeffeyesOverlay,
} from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement, useMemo, useState } from 'react';

import type { WcSystem } from '../../graphql/waterChemistry.queries';

import type { ChartType } from './types';
import {
  usePointInputSets,
  useSystemTanks,
  type PointSetRequest,
} from './useWaterChemistryMonitoring';
import { WcPointPanel } from './WcPointPanel';

// A stable palette by point order, so a point keeps its colour as others come and go.
const OVERLAY_COLORS = [
  colors.error[500],
  colors.success[500],
  colors.info[500],
  colors.warning[500],
  colors.primary[700],
  colors.accent[500],
  colors.secondary[600],
  colors.accent[600],
];

interface PointEntry {
  point: PointRef;
  label: string;
  sets: readonly InputSetResult[];
}

export function WcSystemView({
  system,
  focusTankId,
  chartType,
  onChartTypeChange,
  now,
}: {
  system: WcSystem;
  focusTankId: string | null;
  chartType: ChartType;
  onChartTypeChange: (chartType: ChartType) => void;
  now: number;
}): ReactElement {
  const { t } = useI18n();
  const tanks = useSystemTanks(system.id);
  const tankList = useMemo(() => tanks.data ?? [], [tanks.data]);
  const [selected, setSelected] = useState<string>(focusTankId ?? system.id);

  const requests = useMemo(
    (): PointSetRequest[] => [
      { point: { kind: 'system', id: system.id }, set: 'DOSING' },
      ...tankList.map(
        (tank): PointSetRequest => ({ point: { kind: 'tank', id: tank.id }, set: 'TOXICITY' }),
      ),
    ],
    [system.id, tankList],
  );
  const answers = usePointInputSets(requests);
  const dosing = answers[0] === undefined ? undefined : answers[0].data;

  // Recomputed per render (every 30 s refresh at most): applying a set is cheap
  // and the overlays follow the answers as they arrive.
  const loop = dosing === undefined ? [] : [dosing];
  const points: PointEntry[] = [
    {
      point: { kind: 'system', id: system.id },
      label: t('wqSource.ui.systemPoint', { name: system.name }),
      sets: loop,
    },
    ...tankList.map((tank, index): PointEntry => {
      const own = answers[index + 1];
      const ownSet = own === undefined || own.data === undefined ? [] : [own.data];
      return { point: { kind: 'tank', id: tank.id }, label: tank.name, sets: [...ownSet, ...loop] };
    }),
  ];
  const drawn = points.map((entry, index) => ({
    entry,
    applied: applyResolved(DEFAULT_WATER_CHEMISTRY_INPUTS, entry.sets, {
      overrides: {},
      uncovered: 'missing',
    }),
    color: OVERLAY_COLORS[index % OVERLAY_COLORS.length] ?? colors.info[500],
  }));
  const overlays = drawn.flatMap(({ entry, applied, color }): DeffeyesOverlay[] =>
    applied.inputs === null
      ? []
      : [{ data: buildDeffeyesData(applied.inputs, []), label: entry.label, color }],
  );
  const [firstOverlay] = overlays;
  const selectedEntry = points.find((entry) => entry.point.id === selected) ?? points[0];

  return (
    <div className="space-y-3">
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-900"
        aria-label={t('wqSource.ui.measurementPoints')}
      >
        {drawn.map(({ entry, applied, color }) => (
          <li key={entry.point.id}>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              aria-pressed={
                selectedEntry !== undefined && selectedEntry.point.id === entry.point.id
              }
              className="flex items-center gap-1.5 text-gray-700 hover:underline dark:text-gray-300"
              onClick={() => setSelected(entry.point.id)}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{entry.label}</span>
              {applied.inputs === null && (
                <span className="text-gray-400 dark:text-gray-500">
                  —{' '}
                  {t('wqSource.notDrawn', {
                    fields: applied.missing.map((field) => t(`wqSource.field.${field}`)).join(', '),
                  })}
                </span>
              )}
            </Button>
          </li>
        ))}
      </ul>

      {firstOverlay === undefined ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
          {t('wqSource.ui.noPointDrawn')}
        </div>
      ) : (
        <DeffeyesChart data={firstOverlay.data} overlays={overlays} chartHeight={460} />
      )}

      {selectedEntry !== undefined && (
        <WcPointPanel
          key={selectedEntry.point.id}
          point={selectedEntry.point}
          label={selectedEntry.label}
          sets={selectedEntry.sets}
          chartType={chartType}
          onChartTypeChange={onChartTypeChange}
          now={now}
        />
      )}
    </div>
  );
}
