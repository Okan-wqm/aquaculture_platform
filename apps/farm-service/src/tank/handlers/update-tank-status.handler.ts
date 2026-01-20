/**
 * Update Tank Status Command Handler
 * @module Tank/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { UpdateTankStatusCommand } from '../commands/update-tank-status.command';
import { Tank, TankStatus } from '../entities/tank.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(UpdateTankStatusCommand)
export class UpdateTankStatusHandler
  implements ICommandHandler<UpdateTankStatusCommand, Tank>
{
  private readonly logger = new Logger(UpdateTankStatusHandler.name);

  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: UpdateTankStatusCommand): Promise<Tank> {
    const { tenantId, userId, input } = command;

    this.logger.log(
      `Updating tank status: ${input.id} to ${input.status} for tenant: ${tenantId}`,
    );

    // Find existing
    const tank = await this.tankRepository.findOne({
      where: { id: input.id, tenantId },
    });

    if (!tank) {
      throw new NotFoundException(`Tank with id "${input.id}" not found`);
    }

    const oldStatus = tank.status;

    // Validate status transition
    if (!tank.canTransitionTo(input.status)) {
      throw new BadRequestException(
        `Invalid status transition from "${oldStatus}" to "${input.status}". ` +
          `Allowed transitions: ${this.getAllowedTransitions(oldStatus).join(', ')}`,
      );
    }

    // Additional validations based on target status
    this.validateStatusChange(tank, input.status);

    // Update status
    tank.status = input.status;
    tank.statusChangedAt = new Date();
    tank.statusReason = input.reason;
    tank.updatedBy = userId;

    // Save
    const saved = await this.tankRepository.save(tank);

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Tank',
      entityId: saved.id,
      action: AuditAction.UPDATE,
      userId,
      changes: {
        before: { status: oldStatus },
        after: { status: saved.status, reason: input.reason },
        changedFields: ['status', 'statusChangedAt', 'statusReason'],
      },
    });

    this.logger.log(
      `Tank status updated: ${saved.id} from ${oldStatus} to ${saved.status}`,
    );

    return saved;
  }

  /**
   * Additional validations for specific status changes
   */
  private validateStatusChange(tank: Tank, newStatus: TankStatus): void {
    switch (newStatus) {
      case TankStatus.ACTIVE:
        // Tank must be prepared before becoming active
        if (tank.status !== TankStatus.PREPARING && tank.status !== TankStatus.QUARANTINE) {
          throw new BadRequestException(
            'Tank must be in PREPARING or QUARANTINE status to become ACTIVE',
          );
        }
        break;

      case TankStatus.HARVESTING:
        // Tank must have biomass to harvest
        if (tank.currentBiomass <= 0) {
          throw new BadRequestException(
            'Cannot start harvesting: tank has no biomass',
          );
        }
        break;

      case TankStatus.INACTIVE:
        // Tank must be empty to deactivate
        if (tank.currentBiomass > 0) {
          throw new BadRequestException(
            'Cannot deactivate tank with active biomass',
          );
        }
        break;
    }
  }

  /**
   * Get allowed transitions for a given status
   */
  private getAllowedTransitions(status: TankStatus): TankStatus[] {
    const transitions: Record<TankStatus, TankStatus[]> = {
      [TankStatus.INACTIVE]: [TankStatus.PREPARING],
      [TankStatus.PREPARING]: [TankStatus.ACTIVE, TankStatus.INACTIVE],
      [TankStatus.ACTIVE]: [
        TankStatus.HARVESTING,
        TankStatus.MAINTENANCE,
        TankStatus.QUARANTINE,
      ],
      [TankStatus.HARVESTING]: [TankStatus.CLEANING],
      [TankStatus.CLEANING]: [TankStatus.PREPARING, TankStatus.MAINTENANCE],
      [TankStatus.MAINTENANCE]: [TankStatus.PREPARING, TankStatus.INACTIVE],
      [TankStatus.FALLOW]: [TankStatus.PREPARING],
      [TankStatus.QUARANTINE]: [TankStatus.ACTIVE, TankStatus.CLEANING],
    };

    return transitions[status] || [];
  }
}
