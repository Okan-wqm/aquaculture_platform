import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import {
  SuspendTenantCommand,
  ActivateTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
} from '../commands/tenant.commands';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { AuditLogService } from '../../audit/audit.service';

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
    private readonly eventBus: EventBus,
    private readonly auditLogService: AuditLogService,
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

      if (tenant.status === TenantStatus.SUSPENDED) {
        throw new BadRequestException('Tenant is already suspended');
      }

      if (tenant.status === TenantStatus.ARCHIVED) {
        throw new BadRequestException('Cannot suspend an archived tenant');
      }

      const previousStatus = tenant.status;
      tenant.status = TenantStatus.SUSPENDED;
      tenant.suspendedAt = new Date();
      tenant.suspendedReason = data.reason;
      tenant.suspendedBy = suspendedBy;

      const savedTenant = await queryRunner.manager.save(tenant);

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

      this.eventBus.publish({
        eventType: 'TenantSuspended',
        payload: {
          tenantId,
          reason: data.reason,
          suspendedBy,
        },
        timestamp: new Date(),
      });

      return savedTenant;
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
    private readonly eventBus: EventBus,
    private readonly auditLogService: AuditLogService,
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

      if (tenant.status === TenantStatus.ACTIVE) {
        throw new BadRequestException('Tenant is already active');
      }

      if (tenant.status === TenantStatus.ARCHIVED) {
        throw new BadRequestException('Cannot activate an archived tenant');
      }

      const previousStatus = tenant.status;
      tenant.status = TenantStatus.ACTIVE;
      tenant.suspendedAt = undefined;
      tenant.suspendedReason = undefined;
      tenant.suspendedBy = undefined;
      tenant.lastActivityAt = new Date();

      const savedTenant = await queryRunner.manager.save(tenant);

      await queryRunner.commitTransaction();

      this.logger.log(`Tenant activated: ${tenantId} by ${activatedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_ACTIVATED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: activatedBy,
        details: { previousStatus },
      });

      this.eventBus.publish({
        eventType: 'TenantActivated',
        payload: {
          tenantId,
          activatedBy,
        },
        timestamp: new Date(),
      });

      return savedTenant;
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
    private readonly eventBus: EventBus,
    private readonly auditLogService: AuditLogService,
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

      if (tenant.status === TenantStatus.DEACTIVATED) {
        throw new BadRequestException('Tenant is already deactivated');
      }

      if (tenant.status === TenantStatus.ARCHIVED) {
        throw new BadRequestException('Cannot deactivate an archived tenant');
      }

      const previousStatus = tenant.status;
      tenant.status = TenantStatus.DEACTIVATED;

      const savedTenant = await queryRunner.manager.save(tenant);

      await queryRunner.commitTransaction();

      this.logger.warn(`Tenant deactivated: ${tenantId} by ${deactivatedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_DEACTIVATED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: deactivatedBy,
        details: { reason, previousStatus },
      });

      this.eventBus.publish({
        eventType: 'TenantDeactivated',
        payload: {
          tenantId,
          reason,
          deactivatedBy,
        },
        timestamp: new Date(),
      });

      return savedTenant;
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
    private readonly eventBus: EventBus,
    private readonly auditLogService: AuditLogService,
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

      if (tenant.status === TenantStatus.ARCHIVED) {
        throw new BadRequestException('Tenant is already archived');
      }

      if (tenant.status === TenantStatus.ACTIVE) {
        throw new BadRequestException(
          'Cannot archive an active tenant. Deactivate first.',
        );
      }

      const previousStatus = tenant.status;
      tenant.status = TenantStatus.ARCHIVED;

      const savedTenant = await queryRunner.manager.save(tenant);

      await queryRunner.commitTransaction();

      this.logger.warn(`Tenant archived: ${tenantId} by ${archivedBy}`);

      await this.auditLogService.log({
        action: 'TENANT_ARCHIVED',
        entityType: 'tenant',
        entityId: tenantId,
        performedBy: archivedBy,
        details: { previousStatus },
      });

      this.eventBus.publish({
        eventType: 'TenantArchived',
        payload: {
          tenantId,
          archivedBy,
        },
        timestamp: new Date(),
      });

      return savedTenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
