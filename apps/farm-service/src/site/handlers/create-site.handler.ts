/**
 * Create Site Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { CreateSiteCommand } from '../commands/create-site.command';
import { Site, SiteStatus } from '../entities/site.entity';

@CommandHandler(CreateSiteCommand)
export class CreateSiteHandler implements ICommandHandler<CreateSiteCommand> {
  private readonly logger = new Logger(CreateSiteHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
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
      location: input.location as any,
      address: input.address as any,
      country: input.country,
      timezone: input.timezone || 'UTC',
      status: input.status || SiteStatus.ACTIVE,
      settings: input.settings as any,
      areaM2: input.totalArea,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedSite = await this.siteRepository.save(site);

    this.logger.log(`Site "${savedSite.name}" created with ID ${savedSite.id}`);

    // TODO: Publish SiteCreated event
    // await this.eventBus.publish(new SiteCreatedEvent({
    //   siteId: savedSite.id,
    //   tenantId,
    //   name: savedSite.name,
    //   code: savedSite.code,
    // }));

    return savedSite;
  }
}
