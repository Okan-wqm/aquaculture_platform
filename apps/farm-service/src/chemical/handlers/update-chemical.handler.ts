/**
 * Update Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { Not, DataSource } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { UpdateChemicalCommand } from '../commands/update-chemical.command';
import { Chemical } from '../entities/chemical.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateChemicalCommand)
export class UpdateChemicalHandler implements ICommandHandler<UpdateChemicalCommand, Chemical> {
  private readonly logger = new Logger(UpdateChemicalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateChemicalCommand): Promise<Chemical> {
    const { chemicalId, input, tenantId, userId } = command;

    this.logger.log(`Updating chemical ${chemicalId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemicalRepo = tenantManagerRepo(queryRunner.manager, Chemical, tenantId);
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      // Find existing chemical
      const chemical = await chemicalRepo.findOne({
        where: { id: chemicalId, tenantId },
      });

      if (!chemical) {
        throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
      }

      const hasSupplierId = Object.prototype.hasOwnProperty.call(input, 'supplierId');
      if (hasSupplierId && input.supplierId) {
        const supplier = await supplierRepo.findOne({
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
          const existingByCode = await chemicalRepo.findOne({
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

      const updatedChemical = await chemicalRepo.save(chemical);

      this.logger.log(`Chemical ${chemicalId} updated successfully`);

      return updatedChemical;
    });
  }
}
