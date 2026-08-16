import {
  FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
  FEEDING_FORECAST_PROJECTION_V1,
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
  FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY,
  compileFeedingForecastGenerationExactSetProofV1,
  assertFeedingForecastMortalityProvenanceV1,
  createGrowthAppliedPayloadV1,
  createGrowthPolicyAssertedPayloadV1,
  feedingMutationCoordinatesForWriter,
  type FeedingForecastPoolScope,
  type FeedingGrowthEventApplicationModeV1,
} from '@aquaculture/feeding-contracts';
import { canonicalWireJsonSha256V1 } from '@aquaculture/shared-contracts';
import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  readTenantMutationSession,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { Injectable, type Provider } from '@nestjs/common';
import type { DeepPartial, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import {
  FeedingDayPlan,
  type DayPlanResolutionV1,
  type DayPlanSnapshot,
  type FeedingDayPlanStatus,
} from './entities/feeding-day-plan.entity';
import { FeedingForecastSnapshot } from './entities/feeding-forecast-snapshot.entity';
import { FeedingMeal, type MealPour, type FeedingMealStatus } from './entities/feeding-meal.entity';
import { FeedingProtocolV2 } from './entities/feeding-protocol-v2.entity';
import {
  FEEDING_UNIT_TYPE_DATABASE_ENUM,
  type ProtocolAssignment,
} from './entities/protocol-assignment.entity';
import type { DayPlanGrowthApplicationMode } from './day-plan-growth-reconciliation.authority';

const FEEDING_AGGREGATE_COORDINATES = feedingMutationCoordinatesForWriter(
  FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
);

interface InsertDayPlanIfAbsentV1 {
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly protocolId: string;
  readonly unitId: string;
  readonly siteId: string;
  readonly unitType: ProtocolAssignment['unitType'];
  readonly unitName: string;
  readonly unitCode: string;
  readonly planDate: string;
  readonly growthPolicyVersion: number;
  readonly growthApplicationMode: DayPlanGrowthApplicationMode;
  readonly snapshot: DayPlanSnapshot;
  readonly resolution: DayPlanResolutionV1;
  readonly plannedTotalKg: number;
  readonly mealsPlanned: number;
  readonly status: FeedingDayPlanStatus;
  readonly skipReason?: string;
}

type CreateDayPlanIfAbsentV1 = Omit<InsertDayPlanIfAbsentV1, 'tenantId'>;

export interface RecordDayPlanGrowthApplicationV1 {
  readonly dayPlanId: string;
  readonly applicationMode: FeedingGrowthEventApplicationModeV1;
  readonly appliedAt: Date;
  readonly expectedFcr: number;
  readonly feedDeltaKg: number;
  readonly growthDeltaKg: number;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly recordedBy: string;
  readonly sourceRef: string;
}

type DayPlanTransitionIntentV1 =
  | 'generated'
  | 'recalculated'
  | 'meal_execution_applied'
  | 'growth_rollup_applied';
type MealTransitionIntentV1 =
  | 'scheduled'
  | 'recorded'
  | 'corrected'
  | 'skipped'
  | 'missed'
  | 'recalculated';
type ProtocolDefinitionTransitionIntentV1 = 'created' | 'updated' | 'archived';
type ProtocolAssignmentTransitionIntentV1 =
  | 'assigned'
  | 'updated'
  | 'paused'
  | 'unassigned'
  | 'band_transitioned'
  | 'feed_transitioned';

type CommitFeedingRecordTransitionV1 =
  | {
      readonly intent: 'recorded';
      readonly aggregate: FeedingRecord;
      readonly provenance: {
        readonly operationId: string;
        readonly origin: 'LIVE_DRAIN' | 'RUNTIME_OPERATION';
      };
    }
  | {
      readonly intent: 'corrected';
      readonly aggregate: FeedingRecord;
    };

interface CommitDayPlanTransitionV1 {
  readonly intent: DayPlanTransitionIntentV1;
  readonly aggregate: FeedingDayPlan;
}

interface CommitMealTransitionV1 {
  readonly intent: MealTransitionIntentV1;
  readonly aggregate: FeedingMeal;
}

interface CommitProtocolDefinitionTransitionV1 {
  readonly intent: ProtocolDefinitionTransitionIntentV1;
  readonly aggregate: FeedingProtocolV2;
}

interface CommitProtocolAssignmentTransitionV1 {
  readonly intent: ProtocolAssignmentTransitionIntentV1;
  readonly aggregate: ProtocolAssignment;
}

type ForecastProjectionSnapshotV1 = Omit<
  Pick<FeedingForecastSnapshot, (typeof FEEDING_FORECAST_PROJECTION_V1.persistedFields)[number]>,
  'poolScope'
> & { readonly poolScope: FeedingForecastPoolScope };

export interface ForecastProjectionGenerationIntentV1 {
  readonly operationId: string;
  readonly sourceWatermark: Date;
  readonly snapshots: readonly ForecastProjectionSnapshotV1[];
}

export interface ForecastProjectionReconciliationV1 {
  readonly generationId: string;
  readonly exactSetDigest: string;
  readonly writtenCount: number;
  readonly retiredSnapshotCount: number;
  readonly replayed: boolean;
}

interface CreateScheduledMealV1 {
  readonly dayPlanId: string;
  readonly unitId: string;
  readonly siteId: string;
  readonly mealIndex: number;
  readonly scheduledAt: Date;
  readonly percentOfDaily: number;
  readonly plannedKg: number;
  readonly status: FeedingMealStatus;
  readonly actualKg: number;
  readonly pours: readonly MealPour[];
  readonly feedId: string;
}

interface SaveOneAuthority<T> {
  save(value: DeepPartial<T>): Promise<T>;
}

interface TimestampedFeedingAggregateV1 {
  createdAt?: Date;
  updatedAt?: Date;
}

function stampFeedingAggregateClockV1(
  aggregate: TimestampedFeedingAggregateV1,
  observedAt: Date,
): void {
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('Feeding aggregate mutation instant is invalid');
  }
  if (aggregate.createdAt !== undefined && !Number.isFinite(aggregate.createdAt.getTime())) {
    throw new Error('Feeding aggregate createdAt is invalid');
  }
  aggregate.createdAt ??= new Date(observedAt.getTime());
  aggregate.updatedAt = new Date(observedAt.getTime());
}

