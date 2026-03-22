import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { UpdateConsumableCommand } from '../commands/update-consumable.command';
import { Consumable } from '../entities/consumable.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateConsumableCommand)
export class UpdateConsumableHandler implements ICommandHandler<UpdateConsumableCommand, Consumable> {
  private readonly logger = new Logger(UpdateConsumableHandler.name);

  constructor(
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: UpdateConsumableCommand): Promise<Consumable> {
    const { consumableId, input, tenantId, userId } = command;

    this.logger.log(`Updating consumable ${consumableId} for tenant ${tenantId}`);

    const consumable = await this.consumableRepository.findOne({
      where: { id: consumableId, tenantId },
    });

    if (!consumable) {
      throw new NotFoundException(`Consumable with ID "${consumableId}" not found`);
    }

    const hasSupplierId = Object.prototype.hasOwnProperty.call(input, 'supplierId');
    if (hasSupplierId && input.supplierId) {
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

    // Check for duplicate code if changing
    if (input.code) {
      const normalizedCode = input.code.toUpperCase();
      if (normalizedCode !== consumable.code) {
        const existingByCode = await this.consumableRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(consumableId) },
        });
        if (existingByCode) {
          throw new ConflictException(`Consumable with code "${normalizedCode}" already exists`);
        }
      }
    }

    Object.assign(consumable, {
      ...input,
      code: input.code ? input.code.toUpperCase() : consumable.code,
      updatedBy: userId,
    });

    const updated = await this.consumableRepository.save(consumable);

    this.logger.log(`Consumable ${consumableId} updated successfully`);
    return updated;
  }
}
