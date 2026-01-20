/**
 * Update Supplier Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateSupplierCommand } from '../commands/update-supplier.command';
import { Supplier } from '../entities/supplier.entity';

@CommandHandler(UpdateSupplierCommand)
export class UpdateSupplierHandler implements ICommandHandler<UpdateSupplierCommand> {
  private readonly logger = new Logger(UpdateSupplierHandler.name);

  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: UpdateSupplierCommand): Promise<Supplier> {
    const { supplierId, input, tenantId, userId } = command;

    this.logger.log(`Updating supplier ${supplierId} for tenant ${tenantId}`);

    // Find existing supplier
    const supplier = await this.supplierRepository.findOne({
      where: { id: supplierId, tenantId },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with ID "${supplierId}" not found`);
    }

    // Check for duplicate code if changing
    if (input.code && input.code !== supplier.code) {
      const existingByCode = await this.supplierRepository.findOne({
        where: { tenantId, code: input.code, id: Not(supplierId) },
      });
      if (existingByCode) {
        throw new ConflictException(`Supplier with code "${input.code}" already exists`);
      }
    }

    // Check for duplicate name if changing
    if (input.name && input.name !== supplier.name) {
      const existingByName = await this.supplierRepository.findOne({
        where: { tenantId, name: input.name, id: Not(supplierId) },
      });
      if (existingByName) {
        throw new ConflictException(`Supplier with name "${input.name}" already exists`);
      }
    }

    // Update fields
    Object.assign(supplier, {
      ...input,
      code: input.code ? input.code.toUpperCase() : supplier.code,
      updatedBy: userId,
    });

    const updatedSupplier = await this.supplierRepository.save(supplier);

    this.logger.log(`Supplier ${supplierId} updated successfully`);

    return updatedSupplier;
  }
}