async function feedingAggregateMutationDateV1(session: TenantMutationSession): Promise<Date> {
  return mutationInstantDateV1(await readTenantMutationInstantV1(session, 'farm'));
}

function saveFeedingRecord(manager: EntityManager, record: FeedingRecord): Promise<FeedingRecord> {
  return manager.save(record);
}

interface AppendedProvenanceEventV1 {
  readonly event_id: string;
  readonly event_sequence: string | number;
  readonly event_digest: string;
}

const PROVENANCE_ROOT_DIGEST = FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.journal.rootDigest;

async function currentProvenanceDigest(
  manager: EntityManager,
  tenantId: string,
  subjectKind: 'FEEDING_RECORD' | 'DAY_PLAN',
  subjectId: string,
): Promise<string> {
  const rows: Array<{ digest: string }> = await manager.query(
    `SELECT "eventDigest" AS digest
       FROM "feeding_historical_provenance_events"
      WHERE "tenantId" = $1 AND "subjectKind" = $2 AND "subjectId" = $3
      ORDER BY sequence DESC LIMIT 1`,
    [tenantId, subjectKind, subjectId],
  );
  return rows[0]?.digest ?? PROVENANCE_ROOT_DIGEST;
}

async function appendHistoricalProvenance(
  manager: EntityManager,
  input: {
    readonly tenantId: string;
    readonly subjectKind: 'FEEDING_RECORD' | 'DAY_PLAN';
    readonly subjectId: string;
    readonly eventKind: 'ATTRIBUTION_ASSERTED' | 'GROWTH_POLICY_ASSERTED' | 'GROWTH_APPLIED';
    readonly payload: Readonly<Record<string, string | null>>;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly recordedAt: Date;
    readonly recordedBy: string;
  },
): Promise<AppendedProvenanceEventV1> {
  const expectedPrevDigest = await currentProvenanceDigest(
    manager,
    input.tenantId,
    input.subjectKind,
    input.subjectId,
  );
  const rows: AppendedProvenanceEventV1[] = await manager.query(
    `SELECT * FROM append_feeding_historical_provenance_v1(
       $1::uuid, $2::text, $3::uuid, $4::text, $5::jsonb, $6::text,
       $7::text, $8::text, $9::timestamptz, $10::text
     )`,
    [
      input.tenantId,
      input.subjectKind,
      input.subjectId,
      input.eventKind,
      JSON.stringify(input.payload),
      input.operationId,
      input.idempotencyKey,
      expectedPrevDigest,
      input.recordedAt,
      input.recordedBy,
    ],
  );
  const appended = rows[0];
  if (!appended?.event_digest) {
    throw new Error(`Provenance append returned no event for ${input.subjectId}`);
  }
  return appended;
}

