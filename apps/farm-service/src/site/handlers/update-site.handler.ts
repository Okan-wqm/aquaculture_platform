/**
 * Update Site Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { SiteUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Not } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UpdateSiteCommand } from '../commands/update-site.command';
import { Site } from '../entities/site.entity';

import {
  monitoringLocationChanged,
  siteMonitoringContractError,
} from '../dto/site-monitoring.validation';
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

      const nextMonitoring = {
        type: input.type ?? site.type,
        location: Object.prototype.hasOwnProperty.call(input, 'location')
          ? input.location
          : site.location,
        monitoringRadiusM: input.monitoringRadiusM ?? site.monitoringRadiusM,
        monitoringArea: Object.prototype.hasOwnProperty.call(input, 'monitoringArea')
          ? input.monitoringArea
          : site.monitoringArea,
      };
      const contractError = siteMonitoringContractError(nextMonitoring);
      if (contractError) {
        throw new BadRequestException(contractError);
      }
      const monitoringChanged = monitoringLocationChanged(
        {
          type: site.type,
          location: site.location,
          monitoringRadiusM: site.monitoringRadiusM,
          monitoringArea: site.monitoringArea,
        },
        nextMonitoring,
      );

      if (input.name !== undefined) {
        site.name = input.name;
      }
      if (normalizedCode !== undefined) {
        site.code = normalizedCode;
      }
      if (input.lokalitetsnummer !== undefined) {
        site.lokalitetsnummer = input.lokalitetsnummer;
      }
      if (input.organisationNumberOverride !== undefined) {
        site.organisationNumberOverride = input.organisationNumberOverride;
      }
      if (input.type !== undefined) {
        site.type = input.type;
      }
      if (input.description !== undefined) {
        site.description = input.description;
      }
      if (Object.prototype.hasOwnProperty.call(input, 'location')) {
        site.location = input.location;
      }
      if (input.monitoringRadiusM !== undefined) {
        site.monitoringRadiusM = input.monitoringRadiusM;
      }
      if (Object.prototype.hasOwnProperty.call(input, 'monitoringArea')) {
        site.monitoringArea = input.monitoringArea;
      }
      if (input.address !== undefined) {
        site.address = input.address;
        site.city = input.address?.city;
      }
      if (input.country !== undefined) {
        site.country = input.country;
      }
      if (input.region !== undefined) {
        site.region = input.region;
      }
      if (input.timezone !== undefined) {
        site.timezone = input.timezone;
      }
      if (input.status !== undefined) {
        site.status = input.status;
      }
      if (input.settings !== undefined) {
        site.settings = input.settings;
      }
      if (input.siteManager !== undefined) {
        site.siteManager = input.siteManager;
      }
      if (input.contactEmail !== undefined) {
        site.contactEmail = input.contactEmail;
      }
      if (input.contactPhone !== undefined) {
        site.contactPhone = input.contactPhone;
      }
      if (input.isActive !== undefined) {
        site.isActive = input.isActive;
      }
      if (monitoringChanged) {
        site.monitoringLocationRevision += 1;
      }
      site.updatedBy = userId;

      // totalArea is the public contract; areaM2 remains the persisted SSoT.
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
