/**
 * Update Supplier Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateSupplierCommand } from '../commands/update-supplier.command';
import { Supplier } from '../entities/supplier.entity';

@CommandHandler(UpdateSupplierCommand)
export class UpdateSupplierHandler implements ICommandHandler<UpdateSupplierCommand, Supplier> {
  private readonly logger = new Logger(UpdateSupplierHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateSupplierCommand): Promise<Supplier> {
    const { supplierId, input, tenantId, userId } = command;

    this.logger.log(`Updating supplier ${supplierId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      // Find existing supplier
      const supplier = await supplierRepo.findOne({
        where: { id: supplierId, tenantId },
      });

      if (!supplier) {
        throw new NotFoundException(`Supplier with ID "${supplierId}" not found`);
      }

      // Check for duplicate code if changing
      if (input.code && input.code !== supplier.code) {
        const existingByCode = await supplierRepo.findOne({
          where: { tenantId, code: input.code, id: Not(supplierId) },
        });
        if (existingByCode) {
          throw new ConflictException(`Supplier with code "${input.code}" already exists`);
        }
      }

      // Check for duplicate name if changing
      if (input.name && input.name !== supplier.name) {
        const existingByName = await supplierRepo.findOne({
          where: { tenantId, name: input.name, id: Not(supplierId) },
        });
        if (existingByName) {
          throw new ConflictException(`Supplier with name "${input.name}" already exists`);
        }
      }

      // Update only allowed fields (exclude id which is the identifier)
      const { id: _id, ...safeInput } = input;
      Object.assign(supplier, {
        ...safeInput,
        code: input.code ? input.code.toUpperCase() : supplier.code,
        updatedBy: userId,
      });

      const updatedSupplier = await supplierRepo.save(supplier);

      this.logger.log(`Supplier ${supplierId} updated successfully`);

      return updatedSupplier;
    });
  }
}