async function assertAndAppendLegacyExecutionAttribution(
  manager: EntityManager,
  tenantId: string,
  record: FeedingRecord,
): Promise<void> {
  if (!record.sourceExecutionId) return;
  const existing: Array<{ present: boolean }> = await manager.query(
    `SELECT EXISTS (
       SELECT 1 FROM feeding_historical_record_attribution_v1
        WHERE "tenantId" = $1 AND "feedingRecordId" = $2
     ) AS present`,
    [tenantId, record.id],
  );
  if (existing[0]?.present) return;
  const candidates: Array<{
    completedAt: Date | null;
    equipmentId: string;
    equipmentType: string;
    batchId: string | null;
    batchLocationId: string | null;
    candidateCount: number;
  }> = await manager.query(
    `SELECT execution."completedAt" AS "completedAt",
            execution."equipmentId"::text AS "equipmentId",
            execution."equipmentType"::text AS "equipmentType",
            (array_agg(location."batchId" ORDER BY location.id)
              FILTER (WHERE location.id IS NOT NULL))[1]::text AS "batchId",
            (array_agg(location.id ORDER BY location.id)
              FILTER (WHERE location.id IS NOT NULL))[1]::text AS "batchLocationId",
            COUNT(location.id)::int AS "candidateCount"
       FROM daily_feeding_executions execution
       LEFT JOIN batch_locations location
         ON location."tenantId" = execution."tenantId"
        AND execution."completedAt" IS NOT NULL
        AND location."movedAt" <= execution."completedAt"
        AND (location."exitedAt" IS NULL OR execution."completedAt" < location."exitedAt")
        AND (
          (execution."equipmentType"::text = 'tank' AND location."tankId" = execution."equipmentId")
          OR (execution."equipmentType"::text = 'pond' AND location."pondId" = execution."equipmentId")
        )
      WHERE execution."tenantId" = $1 AND execution.id = $2
      GROUP BY execution.id, execution."completedAt", execution."equipmentId", execution."equipmentType"`,
    [tenantId, record.sourceExecutionId],
  );
  const resolved = candidates[0];
  if (
    !resolved?.completedAt ||
    resolved.candidateCount !== 1 ||
    !resolved.batchId ||
    !resolved.batchLocationId ||
    !['tank', 'pond'].includes(resolved.equipmentType)
  ) {
    throw new Error(
      `Legacy execution ${record.sourceExecutionId} has no exact historical attribution`,
    );
  }
  const equipmentMatches =
    resolved.equipmentType === 'tank'
      ? record.tankId === resolved.equipmentId && record.pondId == null
      : record.pondId === resolved.equipmentId && record.tankId == null;
  if (
    record.batchId !== resolved.batchId ||
    record.batchLocationId !== resolved.batchLocationId ||
    !equipmentMatches
  ) {
    throw new Error(
      `Legacy execution ${record.sourceExecutionId} attribution differs from occupancy`,
    );
  }
  const originalRecordDigest = canonicalWireJsonSha256V1(
    {
      domain: 'aquaculture.feeding-historical-record-snapshot',
      schemaVersion: FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.schemaVersion,
    },
    {
      actualAmount: Number(record.actualAmount).toFixed(3),
      batchId: record.batchId,
      batchLocationId: record.batchLocationId,
      feedingDate:
        record.feedingDate instanceof Date
          ? record.feedingDate.toISOString().slice(0, 10)
          : String(record.feedingDate),
      feedingRecordId: record.id,
      feedingTime: record.feedingTime,
      pondId: record.pondId ?? null,
      sourceExecutionId: record.sourceExecutionId,
      tankId: record.tankId ?? null,
      tenantId,
    },
  );
  await appendHistoricalProvenance(manager, {
    tenantId,
    subjectKind: 'FEEDING_RECORD',
    subjectId: record.id,
    eventKind: 'ATTRIBUTION_ASSERTED',
    payload: {
      batchId: resolved.batchId,
      batchLocationId: resolved.batchLocationId,
      completedAt: resolved.completedAt.toISOString(),
      equipmentId: resolved.equipmentId,
      locationType: resolved.equipmentType,
      originalRecordDigest,
      schemaVersion: FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.schemaVersion,
      sourceExecutionId: record.sourceExecutionId,
      sourceKind: 'LEGACY_EXECUTION',
    },
    operationId: `legacy-execution:${record.sourceExecutionId}`,
    idempotencyKey: `legacy-attribution:${record.id}:v1`,
    recordedAt: resolved.completedAt,
    recordedBy: record.fedBy ?? 'farm-service/legacy-execution',
  });
}

