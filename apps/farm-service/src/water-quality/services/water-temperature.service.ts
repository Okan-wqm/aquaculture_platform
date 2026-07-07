/**
 * WaterTemperatureService
 *
 * Single source of truth for "what is the current water temperature for tank X",
 * used by the feeding-rate calculation (the temperature multiplier of a feeding
 * protocol). Kept deliberately small and cross-module-injectable.
 *
 * Two sources, and the MOST RECENT reading wins:
 *   - SENSOR: the tank's linked sensor (`equipment.temperatureSensorId`) resolved
 *     against the local `sensor_temperature_latest` projection (fed by the
 *     sensor-service SensorReading event — no synchronous cross-service call, no
 *     cross-schema grant).
 *   - MANUAL: the latest MANUAL water-quality measurement carrying a temperature.
 * When neither exists the caller applies no temperature correction (multiplier 1.0).
 *
 * Reads run inside `runInTenantRead` — the platform's fail-closed tenant
 * boundary (UUID validation + pinned search_path + RLS-GUC assertion) — so the
 * service is safe from the daily-feeding cron (no request context) AND carries
 * no hand-built schema interpolation (GSEC-HIGH-001: the previous
 * `"${schema}".table` raw reads were the only farm read path skipping the
 * boundary; a schema string is never interpolated here again).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';

export type WaterTemperatureSource = 'manual' | 'sensor';

export interface WaterTemperatureReading {
  celsius: number;
  source: WaterTemperatureSource;
}

/**
 * Biologically plausible water-temperature bounds (°C) — the SSoT shared by the
 * manual entry path and the sensor projection so no source can feed the
 * feeding-rate calculation an absurd value.
 */
export const WATER_TEMPERATURE_MIN_C = -5;
export const WATER_TEMPERATURE_MAX_C = 45;

interface DatedTemperature {
  celsius: number;
  measuredAt: Date;
}

interface DatedTemperatureRow {
  celsius: string | number | null;
  measuredAt: string | Date | null;
}

@Injectable()
export class WaterTemperatureService {
  private readonly logger = new Logger(WaterTemperatureService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly metricsService?: FarmDomainMetricsService,
  ) {}

  /**
   * Latest known water temperature (°C) for a tank/equipment, or null when none
   * is on record. Compares the tank's linked-sensor reading against the latest
   * manual measurement and returns whichever is more recent.
   *
   * BULKHEAD (2026-07-06 incident): temperature is ENRICHMENT — an
   * infrastructure failure of one source (the live case: a missing grant on
   * sensor_temperature_latest) must not abort the caller. Before this, the
   * throw escaped and (a) nulled the ENTIRE equipmentList.batchMetrics field —
   * mobile lost all fish counts while tank_batches was healthy — and (b) failed
   * every tank's daily feeding plan tenant-wide. Each source now reads under
   * its own SAVEPOINT (a plain try/catch is NOT enough: Postgres aborts the
   * surrounding transaction after an error, poisoning the sibling read with
   * 25P02) and an infrastructure failure degrades to null-for-that-source —
   * LOUDLY: structured Logger.error + farm_water_temperature_read_failures_total.
   * The tenant boundary itself (runInTenantRead) stays fail-closed.
   */
  async getCurrentTemperature(
    tenantId: string,
    tankId: string,
  ): Promise<WaterTemperatureReading | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sensor = await this.readSourceIsolated(queryRunner, 'sensor', tenantId, tankId, () =>
        this.getLinkedSensorTemperature(queryRunner, tenantId, tankId),
      );
      const manual = await this.readSourceIsolated(queryRunner, 'manual', tenantId, tankId, () =>
        this.getManualTemperature(queryRunner, tenantId, tankId),
      );

      if (sensor && manual) {
        return sensor.measuredAt >= manual.measuredAt
          ? { celsius: sensor.celsius, source: 'sensor' as const }
          : { celsius: manual.celsius, source: 'manual' as const };
      }
      if (sensor) {
        return { celsius: sensor.celsius, source: 'sensor' as const };
      }
      if (manual) {
        return { celsius: manual.celsius, source: 'manual' as const };
      }
      return null;
    });
  }

  /**
   * Run one temperature-source read inside a SAVEPOINT so its failure can be
   * rolled back without poisoning the surrounding READ COMMITTED transaction,
   * then degrade that source to null — loudly (error log + metric), never
   * silently.
   */
  private async readSourceIsolated(
    queryRunner: QueryRunner,
    source: WaterTemperatureSource,
    tenantId: string,
    tankId: string,
    read: () => Promise<DatedTemperature | null>,
  ): Promise<DatedTemperature | null> {
    await queryRunner.query('SAVEPOINT water_temperature_source');
    try {
      const result = await read();
      await queryRunner.query('RELEASE SAVEPOINT water_temperature_source');
      return result;
    } catch (error) {
      await queryRunner.query('ROLLBACK TO SAVEPOINT water_temperature_source');
      this.logger.error({
        event: 'WaterTemperatureSourceReadFailed',
        source,
        tankId,
        tenantHash: tenantId.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
      this.metricsService?.recordWaterTemperatureReadFailure({ source });
      return null;
    }
  }

  /**
   * Latest reading from the sensor linked to the container at creation, if any.
   * A container id resolves against the `tanks` table (tanks/ponds/cages) OR the
   * `equipment` table (other containers) — the equipment list unions both, so the
   * id passed here can belong to either — hence the UNION subquery. Table names
   * are unqualified: the pinned search_path routes them into the tenant schema.
   */
  private async getLinkedSensorTemperature(
    queryRunner: QueryRunner,
    tenantId: string,
    tankId: string,
  ): Promise<DatedTemperature | null> {
    const rows: DatedTemperatureRow[] = await queryRunner.manager.query(
      `SELECT stl."temperatureC" AS celsius, stl."measuredAt" AS "measuredAt"
         FROM sensor_temperature_latest stl
        WHERE stl."tenantId" = $2
          AND stl."sensorId" = (
            SELECT s."temperatureSensorId"
              FROM (
                SELECT "temperatureSensorId" FROM tanks
                 WHERE "id" = $1 AND "tenantId" = $2
                UNION ALL
                SELECT "temperatureSensorId" FROM equipment
                 WHERE "id" = $1 AND "tenantId" = $2
              ) s
             WHERE s."temperatureSensorId" IS NOT NULL
             LIMIT 1
          )
        LIMIT 1`,
      [tankId, tenantId],
    );
    return WaterTemperatureService.toDatedTemperature(rows[0]);
  }

  /** Latest manual water-quality measurement carrying a temperature, if any. */
  private async getManualTemperature(
    queryRunner: QueryRunner,
    tenantId: string,
    tankId: string,
  ): Promise<DatedTemperature | null> {
    const rows: DatedTemperatureRow[] = await queryRunner.manager.query(
      `SELECT "temperature" AS celsius, "measuredAt" AS "measuredAt"
         FROM water_quality_measurements
        WHERE "tenantId" = $1
          AND ("tankId" = $2 OR "equipmentId" = $2)
          AND "temperature" IS NOT NULL
        ORDER BY "measuredAt" DESC
        LIMIT 1`,
      [tenantId, tankId],
    );
    return WaterTemperatureService.toDatedTemperature(rows[0]);
  }

  private static toDatedTemperature(row: DatedTemperatureRow | undefined): DatedTemperature | null {
    if (!row || row.celsius == null || row.measuredAt == null) {
      return null;
    }
    return { celsius: Number(row.celsius), measuredAt: new Date(row.measuredAt) };
  }
}
