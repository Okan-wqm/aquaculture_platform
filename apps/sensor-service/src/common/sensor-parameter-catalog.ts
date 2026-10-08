import {
  CHANNEL_KEYS,
  channelKeyMeaning,
  channelKeyUnit,
  type ChannelKeyMeaning,
  type QuantityFamily,
  type QuantityId,
} from '@aquaculture/shared-contracts';

import { ChannelDataType } from '../database/entities/sensor-data-channel.entity';
import { SensorType } from '../database/entities/sensor.entity';

/**
 * SENSOR-MEDIUM-065: THE single source of truth for how the sensor service
 * presents a measured quantity on a channel (SensorType + label + operational
 * range).
 *
 * Previously this dictionary was triplicated — backend channel discovery, the FE
 * `registration.types.ts` map, and a fourth copy in `DataChannelsStep.tsx` — and
 * the copies disagreed (water level cm/500 vs m/10, CO₂ mg/L/100 vs ppm/5000,
 * temperature max 40 vs 50, …). Those ranges feed alarm thresholds, so a channel
 * discovered by one path validated differently than the same channel created by
 * another. The frontend consumes it through the `sensorParameterCatalog` GraphQL
 * query, so the two can never drift again. Enforced by
 * `tests/invariants/sensor-parameter-catalog-ssot.spec.ts`.
 *
 * Which device spellings name a quantity, and its unit, are not this module's:
 * they come from the measured-quantity registry (`@aquaculture/shared-contracts`)
 * that the reading event and the farm templates read too. This module only adds
 * what a sensor channel needs on top — one entry per quantity, not per spelling,
 * so two spellings of one quantity cannot carry two ranges. Keys with no
 * dedicated SensorType (pressure, alkalinity, tds, humidity, battery, rssi, …)
 * map to MULTI_PARAMETER, exactly as the FE's `inferChildSensorConfig` fell back
 * before.
 */
export interface ParameterDefinition {
  sensorType: SensorType;
  label: string;
  unit: string;
  min: number;
  max: number;
  dataType: ChannelDataType;
}

type Presentation = Omit<ParameterDefinition, 'unit' | 'dataType'>;

const M = SensorType.MULTI_PARAMETER;

/**
 * Per measured quantity: how a channel measuring it is typed, labelled and
 * bounded. A SensorType that has a flat reading mapper (TEMPERATURE → the
 * event's `temperature`, …) is given only to a quantity whose registry
 * `readingParameter` is that same field — otherwise a registered child sensor
 * would publish, say, % saturation as dissolved oxygen. The catalog spec
 * checks this against the mapper registry.
 */
