/**
 * Update Site Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateSiteCommand } from '../commands/update-site.command';
import { Site } from '../entities/site.entity';

@CommandHandler(UpdateSiteCommand)
export class UpdateSiteHandler implements ICommandHandler<UpdateSiteCommand> {
  private readonly logger = new Logger(UpdateSiteHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(command: UpdateSiteCommand): Promise<Site> {
    const { siteId, input, tenantId, userId } = command;

    this.logger.log(`Updating site ${siteId} for tenant ${tenantId}`);

    // Find existing site
    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId },
    });

    if (!site) {
      throw new NotFoundException(`Site with ID "${siteId}" not found`);
    }

    // Check for duplicate name if changing
    if (input.name && input.name !== site.name) {
      const existingByName = await this.siteRepository.findOne({
        where: { tenantId, name: input.name, id: Not(siteId) },
      });
      if (existingByName) {
        throw new ConflictException(`Site with name "${input.name}" already exists`);
      }
    }

    // Check for duplicate code if changing
    if (input.code && input.code !== site.code) {
      const existingByCode = await this.siteRepository.findOne({
        where: { tenantId, code: input.code, id: Not(siteId) },
      });
      if (existingByCode) {
        throw new ConflictException(`Site with code "${input.code}" already exists`);
      }
    }

    // Update fields
    Object.assign(site, {
      ...input,
      code: input.code ? input.code.toUpperCase() : site.code,
      updatedBy: userId,
    });

    const updatedSite = await this.siteRepository.save(site);

    this.logger.log(`Site ${siteId} updated successfully`);

    // TODO: Publish SiteUpdated event

    return updatedSite;
  }
}
