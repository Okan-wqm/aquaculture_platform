/**
 * Update Species Command Handler
 * @module Species/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { UpdateSpeciesCommand } from '../commands/update-species.command';
import { Species } from '../entities/species.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(UpdateSpeciesCommand)
export class UpdateSpeciesHandler
  implements ICommandHandler<UpdateSpeciesCommand, Species>
{
  private readonly logger = new Logger(UpdateSpeciesHandler.name);

  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: UpdateSpeciesCommand): Promise<Species> {
    const { tenantId, userId, input } = command;
    const { id, ...updateData } = input;

    this.logger.log(`Updating species: ${id} for tenant: ${tenantId}`);

    // Find existing
    const existing = await this.speciesRepository.findOne({
      where: { id, tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Species with id "${id}" not found`);
    }

    // Validate unique constraints if updating
    if (updateData.scientificName && updateData.scientificName !== existing.scientificName) {
      await this.validateScientificNameUniqueness(
        tenantId,
        id,
        updateData.scientificName,
      );
    }

    if (updateData.code && updateData.code !== existing.code) {
      await this.validateCodeUniqueness(
        tenantId,
        id,
        updateData.code,
      );
    }

    // Capture old values for audit
    const oldValues = {
      scientificName: existing.scientificName,
      commonName: existing.commonName,
      code: existing.code,
      category: existing.category,
      waterType: existing.waterType,
      status: existing.status,
      isActive: existing.isActive,
      tags: existing.tags,
    };

    // Apply updates
    if (updateData.scientificName !== undefined) existing.scientificName = updateData.scientificName;
    if (updateData.commonName !== undefined) existing.commonName = updateData.commonName;
    if (updateData.localName !== undefined) existing.localName = updateData.localName;
    if (updateData.code !== undefined) existing.code = updateData.code.toUpperCase();
    if (updateData.description !== undefined) existing.description = updateData.description;
    if (updateData.category !== undefined) existing.category = updateData.category;
    if (updateData.waterType !== undefined) existing.waterType = updateData.waterType;
    if (updateData.family !== undefined) existing.family = updateData.family;
    if (updateData.genus !== undefined) existing.genus = updateData.genus;
    if (updateData.optimalConditions !== undefined) {
      existing.optimalConditions = updateData.optimalConditions as Species['optimalConditions'];
    }
    if (updateData.growthParameters !== undefined) {
      existing.growthParameters = updateData.growthParameters as Species['growthParameters'];
    }
    if (updateData.growthStages !== undefined) existing.growthStages = updateData.growthStages;
    if (updateData.marketInfo !== undefined) existing.marketInfo = updateData.marketInfo;
    if (updateData.breedingInfo !== undefined) existing.breedingInfo = updateData.breedingInfo;
    if (updateData.status !== undefined) existing.status = updateData.status;
    if (updateData.imageUrl !== undefined) existing.imageUrl = updateData.imageUrl;
    if (updateData.notes !== undefined) existing.notes = updateData.notes;
    if (updateData.supplierId !== undefined) existing.supplierId = updateData.supplierId;
    if (updateData.tags !== undefined) existing.tags = updateData.tags;
    if (updateData.isActive !== undefined) existing.isActive = updateData.isActive;

    existing.updatedBy = userId;

    // Save
    const saved = await this.speciesRepository.save(existing);

    // Capture new values for audit
    const newValues = {
      scientificName: saved.scientificName,
      commonName: saved.commonName,
      code: saved.code,
      category: saved.category,
      waterType: saved.waterType,
      status: saved.status,
      isActive: saved.isActive,
      tags: saved.tags,
    };

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Species',
      entityId: saved.id,
      action: AuditAction.UPDATE,
      userId,
      changes: {
        before: oldValues,
        after: newValues,
      },
    });

    this.logger.log(`Species updated: ${saved.id}`);

    return saved;
  }

  private async validateScientificNameUniqueness(
    tenantId: string,
    excludeId: string,
    scientificName: string,
  ): Promise<void> {
    const existing = await this.speciesRepository.findOne({
      where: {
        tenantId,
        scientificName,
        id: Not(excludeId),
      },
    });

    if (existing) {
      throw new ConflictException(
        `Species with scientific name "${scientificName}" already exists`,
      );
    }
  }

  private async validateCodeUniqueness(
    tenantId: string,
    excludeId: string,
    code: string,
  ): Promise<void> {
    const existing = await this.speciesRepository.findOne({
      where: {
        tenantId,
        code: code.toUpperCase(),
        id: Not(excludeId),
      },
    });

    if (existing) {
      throw new ConflictException(
        `Species with code "${code}" already exists`,
      );
    }
  }
}
