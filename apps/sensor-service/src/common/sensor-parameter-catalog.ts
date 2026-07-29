import { ChannelDataType } from '../database/entities/sensor-data-channel.entity';
import { SensorType } from '../database/entities/sensor.entity';

/**
 * SENSOR-MEDIUM-065: THE single source of truth for the aquaculture
 * parameter/channel catalog (SensorType + unit + operational range + label per
 * channel key).
 *
 * Previously this dictionary was triplicated — backend channel discovery, the FE
 * `registration.types.ts` map, and a fourth copy in `DataChannelsStep.tsx` — and
 * the copies disagreed (water level cm/500 vs m/10, CO₂ mg/L/100 vs ppm/5000,
 * temperature max 40 vs 50, …). Those ranges feed alarm thresholds, so a channel
 * discovered by one path validated differently than the same channel created by
 * another. This module is now the ONLY hardcoded parameter map; the backend
 * imports it directly and the frontend consumes it through the
 * `sensorParameterCatalog` GraphQL query (its own maps deleted), so the two can
 * never drift again. Enforced by
 * `tests/invariants/sensor-parameter-catalog-ssot.spec.ts`.
 *
 * Canonical unit/range values are the server-side discovery values (they already
 * drive real channel creation), so adopting this SSoT changes no existing backend
 * behaviour; the FE aligns to it. Keys with no dedicated SensorType (pressure,
 * alkalinity, tds, humidity, battery, rssi, …) map to MULTI_PARAMETER, exactly as
 * the FE's `inferChildSensorConfig` fell back before.
 */
export interface ParameterDefinition {
  sensorType: SensorType;
  label: string;
  unit: string;
  min: number;
  max: number;
  dataType: ChannelDataType;
}

const N = ChannelDataType.NUMBER;

/**
 * Keyed by the normalized (lowercased) channel key. Alias keys (temp, do, o2, …)
 * resolve to the same definition as their canonical key so discovery matches
 * whatever a device happens to name the field.
 */
