/**
 * Update Site Command Handler
 */
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { SiteUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { DataSource, Not } from 'typeorm';
import { UpdateSiteCommand } from '../commands/update-site.command';
import { Site } from '../entities/site.entity';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { siteAuditSnapshot } from './site-audit.util';

@CommandHandler(UpdateSiteCommand)
export class UpdateSiteHandler implements ICommandHandler<UpdateSiteCommand, Site> {
  private readonly logger = new Logger(UpdateSiteHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateSiteCommand): Promise<Site> {
    const { siteId, input, tenantId, userId } = command;

    this.logger.log(`Updating site ${siteId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);

      const site = await siteRepository.findOne({
        where: { id: siteId, tenantId },
      });

      if (!site) {
        throw new NotFoundException(`Site with ID "${siteId}" not found`);
      }

      const before = siteAuditSnapshot(site);

      if (input.name && input.name !== site.name) {
        const existingByName = await siteRepository.findOne({
          where: { name: input.name, id: Not(siteId), tenantId },
        });
        if (existingByName) {
          throw new ConflictException(`Site with name "${input.name}" already exists`);
        }
      }

      const normalizedCode = input.code ? input.code.toUpperCase() : undefined;
      if (normalizedCode && normalizedCode !== site.code) {
        const existingByCode = await siteRepository.findOne({
          where: { code: normalizedCode, id: Not(siteId), tenantId },
        });
        if (existingByCode) {
          throw new ConflictException(`Site with code "${input.code}" already exists`);
        }
      }

      Object.assign(site, {
        ...input,
        code: normalizedCode ?? site.code,
        updatedBy: userId,
      });
      if (Object.prototype.hasOwnProperty.call(input, 'totalArea')) {
        site.areaM2 = input.totalArea;
      }

      const updatedSite = await siteRepository.save(site);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Site',
        entityId: updatedSite.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: siteAuditSnapshot(updatedSite),
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: updatedSite.version,
        summary: `Updated site ${updatedSite.code}`,
      });

      const event: SiteUpdatedEvent = {
        ...createBaseEvent<SiteUpdatedEvent>('SiteUpdated', tenantId, {
          aggregateId: updatedSite.id,
          aggregateType: 'Site',
          userId,
        }),
        siteId: updatedSite.id,
        name: updatedSite.name,
        code: updatedSite.code,
        status: updatedSite.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: updatedSite.id,
      });

      this.logger.log(`Site ${siteId} updated successfully`);
      return updatedSite;
    });
  }
}
