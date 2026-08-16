import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  readTenantMutationSession,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { feedingMutationCoordinatesForWriter } from '@aquaculture/feeding-contracts';
import { FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 } from '@aquaculture/shared-contracts';
import { Injectable, type Provider } from '@nestjs/common';
import { In } from 'typeorm';

import { Batch } from './entities/batch.entity';
import { TankBatch } from './entities/tank-batch.entity';
import { Tank, TankStatus } from '../tank/entities/tank.entity';

export type BatchTransitionIntentV1 =
  | 'batch_create'
  | 'batch_update'
  | 'batch_status_change'
  | 'batch_close'
  | 'batch_delete'
  | 'batch_seed'
  | 'stock_allocation'
  | 'stock_transfer'
  | 'mortality_recorded'
  | 'cull_recorded'
  | 'harvest_recorded'
  | 'harvest_reverted'
  | 'feeding_recorded'
  | 'feeding_corrected'
  | 'growth_applied'
  | 'cleaner_fish_created'
  | 'cleaner_fish_deployed'
  | 'cleaner_fish_removed'
  | 'cleaner_fish_transferred'
  | 'cleaner_fish_mortality'
  | 'projection_reconciled';

export type TankBatchTransitionIntentV1 =
  | 'stock_allocation'
  | 'stock_delta_applied'
  | 'stock_transfer'
  | 'feeding_growth_applied'
  | 'cleaner_fish_deployed'
  | 'cleaner_fish_removed'
  | 'cleaner_fish_transferred'
  | 'cleaner_fish_mortality'
  | 'seed_initialized';

export type TankTransitionIntentV1 =
  | 'tank_create'
  | 'tank_update'
  | 'tank_status_change'
  | 'tank_delete'
  | 'stock_allocation'
  | 'feeding_growth_applied'
  | 'seed_initialized';

interface CommitBatchTransitionV1 {
  readonly intent: BatchTransitionIntentV1;
  readonly aggregate: Batch;
}

interface CommitTankBatchTransitionV1 {
  readonly intent: TankBatchTransitionIntentV1;
  readonly aggregate: TankBatch;
}

interface CommitTankBatchTransitionsV1 {
  readonly intent: TankBatchTransitionIntentV1;
  readonly aggregates: readonly TankBatch[];
}

interface CommitTankTransitionV1 {
  readonly intent: TankTransitionIntentV1;
  readonly aggregate: Tank;
}

interface ReplaceTankBiomassProjectionV1 {
  readonly tankId: string;
  readonly currentBiomassKg: number;
  readonly lifecycle: 'preserve' | 'activate';
}

interface ReplaceTankCountProjectionV1 {
  readonly tankId: string;
  readonly currentCount: number;
}

interface ReplaceTankStockProjectionV1
  extends ReplaceTankBiomassProjectionV1,
    ReplaceTankCountProjectionV1 {}

interface DeactivateDepartmentTanksV1 {
  readonly departmentIds: readonly string[];
  readonly userId: string;
}

interface RemoveEmptyTankBatchProjectionV1 {
  readonly tankId: string;
}

