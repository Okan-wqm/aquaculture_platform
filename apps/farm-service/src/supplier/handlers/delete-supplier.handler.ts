/**
 * Delete Supplier Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteSupplierCommand } from '../commands/delete-supplier.command';
import { Supplier } from '../entities/supplier.entity';

@CommandHandler(DeleteSupplierCommand)
export class DeleteSupplierHandler implements ICommandHandler<DeleteSupplierCommand, boolean> {
  private readonly logger = new Logger(DeleteSupplierHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteSupplierCommand): Promise<boolean> {
    const { supplierId, tenantId, userId } = command;

    this.logger.log(`Deleting supplier ${supplierId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      // Find existing supplier
      const supplier = await supplierRepo.findOne({
        where: { id: supplierId, tenantId },
      });

      if (!supplier) {
        throw new NotFoundException(`Supplier with ID "${supplierId}" not found`);
      }

      // Soft delete - mark as deleted AND inactive
      supplier.isDeleted = true;
      supplier.deletedAt = new Date();
      supplier.deletedBy = userId;
      supplier.isActive = false;
      supplier.updatedBy = userId;
      await supplierRepo.save(supplier);

      this.logger.log(`Supplier ${supplierId} marked as deleted`);

      return true;
    });
  }
}
