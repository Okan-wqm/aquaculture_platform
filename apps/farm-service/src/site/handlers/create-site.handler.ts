/**
 * Create Site Command Handler
 */
import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { SiteCreatedEvent } from '@platform/event-contracts';
import { CreateSiteCommand } from '../commands/create-site.command';
import { Site, SiteStatus, SiteLocation, SiteAddress, SiteSettings } from '../entities/site.entity';

@CommandHandler(CreateSiteCommand)
export class CreateSiteHandler implements ICommandHandler<CreateSiteCommand> {
  private readonly logger = new Logger(CreateSiteHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreateSiteCommand): Promise<Site> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating site "${input.name}" for tenant ${tenantId}`);

    // Check for duplicate name
    const existingByName = await this.siteRepository.findOne({
      where: { tenantId, name: input.name },
    });
    if (existingByName) {
      throw new ConflictException(`Site with name "${input.name}" already exists`);
    }

    // Check for duplicate code
    const existingByCode = await this.siteRepository.findOne({
      where: { tenantId, code: input.code },
    });
    if (existingByCode) {
      throw new ConflictException(`Site with code "${input.code}" already exists`);
    }

    // Create site entity
    const site = this.siteRepository.create({
      tenantId,
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description,
      location: input.location as SiteLocation | undefined,
      address: input.address as SiteAddress | undefined,
      country: input.country,
      timezone: input.timezone || 'UTC',
      status: input.status || SiteStatus.ACTIVE,
      settings: input.settings as SiteSettings | undefined,
      areaM2: input.totalArea,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedSite = await this.siteRepository.save(site);

    this.logger.log(`Site "${savedSite.name}" created with ID ${savedSite.id}`);

    // Publish domain event: SiteCreated
    if (this.eventBus) {
      try {
        const event: SiteCreatedEvent = {
          eventId: randomUUID(),
          eventType: 'SiteCreated',
          tenantId,
          timestamp: new Date(),
          siteId: savedSite.id,
          name: savedSite.name,
          code: savedSite.code,
          country: savedSite.country || '',
          region: input.region,
          status: savedSite.status,
        };
        await this.eventBus.publish(event);
        this.logger.debug(`Published SiteCreatedEvent for site ${savedSite.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish SiteCreatedEvent: ${(eventError as Error).message}`);
      }
    }

    return savedSite;
  }
}
