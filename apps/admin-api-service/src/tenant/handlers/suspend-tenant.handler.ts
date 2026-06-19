import * as crypto from 'crypto';

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  TenantSuspendedEvent,
  TenantActivatedEvent,
  TenantArchivedEvent,
  TenantStatusChangedEvent,
  canTransition,
  createBaseEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, QueryRunner, Repository } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  SuspendTenantCommand,
  ActivateTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
} from '../commands/tenant.commands';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';

@Injectable()
@CommandHandler(SuspendTenantCommand)
export class SuspendTenantHandler
  implements ICommandHandler<SuspendTenantCommand, Tenant>
{
  private readonly logger = new Logger(SuspendTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: SuspendTenantCommand): Promise<Tenant> {
    const { tenantId, data, suspendedBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
      }

      // MT-HIGH-003: legality is owned by the tenant-status machine, not a
      // hand-coded equality. Only ACTIVE -> SUSPENDED is legal; any other
      // source state is rejected with the machine's allowed-set in the message.
      if (!canTransition(tenant.status, TenantStatus.SUSPENDED)) {
        throw new BadRequestException(
          `Cannot suspend a tenant in ${tenant.status} state — only ACTIVE tenants can be suspended.`,
        );
      }

      const previousStatus = tenant.status;
      await this.authProvisioningClient.suspendTenant({
        ...buildLifecycleCommandMetadata(
          'SuspendTenant',
          tenantId,
          suspendedBy,
          { reason: data.reason },
        ),
        reason: data.reason,
      });
      tenant.status = TenantStatus.SUSPENDED;
      tenant.suspendedAt = new Date();
      tenant.suspendedReason = data.reason;
      tenant.suspendedBy = suspendedBy;

      await queryRunner.manager.query(
        `INSERT INTO admin.tenant_activities
           ("tenantId", "activityType", title, description,
            "previousValue", "newValue", "performedBy", "createdAt")
         VALUES
           ($1, 'suspended', 'Status changed: suspended', $2,
            jsonb_build_object('status', $3::text),
            '{"status":"suspended"}'::jsonb,
            $4, NOW())`,
        [tenantId, data.reason || 'Tenant suspended', previousStatus, suspendedBy],
      );

      await queryRunner.manager.save(Tenant, tenant);

      const suspendedEvent: TenantSuspendedEvent = {
        ...createBaseEvent<TenantSuspendedEvent>('TenantSuspended', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        reason: data.reason,
        suspendedBy,
      };
      await this.outboxPublisher.enqueue(suspendedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      // Publish TenantStatusChangedEvent for generic status-change consumers
      const statusChangedEvent: TenantStatusChangedEvent = {
        ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        previousStatus,
        newStatus: TenantStatus.SUSPENDED,
        reason: data.reason,
      };
      await this.outboxPublisher.enqueue(statusChangedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      await queryRunner.commitTransaction();

      this.logger.warn(
        `Tenant suspended: ${tenantId} by ${suspendedBy}. Reason: ${data.reason}`,
      );

      await this.auditLogService.log({
        action: 'TENANT_SUSPENDED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: suspendedBy,
        details: {
          reason: data.reason,
          previousStatus,
        },
      });

      return tenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

@Injectable()
@CommandHandler(ActivateTenantCommand)
export class ActivateTenantHandler
  implements ICommandHandler<ActivateTenantCommand, Tenant>
{
  private readonly logger = new Logger(ActivateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: ActivateTenantCommand): Promise<Tenant> {
    const { tenantId, activatedBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
      }

      // MT-HIGH-003: the machine owns the legal source states for -> ACTIVE
      // (SUSPENDED/DEACTIVATED/CANCELLED reactivation + PROVISIONING finalize).
      // ARCHIVED/PURGED/PENDING are rejected — re-archival or terminal states
      // cannot be activated.
      if (!canTransition(tenant.status, TenantStatus.ACTIVE)) {
        throw new BadRequestException(
          `Cannot activate a tenant in ${tenant.status} state — it is not a legal source for ACTIVE.`,
        );
      }

      const previousStatus = tenant.status;
      await this.authProvisioningClient.activateTenant({
        ...buildLifecycleCommandMetadata(
          'ActivateTenant',
          tenantId,
          activatedBy,
          {},
        ),
      });
      tenant.status = TenantStatus.ACTIVE;
      tenant.suspendedAt = undefined;
      tenant.suspendedReason = undefined;
      tenant.suspendedBy = undefined;
      tenant.lastActivityAt = new Date();

      await queryRunner.manager.query(
        `INSERT INTO admin.tenant_activities
           ("tenantId", "activityType", title, description,
            "previousValue", "newValue", "performedBy", "createdAt")
         VALUES
           ($1, 'activated', 'Status changed: active', 'Tenant activated',
            jsonb_build_object('status', $2::text),
            '{"status":"active"}'::jsonb,
            $3, NOW())`,
        [tenantId, previousStatus, activatedBy],
      );

      await queryRunner.manager.save(Tenant, tenant);

      const activatedEvent: TenantActivatedEvent = {
        ...createBaseEvent<TenantActivatedEvent>('TenantActivated', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        activatedBy,
      };
      await this.outboxPublisher.enqueue(activatedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      // Publish TenantStatusChangedEvent for generic status-change consumers
      const statusChangedEvent: TenantStatusChangedEvent = {
        ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        previousStatus,
        newStatus: TenantStatus.ACTIVE,
      };
      await this.outboxPublisher.enqueue(statusChangedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      await queryRunner.commitTransaction();

      this.logger.log(`Tenant activated: ${tenantId} by ${activatedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_ACTIVATED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: activatedBy,
        details: { previousStatus },
      });

      return tenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

@Injectable()
@CommandHandler(DeactivateTenantCommand)
export class DeactivateTenantHandler
  implements ICommandHandler<DeactivateTenantCommand, Tenant>
{
  private readonly logger = new Logger(DeactivateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: DeactivateTenantCommand): Promise<Tenant> {
    const { tenantId, reason, deactivatedBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
      }

      // MT-HIGH-003: only ACTIVE/SUSPENDED -> DEACTIVATED is legal. This also
      // rejects the already-DEACTIVATED idempotent case and the archived/
      // terminal states the hand-coded pair used to special-case.
      if (!canTransition(tenant.status, TenantStatus.DEACTIVATED)) {
        throw new BadRequestException(
          `Cannot deactivate a tenant in ${tenant.status} state — only ACTIVE or SUSPENDED tenants can be deactivated.`,
        );
      }

      const previousStatus = tenant.status;
      await this.authProvisioningClient.deprovisionTenant({
        ...buildLifecycleCommandMetadata(
          'DeprovisionTenant',
          tenantId,
          deactivatedBy,
          { reason },
        ),
        reason,
      });
      tenant.status = TenantStatus.DEACTIVATED;
      await queryRunner.manager.save(Tenant, tenant);

      const statusChangedEvent: TenantStatusChangedEvent = {
        ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        previousStatus,
        newStatus: TenantStatus.DEACTIVATED,
        reason,
      };
      await this.outboxPublisher.enqueue(statusChangedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      await queryRunner.commitTransaction();

      this.logger.warn(`Tenant deactivated: ${tenantId} by ${deactivatedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_DEACTIVATED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: deactivatedBy,
        details: { reason, previousStatus },
      });

      return tenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

@Injectable()
@CommandHandler(ArchiveTenantCommand)
export class ArchiveTenantHandler
  implements ICommandHandler<ArchiveTenantCommand, Tenant>
{
  private readonly logger = new Logger(ArchiveTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: ArchiveTenantCommand): Promise<Tenant> {
    const { tenantId, archivedBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
      }

      // MT-HIGH-003: only SUSPENDED/DEACTIVATED/CANCELLED -> ARCHIVED is legal.
      // An ACTIVE tenant must be suspended or deactivated first; already-archived
      // and provisioning/terminal states are rejected by the same machine rule.
      if (!canTransition(tenant.status, TenantStatus.ARCHIVED)) {
        throw new BadRequestException(
          `Cannot archive a tenant in ${tenant.status} state — suspend or deactivate it first ` +
            `(legal sources: SUSPENDED, DEACTIVATED, CANCELLED).`,
        );
      }

      const previousStatus = tenant.status;
      await this.authProvisioningClient.archiveTenant({
        ...buildLifecycleCommandMetadata(
          'ArchiveTenant',
          tenantId,
          archivedBy,
          {},
        ),
      });
      tenant.status = TenantStatus.ARCHIVED;
      await queryRunner.manager.save(Tenant, tenant);

      const archivedEvent: TenantArchivedEvent = {
        ...createBaseEvent<TenantArchivedEvent>('TenantArchived', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        archivedBy,
      };
      await this.outboxPublisher.enqueue(archivedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      // Publish TenantStatusChangedEvent for generic status-change consumers
      const statusChangedEvent: TenantStatusChangedEvent = {
        ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
        previousStatus,
        newStatus: TenantStatus.ARCHIVED,
      };
      await this.outboxPublisher.enqueue(statusChangedEvent, queryRunner.manager, {
        aggregateId: tenantId,
      });

      await queryRunner.commitTransaction();

      this.logger.warn(`Tenant archived: ${tenantId} by ${archivedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_ARCHIVED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: archivedBy,
        details: { previousStatus },
      });

      return tenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

function buildLifecycleCommandMetadata(
  commandType: string,
  tenantId: string,
  actorId: string,
  _payload: unknown,
): {
  operationId: string;
  tenantId: string;
  actor: { id: string; type: 'user' };
  requestReference: string;
  auditMetadata: Record<string, unknown>;
} {
  const operationId = crypto.randomUUID();
  return {
    operationId,
    tenantId,
    actor: { id: actorId, type: 'user' },
    requestReference: `${commandType}:${tenantId}:${actorId}`,
    auditMetadata: {
      source: 'admin-api-service',
      commandType,
    },
  };
}
