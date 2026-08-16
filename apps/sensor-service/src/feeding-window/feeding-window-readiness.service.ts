import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { FeedingWindowReadinessVerdictV1, MealWindowEntry } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { QUALITY_GOOD_MIN } from '../database/sensor-quality.authority';

export const DO_READING_FRESHNESS_MINUTES = 60;
export const MAX_UNITS_PER_READINESS_BATCH = 500;

interface OxygenObservationRow {
  readonly unitId: string;
  readonly instrumented: boolean;
  readonly dissolvedOxygen: string | number | null;
  readonly observedAt: Date | string | null;
}

interface OxygenObservation {
  readonly instrumented: boolean;
  readonly dissolvedOxygen: number | null;
  readonly observedAt: string | null;
}

function assertGuardedEntry(entry: MealWindowEntry): void {
  if (!isValidUUID(entry.unitId) || !isValidUUID(entry.mealId)) {
    throw new Error('Guarded meal-window entries require UUID unitId and mealId');
  }
  if (
    !Number.isFinite(entry.minDissolvedOxygen) ||
    (entry.minDissolvedOxygen ?? 0) < 0 ||
    (entry.minDissolvedOxygen ?? 0) > 20
  ) {
    throw new Error('Guarded meal-window entries require an oxygen floor from 0 to 20 mg/L');
  }
}

@Injectable()
export class FeedingWindowReadinessService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async evaluate(
    tenantId: string,
    entries: readonly MealWindowEntry[],
    evaluatedAt: Date,
  ): Promise<FeedingWindowReadinessVerdictV1[]> {
    if (!isValidUUID(tenantId)) {
      throw new Error('Feeding-window readiness requires a valid tenant UUID');
    }
    if (!Number.isFinite(evaluatedAt.getTime())) {
      throw new Error('Feeding-window readiness requires a valid evaluation instant');
    }
    if (entries.length > MAX_UNITS_PER_READINESS_BATCH) {
      throw new Error(`Meal-window batch exceeds ${MAX_UNITS_PER_READINESS_BATCH} entry capacity`);
    }

    const guarded = entries.filter(
      (entry): entry is MealWindowEntry & { minDissolvedOxygen: number } =>
        entry.minDissolvedOxygen !== undefined,
    );
    for (const entry of guarded) assertGuardedEntry(entry);
    if (guarded.length === 0) return [];

    const unitIds = [...new Set(guarded.map((entry) => entry.unitId))].sort();
    const observations = await this.loadOxygenObservations(tenantId, unitIds, evaluatedAt);

    return guarded.map((entry) => {
      const observation = observations.get(entry.unitId);
      const common = {
        unitId: entry.unitId,
        unitCode: entry.unitCode,
        mealId: entry.mealId,
        dayPlanId: entry.dayPlanId,
        scheduledAt: entry.scheduledAt,
        minDissolvedOxygen: entry.minDissolvedOxygen,
        lowOxygenReductionPercent: entry.lowOxygenReductionPercent,
      } as const;

      if (!observation?.instrumented) {
        return { ...common, status: 'not_instrumented' as const };
      }
      if (observation.dissolvedOxygen === null || observation.observedAt === null) {
        return { ...common, status: 'no_reading' as const };
      }
      return {
        ...common,
        status:
          observation.dissolvedOxygen < entry.minDissolvedOxygen
            ? ('low_oxygen' as const)
            : ('ready' as const),
        observedDissolvedOxygen: observation.dissolvedOxygen,
        observedAt: observation.observedAt,
      };
    });
  }

  private async loadOxygenObservations(
    tenantId: string,
    unitIds: readonly string[],
    evaluatedAt: Date,
  ): Promise<ReadonlyMap<string, OxygenObservation>> {
    const freshnessCutoff = new Date(evaluatedAt.getTime() - DO_READING_FRESHNESS_MINUTES * 60_000);
    const rows = await runInTenantRead(
      this.dataSource,
      'sensor',
      tenantId,
      async (queryRunner): Promise<OxygenObservationRow[]> =>
        queryRunner.query(
          `WITH requested(unit_id) AS (
             SELECT unnest($1::text[])
           ), do_channels AS (
             SELECT s.id AS sensor_id,
                    binding.unit_id AS unit_id,
                    c.id AS channel_id
               FROM sensors s
               JOIN sensor_data_channels c
                 ON c.sensor_id = s.id
                AND c.tenant_id = $2::uuid
                AND c.channel_key = 'dissolved_oxygen'
                AND c.is_enabled = true
              CROSS JOIN LATERAL (
                VALUES (s.equipment_id::text), (s.tank_id::text)
              ) AS binding(unit_id)
              WHERE s.tenant_id = $2::uuid
                AND s.is_active = true
                AND binding.unit_id = ANY($1::text[])
           )
           SELECT DISTINCT ON (r.unit_id)
                  r.unit_id::text AS "unitId",
                  (dc.sensor_id IS NOT NULL) AS instrumented,
                  latest.value AS "dissolvedOxygen",
                  latest.time AS "observedAt"
             FROM requested r
             LEFT JOIN do_channels dc ON dc.unit_id = r.unit_id
             LEFT JOIN LATERAL (
               SELECT m.value, m.time
                 FROM sensor_metrics m
                WHERE m.sensor_id = dc.sensor_id
                  AND m.channel_id = dc.channel_id
                  AND m.tenant_id = $2::uuid
                  AND m.quality_code >= $5
                  AND m.time >= $3::timestamptz
                  AND m.time <= $4::timestamptz
                ORDER BY m.time DESC
                LIMIT 1
             ) latest ON true
            ORDER BY r.unit_id, latest.time DESC NULLS LAST, dc.sensor_id`,
          [
            unitIds,
            tenantId,
            freshnessCutoff.toISOString(),
            evaluatedAt.toISOString(),
            QUALITY_GOOD_MIN,
          ],
        ),
    );

    const observations = new Map<string, OxygenObservation>();
    for (const row of rows) {
      const dissolvedOxygen = row.dissolvedOxygen === null ? null : Number(row.dissolvedOxygen);
      if (
        dissolvedOxygen !== null &&
        (!Number.isFinite(dissolvedOxygen) || dissolvedOxygen < 0 || dissolvedOxygen > 20)
      ) {
        throw new Error(`Invalid dissolved-oxygen projection for unit ${row.unitId}`);
      }
      const observedAt = row.observedAt === null ? null : new Date(row.observedAt).toISOString();
      observations.set(row.unitId, {
        instrumented: row.instrumented === true,
        dissolvedOxygen,
        observedAt,
      });
    }
    return observations;
  }
}
