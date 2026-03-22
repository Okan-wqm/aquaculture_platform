/**
 * Update Feeding Protocol Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { UpdateFeedingProtocolCommand } from '../commands/update-feeding-protocol.command';
import {
  FeedingProtocol,
  TemperatureRange,
  GrowthStageProtocol,
  FeedingSchedule,
} from '../entities/feeding-protocol.entity';
import { Feed } from '../entities/feed.entity';

@CommandHandler(UpdateFeedingProtocolCommand)
export class UpdateFeedingProtocolHandler implements ICommandHandler<UpdateFeedingProtocolCommand, FeedingProtocol> {
  private readonly logger = new Logger(UpdateFeedingProtocolHandler.name);

  constructor(
    @InjectRepository(FeedingProtocol)
    private readonly feedingProtocolRepository: Repository<FeedingProtocol>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(command: UpdateFeedingProtocolCommand): Promise<FeedingProtocol> {
    const { id, input, tenantId, userId } = command;

    this.logger.log(`Updating feeding protocol ${id} for tenant ${tenantId}`);

    // Find existing protocol
    const existingProtocol = await this.feedingProtocolRepository.findOne({
      where: { id, tenantId },
    });
    if (!existingProtocol) {
      throw new NotFoundException(`Feeding protocol with ID "${id}" not found`);
    }

    // Check for duplicate name if name is being changed
    if (input.name && input.name !== existingProtocol.name) {
      const duplicateName = await this.feedingProtocolRepository.findOne({
        where: { tenantId, name: input.name, id: Not(id) },
      });
      if (duplicateName) {
        throw new ConflictException(`Feeding protocol with name "${input.name}" already exists`);
      }
    }

    // Validate feed if provided
    if (input.feedId) {
      const feed = await this.feedRepository.findOne({
        where: { id: input.feedId, tenantId },
      });
      if (!feed) {
        throw new NotFoundException(`Feed with ID "${input.feedId}" not found`);
      }
      if (feed.isDeleted) {
        throw new BadRequestException(`Feed with ID "${input.feedId}" is deleted`);
      }
    }

    // Determine species and stage for default handling
    const species = input.species ?? existingProtocol.species;
    const stage = input.stage ?? existingProtocol.stage;

    // If setting as default, unset any existing default for this species/stage
    if (input.isDefault && !existingProtocol.isDefault) {
      await this.feedingProtocolRepository.update(
        {
          tenantId,
          species,
          stage,
          isDefault: true,
          id: Not(id),
        },
        { isDefault: false },
      );
    }

    // Update fields
    if (input.name !== undefined) existingProtocol.name = input.name;
    if (input.description !== undefined) existingProtocol.description = input.description;
    if (input.feedId !== undefined) existingProtocol.feedId = input.feedId;
    if (input.species !== undefined) existingProtocol.species = input.species;
    if (input.stage !== undefined) existingProtocol.stage = input.stage;

    // Handle temperature ranges with proper type mapping
    if (input.temperatureRanges !== undefined) {
      existingProtocol.temperatureRanges = input.temperatureRanges?.map((tr) => ({
        min: tr.min,
        max: tr.max,
        unit: tr.unit ?? 'celsius',
        feedingMultiplier: tr.feedingMultiplier,
      })) as TemperatureRange[];
    }

    // Handle growth stage protocols with proper type mapping
    if (input.growthStageProtocols !== undefined) {
      existingProtocol.growthStageProtocols = input.growthStageProtocols?.map((gsp) => ({
        minWeight: gsp.minWeight,
        maxWeight: gsp.maxWeight,
        weightUnit: gsp.weightUnit ?? 'gram',
        feedPercent: gsp.feedPercent,
        schedule: gsp.schedule as FeedingSchedule,
        notes: gsp.notes,
      })) as GrowthStageProtocol[];
    }

    if (input.defaultSchedule !== undefined) {
      existingProtocol.defaultSchedule = input.defaultSchedule as FeedingSchedule;
    }

    if (input.targetFcr !== undefined) existingProtocol.targetFcr = input.targetFcr;
    if (input.minDissolvedOxygen !== undefined) existingProtocol.minDissolvedOxygen = input.minDissolvedOxygen;

    // Handle optimal temperature with proper type mapping
    if (input.optimalTemperature !== undefined) {
      existingProtocol.optimalTemperature = input.optimalTemperature
        ? {
            min: input.optimalTemperature.min,
            max: input.optimalTemperature.max,
            unit: input.optimalTemperature.unit ?? 'celsius',
          }
        : undefined;
    }

    if (input.specialConditions !== undefined) existingProtocol.specialConditions = input.specialConditions;
    if (input.notes !== undefined) existingProtocol.notes = input.notes;
    if (input.isActive !== undefined) existingProtocol.isActive = input.isActive;
    if (input.isDefault !== undefined) existingProtocol.isDefault = input.isDefault;

    existingProtocol.updatedBy = userId;

    const savedProtocol = await this.feedingProtocolRepository.save(existingProtocol);

    this.logger.log(`Feeding protocol ${savedProtocol.id} updated successfully`);

    return savedProtocol;
  }
}
