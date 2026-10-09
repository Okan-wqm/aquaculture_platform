/**
 * The chart a point panel draws, by type: the Deffeyes diagram or one of the
 * pH charts (NH₃, H₂S, CO₂) — the shared SSoT charts the farm calculator
 * draws, from the same input record.
 */
import { buildDeffeyesData } from '@aquaculture/shared-ui';
import type { CalculatedOutputs, WaterChemistryInputs } from '@aquaculture/shared-ui';
import {
  CarbonateVsPhChart,
  DeffeyesChart,
  H2sVsPhChart,
  UiaVsPhChart,
} from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement, useMemo } from 'react';

import type { ChartType } from './types';

export const CHART_LABELS: Readonly<Record<ChartType, string>> = {
  deffeyes: 'Deffeyes',
  nh3: 'NH₃ vs pH',
  co2: 'CO₂ vs pH',
  h2s: 'H₂S vs pH',
};

export function PointChart({
  chartType,
  inputs,
  outputs,
}: {
  chartType: ChartType;
  inputs: WaterChemistryInputs;
  outputs: CalculatedOutputs;
}): ReactElement {
  const deffeyes = useMemo(() => buildDeffeyesData(inputs, []), [inputs]);
  switch (chartType) {
    case 'nh3':
      return <UiaVsPhChart inputs={inputs} outputs={outputs} />;
    case 'h2s':
      return <H2sVsPhChart inputs={inputs} outputs={outputs} />;
    case 'co2':
      return <CarbonateVsPhChart inputs={inputs} outputs={outputs} />;
    case 'deffeyes':
      return <DeffeyesChart data={deffeyes} chartHeight={360} />;
  }
}
