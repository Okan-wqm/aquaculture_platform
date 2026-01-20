/**
 * Delete Site Command Handler
 * Supports cascade soft delete of all related items
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DeleteSiteCommand } from '../commands/delete-site.command';
import { Site } from '../entities/site.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';

@CommandHandler(DeleteSiteCommand)
export class DeleteSiteHandler implements ICommandHandler<DeleteSiteCommand> {
  private readonly logger = new Logger(DeleteSiteHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(command: DeleteSiteCommand): Promise<boolean> {
    const { siteId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting site ${siteId} for tenant ${tenantId} (cascade: ${cascade})`);

    // Find existing site
    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId, isDeleted: false },
    });

    if (!site) {
      throw new NotFoundException(`Site with ID "${siteId}" not found`);
    }

    // Get all departments for this site
    const departments = await this.departmentRepository.find({
      where: { siteId, tenantId, isDeleted: false },
    });

    const departmentIds = departments.map((d) => d.id);

    if (!cascade) {
      // Old behavior: block if site has departments
      if (departments.length > 0) {
        throw new BadRequestException(
          `Cannot delete site "${site.name}". It has ${departments.length} department(s). Use cascade=true to delete all related items.`
        );
      }
    } else {
      // Cascade delete all related items
      this.logger.log(`Cascade deleting site ${siteId} with all related items`);

      const now = new Date();

      // 1. Check for tanks with active biomass (blocker)
      if (departmentIds.length > 0) {
        const tanksWithBiomass = await this.tankRepository
          .createQueryBuilder('tank')
          .where('tank.tenantId = :tenantId', { tenantId })
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
            `Cannot delete site "${site.name}". ${tanksWithBiomass.length} tank(s) contain ${totalBiomass.toFixed(2)} kg of active biomass. Please harvest or transfer fish before deleting.`
          );
        }
      }

      // 2. Soft delete all tanks in departments
      if (departmentIds.length > 0) {
        await this.tankRepository
          .createQueryBuilder()
          .update(Tank)
          .set({
            isActive: false,
            updatedBy: userId,
          } as any)
          .where('tenantId = :tenantId', { tenantId })
          .andWhere('departmentId IN (:...departmentIds)', { departmentIds })
          .execute();

        this.logger.log(`Soft deleted tanks for site ${siteId}`);
      }

      // 3. Soft delete all equipment in departments
      if (departmentIds.length > 0) {
        await this.equipmentRepository
          .createQueryBuilder()
          .update(Equipment)
          .set({
            isDeleted: true,
            deletedAt: now,
            deletedBy: userId,
            isActive: false,
            updatedBy: userId,
          })
          .where('tenantId = :tenantId', { tenantId })
          .andWhere('departmentId IN (:...departmentIds)', { departmentIds })
          .andWhere('isDeleted = false')
          .execute();

        this.logger.log(`Soft deleted equipment for site ${siteId}`);
      }

      // 4. Soft delete all systems for this site
      await this.systemRepository
        .createQueryBuilder()
        .update(System)
        .set({
          isDeleted: true,
          deletedAt: now,
          deletedBy: userId,
          isActive: false,
        })
        .where('tenantId = :tenantId', { tenantId })
        .andWhere('siteId = :siteId', { siteId })
        .andWhere('isDeleted = false')
        .execute();

      this.logger.log(`Soft deleted systems for site ${siteId}`);

      // 5. Orphan departments (set siteId to null) instead of deleting
      // Departments will remain but show as "Not associated with any site"
      await this.departmentRepository
        .createQueryBuilder()
        .update(Department)
        .set({
          siteId: null,
          updatedBy: userId,
        } as any)
        .where('tenantId = :tenantId', { tenantId })
        .andWhere('siteId = :siteId', { siteId })
        .andWhere('isDeleted = false')
        .execute();

      this.logger.log(`Orphaned departments for site ${siteId} (set siteId to null)`);
    }

    // 6. Soft delete the site itself
    site.isDeleted = true;
    site.deletedAt = new Date();
    site.deletedBy = userId;
    site.isActive = false;
    site.updatedBy = userId;
    await this.siteRepository.save(site);

    this.logger.log(`Site ${siteId} marked as deleted`);

    // TODO: Publish SiteDeleted event

    return true;
  }
}
