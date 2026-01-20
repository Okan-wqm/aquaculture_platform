/**
 * Delete Tank Command Handler
 * @module Tank/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { DeleteTankCommand } from '../commands/delete-tank.command';
import { Tank } from '../entities/tank.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(DeleteTankCommand)
export class DeleteTankHandler
  implements ICommandHandler<DeleteTankCommand, boolean>
{
  private readonly logger = new Logger(DeleteTankHandler.name);

  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: DeleteTankCommand): Promise<boolean> {
    const { tenantId, userId, id } = command;

    this.logger.log(`Deleting tank: ${id} for tenant: ${tenantId}`);

    // Find existing
    const tank = await this.tankRepository.findOne({
      where: { id, tenantId },
    });

    if (!tank) {
      throw new NotFoundException(`Tank with id "${id}" not found`);
    }

    // Cannot delete tank with active biomass
    if (tank.currentBiomass > 0) {
      throw new BadRequestException(
        `Cannot delete tank "${tank.name}": it has ${tank.currentBiomass}kg of active biomass. ` +
          'Please transfer or harvest first.',
      );
    }

    // Soft delete - set isActive to false
    tank.isActive = false;
    tank.updatedBy = userId;

    await this.tankRepository.save(tank);

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Tank',
      entityId: id,
      action: AuditAction.SOFT_DELETE,
      userId,
      changes: {
        before: {
          name: tank.name,
          code: tank.code,
          volume: tank.volume,
          isActive: true,
        },
      },
    });

    this.logger.log(`Tank soft-deleted: ${id}`);

    return true;
  }
}
