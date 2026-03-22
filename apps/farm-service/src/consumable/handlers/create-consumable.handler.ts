import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateConsumableCommand } from '../commands/create-consumable.command';
import { Consumable, ConsumableStatus } from '../entities/consumable.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(CreateConsumableCommand)
export class CreateConsumableHandler implements ICommandHandler<CreateConsumableCommand, Consumable> {
  private readonly logger = new Logger(CreateConsumableHandler.name);

  constructor(
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: CreateConsumableCommand): Promise<Consumable> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating consumable "${input.name}" for tenant ${tenantId}`);

    const normalizedCode = input.code.toUpperCase();

    if (input.supplierId) {
      const supplier = await this.supplierRepository.findOne({
        where: { id: input.supplierId, tenantId },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier with ID "${input.supplierId}" not found`);
      }
      if (supplier.isDeleted) {
        throw new BadRequestException(`Supplier with ID "${input.supplierId}" is deleted`);
      }
    }

    // Check for duplicate code within tenant
    const existingByCode = await this.consumableRepository.findOne({
      where: { tenantId, code: normalizedCode },
    });
    if (existingByCode) {
      throw new ConflictException(`Consumable with code "${normalizedCode}" already exists`);
    }

    const consumable = this.consumableRepository.create({
      tenantId,
      name: input.name,
      code: normalizedCode,
      category: input.category,
      description: input.description,
      unit: input.unit,
      brand: input.brand,
      supplierId: input.supplierId,
      status: ConsumableStatus.AVAILABLE,
      quantity: input.quantity ?? 0,
      minStock: input.minStock ?? 0,
      unitPrice: input.unitPrice,
      currency: input.currency ?? 'NOK',
      storageTempMin: input.storageTempMin,
      storageTempMax: input.storageTempMax,
      storageHumidityMin: input.storageHumidityMin,
      storageHumidityMax: input.storageHumidityMax,
      storageRequirements: input.storageRequirements,
      notes: input.notes,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.consumableRepository.save(consumable);

    this.logger.log(`Consumable "${saved.name}" created with ID ${saved.id}`);
    return saved;
  }
}
