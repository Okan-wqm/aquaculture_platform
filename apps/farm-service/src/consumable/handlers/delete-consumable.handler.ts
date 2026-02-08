import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteConsumableCommand } from '../commands/delete-consumable.command';
import { Consumable } from '../entities/consumable.entity';

@CommandHandler(DeleteConsumableCommand)
export class DeleteConsumableHandler implements ICommandHandler<DeleteConsumableCommand> {
  private readonly logger = new Logger(DeleteConsumableHandler.name);

  constructor(
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
  ) {}

  async execute(command: DeleteConsumableCommand): Promise<boolean> {
    const { consumableId, tenantId, userId } = command;

    this.logger.log(`Deleting consumable ${consumableId} for tenant ${tenantId}`);

    const consumable = await this.consumableRepository.findOne({
      where: { id: consumableId, tenantId },
    });

    if (!consumable) {
      throw new NotFoundException(`Consumable with ID "${consumableId}" not found`);
    }

    consumable.isDeleted = true;
    consumable.deletedAt = new Date();
    consumable.deletedBy = userId;
    consumable.isActive = false;
    consumable.updatedBy = userId;
    await this.consumableRepository.save(consumable);

    this.logger.log(`Consumable ${consumableId} marked as deleted`);
    return true;
  }
}
