/**
 * Delete Supplier Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteSupplierCommand } from '../commands/delete-supplier.command';
import { Supplier } from '../entities/supplier.entity';

@CommandHandler(DeleteSupplierCommand)
export class DeleteSupplierHandler implements ICommandHandler<DeleteSupplierCommand> {
  private readonly logger = new Logger(DeleteSupplierHandler.name);

  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: DeleteSupplierCommand): Promise<boolean> {
    const { supplierId, tenantId, userId } = command;

    this.logger.log(`Deleting supplier ${supplierId} for tenant ${tenantId}`);

    // Find existing supplier
    const supplier = await this.supplierRepository.findOne({
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
    await this.supplierRepository.save(supplier);

    this.logger.log(`Supplier ${supplierId} marked as deleted`);

    return true;
  }
}
