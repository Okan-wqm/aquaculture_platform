import { ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateLeaveTypeCommand } from '../commands/create-leave-type.command';
import { LeaveType } from '../entities/leave-type.entity';

@CommandHandler(CreateLeaveTypeCommand)
export class CreateLeaveTypeHandler
  implements ICommandHandler<CreateLeaveTypeCommand>
{
  private readonly logger = new Logger(CreateLeaveTypeHandler.name);

  constructor(
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
  ) {}

  async execute(command: CreateLeaveTypeCommand): Promise<LeaveType> {
    const { tenantId, userId, input } = command;

    // Per-tenant code uniqueness is the business key (@Index(['tenantId','code'], unique)).
    // Fail-fast with a 409 instead of surfacing a raw DB unique-violation.
    const existing = await this.leaveTypeRepository.findOne({
      where: { tenantId, code: input.code, isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(
        `Leave type with code ${input.code} already exists for this tenant`,
      );
    }

    const leaveType = this.leaveTypeRepository.create({
      ...input,
      tenantId,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.leaveTypeRepository.save(leaveType);
    this.logger.log(`Leave type ${saved.id} (${saved.code}) created for tenant ${tenantId}`);
    return saved;
  }
}