function saveDayPlan(manager: EntityManager, dayPlan: FeedingDayPlan): Promise<FeedingDayPlan> {
  return manager.save(dayPlan);
}

function saveMeal(manager: EntityManager, meal: FeedingMeal): Promise<FeedingMeal> {
  return manager.save(meal);
}

function insertMeal(
  manager: EntityManager,
  values: QueryDeepPartialEntity<FeedingMeal>,
): ReturnType<EntityManager['insert']> {
  return manager.insert(FeedingMeal, values);
}

function saveProtocolAssignment(
  authority: SaveOneAuthority<ProtocolAssignment>,
  assignment: ProtocolAssignment,
): Promise<ProtocolAssignment> {
  return authority.save(assignment);
}

function saveProtocolDefinition(
  authority: SaveOneAuthority<FeedingProtocolV2>,
  protocol: FeedingProtocolV2,
): Promise<FeedingProtocolV2> {
  return authority.save(protocol);
}

async function reconcileForecastProjection(
  manager: EntityManager,
  tenantId: string,
  intent: ForecastProjectionGenerationIntentV1,
): Promise<ForecastProjectionReconciliationV1> {
  if (
    intent.operationId.length < 1 ||
    intent.operationId.length > 160 ||
    intent.operationId.trim() !== intent.operationId
  ) {
    throw new Error('Forecast generation operationId is not one bounded canonical identity');
  }
  if (!Number.isFinite(intent.sourceWatermark.getTime())) {
    throw new Error('Forecast generation source watermark is invalid');
  }
  const snapshots = intent.snapshots.map((snapshot) =>
    Object.freeze({
      ...snapshot,
      mortalityAssumption: assertFeedingForecastMortalityProvenanceV1(
        snapshot.mortalityAssumption,
        snapshot.perUnit.map((unit) => unit.unitId),
      ),
    }),
  );
  const proof = compileFeedingForecastGenerationExactSetProofV1(
    snapshots.map((snapshot) => ({
      siteScopeKey: snapshot.siteScopeKey,
      poolScope: snapshot.poolScope,
      payload: snapshot,
    })),
  );
  const activeRows: Array<{ generationId: string }> = await manager.query(
    `SELECT "generationId" FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.activePointer.relation}"
      WHERE "tenantId" = $1`,
    [tenantId],
  );
  const expectedActiveGenerationId = activeRows[0]?.generationId ?? null;
  const retiredSnapshotRows: Array<{ count: number }> = expectedActiveGenerationId
    ? await manager.query(
        `SELECT COUNT(*)::int AS count
           FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotRelation}"
          WHERE "tenantId" = $1 AND "generationId" = $2`,
        [tenantId, expectedActiveGenerationId],
      )
    : [{ count: 0 }];

  const inserted: Array<{ id: string }> = await manager.query(
    `INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"
       (id, "tenantId", "operationId", state, "catalogRevision", "catalogDigest",
        "sourceWatermark", "exactSetDigest", "membershipDigest", "snapshotCount",
        "previousActiveGenerationId", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, 'BUILDING', $3, $4, $5, $6, $7, $8, $9, $5)
     ON CONFLICT ("tenantId", "operationId") DO NOTHING
     RETURNING id`,
    [
      tenantId,
      intent.operationId,
      FEEDING_FORECAST_GENERATION_AUTHORITY.schemaVersion,
      FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
      intent.sourceWatermark,
      proof.exactSetDigest,
      proof.membershipDigest,
      proof.snapshotCount,
      expectedActiveGenerationId,
    ],
  );
  const generationId = inserted[0]?.id;
  if (!generationId) {
    const existing: Array<{
      id: string;
      state: string;
      exactSetDigest: string;
      snapshotCount: number;
    }> = await manager.query(
      `SELECT id, state, "exactSetDigest", "snapshotCount"
         FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"
        WHERE "tenantId" = $1 AND "operationId" = $2`,
      [tenantId, intent.operationId],
    );
    const replay = existing[0];
    if (
      replay?.state !== 'ACTIVE' ||
      replay.exactSetDigest !== proof.exactSetDigest ||
      Number(replay.snapshotCount) !== proof.snapshotCount
    ) {
      throw new Error('Forecast generation replay differs from its immutable operation');
    }
    return Object.freeze({
      generationId: replay.id,
      exactSetDigest: proof.exactSetDigest,
      writtenCount: proof.snapshotCount,
      retiredSnapshotCount: 0,
      replayed: true,
    });
  }

  const digestByScope = new Map(
    proof.snapshots.map((snapshot) => [snapshot.siteScopeKey, snapshot]),
  );
  for (const snapshot of snapshots) {
    const snapshotProof = digestByScope.get(snapshot.siteScopeKey);
    if (!snapshotProof) throw new Error(`Missing forecast scope proof ${snapshot.siteScopeKey}`);
    await manager.query(
      `INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotRelation}"
         (id, "tenantId", "generationId", "siteScopeKey", "poolScope", "payloadDigest",
          "horizonDays", "computedAt", "perFeed", "perUnit", alerts,
          "mortalityAssumption", "createdAt", "updatedAt", version)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
               $10::jsonb, $11::jsonb, $12, $12, 1)`,
      [
        tenantId,
        generationId,
        snapshot.siteScopeKey,
        snapshot.poolScope,
        snapshotProof.payloadDigest,
        snapshot.horizonDays,
        snapshot.computedAt,
        JSON.stringify(snapshot.perFeed),
        JSON.stringify(snapshot.perUnit),
        JSON.stringify(snapshot.alerts),
        JSON.stringify(snapshot.mortalityAssumption),
        intent.sourceWatermark,
      ],
    );
  }
  await manager.query(
    `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify}(
      $1,$2,$3,$4,$5,$6
    )`,
    [
      tenantId,
      generationId,
      proof.exactSetDigest,
      proof.membershipDigest,
      proof.snapshotCount,
      intent.sourceWatermark,
    ],
  );
  await manager.query(
    `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate}($1,$2,$3,$4)`,
    [tenantId, generationId, expectedActiveGenerationId, intent.sourceWatermark],
  );
  return Object.freeze({
    generationId,
    exactSetDigest: proof.exactSetDigest,
    writtenCount: proof.snapshotCount,
    retiredSnapshotCount: Number(retiredSnapshotRows[0]?.count ?? 0),
    replayed: false,
  });
}

