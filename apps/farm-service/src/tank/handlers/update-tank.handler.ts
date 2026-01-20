/**
 * Update Tank Command Handler
 * @module Tank/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { UpdateTankCommand } from '../commands/update-tank.command';
import { Tank, TankType, TankStatus } from '../entities/tank.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(UpdateTankCommand)
export class UpdateTankHandler
  implements ICommandHandler<UpdateTankCommand, Tank>
{
  private readonly logger = new Logger(UpdateTankHandler.name);

  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: UpdateTankCommand): Promise<Tank> {
    const { tenantId, userId, input } = command;
    const { id, ...updateData } = input;

    this.logger.log(`Updating tank: ${id} for tenant: ${tenantId}`);

    // Find existing
    const existing = await this.tankRepository.findOne({
      where: { id, tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Tank with id "${id}" not found`);
    }

    // Cannot update dimensions if tank has active batches
    if (
      existing.currentBiomass > 0 &&
      (updateData.diameter !== undefined ||
        updateData.length !== undefined ||
        updateData.width !== undefined ||
        updateData.depth !== undefined)
    ) {
      throw new BadRequestException(
        'Cannot update dimensions while tank has active biomass. Please transfer or harvest first.',
      );
    }

    // Capture old values for audit
    const oldValues = {
      name: existing.name,
      tankType: existing.tankType,
      volume: existing.volume,
      maxBiomass: existing.maxBiomass,
      status: existing.status,
    };

    // Apply updates
    if (updateData.name !== undefined) existing.name = updateData.name;
    if (updateData.description !== undefined) existing.description = updateData.description;
    if (updateData.tankType !== undefined) existing.tankType = updateData.tankType;
    if (updateData.material !== undefined) existing.material = updateData.material;
    if (updateData.waterType !== undefined) existing.waterType = updateData.waterType;
    if (updateData.diameter !== undefined) existing.diameter = updateData.diameter;
    if (updateData.length !== undefined) existing.length = updateData.length;
    if (updateData.width !== undefined) existing.width = updateData.width;
    if (updateData.depth !== undefined) existing.depth = updateData.depth;
    if (updateData.waterDepth !== undefined) existing.waterDepth = updateData.waterDepth;
    if (updateData.freeboard !== undefined) existing.freeboard = updateData.freeboard;
    if (updateData.maxBiomass !== undefined) existing.maxBiomass = updateData.maxBiomass;
    if (updateData.maxDensity !== undefined) existing.maxDensity = updateData.maxDensity;
    if (updateData.waterFlow !== undefined) {
      existing.waterFlow = updateData.waterFlow as Tank['waterFlow'];
    }
    if (updateData.aeration !== undefined) {
      existing.aeration = updateData.aeration as Tank['aeration'];
    }
    if (updateData.location !== undefined) {
      existing.location = updateData.location as Tank['location'];
    }
    if (updateData.notes !== undefined) existing.notes = updateData.notes;
    if (updateData.installationDate !== undefined) {
      existing.installationDate = new Date(updateData.installationDate);
    }

    existing.updatedBy = userId;

    // Recalculate volume if dimensions changed
    existing.calculateVolume();

    // Validate volume
    if (existing.volume <= 0) {
      throw new BadRequestException(
        'Invalid dimensions: calculated volume must be greater than 0',
      );
    }

    // Save
    const saved = await this.tankRepository.save(existing);

    // Capture new values for audit
    const newValues = {
      name: saved.name,
      tankType: saved.tankType,
      volume: saved.volume,
      maxBiomass: saved.maxBiomass,
      status: saved.status,
    };

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Tank',
      entityId: saved.id,
      action: AuditAction.UPDATE,
      userId,
      changes: {
        before: oldValues,
        after: newValues,
      },
    });

    this.logger.log(`Tank updated: ${saved.id}`);

    return saved;
  }
}
