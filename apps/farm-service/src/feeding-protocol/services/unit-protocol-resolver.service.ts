/**
 * UnitProtocolResolverService — the ONE answer to "which protocol feeds this
 * unit, and at what rate?".
 *
 * WHY this exists: the feeding stack held four independent implementations of
 * that question — the tanks-page DataLoader, FeedSelectorService, the legacy
 * daily-plan engine, and the batch traceability report — and three of them
 * asked the WRONG entity. They read `batches_v2.protocolId`, a v1-era column
 * that pointed at the v1 `feeding_protocols` table and had NO writer anywhere
 * in the repo. It was therefore always NULL: every one of those three readers
 * resolved nothing and silently fell through to a feed-matrix/curve rate, while
 * the 06:00 v2 engine fed the very same tank from its `ProtocolAssignment`
 * band. Two engines, two rates, one tank.
 *
 * Protocol authority is UNIT-scoped, not batch-scoped:
 * `feeding_protocol_assignments.unitId` (an `Equipment.id`) carries at most ONE
 * active row per unit — structurally, via the partial unique index
 * `(tenantId, unitId) WHERE status = 'active'`. That matches the domain: the
 * tank is authoritative for weight, band, feed type and rate, and a batch that
 * moves tanks inherits the DESTINATION tank's protocol rather than dragging a
 * stale one with it. Batch identity remains for traceability only.
 *
 * WHAT it does, split deliberately into two halves:
 *  - `loadActiveBindings` is the single SQL shape that joins a unit's ACTIVE
 *    assignment to its ACTIVE protocol. Bulk by construction (`unitId = ANY`),
 *    so the N+1-sensitive DataLoader and the single-unit callers share it.
 *  - `resolveRate` is PURE band → effective-rate math, delegated to
 *    ProtocolRateService — the same calculator `MealPlanGeneratorService` runs
 *    at 06:00. The tanks page, the legacy daily plan, and the day plan cannot
 *    disagree by construction; there is no second formula to drift.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';

import type {
  ProtocolBand,
  ProtocolSettings,
  TemperatureAdjustment,
} from '../entities/feeding-protocol-v2.entity';
import type { AssignmentOverrides } from '../entities/protocol-assignment.entity';
import { ProtocolRateService, type BandWeightG } from './protocol-rate.service';

/**
 * The narrowest capability this resolver needs from TypeORM.
 *
 * WHY not `EntityManager`: callers reach the database through four different
 * TypeORM handles — a `DataSource` (cron), a `Repository` (DataLoader), a
 * request-scoped `EntityManager`, and a `QueryRunner`'s manager (tenant reads).
 * All four expose `query`, and that is the ONLY member used here. Typing the
 * parameter as exactly that member lets every caller pass its existing handle
 * unwrapped, and lets a test double be an honest object instead of a lie cast
 * to a full EntityManager.
 */
export type ProtocolSqlExecutor = Pick<EntityManager, 'query'>;

/** A unit's live protocol binding: its active assignment joined to its active protocol. */
export interface UnitProtocolBinding {
  /** `Equipment.id` — the canonical unit identity (ProtocolAssignment.unitId). */
  unitId: string;
  protocolId: string;
  protocolName: string;
  bands: ProtocolBand[];
  temperatureAdjustments?: TemperatureAdjustment[];
  settings: ProtocolSettings;
  /** Unit-level operational overrides (rate adjustment, meal shifts, FCR). */
  overrides?: AssignmentOverrides;
}

/** A binding resolved against a concrete tank state — feed product + final rate. */
export interface ResolvedUnitProtocol {
  unitId: string;
  protocolId: string;
  protocolName: string;
  bandIndex: number;
  /** Feed product is denormalized ON the band — no extra `feeds` lookup. */
  feedId: string;
  feedCode: string;
  feedName: string;
  /** band × tempMultiplier × (1 + rateAdj/100), clamped to protocol min/max (K-18). */
  effectiveRatePercent: number;
}

/** Raw row shape of the assignment ⋈ protocol join. */
interface UnitProtocolRow {
  unitId: string;
  protocolId: string;
  protocolName: string;
  overrides: AssignmentOverrides | string | null;
  bands: ProtocolBand[] | string;
  temperatureAdjustments: TemperatureAdjustment[] | string | null;
  settings: ProtocolSettings | string;
}

/**
 * WHY the string branch: these columns are `jsonb`. node-postgres parses jsonb
 * for us, but the same rows also arrive through TypeORM query paths that hand
 * back the raw text. Both shapes are legitimate driver output, so the parse is
 * a real narrowing of a genuinely-two-shaped input, not a defensive guard.
 */