async function purgeForecastProjectionBefore(
  manager: EntityManager,
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  if (!Number.isFinite(cutoff.getTime())) throw new Error('Forecast retention cutoff is invalid');
  const rows: Array<{ count: string | number }> = await manager.query(
    `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.purgeRetired}(
      $1,$2
    ) AS count`,
    [tenantId, cutoff],
  );
  return Number(rows[0]?.count ?? 0);
}

async function insertDayPlanIfAbsent(
  manager: EntityManager,
  input: InsertDayPlanIfAbsentV1,
  observedAt: Date,
): Promise<string | null> {
  const inserted: Array<{ id: string }> = await manager.query(
    `INSERT INTO "feeding_day_plans"
       (id, "tenantId", "assignmentId", "protocolId", "unitId", "siteId", "unitType",
        "unitName", "unitCode", "planDate", "growthPolicyVersion", "growthApplicationMode",
        snapshot, resolution, "plannedTotalKg",
        "unplannedActualKg", "mealsPlanned", status, "skipReason", "recalcLog",
        "createdAt", "updatedAt", version)
     VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5,
             $6::${FEEDING_UNIT_TYPE_DATABASE_ENUM}, $7, $8, $9, $10, $11,
             $12::jsonb, $13::jsonb, $14, 0, $15, $16::feeding_day_plans_status_enum, $17,
             '[]'::jsonb, $18, $18, 1)
     ON CONFLICT ("tenantId", "unitId", "planDate") DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.assignmentId,
      input.protocolId,
      input.unitId,
      input.siteId,
      input.unitType,
      input.unitName,
      input.unitCode,
      input.planDate,
      input.growthPolicyVersion,
      input.growthApplicationMode,
      JSON.stringify(input.snapshot),
      JSON.stringify(input.resolution),
      input.plannedTotalKg,
      input.mealsPlanned,
      input.status,
      input.skipReason ?? null,
      observedAt,
    ],
  );
  const dayPlanId = inserted[0]?.id ?? null;
  if (!dayPlanId) return null;
  const proofAt = new Date(input.resolution.resolvedAt);
  await appendHistoricalProvenance(manager, {
    tenantId: input.tenantId,
    subjectKind: 'DAY_PLAN',
    subjectId: dayPlanId,
    eventKind: 'GROWTH_POLICY_ASSERTED',
    payload: createGrowthPolicyAssertedPayloadV1({
      expectedFcr: Number(input.resolution.expectedFcr),
      growthApplicationMode: input.growthApplicationMode,
      proofAt,
      proofKind: 'LIVE_PROTOCOL_RESOLUTION',
    }),
    operationId: `day-plan:${input.tenantId}:${input.unitId}:${input.planDate}`,
    idempotencyKey: `day-plan-policy:${dayPlanId}:v1`,
    recordedAt: proofAt,
    recordedBy: 'farm-service/day-plan-generator',
  });
  return dayPlanId;
}

async function incrementDayPlanUnplannedActual(
  manager: EntityManager,
  input: {
    readonly tenantId: string;
    readonly dayPlanId: string;
    readonly deltaKg: number;
    readonly observedAt: Date;
  },
): Promise<void> {
  await manager.query(
    `UPDATE "feeding_day_plans"
        SET "unplannedActualKg" = "unplannedActualKg" + $1,
            "updatedAt" = $4
      WHERE id = $2 AND "tenantId" = $3`,
    [input.deltaKg, input.dayPlanId, input.tenantId, input.observedAt],
  );
}

async function markMealWindowNotified(
  manager: EntityManager,
  tenantId: string,
  mealIds: readonly string[],
  observedAt: Date,
): Promise<void> {
  await manager.query(
    `UPDATE "feeding_meals"
        SET "windowNotifiedAt" = $3,
            "updatedAt" = $3
      WHERE "tenantId" = $1 AND id = ANY($2)`,
    [tenantId, [...mealIds], observedAt],
  );
}

async function recordDayPlanGrowthApplication(
  manager: EntityManager,
  input: RecordDayPlanGrowthApplicationV1 & { readonly tenantId: string },
): Promise<void> {
  await appendHistoricalProvenance(manager, {
    tenantId: input.tenantId,
    subjectKind: 'DAY_PLAN',
    subjectId: input.dayPlanId,
    eventKind: 'GROWTH_APPLIED',
    payload: createGrowthAppliedPayloadV1(input),
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    recordedAt: input.appliedAt,
    recordedBy: input.recordedBy,
  });
}

async function commitDayPlanStatusTransition(
  manager: EntityManager,
  input: {
    readonly tenantId: string;
    readonly dayPlanId: string;
    readonly status: FeedingDayPlanStatus;
    readonly observedAt: Date;
  },
): Promise<void> {
  await manager.query(
    `UPDATE "feeding_day_plans"
        SET status = $3::feeding_day_plans_status_enum,
            "updatedAt" = $4,
            version = version + 1
      WHERE id = $1 AND "tenantId" = $2 AND status <> $3::feeding_day_plans_status_enum`,
    [input.dayPlanId, input.tenantId, input.status, input.observedAt],
  );
}

function assertPositiveRetention(value: number, unit: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid feeding retention ${unit}`);
  }
}

