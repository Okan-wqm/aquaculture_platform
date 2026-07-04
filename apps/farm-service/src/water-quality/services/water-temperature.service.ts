/**
 * WaterTemperatureService
 *
 * Single source of truth for "what is the current water temperature for tank X",
 * used by the feeding-rate calculation (the temperature multiplier of a feeding
 * protocol). Kept deliberately small and cross-module-injectable.
 *
 * Sources, in priority order:
 *   1. (Phase 2b) the latest reading from a sensor linked to the tank.
 *   2. the latest MANUAL water-quality measurement carrying a temperature.
 *   3. null — the caller then applies no temperature correction (multiplier 1.0).
 *
 * Phase 2a wires source #2 only; source #1 (sensor) lands in Phase 2b via a
 * farm-side projection of the sensor-service SensorReading event stream (the
 * cross-schema raw query the old bridge used is prod-broken — `farm_service`
 * has no grant on the `sensor` schema).
 *
 * Reads are explicitly schema-qualified (`getTenantSchemaName`) rather than
 * relying on the request search_path, so the service is safe to call from the
 * daily-feeding cron (no request context) as well as GraphQL resolvers.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';

export type WaterTemperatureSource = 'manual' | 'sensor';

export interface WaterTemperatureReading {
  celsius: number;
  source: WaterTemperatureSource;
}

interface TemperatureRow {
  temperature: string | number | null;
}

@Injectable()
export class WaterTemperatureService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Latest known water temperature (°C) for a tank/equipment, or null when none
   * is on record. `tankId` matches either the measurement's `tankId` or its
   * `equipmentId` (a tank is a farm Equipment row; measurements may key on
   * either).
   */
  async getCurrentTemperature(
    tenantId: string,
    tankId: string,
  ): Promise<WaterTemperatureReading | null> {
    const schema = getTenantSchemaName(tenantId);
    const rows: TemperatureRow[] = await this.dataSource.query(
      `SELECT "temperature"
         FROM "${schema}".water_quality_measurements
        WHERE "tenantId" = $1
          AND ("tankId" = $2 OR "equipmentId" = $2)
          AND "temperature" IS NOT NULL
        ORDER BY "measuredAt" DESC
        LIMIT 1`,
      [tenantId, tankId],
    );
    const value = rows[0]?.temperature;
    if (value == null) {
      return null;
    }
    return { celsius: Number(value), source: 'manual' };
  }
}
