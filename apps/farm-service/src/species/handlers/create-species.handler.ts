/**
 * Create Species Command Handler
 * @module Species/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { CreateSpeciesCommand } from '../commands/create-species.command';
import { Species } from '../entities/species.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { CodeGeneratorService } from '../../database/services/code-generator.service';
import { AuditAction } from '../../database/entities/audit-log.entity';

@CommandHandler(CreateSpeciesCommand)
export class CreateSpeciesHandler
  implements ICommandHandler<CreateSpeciesCommand, Species>
{
  private readonly logger = new Logger(CreateSpeciesHandler.name);

  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly auditLogService: AuditLogService,
    private readonly codeGeneratorService: CodeGeneratorService,
  ) {}

  async execute(command: CreateSpeciesCommand): Promise<Species> {
    const { tenantId, userId, input } = command;

    this.logger.log(
      `Creating species: ${input.scientificName} for tenant: ${tenantId}`,
    );

    // Validate unique constraints
    await this.validateUniqueness(tenantId, input.scientificName, input.code);

    // Validate growth stages if provided
    if (input.growthStages?.length) {
      this.validateGrowthStages(input.growthStages);
    }

    // Validate optimal conditions
    if (input.optimalConditions) {
      this.validateOptimalConditions(input.optimalConditions);
    }

    // Create entity
    const species = this.speciesRepository.create({
      tenantId,
      scientificName: input.scientificName,
      commonName: input.commonName,
      localName: input.localName,
      code: input.code.toUpperCase(),
      description: input.description,
      category: input.category,
      waterType: input.waterType,
      family: input.family,
      genus: input.genus,
      optimalConditions: input.optimalConditions as Species['optimalConditions'],
      growthParameters: input.growthParameters as Species['growthParameters'],
      growthStages: input.growthStages,
      marketInfo: input.marketInfo,
      breedingInfo: input.breedingInfo,
      status: input.status,
      imageUrl: input.imageUrl,
      notes: input.notes,
      supplierId: input.supplierId,
      tags: input.tags || [],
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    // Save
    const saved = await this.speciesRepository.save(species);

    // Audit log
    await this.auditLogService.log({
      tenantId,
      entityType: 'Species',
      entityId: saved.id,
      action: AuditAction.CREATE,
      userId,
      changes: {
        after: {
          scientificName: saved.scientificName,
          commonName: saved.commonName,
          code: saved.code,
          category: saved.category,
          waterType: saved.waterType,
        },
      },
    });

    this.logger.log(`Species created: ${saved.id} - ${saved.scientificName}`);

    return saved;
  }

  /**
   * Validates uniqueness of scientific name and code within tenant
   */
  private async validateUniqueness(
    tenantId: string,
    scientificName: string,
    code: string,
  ): Promise<void> {
    // Check scientific name uniqueness
    const existingByName = await this.speciesRepository.findOne({
      where: { tenantId, scientificName },
    });

    if (existingByName) {
      throw new ConflictException(
        `Species with scientific name "${scientificName}" already exists`,
      );
    }

    // Check code uniqueness
    const existingByCode = await this.speciesRepository.findOne({
      where: { tenantId, code: code.toUpperCase() },
    });

    if (existingByCode) {
      throw new ConflictException(
        `Species with code "${code}" already exists`,
      );
    }
  }

  /**
   * Validates growth stages ordering and consistency
   */
  private validateGrowthStages(
    stages: Species['growthStages'],
  ): void {
    if (!stages || stages.length === 0) return;

    // Sort by order
    const sorted = [...stages].sort((a, b) => a.order - b.order);

    // Validate weight progression
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      if (!prev || !curr) continue;

      // Convert to grams for comparison
      const prevMaxWeight =
        prev.weightUnit === 'kg' ? prev.maxWeight * 1000 : prev.maxWeight;
      const currMinWeight =
        curr.weightUnit === 'kg' ? curr.minWeight * 1000 : curr.minWeight;

      if (currMinWeight < prevMaxWeight) {
        throw new BadRequestException(
          `Growth stage "${curr.name}" min weight (${curr.minWeight}${curr.weightUnit}) ` +
            `must be >= previous stage "${prev.name}" max weight (${prev.maxWeight}${prev.weightUnit})`,
        );
      }
    }

    // Validate each stage has valid FCR
    for (const stage of stages) {
      if (stage.targetFCR <= 0 || stage.targetFCR > 10) {
        throw new BadRequestException(
          `Growth stage "${stage.name}" has invalid FCR: ${stage.targetFCR}. Must be between 0.1 and 10.`,
        );
      }
    }
  }

  /**
   * Validates optimal conditions for logical consistency
   */
  private validateOptimalConditions(
    conditions: Partial<Species['optimalConditions']>,
  ): void {
    if (!conditions) return;

    // Temperature validation
    if (conditions.temperature) {
      const temp = conditions.temperature;
      if (temp.min > temp.max) {
        throw new BadRequestException(
          `Temperature min (${temp.min}) cannot be greater than max (${temp.max})`,
        );
      }
      if (temp.optimal && (temp.optimal < temp.min || temp.optimal > temp.max)) {
        throw new BadRequestException(
          `Optimal temperature (${temp.optimal}) must be between min (${temp.min}) and max (${temp.max})`,
        );
      }
      if (temp.criticalMin !== undefined && temp.criticalMin > temp.min) {
        throw new BadRequestException(
          `Critical min temperature (${temp.criticalMin}) should be <= min (${temp.min})`,
        );
      }
      if (temp.criticalMax !== undefined && temp.criticalMax < temp.max) {
        throw new BadRequestException(
          `Critical max temperature (${temp.criticalMax}) should be >= max (${temp.max})`,
        );
      }
    }

    // pH validation
    if (conditions.ph) {
      if (conditions.ph.min > conditions.ph.max) {
        throw new BadRequestException(
          `pH min (${conditions.ph.min}) cannot be greater than max (${conditions.ph.max})`,
        );
      }
    }

    // Salinity validation
    if (conditions.salinity) {
      if (conditions.salinity.min > conditions.salinity.max) {
        throw new BadRequestException(
          `Salinity min (${conditions.salinity.min}) cannot be greater than max (${conditions.salinity.max})`,
        );
      }
    }

    // CO2 validation
    if (conditions.co2) {
      if (conditions.co2.min > conditions.co2.max) {
        throw new BadRequestException(
          `CO2 min (${conditions.co2.min}) cannot be greater than max (${conditions.co2.max})`,
        );
      }
    }

    // Light regime validation
    if (conditions.lightRegime) {
      const totalHours = conditions.lightRegime.lightHours + conditions.lightRegime.darkHours;
      if (totalHours !== 24) {
        throw new BadRequestException(
          `Light regime total hours must equal 24 (got ${totalHours}: light=${conditions.lightRegime.lightHours}, dark=${conditions.lightRegime.darkHours})`,
        );
      }
    }
  }
}
