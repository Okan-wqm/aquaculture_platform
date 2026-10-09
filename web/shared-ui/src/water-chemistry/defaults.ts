/**
 * The calculator's starting record: the values a new calculation opens with,
 * and the targets and limits the live monitoring view draws its zones with.
 *
 * WHY shared: the farm calculator and the sensor-module monitoring view must
 * agree on the targets and limits they draw; one record, one owner. The
 * measured fields here are only the calculator's opening entries — the
 * monitoring view never reads them (applyResolved with `uncovered: 'missing'`).
 */
import type { WaterChemistryInputs } from './types';

export const DEFAULT_WATER_CHEMISTRY_INPUTS: Readonly<WaterChemistryInputs> = {
  tempC: 12,
  pH: 7.0,
  salinity: 1,
  alkalinityMg: 80,
  targetpH: 7.5,
  targetAlkalinityMg: 100,
  alkMinMg: 50,
  alkMaxMg: 100,
  tan: 0.5,
  unIonizedNH3: 0.0125,
  co2Toxic: 40,
  h2sUgL: 15,
  h2sLimitUgL: 25,
  caMgL: 400,
  volume: 1,
  fishType: 'Arctic Charr',
  fishSize: '0-5 gram',
  showTarget: true,
};
