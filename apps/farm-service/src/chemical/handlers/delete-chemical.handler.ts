/**
 * Delete Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DeleteChemicalCommand } from '../commands/delete-chemical.command';
import { Chemical } from '../entities/chemical.entity';

@CommandHandler(DeleteChemicalCommand)
export class DeleteChemicalHandler implements ICommandHandler<DeleteChemicalCommand, boolean> {
  private readonly logger = new Logger(DeleteChemicalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteChemicalCommand): Promise<boolean> {
    const { chemicalId, tenantId, userId } = command;

    this.logger.log(`Deleting chemical ${chemicalId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemicalRepo = tenantManagerRepo(queryRunner.manager, Chemical, tenantId);

      // Find existing chemical
      const chemical = await chemicalRepo.findOne({
        where: { id: chemicalId, tenantId },
      });

      if (!chemical) {
        throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
      }

      // Soft delete - mark as deleted AND inactive
      chemical.isDeleted = true;
      chemical.deletedAt = new Date();
      chemical.deletedBy = userId;
      chemical.isActive = false;
      chemical.updatedBy = userId;
      await chemicalRepo.save(chemical);

      this.logger.log(`Chemical ${chemicalId} marked as deleted`);

      return true;
    });
  }
}
