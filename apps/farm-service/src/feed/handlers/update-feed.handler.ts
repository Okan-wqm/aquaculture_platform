/**
 * Update Feed Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { UpdateFeedCommand } from '../commands/update-feed.command';
import { Feed } from '../entities/feed.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateFeedCommand)
export class UpdateFeedHandler implements ICommandHandler<UpdateFeedCommand, Feed> {
  private readonly logger = new Logger(UpdateFeedHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateFeedCommand): Promise<Feed> {
    const { feedId, input, tenantId, userId } = command;

    this.logger.log(`Updating feed ${feedId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const feedRepo = tenantManagerRepo(queryRunner.manager, Feed, tenantId);
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      // Find existing feed
      const feed = await feedRepo.findOne({
        where: { id: feedId, tenantId },
      });

      if (!feed) {
        throw new NotFoundException(`Feed with ID "${feedId}" not found`);
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
        if (normalizedCode !== feed.code) {
          const existingByCode = await feedRepo.findOne({
            where: { tenantId, code: normalizedCode, id: Not(feedId) },
          });
          if (existingByCode) {
            throw new ConflictException(`Feed with code "${normalizedCode}" already exists`);
          }
        }
      }

      // Update fields - exclude id to prevent entity identity corruption
      const { id: _id, ...updateFields } = input;
      Object.assign(feed, {
        ...updateFields,
        code: input.code ? input.code.toUpperCase() : feed.code,
        updatedBy: userId,
      });

      const updatedFeed = await feedRepo.save(feed);

      this.logger.log(`Feed ${feedId} updated successfully`);

      return updatedFeed;
    });
  }
}
