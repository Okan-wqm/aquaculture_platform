/**
 * Create Supplier Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { CreateSupplierCommand } from '../commands/create-supplier.command';
import { Supplier, SupplierStatus } from '../entities/supplier.entity';

@CommandHandler(CreateSupplierCommand)
export class CreateSupplierHandler implements ICommandHandler<CreateSupplierCommand> {
  private readonly logger = new Logger(CreateSupplierHandler.name);

  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: CreateSupplierCommand): Promise<Supplier> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating supplier "${input.name}" for tenant ${tenantId}`);

    // Check for duplicate code within tenant
    const existingByCode = await this.supplierRepository.findOne({
      where: { tenantId, code: input.code },
    });
    if (existingByCode) {
      throw new ConflictException(`Supplier with code "${input.code}" already exists`);
    }

    // Check for duplicate name within tenant
    const existingByName = await this.supplierRepository.findOne({
      where: { tenantId, name: input.name },
    });
    if (existingByName) {
      throw new ConflictException(`Supplier with name "${input.name}" already exists`);
    }

    // Create supplier entity - aligned with Supplier entity
    const supplier = this.supplierRepository.create({
      tenantId,
      name: input.name,
      code: input.code?.toUpperCase(),
      type: input.type,
      supplyTypes: input.categories,
      status: SupplierStatus.ACTIVE,
      contactPerson: input.primaryContact as any,
      email: input.email,
      phone: input.phone,
      website: input.website,
      address: input.address as any,
      country: input.country,
      taxId: input.taxNumber,
      paymentTerms: input.paymentTerms as any,
      rating: input.rating,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    } as any);

    const savedSupplier = await this.supplierRepository.save(supplier) as unknown as Supplier;

    this.logger.log(`Supplier "${savedSupplier.name}" created with ID ${savedSupplier.id}`);

    return savedSupplier;
  }
}