function assertAggregateTenant(aggregate: { readonly tenantId?: string }, tenantId: string): void {
  if (aggregate.tenantId !== tenantId) {
    throw new Error('Aggregate tenant does not match the mutation session');
  }
}

async function purgeMealsBeforeRetention(
  manager: EntityManager,
  tenantId: string,
  months: number,
  observedAt: Date,
): Promise<number> {
  assertPositiveRetention(months, 'months');
  const rows: Array<{ count: number }> = await manager.query(
    `WITH deleted AS (
       DELETE FROM "feeding_meals" m
        USING "feeding_day_plans" dp
        WHERE m."dayPlanId" = dp.id
          AND m."tenantId" = dp."tenantId"
          AND dp."tenantId" = $1
          AND dp."planDate" < (
            ($3::timestamptz AT TIME ZONE 'UTC')::date - ($2 * INTERVAL '1 month')
          )
       RETURNING 1
     ) SELECT COUNT(*)::int AS count FROM deleted`,
    [tenantId, months, observedAt],
  );
  return Number(rows[0]?.count ?? 0);
}

async function purgeDayPlansBeforeRetention(
  manager: EntityManager,
  tenantId: string,
  months: number,
  observedAt: Date,
): Promise<number> {
  assertPositiveRetention(months, 'months');
  const rows: Array<{ count: number }> = await manager.query(
    `WITH deleted AS (
       DELETE FROM "feeding_day_plans"
        WHERE "tenantId" = $1
          AND "planDate" < (
            ($3::timestamptz AT TIME ZONE 'UTC')::date - ($2 * INTERVAL '1 month')
          )
       RETURNING 1
     ) SELECT COUNT(*)::int AS count FROM deleted`,
    [tenantId, months, observedAt],
  );
  return Number(rows[0]?.count ?? 0);
}

