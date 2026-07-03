import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteConsumableCommand } from '../commands/delete-consumable.command';
import { Consumable } from '../entities/consumable.entity';

@CommandHandler(DeleteConsumableCommand)
export class DeleteConsumableHandler implements ICommandHandler<DeleteConsumableCommand, boolean> {
  private readonly logger = new Logger(DeleteConsumableHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteConsumableCommand): Promise<boolean> {
    const { consumableId, tenantId, userId } = command;

    this.logger.log(`Deleting consumable ${consumableId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const consumableRepo = tenantManagerRepo(queryRunner.manager, Consumable, tenantId);

      const consumable = await consumableRepo.findOne({
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
      await consumableRepo.save(consumable);

      this.logger.log(`Consumable ${consumableId} marked as deleted`);
      return true;
    });
  }
}
