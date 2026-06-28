import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateLeaveTypeCommand } from '../commands/update-leave-type.command';
import { LeaveType } from '../entities/leave-type.entity';

@CommandHandler(UpdateLeaveTypeCommand)
export class UpdateLeaveTypeHandler
  implements ICommandHandler<UpdateLeaveTypeCommand>
{
  private readonly logger = new Logger(UpdateLeaveTypeHandler.name);

  constructor(
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
  ) {}

  async execute(command: UpdateLeaveTypeCommand): Promise<LeaveType> {
    const { tenantId, userId, input } = command;
    const { id, ...patch } = input;

    const leaveType = await this.leaveTypeRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });
    if (!leaveType) {
      throw new NotFoundException(`Leave type with ID ${id} not found`);
    }

    // Apply only the keys the caller actually supplied. Undefined keys are
    // left untouched so a partial patch never clobbers existing values.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        Reflect.set(leaveType, key, value);
      }
    }
    leaveType.updatedBy = userId;

    const saved = await this.leaveTypeRepository.save(leaveType);
    this.logger.log(`Leave type ${saved.id} updated for tenant ${tenantId}`);
    return saved;
  }
}
