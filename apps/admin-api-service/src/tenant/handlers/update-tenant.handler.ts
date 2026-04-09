import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner, Not } from 'typeorm';
import { IEventBus } from '@platform/event-bus';

import { AuditLogService } from '../../audit/audit.service';
import { UpdateTenantCommand } from '../commands/tenant.commands';
import { Tenant, TenantSettings } from '../entities/tenant.entity';

@Injectable()
@CommandHandler(UpdateTenantCommand)
export class UpdateTenantHandler
  implements ICommandHandler<UpdateTenantCommand, Tenant>
{
  private readonly logger = new Logger(UpdateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: UpdateTenantCommand): Promise<Tenant> {
    const { tenantId, data, updatedBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Find tenant with lock
      const tenant = await queryRunner.manager.findOne(Tenant, {
        where: { id: tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tenant) {
        throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
      }

      // Check for domain conflict if domain is being updated
      if (data.domain && data.domain !== tenant.domain) {
        const existingByDomain = await queryRunner.manager.findOne(Tenant, {
          where: { domain: data.domain, id: Not(tenantId) },
        });

        if (existingByDomain) {
          throw new ConflictException(
            `Tenant with domain '${data.domain}' already exists`,
          );
        }
      }

      // Track changes for audit
      const changes: Record<string, { old: unknown; new: unknown }> = {};

      // Update fields
      if (data.name !== undefined && data.name !== tenant.name) {
        changes['name'] = { old: tenant.name, new: data.name };
        tenant.name = data.name;
      }

      if (
        data.description !== undefined &&
        data.description !== tenant.description
      ) {
        changes['description'] = {
          old: tenant.description,
          new: data.description,
        };
        tenant.description = data.description;
      }

      if (data.domain !== undefined && data.domain !== tenant.domain) {
        changes['domain'] = { old: tenant.domain, new: data.domain };
        tenant.domain = data.domain;
      }

      if (data.tier !== undefined && data.tier !== tenant.tier) {
        changes['tier'] = { old: tenant.tier, new: data.tier };
        tenant.tier = data.tier;
      }

      if (data.limits !== undefined) {
        changes['limits'] = { old: tenant.limits, new: data.limits };
        // limits is computed from maxUsers, update maxUsers instead
        if (data.limits.maxUsers !== undefined) {
          tenant.maxUsers = data.limits.maxUsers;
        }
      }

      if (data.settings !== undefined) {
        changes['settings'] = { old: tenant.settings, new: data.settings };
        tenant.settings = data.settings as TenantSettings;
      }

      if (data.primaryContact !== undefined) {
        changes['primaryContact'] = {
          old: tenant.primaryContact,
          new: data.primaryContact,
        };
        tenant.primaryContact = {
          name: data.primaryContact.name,
          email: data.primaryContact.email,
          phone: data.primaryContact.phone,
          role: data.primaryContact.role || 'Primary Contact',
        };
      }

      if (data.billingContact !== undefined) {
        changes['billingContact'] = {
          old: tenant.billingContact,
          new: data.billingContact,
        };
        tenant.billingContact = {
          name: data.billingContact.name,
          email: data.billingContact.email,
          phone: data.billingContact.phone,
          role: data.billingContact.role || 'Billing Contact',
        };
      }

      if (data.billingEmail !== undefined) {
        changes['billingEmail'] = {
          old: tenant.billingEmail,
          new: data.billingEmail,
        };
        tenant.billingEmail = data.billingEmail;
      }

      if (data.country !== undefined) {
        changes['country'] = { old: tenant.country, new: data.country };
        tenant.country = data.country;
      }

      if (data.region !== undefined) {
        changes['region'] = { old: tenant.region, new: data.region };
        tenant.region = data.region;
      }

      const savedTenant = await queryRunner.manager.save(tenant);

      await queryRunner.commitTransaction();

      this.logger.log(`Tenant updated: ${tenantId} by ${updatedBy}`);

      // Audit log
      if (Object.keys(changes).length > 0) {
        await this.auditLogService.log({
          action: 'TENANT_UPDATED',
          entityType: 'tenant',
          entityId: tenantId,
          performedBy: updatedBy,
          details: { changes },
        });

        // Publish domain event via NATS
        await this.eventBus.publish({
          eventId: crypto.randomUUID(),
          eventType: 'TenantUpdated',
          timestamp: new Date(),
          tenantId,
          name: data.name,
          userId: updatedBy,
          version: 1,
        });
      }

      return savedTenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to update tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
