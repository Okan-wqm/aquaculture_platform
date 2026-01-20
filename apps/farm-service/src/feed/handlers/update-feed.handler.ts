/**
 * Update Feed Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { UpdateFeedCommand } from '../commands/update-feed.command';
import { Feed } from '../entities/feed.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';

@CommandHandler(UpdateFeedCommand)
export class UpdateFeedHandler implements ICommandHandler<UpdateFeedCommand> {
  private readonly logger = new Logger(UpdateFeedHandler.name);

  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(command: UpdateFeedCommand): Promise<Feed> {
    const { feedId, input, tenantId, userId } = command;

    this.logger.log(`Updating feed ${feedId} for tenant ${tenantId}`);

    // Find existing feed
    const feed = await this.feedRepository.findOne({
      where: { id: feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed with ID "${feedId}" not found`);
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
      if (normalizedCode !== feed.code) {
        const existingByCode = await this.feedRepository.findOne({
          where: { tenantId, code: normalizedCode, id: Not(feedId) },
        });
        if (existingByCode) {
          throw new ConflictException(`Feed with code "${normalizedCode}" already exists`);
        }
      }
    }

    // Update fields
    Object.assign(feed, {
      ...input,
      code: input.code ? input.code.toUpperCase() : feed.code,
      updatedBy: userId,
    });

    const updatedFeed = await this.feedRepository.save(feed);

    this.logger.log(`Feed ${feedId} updated successfully`);

    return updatedFeed;
  }
}
