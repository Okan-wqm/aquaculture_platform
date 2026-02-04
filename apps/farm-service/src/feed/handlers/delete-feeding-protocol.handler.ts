/**
 * Delete Feeding Protocol Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException } from '@nestjs/common';
import { DeleteFeedingProtocolCommand } from '../commands/delete-feeding-protocol.command';
import { FeedingProtocol } from '../entities/feeding-protocol.entity';

@CommandHandler(DeleteFeedingProtocolCommand)
export class DeleteFeedingProtocolHandler implements ICommandHandler<DeleteFeedingProtocolCommand> {
  private readonly logger = new Logger(DeleteFeedingProtocolHandler.name);

  constructor(
    @InjectRepository(FeedingProtocol)
    private readonly feedingProtocolRepository: Repository<FeedingProtocol>,
  ) {}

  async execute(command: DeleteFeedingProtocolCommand): Promise<boolean> {
    const { id, tenantId, userId } = command;

    this.logger.log(`Deleting feeding protocol ${id} for tenant ${tenantId}`);

    // Find existing protocol
    const existingProtocol = await this.feedingProtocolRepository.findOne({
      where: { id, tenantId },
    });
    if (!existingProtocol) {
      throw new NotFoundException(`Feeding protocol with ID "${id}" not found`);
    }

    // Soft delete by setting isActive to false
    // The entity doesn't have isDeleted field, so we just deactivate
    existingProtocol.isActive = false;
    existingProtocol.updatedBy = userId;

    await this.feedingProtocolRepository.save(existingProtocol);

    this.logger.log(`Feeding protocol ${id} deleted (deactivated) successfully`);

    return true;
  }
}