function parseJsonArray<T>(value: T[] | string | null | undefined): T[] | undefined {
  if (value == null) return undefined;
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

function parseJsonObject<T>(value: T | string | null | undefined): T | undefined {
  if (value == null) return undefined;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

@Injectable()
export class UnitProtocolResolverService {
  constructor(private readonly rateService: ProtocolRateService) {}

  /**
   * Bulk-load the active protocol binding for each unit, keyed by `unitId`.
   * Units with no active assignment — or whose protocol is archived/deleted —
   * are simply absent from the map; the caller decides what "no protocol" means
   * for it (fall through to a feed matrix, skip the plan, report no protocol).
   *
   * WHY schema-qualified: this runs from cron contexts that never set a request
   * `search_path`, so an unqualified name would resolve against whatever schema
   * the pooled connection happened to carry. `getTenantSchemaName` is the same
   * SSoT every other farm raw query uses.
   */
  async loadActiveBindings(
    executor: ProtocolSqlExecutor,
    tenantId: string,
    unitIds: readonly string[],
  ): Promise<Map<string, UnitProtocolBinding>> {
    const bindings = new Map<string, UnitProtocolBinding>();
    const distinctUnitIds = [...new Set(unitIds)];
    // No units → no query. Keeps the "caller has no unit context" path free of
    // a pointless round trip (and keeps that fact assertable in tests).
    if (distinctUnitIds.length === 0) return bindings;

    const schema = getTenantSchemaName(tenantId);
    const rows: UnitProtocolRow[] = await executor.query(
      `SELECT pa."unitId", pa."overrides",
              p."id" AS "protocolId", p."name" AS "protocolName",
              p."bands", p."temperatureAdjustments", p."settings"
         FROM "${schema}".feeding_protocol_assignments pa
         JOIN "${schema}".feeding_protocols_v2 p
           ON p."id" = pa."protocolId"
          AND p."tenantId" = pa."tenantId"
          AND p."status" = 'active'
          AND p."isDeleted" = false
        WHERE pa."tenantId" = $1
          AND pa."unitId" = ANY($2::uuid[])
          AND pa."status" = 'active'`,
      [tenantId, distinctUnitIds],
    );

    for (const row of rows) {
      const settings = parseJsonObject<ProtocolSettings>(row.settings);
      // A protocol row always carries settings (NOT NULL jsonb). If a row ever
      // arrives without them the binding is unusable — skipping it degrades to
      // "no protocol" rather than inventing clamp bounds nobody configured.
      if (!settings) continue;
      bindings.set(row.unitId, {
        unitId: row.unitId,
        protocolId: row.protocolId,
        protocolName: row.protocolName,
        bands: parseJsonArray<ProtocolBand>(row.bands) ?? [],
        temperatureAdjustments: parseJsonArray<TemperatureAdjustment>(row.temperatureAdjustments),
        settings,
        overrides: parseJsonObject<AssignmentOverrides>(row.overrides),
      });
    }
    return bindings;
  }

  /**
   * PURE: resolve a binding against a concrete tank state. `null` when the
   * protocol carries no band for this weight (a protocol with zero bands).
   *
   * WHY `waterTempC: number | null` and not `number | undefined`: "no reading"
   * is a first-class state (P-20). A fabricated default temperature must never
   * scale the rate, so absence is passed through to `temperatureMultiplier`,
   * which answers 1.0 — the same contract the 06:00 generator honours.
   *
   * WHY `BandWeightG` and not a bare number: the band input must be the UNIT's
   * authoritative average weight. The brand makes handing it a batch-scoped
   * weight (`batch.getCurrentAvgWeight()`) a compile error rather than a silent
   * two-source divergence — and for a mixed tank that is exactly the point:
   * fish are size-graded before stocking, so a tank holds ONE size class and
   * the count-weighted tank mean IS the cohort's weight. Picking one batch's
   * weight would feed the whole tank on a sample of itself.
   */
  resolveRate(
    binding: UnitProtocolBinding,
    avgWeightG: BandWeightG,
    waterTempC: number | null,
  ): ResolvedUnitProtocol | null {
    const resolved = this.rateService.bandFor(binding.bands, avgWeightG);
    if (!resolved) return null;

    const tempMultiplier = this.rateService.temperatureMultiplier(
      binding.temperatureAdjustments,
      waterTempC,
    );
    const effectiveRatePercent = this.rateService.effectiveRatePercent({
      baseRatePercent: resolved.band.feedingRatePercent,
      temperatureMultiplier: tempMultiplier,
      rateAdjustmentPercent: binding.overrides?.rateAdjustmentPercent,
      minRatePercent: binding.settings.minFeedingRatePercent,
      maxRatePercent: binding.settings.maxFeedingRatePercent,
    });

    return {
      unitId: binding.unitId,
      protocolId: binding.protocolId,
      protocolName: binding.protocolName,
      bandIndex: resolved.index,
      feedId: resolved.band.feedId,
      feedCode: resolved.band.feedCode,
      feedName: resolved.band.feedName,
      effectiveRatePercent,
    };
  }

  /**
   * Single-unit convenience over the same two halves — one round trip, the same
   * SQL and the same math as the bulk path, so a one-off caller can never
   * become the place where a fifth formula grows.
   */
  async resolveForUnit(
    executor: ProtocolSqlExecutor,
    tenantId: string,
    unitId: string,
    avgWeightG: BandWeightG,
    waterTempC: number | null,
  ): Promise<ResolvedUnitProtocol | null> {
    const bindings = await this.loadActiveBindings(executor, tenantId, [unitId]);
    const binding = bindings.get(unitId);
    if (!binding) return null;
    return this.resolveRate(binding, avgWeightG, waterTempC);
  }
}
