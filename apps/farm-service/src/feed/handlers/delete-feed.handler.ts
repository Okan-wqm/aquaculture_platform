/**
 * Delete Feed Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteFeedCommand } from '../commands/delete-feed.command';
import { Feed } from '../entities/feed.entity';

@CommandHandler(DeleteFeedCommand)
export class DeleteFeedHandler implements ICommandHandler<DeleteFeedCommand> {
  private readonly logger = new Logger(DeleteFeedHandler.name);

  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(command: DeleteFeedCommand): Promise<boolean> {
    const { feedId, tenantId, userId } = command;

    this.logger.log(`Deleting feed ${feedId} for tenant ${tenantId}`);

    // Find existing feed
    const feed = await this.feedRepository.findOne({
      where: { id: feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed with ID "${feedId}" not found`);
    }

    // Soft delete - mark as deleted AND inactive
    feed.isDeleted = true;
    feed.deletedAt = new Date();
    feed.deletedBy = userId;
    feed.isActive = false;
    feed.updatedBy = userId;
    await this.feedRepository.save(feed);

    this.logger.log(`Feed ${feedId} marked as deleted`);

    return true;
  }
}
