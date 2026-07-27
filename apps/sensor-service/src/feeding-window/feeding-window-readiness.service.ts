/**
 * FeedingWindowReadinessService (W7 — FARM-MEDIUM-271)
 *
 * Answers the question the farm engine puts on the wire and, until this
 * service existed, nobody read: **is this unit's dissolved oxygen above the
 * protocol floor at the moment the meal is about to start?**
 *
 * `MealWindowUpcoming` carries `minDissolvedOxygen` +
 * `lowOxygenReductionPercent` per meal precisely so the sensor side can gate
 * (and later pre-boost aeration for) the feed. Those fields were serialised
 * and dropped, which made the operator's protocol setting decorative — and
 * because farm burns `windowNotifiedAt` in the emitting transaction, the
 * window could not be replayed to recover the check.
 *
 * ## Query shape
 *
 * ONE pass over the whole batch (the event caps at 500 entries), never a query
 * per unit: `unnest` of the unit ids joined to the tenant's active DO sensors,
 * with a LATERAL pick of each sensor's freshest in-window reading. The LATERAL
 * is a LEFT JOIN on purpose — a unit with a DO sensor that has gone quiet must
 * come back with a NULL reading so it can be reported as `no_reading` rather
 * than silently passing the guard. A unit with no DO sensor at all produces no
 * row and no verdict: nothing was promised for it.
 *
 * `sensors` / `sensor_readings` are per-tenant tables, so the read runs inside
 * `runInTenantRead` (search_path pinned + asserted) rather than a hand-written
 * schema qualification.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import type { MealWindowEntry } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

/** A reading older than this cannot vouch for conditions at meal time. */
export const DO_READING_FRESHNESS_MINUTES = 60;

/**
 * Hard cap on units evaluated per event. `MealWindowUpcoming` already caps its
 * own batch at 500 entries and emits continuation events beyond that; this is
 * the defensive twin so a malformed producer cannot turn one message into an
 * unbounded `unnest`.
 */
export const MAX_UNITS_PER_EVALUATION = 500;

export interface UnitOxygenObservation {
  unitId: string;
  /** Freshest in-window mg/L reading, or null when the sensor has gone quiet. */
  dissolvedOxygen: number | null;
  observedAt: Date | null;
}

export interface FeedingWindowVerdict {
  entry: MealWindowEntry;
  status: 'low_oxygen' | 'no_reading';
  observedDissolvedOxygen?: number;
  observedAt?: string;
}

interface OxygenRow {
  unitId: string;
  dissolvedOxygen: string | null;
  observedAt: Date | null;
}

@Injectable()
export class FeedingWindowReadinessService {
  private readonly logger = new Logger(FeedingWindowReadinessService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Evaluate every entry that declares an oxygen floor and return ONLY the
   * non-ready verdicts. A "ready" answer for every meal of every unit would be
   * ~500 events per tick carrying no decision — the wire is for decisions.
   */
  async evaluate(
    tenantId: string,
    entries: readonly MealWindowEntry[],
  ): Promise<FeedingWindowVerdict[]> {
    const guarded = entries.filter(
      (entry) =>
        typeof entry.minDissolvedOxygen === 'number' && isValidUUID(entry.unitId),
    );
    if (guarded.length === 0) {
      return [];
    }

    const unitIds = [...new Set(guarded.map((entry) => entry.unitId))].slice(
      0,
      MAX_UNITS_PER_EVALUATION,
    );
    const observations = await this.loadOxygenObservations(tenantId, unitIds);

    const verdicts: FeedingWindowVerdict[] = [];
    for (const entry of guarded) {
      const observation = observations.get(entry.unitId);
      if (!observation) {
        // No active DO sensor mapped to this unit — the protocol floor cannot
        // be evaluated and no guarantee was ever made. Silence is correct;
        // reporting it would page an operator about every non-instrumented tank.
        continue;
      }

      if (observation.dissolvedOxygen === null || observation.observedAt === null) {
        verdicts.push({ entry, status: 'no_reading' });
        continue;
      }

      // `minDissolvedOxygen` is non-null for every `guarded` entry.
      if (observation.dissolvedOxygen < (entry.minDissolvedOxygen ?? 0)) {
        verdicts.push({
          entry,
          status: 'low_oxygen',
          observedDissolvedOxygen: observation.dissolvedOxygen,
          observedAt: observation.observedAt.toISOString(),
        });
      }
    }

    this.logger.debug(
      `Evaluated ${guarded.length} guarded meal window(s) across ${unitIds.length} unit(s) — ` +
        `${verdicts.length} non-ready verdict(s)`,
    );
    return verdicts;
  }

  private async loadOxygenObservations(
    tenantId: string,
    unitIds: string[],
  ): Promise<Map<string, UnitOxygenObservation>> {
    const freshnessCutoff = new Date(
      Date.now() - DO_READING_FRESHNESS_MINUTES * 60_000,
    );

    const rows = await runInTenantRead(
      this.dataSource,
      'sensor',
      tenantId,
      async (queryRunner): Promise<OxygenRow[]> =>
        // `sensors.equipment_id` / `sensors.tank_id` are the two columns that
        // bind a sensor to a farm unit (Equipment.id); both are varchar, hence
        // the text[] unnest rather than uuid[].
        queryRunner.query(
          `SELECT DISTINCT ON (u.unit_id)
                  u.unit_id                                   AS "unitId",
                  (r.readings->>'dissolvedOxygen')::numeric   AS "dissolvedOxygen",
                  r.timestamp                                 AS "observedAt"
             FROM unnest($1::text[]) AS u(unit_id)
             JOIN sensors s
               ON (s.equipment_id = u.unit_id OR s.tank_id = u.unit_id)
              AND s.tenant_id = $2
              AND s.type::text = 'dissolved_oxygen'
              AND s.is_active = true
             LEFT JOIN LATERAL (
                   SELECT rr."timestamp", rr.readings
                     FROM sensor_readings rr
                    WHERE rr.sensor_id = s.id
                      AND rr.tenant_id = $2
                      AND rr."timestamp" >= $3
                      AND rr.readings ? 'dissolvedOxygen'
                    ORDER BY rr."timestamp" DESC
                    LIMIT 1
                 ) r ON true
            ORDER BY u.unit_id, r."timestamp" DESC NULLS LAST`,
          [unitIds, tenantId, freshnessCutoff.toISOString()],
        ),
    );

    const observations = new Map<string, UnitOxygenObservation>();
    for (const row of rows) {
      observations.set(row.unitId, {
        unitId: row.unitId,
        // numeric arrives as a string from pg — parse once, here.
        dissolvedOxygen:
          row.dissolvedOxygen === null ? null : Number(row.dissolvedOxygen),
        observedAt: row.observedAt === null ? null : new Date(row.observedAt),
      });
    }
    return observations;
  }
}
