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

import { round2 } from '../../common/utils/rounding.util';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';

export type WaterTemperatureSource = 'manual' | 'sensor';

export interface WaterTemperatureReading {
  celsius: number;
  source: WaterTemperatureSource;
  /** When the winning reading was measured (provenance for reporting). */
  measuredAt: Date;
  /** Sensor identity when source === 'sensor'. */
  sensorId?: string;
}

// ── Tazelik-pencereli etkin sıcaklık (feeding-protocol SSoT Faz 3, C-3/K-11) ──

/**
 * Tazelik pencereleri: yemleme oranı hesabına yalnız GÜNCEL veri girer.
 * Bayat sensör okuması manuel girişe, bayat manuel giriş açık NONE'a iner —
 * v1'in sessiz 15°C varsayımı burada da imkânsızdır (P-20).
 */
export const SENSOR_FRESHNESS_HOURS = 6;
export const MANUAL_FRESHNESS_HOURS = 24;

export type EffectiveTemperatureSource = 'sensor' | 'manual' | 'none';

/**
 * Yemleme motorunun/forecast'ın tükettiği etkin sıcaklık: kaynak AÇIKÇA
 * etiketlidir; `none` = "sıcaklık bilinmiyor, çarpan 1.0 uygula ve UI'da
 * göster" (snapshot `usingDefaultTemperature` bayrağını bundan türetir).
 */
export interface EffectiveTemperature {
  celsius: number | null;
  source: EffectiveTemperatureSource;
  measuredAt?: Date;
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

  /**
   * Tazelik-pencereli etkin sıcaklık (tek ünite): taze sensör (≤6s) →
   * taze manuel (≤24s) → NONE. `getCurrentTemperature`tan farkı recency
   * yarışı değil KESİN öncelik + tazelik kapısıdır — atanmış ama bayat bir
   * sensör, dünkü taze manuel girişi gölgeleyemez.
   */
  async getEffectiveTemperature(tenantId: string, unitId: string): Promise<EffectiveTemperature> {
    const map = await this.getEffectiveTemperaturesForUnits(tenantId, [unitId]);
    return map.get(unitId) ?? { celsius: null, source: 'none' };
  }

  /**
   * Toplu etkin sıcaklık çözümü (K-11): 06:00 plan cron'u ve forecast ünite
   * başına sorgu ATMAZ — tek tenant-read içinde iki toplu sorgu (sensör
   * projeksiyonu + manuel ölçümler, her ikisi DISTINCT ON ile ünite başına en
   * yeni satır). Her kaynak kendi SAVEPOINT'inde okunur (2026-07-06 bulkhead
   * kuralı): tek kaynağın altyapı hatası diğerini ve çağıranı düşürmez.
   */
  async getEffectiveTemperaturesForUnits(
    tenantId: string,
    unitIds: string[],
  ): Promise<Map<string, EffectiveTemperature>> {
    const result = new Map<string, EffectiveTemperature>();
    if (unitIds.length === 0) return result;
    for (const unitId of unitIds) {
      result.set(unitId, { celsius: null, source: 'none' });
    }

    await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sensorRows = await this.readSourceIsolated(
        queryRunner,
        'sensor',
        tenantId,
        'bulk',
        () =>
          queryRunner.manager.query(
            `SELECT DISTINCT ON (u."unitId")
                  u."unitId"        AS "unitId",
                  stl."temperatureC" AS celsius,
                  stl."measuredAt"   AS "measuredAt",
                  stl."sensorId"     AS "sensorId"
             FROM (
               SELECT "id" AS "unitId", "temperatureSensorId" FROM equipment
                WHERE "id" = ANY($1) AND "tenantId" = $2
               UNION ALL
               SELECT "id" AS "unitId", "temperatureSensorId" FROM tanks
                WHERE "id" = ANY($1) AND "tenantId" = $2
             ) u
             JOIN sensor_temperature_latest stl
               ON stl."sensorId" = u."temperatureSensorId" AND stl."tenantId" = $2
            WHERE u."temperatureSensorId" IS NOT NULL
              AND stl."measuredAt" >= now() - ($3 || ' hours')::interval
            ORDER BY u."unitId", stl."measuredAt" DESC`,
            [unitIds, tenantId, String(SENSOR_FRESHNESS_HOURS)],
          ) as Promise<Array<DatedTemperatureRow & { unitId: string }>>,
      );
      for (const row of sensorRows ?? []) {
        const dated = WaterTemperatureService.toDatedTemperature(row);
        if (dated) {
          result.set(row.unitId, {
            celsius: dated.celsius,
            source: 'sensor',
            measuredAt: dated.measuredAt,
            sensorId: dated.sensorId,
          });
        }
      }

      const unresolved = unitIds.filter((id) => result.get(id)?.source === 'none');
      if (unresolved.length === 0) return null;

      const manualRows = await this.readSourceIsolated(
        queryRunner,
        'manual',
        tenantId,
        'bulk',
        () =>
          queryRunner.manager.query(
            `SELECT DISTINCT ON (m."unitId")
                  m."unitId"    AS "unitId",
                  m."temperature" AS celsius,
                  m."measuredAt"  AS "measuredAt"
             FROM (
               SELECT COALESCE("tankId", "equipmentId") AS "unitId",
                      "temperature", "measuredAt"
                 FROM water_quality_measurements
                WHERE "tenantId" = $2
                  AND ("tankId" = ANY($1) OR "equipmentId" = ANY($1))
                  AND "temperature" IS NOT NULL
                  AND "measuredAt" >= now() - ($3 || ' hours')::interval
             ) m
            ORDER BY m."unitId", m."measuredAt" DESC`,
            [unresolved, tenantId, String(MANUAL_FRESHNESS_HOURS)],
          ) as Promise<Array<DatedTemperatureRow & { unitId: string }>>,
      );
      for (const row of manualRows ?? []) {
        const dated = WaterTemperatureService.toDatedTemperature(row);
        if (dated && result.get(row.unitId)?.source === 'none') {
          result.set(row.unitId, {
            celsius: dated.celsius,
            source: 'manual',
            measuredAt: dated.measuredAt,
          });
        }
      }
      return null;
    });

    return result;
  }

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
   * Run one temperature-source read inside a SAVEPOINT so its failure can be
   * rolled back without poisoning the surrounding READ COMMITTED transaction,
   * then degrade that source to null — loudly (error log + metric), never
   * silently.
   */
  private async readSourceIsolated<T>(
    queryRunner: QueryRunner,
    source: WaterTemperatureSource,
    tenantId: string,
    tankId: string,
    read: () => Promise<T>,
  ): Promise<T | null> {
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
