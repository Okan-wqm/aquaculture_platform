/**
 * Create Site Command Handler
 */
import { ConflictException, Logger } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { SiteCreatedEvent, createBaseEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { CreateSiteCommand } from '../commands/create-site.command';
import { Site, SiteStatus, SiteLocation, SiteAddress, SiteSettings } from '../entities/site.entity';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { siteAuditSnapshot } from './site-audit.util';

@CommandHandler(CreateSiteCommand)
export class CreateSiteHandler implements ICommandHandler<CreateSiteCommand, Site> {
  private readonly logger = new Logger(CreateSiteHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CreateSiteCommand): Promise<Site> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating site "${input.name}" for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);

      const existingByName = await siteRepository.findOne({
        where: { name: input.name, tenantId },
      });
      if (existingByName) {
        throw new ConflictException(`Site with name "${input.name}" already exists`);
      }

      const code = input.code.toUpperCase();
      const existingByCode = await siteRepository.findOne({
        where: { code, tenantId },
      });
      if (existingByCode) {
        throw new ConflictException(`Site with code "${input.code}" already exists`);
      }

      const site = siteRepository.create({
        name: input.name,
        code,
        description: input.description,
        location: input.location as SiteLocation | undefined,
        address: input.address as SiteAddress | undefined,
        country: input.country,
        timezone: input.timezone || 'UTC',
        status: input.status || SiteStatus.ACTIVE,
        settings: input.settings as SiteSettings | undefined,
        areaM2: input.totalArea,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedSite = await siteRepository.save(site);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Site',
        entityId: savedSite.id,
        action: AuditAction.CREATE,
        userId,
        changes: { after: siteAuditSnapshot(savedSite) },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: savedSite.version,
        summary: `Created site ${savedSite.code}`,
      });

      const event: SiteCreatedEvent = {
        ...createBaseEvent<SiteCreatedEvent>('SiteCreated', tenantId, {
          aggregateId: savedSite.id,
          aggregateType: 'Site',
          userId,
        }),
        siteId: savedSite.id,
        name: savedSite.name,
        code: savedSite.code,
        country: savedSite.country || '',
        region: input.region,
        status: savedSite.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: savedSite.id,
      });

      this.logger.log(`Site "${savedSite.name}" created with ID ${savedSite.id}`);
      return savedSite;
    });
  }
}
