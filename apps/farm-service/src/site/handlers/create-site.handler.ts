/**
 * Create Site Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { assertWithinQuota } from '@aquaculture/backend-common/quota';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import {
  SiteCreatedEvent,
  createBaseEvent,
  resolvePlanLimits,
  tenantPlanFromLevel,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { CreateSiteCommand } from '../commands/create-site.command';
import { Site, SiteStatus, SiteType } from '../entities/site.entity';

import { siteMonitoringContractError } from '../dto/site-monitoring.validation';
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
    const { input, tenantId, userId, planLevel } = command;
    const type = input.type ?? SiteType.LAND_BASED;
    const monitoringRadiusM = input.monitoringRadiusM ?? 2_000;
    const monitoringArea = input.monitoringArea ?? null;
    const contractError = siteMonitoringContractError({
      type,
      location: input.location,
      monitoringRadiusM,
      monitoringArea,
    });
    if (contractError) {
      throw new BadRequestException(contractError);
    }

    this.logger.log(`Creating site "${input.name}" for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);

      // SSOT-C-13: fail-closed per-plan farm-count quota. Skipped when the caller
      // carries no plan ordinal (platform SUPER_ADMIN). Counted inside the tx so
      // two concurrent creates cannot both slip past the limit.
      if (planLevel !== undefined) {
        const maxFarms = resolvePlanLimits(tenantPlanFromLevel(planLevel)).maxFarms;
        if (maxFarms !== -1) {
          const currentFarms = await siteRepository.count({ where: { tenantId } });
          assertWithinQuota('farms', currentFarms, maxFarms);
        }
      }

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
        lokalitetsnummer: input.lokalitetsnummer,
        organisationNumberOverride: input.organisationNumberOverride,
        type,
        description: input.description,
        location: input.location,
        monitoringRadiusM,
        monitoringArea,
        monitoringLocationRevision: 1,
        address: input.address,
        city: input.address?.city,
        country: input.country ?? input.address?.country,
        region: input.region,
        // Boş bırakılan zon 'UTC' ile DOLDURULMAZ: NULL "tenant'tan devral"
        // demektir (W5). Sitesine özel zon veren tesisler kolonu açıkça yazar.
        timezone: input.timezone || null,
        status: input.status || SiteStatus.ACTIVE,
        settings: input.settings,
        areaM2: input.totalArea,
        siteManager: input.siteManager,
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
        region: savedSite.region,
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