function assertIdentifier(value: string, field: string): void {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty canonical identifier`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
}

function assertNonNegativeCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('currentCount must be a non-negative safe integer');
  }
}

function assertAggregateTenant(aggregate: { readonly tenantId?: string }, tenantId: string): void {
  if (aggregate.tenantId !== tenantId) {
    throw new Error('Aggregate tenant does not match the mutation session');
  }
}

interface TimestampedBatchAggregateV1 {
  createdAt?: Date;
  updatedAt?: Date;
}

async function batchMutationDateV1(session: TenantMutationSession): Promise<Date> {
  return mutationInstantDateV1(await readTenantMutationInstantV1(session, 'farm'));
}

function stampBatchAggregateClockV1(
  aggregate: TimestampedBatchAggregateV1,
  observedAt: Date,
): void {
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('Batch aggregate mutation instant is invalid');
  }
  if (aggregate.createdAt !== undefined && !Number.isFinite(aggregate.createdAt.getTime())) {
    throw new Error('Batch aggregate createdAt is invalid');
  }
  aggregate.createdAt ??= new Date(observedAt.getTime());
  aggregate.updatedAt = new Date(observedAt.getTime());
}

const BATCH_AGGREGATE_MUTATION_PORT_BRAND = Symbol(
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE,
);

const BATCH_AGGREGATE_COORDINATES = feedingMutationCoordinatesForWriter(
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE,
);

/** Closed domain intents over an opaque, transaction-scoped capability. */
export abstract class BatchAggregateMutationPort {
  protected readonly [BATCH_AGGREGATE_MUTATION_PORT_BRAND] = true;
  readonly authorityId = FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE;
  readonly coordinates = BATCH_AGGREGATE_COORDINATES;

  abstract commitBatchTransition(
    session: TenantMutationSession,
    input: CommitBatchTransitionV1,
  ): Promise<Batch>;
  abstract commitTankBatchTransition(
    session: TenantMutationSession,
    input: CommitTankBatchTransitionV1,
  ): Promise<TankBatch>;
  abstract commitTankBatchTransitions(
    session: TenantMutationSession,
    input: CommitTankBatchTransitionsV1,
  ): Promise<TankBatch[]>;
  abstract commitTankTransition(
    session: TenantMutationSession,
    input: CommitTankTransitionV1,
  ): Promise<Tank>;
  abstract replaceTankBiomassProjection(
    session: TenantMutationSession,
    input: ReplaceTankBiomassProjectionV1,
  ): Promise<void>;
  abstract replaceTankCountProjection(
    session: TenantMutationSession,
    input: ReplaceTankCountProjectionV1,
  ): Promise<void>;
  abstract replaceTankStockProjection(
    session: TenantMutationSession,
    input: ReplaceTankStockProjectionV1,
  ): Promise<void>;
  abstract deactivateDepartmentTanks(
    session: TenantMutationSession,
    input: DeactivateDepartmentTanksV1,
  ): Promise<void>;
  abstract pruneEmptyTankBatchProjection(
    session: TenantMutationSession,
    input: RemoveEmptyTankBatchProjectionV1,
  ): Promise<void>;
}

@Injectable()
class TypeOrmBatchAggregateMutationPort extends BatchAggregateMutationPort {
  async commitBatchTransition(
    session: TenantMutationSession,
    input: CommitBatchTransitionV1,
  ): Promise<Batch> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampBatchAggregateClockV1(input.aggregate, await batchMutationDateV1(session));
    return manager.save(Batch, input.aggregate);
  }

  async commitTankBatchTransition(
    session: TenantMutationSession,
    input: CommitTankBatchTransitionV1,
  ): Promise<TankBatch> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampBatchAggregateClockV1(input.aggregate, await batchMutationDateV1(session));
    return manager.save(TankBatch, input.aggregate);
  }

  async commitTankBatchTransitions(
    session: TenantMutationSession,
    input: CommitTankBatchTransitionsV1,
  ): Promise<TankBatch[]> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    input.aggregates.forEach((aggregate) => assertAggregateTenant(aggregate, tenantId));
    const observedAt = await batchMutationDateV1(session);
    input.aggregates.forEach((aggregate) => stampBatchAggregateClockV1(aggregate, observedAt));
    return manager.save(TankBatch, [...input.aggregates]);
  }

  async commitTankTransition(
    session: TenantMutationSession,
    input: CommitTankTransitionV1,
  ): Promise<Tank> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertAggregateTenant(input.aggregate, tenantId);
    stampBatchAggregateClockV1(input.aggregate, await batchMutationDateV1(session));
    return manager.save(Tank, input.aggregate);
  }

  async replaceTankBiomassProjection(
    session: TenantMutationSession,
    input: ReplaceTankBiomassProjectionV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertIdentifier(input.tankId, 'tankId');
    assertNonNegativeFinite(input.currentBiomassKg, 'currentBiomassKg');
    const observedAt = await batchMutationDateV1(session);
    await manager.update(
      Tank,
      { id: input.tankId, tenantId },
      {
        currentBiomass: input.currentBiomassKg,
        updatedAt: observedAt,
        ...(input.lifecycle === 'activate' ? { status: TankStatus.ACTIVE } : {}),
      },
    );
  }

  async replaceTankCountProjection(
    session: TenantMutationSession,
    input: ReplaceTankCountProjectionV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertIdentifier(input.tankId, 'tankId');
    assertNonNegativeCount(input.currentCount);
    const observedAt = await batchMutationDateV1(session);
    await manager.update(
      Tank,
      { id: input.tankId, tenantId },
      { currentCount: input.currentCount, updatedAt: observedAt },
    );
  }

  async replaceTankStockProjection(
    session: TenantMutationSession,
    input: ReplaceTankStockProjectionV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertIdentifier(input.tankId, 'tankId');
    assertNonNegativeFinite(input.currentBiomassKg, 'currentBiomassKg');
    assertNonNegativeCount(input.currentCount);
    const observedAt = await batchMutationDateV1(session);
    await manager.update(
      Tank,
      { id: input.tankId, tenantId },
      {
        currentBiomass: input.currentBiomassKg,
        currentCount: input.currentCount,
        updatedAt: observedAt,
        ...(input.lifecycle === 'activate' ? { status: TankStatus.ACTIVE } : {}),
      },
    );
  }

  async deactivateDepartmentTanks(
    session: TenantMutationSession,
    input: DeactivateDepartmentTanksV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertIdentifier(input.userId, 'userId');
    if (input.departmentIds.length === 0) {
      throw new Error('departmentIds must contain at least one department');
    }
    const departmentIds = [...new Set(input.departmentIds)].sort();
    if (departmentIds.length !== input.departmentIds.length) {
      throw new Error('departmentIds must not contain duplicates');
    }
    departmentIds.forEach((departmentId) => assertIdentifier(departmentId, 'departmentId'));
    const observedAt = await batchMutationDateV1(session);
    await manager.update(
      Tank,
      { tenantId, departmentId: In(departmentIds) },
      { isActive: false, updatedBy: input.userId, updatedAt: observedAt },
    );
  }

  async pruneEmptyTankBatchProjection(
    session: TenantMutationSession,
    input: RemoveEmptyTankBatchProjectionV1,
  ): Promise<void> {
    const { manager, tenantId } = readTenantMutationSession(session, 'farm');
    assertIdentifier(input.tankId, 'tankId');
    await manager.delete(TankBatch, { tenantId, tankId: input.tankId });
  }
}

export const BATCH_AGGREGATE_MUTATION_PORT_PROVIDER: Provider = Object.freeze({
  provide: BatchAggregateMutationPort,
  useClass: TypeOrmBatchAggregateMutationPort,
});
