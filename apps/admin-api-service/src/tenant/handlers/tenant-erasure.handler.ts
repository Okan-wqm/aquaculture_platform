import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import {
  createCleanupDropProof,
  getTenantSchemaName,
  queryRowsNormalized,
} from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  canTransition,
  createBaseEvent,
  isTenantErasureTargetService,
  TENANT_ERASURE_TARGET_SERVICES,
  TENANT_ERASURE_TARGET_SERVICE_COUNT,
  TenantDataErasedEvent,
  TenantDataErasureFailedEvent,
  TenantErasedEvent,
  TenantErasureBlockedEvent,
  TenantErasureRequestedEvent,
  TenantStatus,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { createHash, randomUUID } from 'crypto';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { RequestTenantErasureCommand } from '../commands/tenant.commands';
import {
  TenantErasureOperationAcceptedResponse,
} from '../dto/request-tenant-erasure.dto';
import { Tenant } from '../entities/tenant.entity';

type ErasureProofEvent =
  | TenantDataErasedEvent
  | TenantDataErasureFailedEvent
  | TenantErasureBlockedEvent;

interface TenantErasureOperationRow {
  id: string;
  tenantId: string;
  status: 'IN_PROGRESS' | 'BLOCKED' | 'FAILED' | 'COMPLETED';
  requestedBy: string;
  reason: string;
  requestedAt: Date | string;
  legalHoldCheckedAt: Date | string;
  targetServices: string[];
  proofs: Record<string, unknown>;
  failures: unknown[];
  schemaDeletionJobId: string | null;
  schemaDeletionRequestedAt: Date | string | null;
  schemaDeletedAt: Date | string | null;
}

interface TenantSchemaDeletionState {
  readonly jobId: string;
  readonly schemaName: string;
  readonly jobStatus: string;
  readonly schemaLedgerStatus: string | null;
  readonly schemaExists: boolean;
  readonly tableCount: number;
  readonly requestedAt: string;
  readonly deletedAt: string | null;
  readonly failureResidue: unknown;
  readonly errorMessage: string | null;
}

@Injectable()
@CommandHandler(RequestTenantErasureCommand)
export class RequestTenantErasureHandler
  implements
    ICommandHandler<
      RequestTenantErasureCommand,
      TenantErasureOperationAcceptedResponse
    >
{
  private readonly logger = new Logger(RequestTenantErasureHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly legalHoldService: LegalHoldService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(
    command: RequestTenantErasureCommand,
  ): Promise<TenantErasureOperationAcceptedResponse> {
    const operationId = randomUUID();
    const requestedAt = new Date();

    await this.legalHoldService.assertNoHold(command.tenantId, 'tenant');
    const legalHoldCheckedAt = new Date();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: command.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${command.tenantId}' not found`);
      }

      if (!canTransition(tenant.status, TenantStatus.PURGED)) {
        throw new BadRequestException(
          `Cannot request GDPR erasure for tenant in ${tenant.status} state; ` +
            'tenant must be ARCHIVED before irreversible purge.',
        );
      }

      const activeRows = queryRowsNormalized<{ id: string }>(
        await queryRunner.manager.query(
          `SELECT id
             FROM admin.tenant_erasure_operations
            WHERE "tenantId" = $1 AND status = 'IN_PROGRESS'
            FOR UPDATE`,
          [command.tenantId],
        ),
      );
      if (activeRows.length > 0) {
        throw new BadRequestException(
          `Tenant ${command.tenantId} already has an active erasure operation.`,
        );
      }

      await queryRunner.manager.query(
        `INSERT INTO admin.tenant_erasure_operations (
           id, "tenantId", status, "requestedBy", reason, "requestedAt",
           "legalHoldCheckedAt", "targetServices", proofs, failures,
           "createdAt", "updatedAt"
         ) VALUES (
           $1, $2, 'IN_PROGRESS', $3, $4, $5, $6, $7::text[],
           '{}'::jsonb, '[]'::jsonb, NOW(), NOW()
         )`,
        [
          operationId,
          command.tenantId,
          command.requestedBy,
          command.reason,
          requestedAt,
          legalHoldCheckedAt,
          [...TENANT_ERASURE_TARGET_SERVICES],
        ],
      );

      const event: TenantErasureRequestedEvent = {
        ...createBaseEvent<TenantErasureRequestedEvent>(
          'TenantErasureRequested',
          command.tenantId,
          {
            aggregateId: command.tenantId,
            aggregateType: 'Tenant',
            userId: command.requestedBy,
          },
        ),
        timestamp: requestedAt.toISOString(),
        operationId,
        requestedAt: requestedAt.toISOString(),
        requestedBy: command.requestedBy,
        legalHoldCheckedAt: legalHoldCheckedAt.toISOString(),
        dryRun: command.dryRun,
        targetServiceCount: TENANT_ERASURE_TARGET_SERVICE_COUNT,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: command.tenantId,
        idempotencyKey: `tenant-erasure:${operationId}:requested`,
      });

      await queryRunner.commitTransaction();
    } catch (error) {
      await this.rollbackQuietly(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.auditLogService.log({
      action: 'TENANT_ERASURE_REQUESTED',
      entityType: 'tenant',
      entityId: command.tenantId,
      performedBy: command.requestedBy,
      details: {
        operationId,
        reason: command.reason,
        targetServices: [...TENANT_ERASURE_TARGET_SERVICES],
      },
    });

    this.logger.warn(
      `Tenant erasure requested: operation=${operationId} tenant=${command.tenantId}`,
    );
    return {
      operationId,
      tenantId: command.tenantId,
      status: 'IN_PROGRESS',
    };
  }

  private async rollbackQuietly(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
  }
}