const FEEDING_AGGREGATE_MUTATION_PORT_BRAND = Symbol(
  FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
);

/** The only injectable capability permitted to mutate feeding-owned relations. */
export abstract class FeedingAggregateMutationPort {
  protected readonly [FEEDING_AGGREGATE_MUTATION_PORT_BRAND] = true;
  readonly authorityId = FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID;
  readonly coordinates = FEEDING_AGGREGATE_COORDINATES;

  abstract commitFeedingRecordTransition(
    session: TenantMutationSession,
    input: CommitFeedingRecordTransitionV1,
  ): Promise<FeedingRecord>;
  abstract commitDayPlanTransition(
    session: TenantMutationSession,
    input: CommitDayPlanTransitionV1,
  ): Promise<FeedingDayPlan>;
  abstract commitMealTransition(
    session: TenantMutationSession,
    input: CommitMealTransitionV1,
  ): Promise<FeedingMeal>;
  abstract createScheduledMeal(
    session: TenantMutationSession,
    input: CreateScheduledMealV1,
  ): Promise<void>;
  abstract commitProtocolAssignmentTransition(
    session: TenantMutationSession,
    input: CommitProtocolAssignmentTransitionV1,
  ): Promise<ProtocolAssignment>;
  abstract commitProtocolDefinitionTransition(
    session: TenantMutationSession,
    input: CommitProtocolDefinitionTransitionV1,
  ): Promise<FeedingProtocolV2>;
  abstract clearDefaultProtocolForSpecies(
    session: TenantMutationSession,
    speciesId: string,
  ): Promise<void>;
  abstract reconcileForecastProjection(
    session: TenantMutationSession,
    intent: ForecastProjectionGenerationIntentV1,
  ): Promise<ForecastProjectionReconciliationV1>;
  abstract purgeForecastProjectionBefore(
    session: TenantMutationSession,
    cutoff: Date,
  ): Promise<number>;
  abstract createDayPlanIfAbsent(
    session: TenantMutationSession,
    input: CreateDayPlanIfAbsentV1,
  ): Promise<string | null>;
  abstract incrementDayPlanUnplannedActual(
    session: TenantMutationSession,
    input: { readonly dayPlanId: string; readonly deltaKg: number },
  ): Promise<void>;
  abstract markMealWindowNotified(
    session: TenantMutationSession,
    mealIds: readonly string[],
  ): Promise<void>;
  abstract recordDayPlanGrowthApplication(
    session: TenantMutationSession,
    input: RecordDayPlanGrowthApplicationV1,
  ): Promise<void>;
  abstract commitDayPlanStatusTransition(
    session: TenantMutationSession,
    input: { readonly dayPlanId: string; readonly status: FeedingDayPlanStatus },
  ): Promise<void>;
  abstract purgeMealsBeforeRetention(
    session: TenantMutationSession,
    months: number,
  ): Promise<number>;
  abstract purgeDayPlansBeforeRetention(
    session: TenantMutationSession,
    months: number,
  ): Promise<number>;
}

