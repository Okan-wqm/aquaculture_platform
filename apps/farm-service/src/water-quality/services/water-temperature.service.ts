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
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

export type WaterTemperatureSource = 'manual' | 'sensor';

export interface WaterTemperatureReading {
  celsius: number;
  source: WaterTemperatureSource;
  /** When the winning reading was measured (provenance for reporting). */
  measuredAt: Date;
  /** Sensor identity when source === 'sensor'. */
  sensorId?: string;
}

/**
 * Period-representative temperature over a reporting window (e.g. the lakselus
 * report week). Unlike the point-in-time reading, this is aggregated across the
 * period so a report for week N carries week N's temperature — not wall-clock
 * "now" at assembly time.
 */
export interface PeriodTemperature {
  /** Mean over the period (°C), rounded to 2 decimals. */
  celsius: number;
  source: WaterTemperatureSource;
  /** Distinct calendar days in the period that carried data (coverage). */
  coverageDays: number;
  minC: number;
  maxC: number;
}

interface SensorPeriodRow {
  sumC: string | number | null;
  sampleCount: string | number | null;
  minC: string | number | null;
  maxC: string | number | null;
  coverageDays: string | number | null;
}

interface ManualPeriodRow {
  avgC: string | number | null;
  minC: string | number | null;
  maxC: string | number | null;
  coverageDays: string | number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
  sensorId?: string;
}

interface DatedTemperatureRow {
  celsius: string | number | null;
  measuredAt: string | Date | null;
  sensorId?: string | null;
}

