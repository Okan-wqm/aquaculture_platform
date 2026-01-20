/**
 * Update Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { UpdateChemicalCommand } from '../commands/update-chemical.command';
import { Chemical } from '../entities/chemical.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateChemicalCommand)
export class UpdateChemicalHandler implements ICommandHandler<UpdateChemicalCommand> {
  private readonly logger = new Logger(UpdateChemicalHandler.name);

  constructor(
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: UpdateChemicalCommand): Promise<Chemical> {
    const { chemicalId, input, tenantId, userId } = command;

    this.logger.log(`Updating chemical ${chemicalId} for tenant ${tenantId}`);

    // Find existing chemical
    const chemical = await this.chemicalRepository.findOne({
      where: { id: chemicalId, tenantId },
    });

    if (!chemical) {
      throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
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
      if (normalizedCode !== chemical.code) {
        const existingByCode = await this.chemicalRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(chemicalId) },
        });
        if (existingByCode) {
          throw new ConflictException(`Chemical with code "${normalizedCode}" already exists`);
        }
      }
    }

    // Update fields
    Object.assign(chemical, {
      ...input,
      code: input.code ? input.code.toUpperCase() : chemical.code,
      updatedBy: userId,
    });

    const updatedChemical = await this.chemicalRepository.save(chemical);

    this.logger.log(`Chemical ${chemicalId} updated successfully`);

    return updatedChemical;
  }
}
