/**
 * Delete Site Command Handler
 * Supports cascade soft delete of all related items
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, SiteDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, In } from 'typeorm';

import { runRetryingTenantTransaction } from '../../common/database/retrying-tenant-transaction';
import { closeSourcesAtPoints, unitPoints } from '../../water-quality/services/parameter-sources';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Department } from '../../department/entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteSiteCommand } from '../commands/delete-site.command';
import { Site } from '../entities/site.entity';

import { siteAuditSnapshot } from './site-audit.util';

@CommandHandler(DeleteSiteCommand)
export class DeleteSiteHandler implements ICommandHandler<DeleteSiteCommand, boolean> {
  private readonly logger = new Logger(DeleteSiteHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteSiteCommand): Promise<boolean> {
    const { siteId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting site ${siteId} for tenant ${tenantId} (cascade: ${cascade})`);

    await runRetryingTenantTransaction(this.dataSource, tenantId, async (queryRunner) => {
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);
      const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
      const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);

      const site = await siteRepository.findOne({
        where: { id: siteId, isDeleted: false, tenantId },
      });

      if (!site) {
        throw new NotFoundException(`Site with ID "${siteId}" not found`);
      }

      const before = siteAuditSnapshot(site);
      const departments = await departmentRepository.find({
        where: { siteId, isDeleted: false, tenantId },
      });
      const departmentIds = departments.map((d) => d.id);

      if (!cascade) {
        if (departments.length > 0) {
          throw new BadRequestException(
            `Cannot delete site "${site.name}". It has ${departments.length} department(s). Use cascade=true to delete all related items.`,
          );
        }
      } else {
        this.logger.log(`Cascade deleting site ${siteId} with all related items`);

        const now = new Date();

        // Collected before they are retired, to close their water-quality sources.
        const retiredUnitIds: string[] = [];
        if (departmentIds.length > 0) {
          const tanksWithBiomass = await tankRepository
            .createQueryBuilder('tank')
            .andWhere('tank.departmentId IN (:...departmentIds)', { departmentIds })
            .andWhere('tank.currentBiomass > 0')
            .andWhere('tank.isActive = true')
            .getMany();

          if (tanksWithBiomass.length > 0) {
            const totalBiomass = tanksWithBiomass.reduce(
              (sum, t) => sum + Number(t.currentBiomass || 0),
              0,
            );
            throw new BadRequestException(
              `Cannot delete site "${site.name}". ${tanksWithBiomass.length} tank(s) contain ${totalBiomass.toFixed(2)} kg of active biomass. Please harvest or transfer fish before deleting.`,
            );
          }

          const retiredTanks = await tankRepository.find({
            where: { departmentId: In(departmentIds), tenantId },
            select: { id: true },
          });
          const retiredEquipment = await equipmentRepository.find({
            where: { departmentId: In(departmentIds), isDeleted: false, tenantId },
            select: { id: true },
          });
          retiredUnitIds.push(
            ...retiredTanks.map((tank) => tank.id),
            ...retiredEquipment.map((unit) => unit.id),
          );

          await tankRepository.update(
            { departmentId: In(departmentIds) },
            {
              isActive: false,
              updatedBy: userId,
            },
          );

          await equipmentRepository.update(
            { departmentId: In(departmentIds), isDeleted: false },
            {
              isDeleted: true,
              deletedAt: now,
              deletedBy: userId,
              isActive: false,
              updatedBy: userId,
            },
          );

          this.logger.log(`Soft deleted tanks and equipment for site ${siteId}`);
        }

        const retiredSystems = await systemRepository.find({
          where: { siteId, isDeleted: false, tenantId },
          select: { id: true },
        });

        await systemRepository.update(
          { siteId, isDeleted: false },
          {
            isDeleted: true,
            deletedAt: now,
            deletedBy: userId,
            isActive: false,
            updatedBy: userId,
          },
        );

        await departmentRepository.update(
          { siteId, isDeleted: false },
          {
            siteId: null as unknown as string,
            updatedBy: userId,
          },
        );

        this.logger.log(`Soft deleted systems and orphaned departments for site ${siteId}`);

        // The site's units and systems are no longer places a parameter is
        // measured: their water-quality sources end here (FARM-HIGH-373, D12).
        await closeSourcesAtPoints(
          queryRunner.manager,
          tenantId,
          [
            ...unitPoints(retiredUnitIds),
            ...retiredSystems.map((system) => ({ kind: 'system' as const, id: system.id })),
          ],
          userId,
          'all',
        );
      }

      site.isDeleted = true;
      site.deletedAt = new Date();
      site.deletedBy = userId;
      site.isActive = false;
      site.updatedBy = userId;
      const deletedSite = await siteRepository.save(site);
      // Sources at the site point end with the site, cascade or not — after
      // the site row is written, so a bind holding the site FOR SHARE has
      // either committed (and is closed here) or will see the site gone.
      await closeSourcesAtPoints(
        queryRunner.manager,
        tenantId,
        [{ kind: 'site', id: siteId }],
        userId,
        'all',
      );

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Site',
        entityId: deletedSite.id,
        action: AuditAction.SOFT_DELETE,
        userId,
        changes: {
          before,
          after: siteAuditSnapshot(deletedSite),
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: deletedSite.version,
        summary: `Soft deleted site ${deletedSite.code}`,
      });

      const event: SiteDeletedEvent = {
        ...createBaseEvent<SiteDeletedEvent>('SiteDeleted', tenantId, {
          aggregateId: deletedSite.id,
          aggregateType: 'Site',
          userId,
        }),
        siteId: deletedSite.id,
        name: deletedSite.name,
        code: deletedSite.code,
        deletedAt: toEventIso(deletedSite.deletedAt ?? new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: deletedSite.id,
      });

      this.logger.log(`Site ${siteId} marked as deleted`);
    });

    return true;
  }
}
