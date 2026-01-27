/**
 * Create Supplier Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { CreateSupplierCommand } from '../commands/create-supplier.command';
import { Supplier, SupplierStatus, SupplierAddress } from '../entities/supplier.entity';

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

    // Transform address input to entity format
    const address: SupplierAddress | undefined = input.address ? {
      street: input.address.street,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
      country: input.address.country,
    } : undefined;

    // Transform payment terms to string format
    const paymentTermsStr = input.paymentTerms
      ? `${input.paymentTerms.paymentDays} days${input.paymentTerms.notes ? ` - ${input.paymentTerms.notes}` : ''}`
      : undefined;

    // Extract contact person name from contact object
    const contactPersonName = input.primaryContact?.name || input.contactPerson;

    // Create supplier entity with proper types
    const supplierData: DeepPartial<Supplier> = {
      tenantId,
      name: input.name,
      code: input.code?.toUpperCase(),
      type: input.type,
      supplyTypes: input.categories,
      status: SupplierStatus.ACTIVE,
      contactPerson: contactPersonName,
      email: input.email,
      phone: input.phone,
      website: input.website,
      address,
      country: input.country,
      taxId: input.taxNumber,
      paymentTerms: paymentTermsStr,
      rating: input.rating,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    };

    const supplier = this.supplierRepository.create(supplierData);
    const savedSupplier = await this.supplierRepository.save(supplier);

    this.logger.log(`Supplier "${savedSupplier.name}" created with ID ${savedSupplier.id}`);

    return savedSupplier;
  }
}