@Injectable()
export class WaterTemperatureService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Latest known water temperature (°C) for a tank/equipment, or null when none
   * is on record. Compares the tank's linked-sensor reading against the latest
   * manual measurement and returns whichever is more recent.
   */
  async getCurrentTemperature(
    tenantId: string,
    tankId: string,
  ): Promise<WaterTemperatureReading | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const [sensor, manual] = await Promise.all([
        this.getLinkedSensorTemperature(queryRunner, tenantId, tankId),
        this.getManualTemperature(queryRunner, tenantId, tankId),
      ]);

      return WaterTemperatureService.pickNewest(sensor, manual);
    });
  }

  /**
   * Latest known water temperature (°C) across every tank of a site, or null
   * when none is on record. The reporting SSoT for site-level fields such as
   * the lakselus report's sjøtemperatur: sensor projection and manual
   * measurements compete on recency exactly like the per-tank read — one
   * temperature path, never a second implementation.
   */
  async getSiteCurrentTemperature(
    tenantId: string,
    siteId: string,
  ): Promise<WaterTemperatureReading | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sensorRows: DatedTemperatureRow[] = await queryRunner.manager.query(
        `SELECT stl."temperatureC" AS celsius,
                stl."measuredAt" AS "measuredAt",
                stl."sensorId" AS "sensorId"
           FROM sensor_temperature_latest stl
          WHERE stl."tenantId" = $1
            AND stl."sensorId" IN (
              SELECT t."temperatureSensorId"
                FROM tanks t
                JOIN departments d ON d.id = t."departmentId"
               WHERE t."tenantId" = $1
                 AND d."siteId" = $2
                 AND t."temperatureSensorId" IS NOT NULL
            )
          ORDER BY stl."measuredAt" DESC
          LIMIT 1`,
        [tenantId, siteId],
      );
      const manualRows: DatedTemperatureRow[] = await queryRunner.manager.query(
        `SELECT m."temperature" AS celsius, m."measuredAt" AS "measuredAt"
           FROM water_quality_measurements m
           JOIN tanks t ON t.id = m."tankId" AND t."tenantId" = m."tenantId"
           JOIN departments d ON d.id = t."departmentId"
          WHERE m."tenantId" = $1
            AND d."siteId" = $2
            AND m."temperature" IS NOT NULL
          ORDER BY m."measuredAt" DESC
          LIMIT 1`,
        [tenantId, siteId],
      );
      return WaterTemperatureService.pickNewest(
        WaterTemperatureService.toDatedTemperature(sensorRows[0]),
        WaterTemperatureService.toDatedTemperature(manualRows[0]),
      );
    });
  }

  /**
   * Representative water temperature over a reporting period for a site,
   * aggregated from the sensor daily rollup (preferred, continuous) or the
   * period's manual measurements (fallback). Returns null when the site has
   * no temperature data in the window — the caller flags MANUAL_REQUIRED
   * rather than guessing.
   *
   * `fromDate`/`toDate` are inclusive UTC ISO dates (yyyy-mm-dd) matching the
   * daily rollup's `day` grain, so the aggregate is tied to the report period
   * and never to wall-clock now.
   */
  async getPeriodTemperature(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<PeriodTemperature | null> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sensorRows: SensorPeriodRow[] = await queryRunner.manager.query(
        `SELECT SUM(std."sumC") AS "sumC",
                SUM(std."sampleCount") AS "sampleCount",
                MIN(std."minC") AS "minC",
                MAX(std."maxC") AS "maxC",
                COUNT(DISTINCT std."day") AS "coverageDays"
           FROM sensor_temperature_daily std
          WHERE std."tenantId" = $1
            AND std."day" BETWEEN $3 AND $4
            AND std."sensorId" IN (
              SELECT t."temperatureSensorId"
                FROM tanks t
                JOIN departments d ON d.id = t."departmentId"
               WHERE t."tenantId" = $1
                 AND d."siteId" = $2
                 AND t."temperatureSensorId" IS NOT NULL
            )`,
        [tenantId, siteId, fromDate, toDate],
      );
      const sensor = sensorRows[0];
      const sampleCount = sensor ? Number(sensor.sampleCount ?? 0) : 0;
      if (sensor && sampleCount > 0) {
        return {
          celsius: round2(Number(sensor.sumC) / sampleCount),
          source: 'sensor',
          coverageDays: Number(sensor.coverageDays ?? 0),
          minC: round2(Number(sensor.minC)),
          maxC: round2(Number(sensor.maxC)),
        };
      }

      const manualRows: ManualPeriodRow[] = await queryRunner.manager.query(
        `SELECT AVG(m."temperature") AS "avgC",
                MIN(m."temperature") AS "minC",
                MAX(m."temperature") AS "maxC",
                COUNT(DISTINCT (m."measuredAt" AT TIME ZONE 'UTC')::date) AS "coverageDays"
           FROM water_quality_measurements m
           JOIN tanks t ON t.id = m."tankId" AND t."tenantId" = m."tenantId"
           JOIN departments d ON d.id = t."departmentId"
          WHERE m."tenantId" = $1
            AND d."siteId" = $2
            AND m."temperature" IS NOT NULL
            AND (m."measuredAt" AT TIME ZONE 'UTC')::date BETWEEN $3 AND $4`,
        [tenantId, siteId, fromDate, toDate],
      );
      const manual = manualRows[0];
      const coverageDays = manual ? Number(manual.coverageDays ?? 0) : 0;
      if (manual && manual.avgC != null && coverageDays > 0) {
        return {
          celsius: round2(Number(manual.avgC)),
          source: 'manual',
          coverageDays,
          minC: round2(Number(manual.minC)),
          maxC: round2(Number(manual.maxC)),
        };
      }

      return null;
    });
  }

  /** Newest-wins merge of the sensor and manual candidates. */
  private static pickNewest(
    sensor: DatedTemperature | null,
    manual: DatedTemperature | null,
  ): WaterTemperatureReading | null {
    if (sensor && manual) {
      return sensor.measuredAt >= manual.measuredAt
        ? WaterTemperatureService.toReading(sensor, 'sensor')
        : WaterTemperatureService.toReading(manual, 'manual');
    }
    if (sensor) {
      return WaterTemperatureService.toReading(sensor, 'sensor');
    }
    if (manual) {
      return WaterTemperatureService.toReading(manual, 'manual');
    }
    return null;
  }

  private static toReading(
    dated: DatedTemperature,
    source: WaterTemperatureSource,
  ): WaterTemperatureReading {
    return {
      celsius: dated.celsius,
      source,
      measuredAt: dated.measuredAt,
      sensorId: source === 'sensor' ? dated.sensorId : undefined,
    };
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
      `SELECT stl."temperatureC" AS celsius,
              stl."measuredAt" AS "measuredAt",
              stl."sensorId" AS "sensorId"
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
    return {
      celsius: Number(row.celsius),
      measuredAt: new Date(row.measuredAt),
      sensorId: row.sensorId ?? undefined,
    };
  }
}