const QUANTITY_PRESENTATION: Readonly<Record<QuantityId, Presentation>> = {
  temperature: { sensorType: SensorType.TEMPERATURE, label: 'Temperature', min: 0, max: 40 },
  ph: { sensorType: SensorType.PH, label: 'pH', min: 0, max: 14 },
  dissolvedOxygen: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    min: 0,
    max: 20,
  },
  oxygenSaturation: { sensorType: M, label: 'Oxygen Saturation', min: 0, max: 200 },
  salinity: { sensorType: SensorType.SALINITY, label: 'Salinity', min: 0, max: 50 },
  conductivity: { sensorType: SensorType.CONDUCTIVITY, label: 'Conductivity', min: 0, max: 50000 },
  specificConductance: {
    sensorType: SensorType.CONDUCTIVITY,
    label: 'Specific Conductance',
    min: 0,
    max: 50000,
  },
  tan: { sensorType: M, label: 'Total Ammonia Nitrogen', min: 0, max: 10 },
  nh3: { sensorType: M, label: 'Un-ionized Ammonia', min: 0, max: 10 },
  nh4: { sensorType: M, label: 'Ammonium', min: 0, max: 10 },
  nh4Ion: { sensorType: M, label: 'Ammonium', min: 0, max: 15 },
  nitriteN: { sensorType: M, label: 'Nitrite-N', min: 0, max: 5 },
  nitriteIon: { sensorType: M, label: 'Nitrite', min: 0, max: 20 },
  nitrateN: { sensorType: M, label: 'Nitrate-N', min: 0, max: 100 },
  nitrateIon: { sensorType: M, label: 'Nitrate', min: 0, max: 500 },
  h2s: { sensorType: M, label: 'Hydrogen Sulfide', min: 0, max: 1000 },
  totalSulfide: { sensorType: M, label: 'Total Sulfide', min: 0, max: 1000 },
  totalSulfideAsS: { sensorType: M, label: 'Total Sulfide (as S)', min: 0, max: 1000 },
  alkalinity: { sensorType: M, label: 'Alkalinity', min: 0, max: 500 },
  calcium: { sensorType: M, label: 'Calcium', min: 0, max: 1000 },
  hardness: { sensorType: M, label: 'Hardness', min: 0, max: 1000 },
  co2: { sensorType: SensorType.CO2, label: 'CO2', min: 0, max: 100 },
  turbidity: { sensorType: SensorType.TURBIDITY, label: 'Turbidity', min: 0, max: 1000 },
  waterLevel: { sensorType: SensorType.WATER_LEVEL, label: 'Water Level', min: 0, max: 500 },
  flowRate: { sensorType: SensorType.FLOW_RATE, label: 'Flow Rate', min: 0, max: 1000 },
  // Pressure — no dedicated SensorType, persisted as MULTI_PARAMETER (SENSOR-HIGH-028).
  pressure: { sensorType: M, label: 'Pressure', min: 0, max: 10 },
  barometricPressure: { sensorType: M, label: 'Barometric Pressure', min: 800, max: 1100 },
  orp: { sensorType: SensorType.ORP, label: 'ORP', min: -500, max: 500 },
  tds: { sensorType: M, label: 'Total Dissolved Solids', min: 0, max: 50000 },
  chlorine: { sensorType: SensorType.CHLORINE, label: 'Chlorine', min: 0, max: 10 },
  chloride: { sensorType: M, label: 'Chloride', min: 0, max: 30000 },
  ozone: { sensorType: M, label: 'Ozone', min: 0, max: 2 },
  humidity: { sensorType: M, label: 'Humidity', min: 0, max: 100 },
  batteryLevel: { sensorType: M, label: 'Battery Level', min: 0, max: 100 },
  signalStrength: { sensorType: M, label: 'Signal Strength', min: -120, max: 0 },
};

/** Per family: a channel whose key names the family before its basis is declared. */
const FAMILY_PRESENTATION: Readonly<Record<QuantityFamily, Presentation>> = {
  ammonia: { sensorType: SensorType.AMMONIA, label: 'Ammonia', min: 0, max: 10 },
  nitrite: { sensorType: SensorType.NITRITE, label: 'Nitrite', min: 0, max: 5 },
  nitrate: { sensorType: SensorType.NITRATE, label: 'Nitrate', min: 0, max: 100 },
};

function presentationOf(meaning: ChannelKeyMeaning): Presentation {
  return meaning.family === undefined
    ? QUANTITY_PRESENTATION[meaning.quantity]
    : FAMILY_PRESENTATION[meaning.family];
}

function definitionFor(channelKey: string, meaning: ChannelKeyMeaning): ParameterDefinition {
  const unit = channelKeyUnit(channelKey);
  if (unit === undefined) {
    throw new Error(`Channel key ${channelKey} has no unit in the quantity registry`);
  }
  return { ...presentationOf(meaning), unit, dataType: ChannelDataType.NUMBER };
}

/**
 * Keyed by the normalized (lowercased) channel key: every spelling the registry
 * knows, each resolving to its quantity's definition, so discovery matches
 * whatever a device happens to name the field.
 */
export const SENSOR_PARAMETER_CATALOG: Readonly<Record<string, ParameterDefinition>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(CHANNEL_KEYS).map(([key, meaning]: [string, ChannelKeyMeaning]) => [
        key,
        definitionFor(key, meaning),
      ]),
    ),
  );

/** A catalog entry with its lookup key, for serialization to the FE. */
export interface ParameterCatalogEntry extends ParameterDefinition {
  key: string;
}

/** Resolve a (case-insensitive) channel key to its parameter definition. */
export function lookupParameter(key: string): ParameterDefinition | undefined {
  // Own keys only: a bare index would answer `constructor` with Object's.
  const meaning = channelKeyMeaning(key);
  return meaning === undefined ? undefined : SENSOR_PARAMETER_CATALOG[key.toLowerCase()];
}

/** The whole catalog as a flat list (used by the sensorParameterCatalog query). */
export function listParameterCatalog(): ParameterCatalogEntry[] {
  return Object.entries(SENSOR_PARAMETER_CATALOG).map(([key, def]) => ({ key, ...def }));
}