export const SENSOR_PARAMETER_CATALOG: Record<string, ParameterDefinition> = {
  // Temperature variants
  temperature: {
    sensorType: SensorType.TEMPERATURE,
    label: 'Temperature',
    unit: '°C',
    min: 0,
    max: 40,
    dataType: N,
  },
  temp: {
    sensorType: SensorType.TEMPERATURE,
    label: 'Temperature',
    unit: '°C',
    min: 0,
    max: 40,
    dataType: N,
  },
  water_temperature: {
    sensorType: SensorType.TEMPERATURE,
    label: 'Water Temperature',
    unit: '°C',
    min: 0,
    max: 40,
    dataType: N,
  },
  water_temp: {
    sensorType: SensorType.TEMPERATURE,
    label: 'Water Temperature',
    unit: '°C',
    min: 0,
    max: 40,
    dataType: N,
  },

  // pH variants
  ph: { sensorType: SensorType.PH, label: 'pH', unit: 'pH', min: 0, max: 14, dataType: N },
  ph_level: {
    sensorType: SensorType.PH,
    label: 'pH Level',
    unit: 'pH',
    min: 0,
    max: 14,
    dataType: N,
  },

  // Dissolved Oxygen variants
  dissolved_oxygen: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    unit: 'mg/L',
    min: 0,
    max: 20,
    dataType: N,
  },
  do: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    unit: 'mg/L',
    min: 0,
    max: 20,
    dataType: N,
  },
  do_level: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    unit: 'mg/L',
    min: 0,
    max: 20,
    dataType: N,
  },
  oxygen: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    unit: 'mg/L',
    min: 0,
    max: 20,
    dataType: N,
  },
  o2: {
    sensorType: SensorType.DISSOLVED_OXYGEN,
    label: 'Dissolved Oxygen',
    unit: 'mg/L',
    min: 0,
    max: 20,
    dataType: N,
  },

  // Salinity variants
  salinity: {
    sensorType: SensorType.SALINITY,
    label: 'Salinity',
    unit: 'ppt',
    min: 0,
    max: 50,
    dataType: N,
  },
  salt: {
    sensorType: SensorType.SALINITY,
    label: 'Salinity',
    unit: 'ppt',
    min: 0,
    max: 50,
    dataType: N,
  },

  // Ammonia variants
  ammonia: {
    sensorType: SensorType.AMMONIA,
    label: 'Ammonia',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },
  nh3: {
    sensorType: SensorType.AMMONIA,
    label: 'Ammonia',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },
  nh4: {
    sensorType: SensorType.AMMONIA,
    label: 'Ammonium',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },
  total_ammonia: {
    sensorType: SensorType.AMMONIA,
    label: 'Total Ammonia Nitrogen',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },
  tan: {
    sensorType: SensorType.AMMONIA,
    label: 'Total Ammonia Nitrogen',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },

  // Nitrite variants
  nitrite: {
    sensorType: SensorType.NITRITE,
    label: 'Nitrite',
    unit: 'mg/L',
    min: 0,
    max: 5,
    dataType: N,
  },
  no2: {
    sensorType: SensorType.NITRITE,
    label: 'Nitrite',
    unit: 'mg/L',
    min: 0,
    max: 5,
    dataType: N,
  },

  // Nitrate variants
  nitrate: {
    sensorType: SensorType.NITRATE,
    label: 'Nitrate',
    unit: 'mg/L',
    min: 0,
    max: 100,
    dataType: N,
  },
  no3: {
    sensorType: SensorType.NITRATE,
    label: 'Nitrate',
    unit: 'mg/L',
    min: 0,
    max: 100,
    dataType: N,
  },

  // Turbidity variants
  turbidity: {
    sensorType: SensorType.TURBIDITY,
    label: 'Turbidity',
    unit: 'NTU',
    min: 0,
    max: 1000,
    dataType: N,
  },
  ntu: {
    sensorType: SensorType.TURBIDITY,
    label: 'Turbidity',
    unit: 'NTU',
    min: 0,
    max: 1000,
    dataType: N,
  },

  // Water Level variants
  water_level: {
    sensorType: SensorType.WATER_LEVEL,
    label: 'Water Level',
    unit: 'cm',
    min: 0,
    max: 500,
    dataType: N,
  },
  level: {
    sensorType: SensorType.WATER_LEVEL,
    label: 'Water Level',
    unit: 'cm',
    min: 0,
    max: 500,
    dataType: N,
  },

  // Flow Rate variants
  flow_rate: {
    sensorType: SensorType.FLOW_RATE,
    label: 'Flow Rate',
    unit: 'L/min',
    min: 0,
    max: 1000,
    dataType: N,
  },
  flow: {
    sensorType: SensorType.FLOW_RATE,
    label: 'Flow Rate',
    unit: 'L/min',
    min: 0,
    max: 1000,
    dataType: N,
  },

  // Pressure — no dedicated SensorType, persisted as MULTI_PARAMETER (SENSOR-HIGH-028).
  pressure: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Pressure',
    unit: 'bar',
    min: 0,
    max: 10,
    dataType: N,
  },

  // Conductivity variants
  conductivity: {
    sensorType: SensorType.CONDUCTIVITY,
    label: 'Conductivity',
    unit: 'µS/cm',
    min: 0,
    max: 50000,
    dataType: N,
  },
  ec: {
    sensorType: SensorType.CONDUCTIVITY,
    label: 'Electrical Conductivity',
    unit: 'µS/cm',
    min: 0,
    max: 50000,
    dataType: N,
  },

  // ORP variants
  orp: { sensorType: SensorType.ORP, label: 'ORP', unit: 'mV', min: -500, max: 500, dataType: N },
  redox: { sensorType: SensorType.ORP, label: 'ORP', unit: 'mV', min: -500, max: 500, dataType: N },

  // CO2 variants
  co2: { sensorType: SensorType.CO2, label: 'CO2', unit: 'mg/L', min: 0, max: 100, dataType: N },
  carbon_dioxide: {
    sensorType: SensorType.CO2,
    label: 'Carbon Dioxide',
    unit: 'mg/L',
    min: 0,
    max: 100,
    dataType: N,
  },

  // Alkalinity — MULTI_PARAMETER catch-all.
  alkalinity: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Alkalinity',
    unit: 'mg/L CaCO3',
    min: 0,
    max: 500,
    dataType: N,
  },

  // TDS — MULTI_PARAMETER catch-all.
  tds: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Total Dissolved Solids',
    unit: 'ppm',
    min: 0,
    max: 50000,
    dataType: N,
  },

  // Chlorine variants
  chlorine: {
    sensorType: SensorType.CHLORINE,
    label: 'Chlorine',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },
  cl: {
    sensorType: SensorType.CHLORINE,
    label: 'Chlorine',
    unit: 'mg/L',
    min: 0,
    max: 10,
    dataType: N,
  },

  // Ambient / status — MULTI_PARAMETER catch-alls.
  humidity: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Humidity',
    unit: '%',
    min: 0,
    max: 100,
    dataType: N,
  },
  battery: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Battery Level',
    unit: '%',
    min: 0,
    max: 100,
    dataType: N,
  },
  battery_level: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Battery Level',
    unit: '%',
    min: 0,
    max: 100,
    dataType: N,
  },
  rssi: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Signal Strength',
    unit: 'dBm',
    min: -120,
    max: 0,
    dataType: N,
  },
  signal: {
    sensorType: SensorType.MULTI_PARAMETER,
    label: 'Signal Strength',
    unit: 'dBm',
    min: -120,
    max: 0,
    dataType: N,
  },
};

/** A catalog entry with its lookup key, for serialization to the FE. */
export interface ParameterCatalogEntry extends ParameterDefinition {
  key: string;
}

/** Resolve a (case-insensitive) channel key to its parameter definition. */
export function lookupParameter(key: string): ParameterDefinition | undefined {
  return SENSOR_PARAMETER_CATALOG[key.toLowerCase()];
}

/** The whole catalog as a flat list (used by the sensorParameterCatalog query). */
export function listParameterCatalog(): ParameterCatalogEntry[] {
  return Object.entries(SENSOR_PARAMETER_CATALOG).map(([key, def]) => ({ key, ...def }));
}
