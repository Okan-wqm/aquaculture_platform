/**
 * Delete Department Command Handler
 * Supports cascade soft delete of all related items
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { DeleteDepartmentCommand } from '../commands/delete-department.command';
import { Department } from '../entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { System } from '../../system/entities/system.entity';

@CommandHandler(DeleteDepartmentCommand)
export class DeleteDepartmentHandler implements ICommandHandler<DeleteDepartmentCommand> {
  private readonly logger = new Logger(DeleteDepartmentHandler.name);

  constructor(
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: DeleteDepartmentCommand): Promise<boolean> {
    const { departmentId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting department ${departmentId} for tenant ${tenantId} (cascade: ${cascade})`);

    // Find existing department
    const department = await this.departmentRepository.findOne({
      where: { id: departmentId, tenantId, isDeleted: false },
    });

    if (!department) {
      throw new NotFoundException(`Department with ID "${departmentId}" not found`);
    }

    // Get equipment and tank counts
    const equipment = await this.equipmentRepository.find({
      where: { departmentId, tenantId, isDeleted: false },
    });

    const tanks = await this.tankRepository.find({
      where: { departmentId, tenantId, isActive: true },
    });

    if (!cascade) {
      // Old behavior: block if department has equipment or tanks
      if (equipment.length > 0 || tanks.length > 0) {
        throw new BadRequestException(
          `Cannot delete department "${department.name}". It has ${equipment.length} equipment(s) and ${tanks.length} tank(s). Use cascade=true to delete all related items.`
        );
      }
    } else {
      // Cascade delete all related items
      this.logger.log(`Cascade deleting department ${departmentId} with all related items`);

      const now = new Date();

      // 1. Check for tanks with active biomass (blocker)
      const tanksWithBiomass = tanks.filter(
        (t) => t.currentBiomass && Number(t.currentBiomass) > 0,
      );

      if (tanksWithBiomass.length > 0) {
        const totalBiomass = tanksWithBiomass.reduce(
          (sum, t) => sum + Number(t.currentBiomass || 0),
          0,
        );
        throw new BadRequestException(
          `Cannot delete department "${department.name}". ${tanksWithBiomass.length} tank(s) contain ${totalBiomass.toFixed(2)} kg of active biomass. Please harvest or transfer fish before deleting.`
        );
      }

      // 2. Soft delete all tanks
      if (tanks.length > 0) {
        await this.tankRepository
          .createQueryBuilder()
          .update(Tank)
          .set({
            isActive: false,
            updatedBy: userId,
          } as Partial<Tank>)
          .where('tenantId = :tenantId', { tenantId })
          .andWhere('departmentId = :departmentId', { departmentId })
          .execute();

        this.logger.log(`Soft deleted ${tanks.length} tanks for department ${departmentId}`);
      }

      // 3. Soft delete all equipment
      if (equipment.length > 0) {
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
          .andWhere('departmentId = :departmentId', { departmentId })
          .andWhere('isDeleted = false')
          .execute();

        this.logger.log(`Soft deleted ${equipment.length} equipment for department ${departmentId}`);
      }

      // 4. Orphan systems (set departmentId to null) instead of deleting
      // Systems will remain but show as "Not associated with any department"
      await this.systemRepository
        .createQueryBuilder()
        .update(System)
        .set({
          departmentId: null as unknown as string,
          updatedBy: userId,
        })
        .where('tenantId = :tenantId', { tenantId })
        .andWhere('departmentId = :departmentId', { departmentId })
        .andWhere('isDeleted = false')
        .execute();

      this.logger.log(`Orphaned systems for department ${departmentId} (set departmentId to null)`);
    }

    // 5. Soft delete the department itself
    department.isDeleted = true;
    department.deletedAt = new Date();
    department.deletedBy = userId;
    department.isActive = false;
    department.updatedBy = userId;
    await this.departmentRepository.save(department);

    this.logger.log(`Department ${departmentId} marked as deleted`);

    // Domain event: DepartmentDeleted
    // await this.eventBus?.publish(new DepartmentDeletedEvent({
    //   tenantId,
    //   departmentId: department.id,
    //   name: department.name,
    //   cascade,
    //   deletedBy: userId,
    // }));

    return true;
  }
}
