/**
 * Create Feeding Protocol Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateFeedingProtocolCommand } from '../commands/create-feeding-protocol.command';
import {
  FeedingProtocol,
  TemperatureRange,
  GrowthStageProtocol,
  FeedingSchedule,
} from '../entities/feeding-protocol.entity';
import { Feed } from '../entities/feed.entity';

@CommandHandler(CreateFeedingProtocolCommand)
export class CreateFeedingProtocolHandler implements ICommandHandler<CreateFeedingProtocolCommand, FeedingProtocol> {
  private readonly logger = new Logger(CreateFeedingProtocolHandler.name);

  constructor(
    @InjectRepository(FeedingProtocol)
    private readonly feedingProtocolRepository: Repository<FeedingProtocol>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(command: CreateFeedingProtocolCommand): Promise<FeedingProtocol> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating feeding protocol "${input.name}" for tenant ${tenantId}`);

    // Check for duplicate name within tenant
    const existingByName = await this.feedingProtocolRepository.findOne({
      where: { tenantId, name: input.name },
    });
    if (existingByName) {
      throw new ConflictException(`Feeding protocol with name "${input.name}" already exists`);
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

    // If setting as default, unset any existing default for this species/stage
    if (input.isDefault) {
      await this.feedingProtocolRepository.update(
        {
          tenantId,
          species: input.species,
          stage: input.stage,
          isDefault: true,
        },
        { isDefault: false },
      );
    }

    // Map temperature ranges with proper defaults
    const temperatureRanges: TemperatureRange[] | undefined = input.temperatureRanges?.map((tr) => ({
      min: tr.min,
      max: tr.max,
      unit: tr.unit ?? 'celsius',
      feedingMultiplier: tr.feedingMultiplier,
    }));

    // Map growth stage protocols with proper defaults
    const growthStageProtocols: GrowthStageProtocol[] | undefined = input.growthStageProtocols?.map((gsp) => ({
      minWeight: gsp.minWeight,
      maxWeight: gsp.maxWeight,
      weightUnit: gsp.weightUnit ?? 'gram',
      feedPercent: gsp.feedPercent,
      schedule: gsp.schedule as FeedingSchedule,
      notes: gsp.notes,
    }));

    // Map optimal temperature with proper defaults
    const optimalTemperature = input.optimalTemperature
      ? {
          min: input.optimalTemperature.min,
          max: input.optimalTemperature.max,
          unit: input.optimalTemperature.unit ?? 'celsius',
        }
      : undefined;

    // Create feeding protocol entity
    const feedingProtocol = this.feedingProtocolRepository.create({
      tenantId,
      name: input.name,
      description: input.description,
      feedId: input.feedId,
      species: input.species,
      stage: input.stage,
      temperatureRanges,
      growthStageProtocols,
      defaultSchedule: input.defaultSchedule as FeedingSchedule | undefined,
      targetFcr: input.targetFcr,
      minDissolvedOxygen: input.minDissolvedOxygen,
      optimalTemperature,
      specialConditions: input.specialConditions,
      notes: input.notes,
      isActive: input.isActive ?? true,
      isDefault: input.isDefault ?? false,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedProtocol = await this.feedingProtocolRepository.save(feedingProtocol);

    this.logger.log(`Feeding protocol "${savedProtocol.name}" created with ID ${savedProtocol.id}`);

    return savedProtocol;
  }
}