@Injectable()
class TypeOrmFeedingAggregateMutationPort extends FeedingAggregateMutationPort {
  async commitFeedingRecordTransition(
    session: TenantMutationSession,
    input: CommitFeedingRecordTransitionV1,
  ): Promise<FeedingRecord> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    const observedAt = await feedingAggregateMutationDateV1(session);
    stampFeedingAggregateClockV1(input.aggregate, observedAt);
    const saved = await saveFeedingRecord(manager, input.aggregate);
    if (input.intent === 'recorded') {
      const proof: Array<{ provenance_digest: string }> = await manager.query(
        `SELECT * FROM "${FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY.appendFunction}"(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz
        )`,
        [tenantId, saved.id, input.provenance.operationId, input.provenance.origin, observedAt],
      );
      if (!proof[0]?.provenance_digest) {
        throw new Error(`Feeding record ${saved.id} write provenance append returned no proof`);
      }
    }
    await assertAndAppendLegacyExecutionAttribution(manager, tenantId, saved);
    return saved;
  }

  async commitDayPlanTransition(
    session: TenantMutationSession,
    input: CommitDayPlanTransitionV1,
  ): Promise<FeedingDayPlan> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampFeedingAggregateClockV1(input.aggregate, await feedingAggregateMutationDateV1(session));
    return saveDayPlan(manager, input.aggregate);
  }

  async commitMealTransition(
    session: TenantMutationSession,
    input: CommitMealTransitionV1,
  ): Promise<FeedingMeal> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampFeedingAggregateClockV1(input.aggregate, await feedingAggregateMutationDateV1(session));
    return saveMeal(manager, input.aggregate);
  }

  async createScheduledMeal(
    session: TenantMutationSession,
    input: CreateScheduledMealV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    const observedAt = await feedingAggregateMutationDateV1(session);
    await insertMeal(manager, {
      ...input,
      tenantId,
      pours: [...input.pours],
      createdAt: observedAt,
      updatedAt: observedAt,
    });
  }

  async commitProtocolAssignmentTransition(
    session: TenantMutationSession,
    input: CommitProtocolAssignmentTransitionV1,
  ): Promise<ProtocolAssignment> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampFeedingAggregateClockV1(input.aggregate, await feedingAggregateMutationDateV1(session));
    return saveProtocolAssignment(manager, input.aggregate);
  }

  async commitProtocolDefinitionTransition(
    session: TenantMutationSession,
    input: CommitProtocolDefinitionTransitionV1,
  ): Promise<FeedingProtocolV2> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampFeedingAggregateClockV1(input.aggregate, await feedingAggregateMutationDateV1(session));
    return saveProtocolDefinition(manager, input.aggregate);
  }

  async clearDefaultProtocolForSpecies(
    session: TenantMutationSession,
    speciesId: string,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    const observedAt = await feedingAggregateMutationDateV1(session);
    if (speciesId.trim().length === 0 || speciesId !== speciesId.trim()) {
      throw new Error('speciesId must be a non-empty canonical identifier');
    }
    await manager.update(
      FeedingProtocolV2,
      { tenantId, speciesId, isDefault: true },
      { isDefault: false, updatedAt: observedAt },
    );
  }

  async reconcileForecastProjection(
    session: TenantMutationSession,
    intent: ForecastProjectionGenerationIntentV1,
  ): Promise<ForecastProjectionReconciliationV1> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return reconcileForecastProjection(manager, tenantId, intent);
  }

  async purgeForecastProjectionBefore(
    session: TenantMutationSession,
    cutoff: Date,
  ): Promise<number> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return purgeForecastProjectionBefore(manager, tenantId, cutoff);
  }

  async createDayPlanIfAbsent(
    session: TenantMutationSession,
    input: CreateDayPlanIfAbsentV1,
  ): Promise<string | null> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return insertDayPlanIfAbsent(
      manager,
      { ...input, tenantId },
      await feedingAggregateMutationDateV1(session),
    );
  }

  async incrementDayPlanUnplannedActual(
    session: TenantMutationSession,
    input: { readonly dayPlanId: string; readonly deltaKg: number },
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return incrementDayPlanUnplannedActual(manager, {
      ...input,
      tenantId,
      observedAt: await feedingAggregateMutationDateV1(session),
    });
  }

  async markMealWindowNotified(
    session: TenantMutationSession,
    mealIds: readonly string[],
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return markMealWindowNotified(
      manager,
      tenantId,
      mealIds,
      await feedingAggregateMutationDateV1(session),
    );
  }

  recordDayPlanGrowthApplication(
    session: TenantMutationSession,
    input: RecordDayPlanGrowthApplicationV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return recordDayPlanGrowthApplication(manager, { ...input, tenantId });
  }

  async commitDayPlanStatusTransition(
    session: TenantMutationSession,
    input: { readonly dayPlanId: string; readonly status: FeedingDayPlanStatus },
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return commitDayPlanStatusTransition(manager, {
      ...input,
      tenantId,
      observedAt: await feedingAggregateMutationDateV1(session),
    });
  }

  async purgeMealsBeforeRetention(session: TenantMutationSession, months: number): Promise<number> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return purgeMealsBeforeRetention(
      manager,
      tenantId,
      months,
      await feedingAggregateMutationDateV1(session),
    );
  }

  async purgeDayPlansBeforeRetention(
    session: TenantMutationSession,
    months: number,
  ): Promise<number> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    return purgeDayPlansBeforeRetention(
      manager,
      tenantId,
      months,
      await feedingAggregateMutationDateV1(session),
    );
  }
}

export const FEEDING_AGGREGATE_MUTATION_PORT_PROVIDER: Provider = Object.freeze({
  provide: FeedingAggregateMutationPort,
  useClass: TypeOrmFeedingAggregateMutationPort,
});
