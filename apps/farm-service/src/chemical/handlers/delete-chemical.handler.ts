/**
 * Delete Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteChemicalCommand } from '../commands/delete-chemical.command';
import { Chemical } from '../entities/chemical.entity';

@CommandHandler(DeleteChemicalCommand)
export class DeleteChemicalHandler implements ICommandHandler<DeleteChemicalCommand> {
  private readonly logger = new Logger(DeleteChemicalHandler.name);

  constructor(
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
  ) {}

  async execute(command: DeleteChemicalCommand): Promise<boolean> {
    const { chemicalId, tenantId, userId } = command;

    this.logger.log(`Deleting chemical ${chemicalId} for tenant ${tenantId}`);

    // Find existing chemical
    const chemical = await this.chemicalRepository.findOne({
      where: { id: chemicalId, tenantId },
    });

    if (!chemical) {
      throw new NotFoundException(`Chemical with ID "${chemicalId}" not found`);
    }

    // Soft delete - mark as deleted AND inactive
    chemical.isDeleted = true;
    chemical.deletedAt = new Date();
    chemical.deletedBy = userId;
    chemical.isActive = false;
    chemical.updatedBy = userId;
    await this.chemicalRepository.save(chemical);

    this.logger.log(`Chemical ${chemicalId} marked as deleted`);

    return true;
  }
}