@Injectable()
export class TenantErasureProofHandler
  implements IEventHandler<ErasureProofEvent>, OnModuleInit
{
  private static readonly SCHEMA_DELETION_POLL_LIMIT = 25;
  private readonly logger = new Logger(TenantErasureProofHandler.name);

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly legalHoldService: LegalHoldService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('TenantDataErased', this);
    await this.eventBus.subscribeWildcard('TenantDataErasureFailed', this);
    await this.eventBus.subscribeWildcard('TenantErasureBlocked', this);
    this.logger.log(
      'Subscribed to tenant erasure proof/failure events for finalization',
    );
  }

  getEventType(): string {
    return 'TenantErasureProof';
  }

  async handle(event: ErasureProofEvent): Promise<void> {
    if (event.eventType === 'TenantDataErased') {
      await this.recordServiceProof(event);
      return;
    }
    await this.recordServiceFailure(event);
  }

  @Interval(30_000)
  async pollSchemaDeletionCompletion(): Promise<void> {
    const operations = queryRowsNormalized<{ id: string; tenantId: string }>(
      await this.dataSource.query(
        `SELECT id, "tenantId"
           FROM admin.tenant_erasure_operations
          WHERE status = 'IN_PROGRESS'
            AND "schemaDeletionJobId" IS NOT NULL
          ORDER BY "updatedAt" ASC
          LIMIT $1`,
        [TenantErasureProofHandler.SCHEMA_DELETION_POLL_LIMIT],
      ),
    );

    for (const row of operations) {
      await this.dataSource.transaction(async (manager) => {
        const operation = await this.loadOperationForUpdate(
          manager,
          row.id,
          row.tenantId,
        );
        if (operation.status !== 'IN_PROGRESS') {
          return;
        }
        const proofs = this.asRecord(operation.proofs);
        if (!this.hasEveryTargetProof(operation, proofs)) {
          return;
        }
        await this.advanceAfterTargetProofs(
          manager,
          operation,
          proofs,
          this.extractCausationEventId(operation, proofs),
        );
      });
    }
  }

  private async recordServiceProof(event: TenantDataErasedEvent): Promise<void> {
    if (!isTenantErasureTargetService(event.targetService)) {
      throw new BadRequestException(
        `Unknown tenant-erasure target service: ${event.targetService}`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const operation = await this.loadOperationForUpdate(
        manager,
        event.operationId,
        event.tenantId,
      );
      if (operation.status === 'COMPLETED') {
        this.logger.warn(
          `Ignoring replayed TenantDataErased for completed operation ${event.operationId}`,
        );
        return;
      }
      if (operation.status !== 'IN_PROGRESS') {
        throw new BadRequestException(
          `Tenant erasure operation ${event.operationId} is ${operation.status}; cannot accept proof.`,
        );
      }

      const proofs = this.asRecord(operation.proofs);
      proofs[event.targetService] = {
        targetService: event.targetService,
        erasedAt: event.erasedAt,
        dryRun: event.dryRun,
        matchedRecordCount: event.matchedRecordCount,
        erasedRecordCount: event.erasedRecordCount,
        proofHash: event.proofHash,
        eventId: event.eventId,
      };

      if (!this.hasEveryTargetProof(operation, proofs)) {
        await this.updateOperationProgress(manager, operation.id, proofs);
        return;
      }

      await this.advanceAfterTargetProofs(
        manager,
        operation,
        proofs,
        event.eventId,
      );
    });
  }

  private async recordServiceFailure(
    event: TenantDataErasureFailedEvent | TenantErasureBlockedEvent,
  ): Promise<void> {
    const targetService =
      event.eventType === 'TenantDataErasureFailed'
        ? event.targetService
        : event.blockedByService;
    if (
      targetService !== 'platform-orchestrator' &&
      !isTenantErasureTargetService(targetService)
    ) {
      throw new BadRequestException(
        `Unknown tenant-erasure target service: ${targetService}`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const operation = await this.loadOperationForUpdate(
        manager,
        event.operationId,
        event.tenantId,
      );
      if (operation.status === 'COMPLETED') {
        throw new BadRequestException(
          `Tenant erasure operation ${event.operationId} is already completed.`,
        );
      }

      const failures = Array.isArray(operation.failures)
        ? [...operation.failures]
        : [];
      failures.push({
        eventType: event.eventType,
        targetService,
        reason:
          event.eventType === 'TenantDataErasureFailed'
            ? event.errorMessage
            : event.reason,
        occurredAt:
          event.eventType === 'TenantDataErasureFailed'
            ? event.failedAt
            : event.blockedAt,
        eventId: event.eventId,
      });

      await manager.query(
        `UPDATE admin.tenant_erasure_operations
            SET status = $2,
                failures = $3::jsonb,
                "updatedAt" = NOW()
          WHERE id = $1`,
        [
          operation.id,
          event.eventType === 'TenantErasureBlocked' ? 'BLOCKED' : 'FAILED',
          JSON.stringify(failures),
        ],
      );
    });
  }

  private async advanceAfterTargetProofs(
    manager: EntityManager,
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
    causationEventId: string,
  ): Promise<void> {
    const schemaDeletion =
      !operation.schemaDeletionJobId
        ? await this.requestSchemaDeletion(manager, operation, proofs)
        : await this.readSchemaDeletionState(manager, operation);

    if (
      schemaDeletion.jobStatus === 'FAILED' ||
      schemaDeletion.jobStatus === 'ABORTED'
    ) {
      await this.recordSchemaDeletionFailure(manager, operation, schemaDeletion);
      return;
    }

    if (!this.isSchemaDeletionComplete(schemaDeletion)) {
      await this.updateOperationProgress(manager, operation.id, proofs);
      return;
    }

    await this.finalizeOperation(
      manager,
      operation,
      proofs,
      causationEventId,
      schemaDeletion,
    );
  }

  private hasEveryTargetProof(
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
  ): boolean {
    return operation.targetServices.every((service) => proofs[service] !== undefined);
  }

  private async requestSchemaDeletion(
    manager: EntityManager,
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
  ): Promise<TenantSchemaDeletionState> {
    const schemaRow = await this.loadTenantSchemaForUpdate(manager, operation.tenantId);
    const existingSchemas = await this.readExistingTenantSchemas(manager, [
      schemaRow.schemaName,
    ]);
    const requestedAt = new Date().toISOString();
    const legalHoldCheckedAt = await this.assertLiveLegalHold(operation.tenantId);
    const proof = createCleanupDropProof({
      operationId: operation.id,
      tenantId: operation.tenantId,
      purpose: 'tenant_erasure',
      actorId: 'tenant-erasure-orchestrator',
      reason: operation.reason,
      legalHoldCheckedAt,
      preCounts: {
        schemaName: schemaRow.schemaName,
        schemaLedgerStatus: schemaRow.status,
        tableCount: schemaRow.tableCount,
        existingSchemas,
        initialLegalHoldCheckedAt: this.toIso(operation.legalHoldCheckedAt),
        targetServices: operation.targetServices,
        proofedTargets: Object.keys(proofs).sort(),
      },
    });

    const rows = queryRowsNormalized<{ jobId: string }>(
      await manager.query(
        `SELECT platform.request_tenant_schema_deletion(
           $1::uuid,
           $2::uuid,
           $3::text,
           $4::jsonb
         ) AS "jobId"`,
        [
          operation.id,
          operation.tenantId,
          schemaRow.schemaName,
          JSON.stringify({
            cleanupProof: proof,
            tombstone: {
              cleanupRunId: operation.id,
              tenantId: operation.tenantId,
              schemaName: schemaRow.schemaName,
              requestedAt,
              requestedBy: 'tenant-erasure-orchestrator',
            },
          }),
        ],
      ),
    );
    const jobId = rows[0]?.jobId;
    if (!jobId) {
      throw new Error(
        `db-migrate tenant schema deletion did not return a job id for erasure operation ${operation.id}`,
      );
    }

    await manager.query(
      `UPDATE admin.tenant_erasure_operations
          SET proofs = $2::jsonb,
              "schemaDeletionJobId" = $3,
              "schemaDeletionRequestedAt" = $4,
              "legalHoldCheckedAt" = $5,
              "updatedAt" = NOW()
        WHERE id = $1`,
      [operation.id, JSON.stringify(proofs), jobId, requestedAt, legalHoldCheckedAt],
    );

    return this.readSchemaDeletionState(manager, {
      ...operation,
      schemaDeletionJobId: jobId,
      schemaDeletionRequestedAt: requestedAt,
      legalHoldCheckedAt,
    });
  }

  private async loadTenantSchemaForUpdate(
    manager: EntityManager,
    tenantId: string,
  ): Promise<{ schemaName: string; status: string; tableCount: number }> {
    const expectedSchemaName = getTenantSchemaName(tenantId);
    const rows = queryRowsNormalized<{
      schemaName: string;
      status: string;
      tableCount: string | number;
    }>(
      await manager.query(
        `SELECT "schemaName" AS "schemaName",
                status,
                "tableCount" AS "tableCount"
           FROM admin.tenant_schemas
          WHERE "tenantId" = $1
            AND "schemaName" = $2
          FOR UPDATE`,
        [tenantId, expectedSchemaName],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(
        `Tenant schema ledger is missing for tenant ${tenantId}; erasure cannot prove schema deletion.`,
      );
    }
    return {
      schemaName: row.schemaName,
      status: row.status,
      tableCount: Number(row.tableCount ?? 0),
    };
  }

  private async readExistingTenantSchemas(
    manager: EntityManager,
    schemaNames: readonly string[],
  ): Promise<string[]> {
    if (schemaNames.length === 0) {
      return [];
    }
    const rows = queryRowsNormalized<{ nspname: string }>(
      await manager.query(
        `SELECT nspname
           FROM pg_namespace
          WHERE nspname = ANY($1::text[])
          ORDER BY nspname`,
        [schemaNames],
      ),
    );
    return rows.map((row) => row.nspname);
  }

  private async readSchemaDeletionState(
    manager: EntityManager,
    operation: TenantErasureOperationRow,
  ): Promise<TenantSchemaDeletionState> {
    const rows = queryRowsNormalized<{
      jobId: string;
      schemaName: string;
      jobStatus: string;
      schemaLedgerStatus: string | null;
      schemaExists: boolean;
      tableCount: string | number | null;
      requestedAt: Date | string;
      deletedAt: Date | string | null;
      failureResidue: unknown;
      errorMessage: string | null;
    }>(
      await manager.query(
        `SELECT j.id AS "jobId",
                j.schema_name AS "schemaName",
                j.status AS "jobStatus",
                ts.status AS "schemaLedgerStatus",
                EXISTS (
                  SELECT 1
                    FROM pg_namespace n
                   WHERE n.nspname = j.schema_name
                ) AS "schemaExists",
                ts."tableCount" AS "tableCount",
                j.created_at AS "requestedAt",
                j.completed_at AS "deletedAt",
                j.failure_residue AS "failureResidue",
                j.error_message AS "errorMessage"
           FROM platform.tenant_schema_jobs j
           LEFT JOIN admin.tenant_schemas ts
             ON ts."tenantId" = j.tenant_id
            AND ts."schemaName" = j.schema_name
          WHERE j.operation_id = $1::uuid
            AND j.tenant_id = $2::uuid
            AND j.job_type = 'DELETE'
          LIMIT 1`,
        [operation.id, operation.tenantId],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(
        `db-migrate tenant schema deletion job is missing for erasure operation ${operation.id}`,
      );
    }

    return {
      jobId: row.jobId,
      schemaName: row.schemaName,
      jobStatus: row.jobStatus,
      schemaLedgerStatus: row.schemaLedgerStatus,
      schemaExists: row.schemaExists,
      tableCount: Number(row.tableCount ?? 0),
      requestedAt: this.toIso(row.requestedAt),
      deletedAt: row.deletedAt ? this.toIso(row.deletedAt) : null,
      failureResidue: row.failureResidue,
      errorMessage: row.errorMessage,
    };
  }

  private isSchemaDeletionComplete(state: TenantSchemaDeletionState): boolean {
    return (
      state.jobStatus === 'DELETED' &&
      state.schemaLedgerStatus === 'deleted' &&
      state.tableCount === 0 &&
      !state.schemaExists
    );
  }

  private async recordSchemaDeletionFailure(
    manager: EntityManager,
    operation: TenantErasureOperationRow,
    state: TenantSchemaDeletionState,
  ): Promise<void> {
    const failures = Array.isArray(operation.failures)
      ? [...operation.failures]
      : [];
    failures.push({
      eventType: 'TenantSchemaDeletionFailed',
      targetService: 'platform-orchestrator',
      jobId: state.jobId,
      schemaName: state.schemaName,
      reason: state.errorMessage ?? `db-migrate job ${state.jobStatus}`,
      failureResidue: state.failureResidue,
      occurredAt: new Date().toISOString(),
    });

    await manager.query(
      `UPDATE admin.tenant_erasure_operations
          SET status = 'FAILED',
              failures = $2::jsonb,
              "updatedAt" = NOW()
        WHERE id = $1`,
      [operation.id, JSON.stringify(failures)],
    );
  }

  private async finalizeOperation(
    manager: EntityManager,
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
    causationEventId: string,
    schemaDeletion: TenantSchemaDeletionState,
  ): Promise<void> {
    const tenant = await manager.findOne(Tenant, {
      where: { id: operation.tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${operation.tenantId}' not found`);
    }
    if (!canTransition(tenant.status, TenantStatus.PURGED)) {
      throw new BadRequestException(
        `Cannot complete GDPR erasure from tenant state ${tenant.status}; expected ARCHIVED.`,
      );
    }

    const finalLegalHoldCheckedAt = await this.assertLiveLegalHold(
      operation.tenantId,
    );
    const completedAt = new Date().toISOString();
    const proofHash = this.createFinalProofHash(
      operation,
      proofs,
      completedAt,
      schemaDeletion,
      finalLegalHoldCheckedAt,
    );
    tenant.status = TenantStatus.PURGED;
    await manager.save(Tenant, tenant);

    const finalEvent: TenantErasedEvent = {
      ...createBaseEvent<TenantErasedEvent>('TenantErased', operation.tenantId, {
        aggregateId: operation.tenantId,
        aggregateType: 'Tenant',
        causationId: causationEventId,
        userId: operation.requestedBy,
      }),
      timestamp: completedAt,
      operationId: operation.id,
      requestedAt: this.toIso(operation.requestedAt),
      requestedBy: operation.requestedBy,
      legalHoldCheckedAt: finalLegalHoldCheckedAt,
      completedAt,
      targetServiceCount: operation.targetServices.length,
      proofHash,
      proofVersion: 1,
    };
    await this.outboxPublisher.enqueue(finalEvent, manager, {
      aggregateId: operation.tenantId,
      idempotencyKey: `tenant-erasure:${operation.id}:final`,
    });

    await manager.query(
      `UPDATE admin.tenant_erasure_operations
          SET status = 'COMPLETED',
              proofs = $2::jsonb,
              "proofHash" = $3,
              "schemaDeletedAt" = $5,
              "legalHoldCheckedAt" = $6,
              "completedAt" = $4,
              "updatedAt" = NOW()
        WHERE id = $1`,
      [
        operation.id,
        JSON.stringify(proofs),
        proofHash,
        completedAt,
        schemaDeletion.deletedAt ?? completedAt,
        finalLegalHoldCheckedAt,
      ],
    );
  }

  private async loadOperationForUpdate(
    manager: EntityManager,
    operationId: string,
    tenantId: string,
  ): Promise<TenantErasureOperationRow> {
    const rows = queryRowsNormalized<TenantErasureOperationRow>(
      await manager.query(
        `SELECT id,
                "tenantId",
                status,
                "requestedBy",
                reason,
                "requestedAt",
                "legalHoldCheckedAt",
                "targetServices",
                proofs,
                failures,
                "schemaDeletionJobId",
                "schemaDeletionRequestedAt",
                "schemaDeletedAt"
           FROM admin.tenant_erasure_operations
          WHERE id = $1 AND "tenantId" = $2
          FOR UPDATE`,
        [operationId, tenantId],
      ),
    );
    const operation = rows[0];
    if (!operation) {
      throw new NotFoundException(
        `Tenant erasure operation ${operationId} for tenant ${tenantId} not found`,
      );
    }
    return operation;
  }

  private async updateOperationProgress(
    manager: EntityManager,
    operationId: string,
    proofs: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `UPDATE admin.tenant_erasure_operations
          SET proofs = $2::jsonb,
              "updatedAt" = NOW()
        WHERE id = $1`,
      [operationId, JSON.stringify(proofs)],
    );
  }

  private createFinalProofHash(
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
    completedAt: string,
    schemaDeletion: TenantSchemaDeletionState,
    legalHoldCheckedAt: string,
  ): string {
    const targetProofs = operation.targetServices.map((targetService) => ({
      targetService,
      proof: proofs[targetService],
    }));
    const payload = {
      operationId: operation.id,
      tenantId: operation.tenantId,
      requestedAt: this.toIso(operation.requestedAt),
      legalHoldCheckedAt,
      completedAt,
      targetProofs,
      schemaDeletion: {
        jobId: schemaDeletion.jobId,
        schemaName: schemaDeletion.schemaName,
        jobStatus: schemaDeletion.jobStatus,
        schemaLedgerStatus: schemaDeletion.schemaLedgerStatus,
        deletedAt: schemaDeletion.deletedAt,
      },
      proofVersion: 1,
    };
    return `sha256:${createHash('sha256').update(this.stableStringify(payload)).digest('hex')}`;
  }

  private async assertLiveLegalHold(tenantId: string): Promise<string> {
    await this.legalHoldService.assertNoHold(tenantId, 'tenant');
    return new Date().toISOString();
  }

  private extractCausationEventId(
    operation: TenantErasureOperationRow,
    proofs: Record<string, unknown>,
  ): string {
    for (const targetService of [...operation.targetServices].reverse()) {
      const proof = this.asRecord(proofs[targetService]);
      const eventId = proof['eventId'];
      if (typeof eventId === 'string' && eventId.length > 0) {
        return eventId;
      }
    }
    throw new Error(
      `Tenant erasure operation ${operation.id} has no proof eventId for final causation`,
    );
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { ...value };
    }
    return {};
  }

  private toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
