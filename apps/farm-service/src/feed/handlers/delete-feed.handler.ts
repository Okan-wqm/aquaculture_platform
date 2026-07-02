/**
 * Delete Feed Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DeleteFeedCommand } from '../commands/delete-feed.command';
import { Feed } from '../entities/feed.entity';

@CommandHandler(DeleteFeedCommand)
export class DeleteFeedHandler implements ICommandHandler<DeleteFeedCommand, boolean> {
  private readonly logger = new Logger(DeleteFeedHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteFeedCommand): Promise<boolean> {
    const { feedId, tenantId, userId } = command;

    this.logger.log(`Deleting feed ${feedId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const feedRepo = tenantManagerRepo(queryRunner.manager, Feed, tenantId);

      // Find existing feed
      const feed = await feedRepo.findOne({
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
      await feedRepo.save(feed);

      this.logger.log(`Feed ${feedId} marked as deleted`);

      return true;
    });
  }
}
