/**
 * Create Feed Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CreateFeedCommand } from '../commands/create-feed.command';
import { Feed, FeedStatus, FloatingType } from '../entities/feed.entity';
import { FeedSite } from '../entities/feed-site.entity';
import { FeedTypeSpecies, FeedGrowthStage, FeedSpeciesRecommendation } from '../entities/feed-type-species.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Site } from '../../site/entities/site.entity';
import { Species } from '../../species/entities/species.entity';

@CommandHandler(CreateFeedCommand)
export class CreateFeedHandler implements ICommandHandler<CreateFeedCommand, Feed> {
  private readonly logger = new Logger(CreateFeedHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreateFeedCommand): Promise<Feed> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating feed "${input.name}" for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const feedRepo = tenantManagerRepo(queryRunner.manager, Feed, tenantId);
      const feedSiteRepo = tenantManagerRepo(queryRunner.manager, FeedSite, tenantId);
      const feedTypeSpeciesRepo = tenantManagerRepo(queryRunner.manager, FeedTypeSpecies, tenantId);
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);
      const siteRepo = tenantManagerRepo(queryRunner.manager, Site, tenantId);
      const speciesRepo = tenantManagerRepo(queryRunner.manager, Species, tenantId);

      const normalizedCode = input.code.toUpperCase();

      const site = await siteRepo.findOne({
        where: { id: input.siteId, tenantId },
      });
      if (!site) {
        throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
      }
      if (site.isDeleted) {
        throw new BadRequestException(`Site with ID "${input.siteId}" is deleted`);
      }

      if (input.supplierId) {
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

      // Check for duplicate code within tenant
      const existingByCode = await feedRepo.findOne({
        where: { tenantId, code: normalizedCode },
      });
      if (existingByCode) {
        throw new ConflictException(`Feed with code "${normalizedCode}" already exists`);
      }

      // Check for duplicate name within tenant
      const existingByName = await feedRepo.findOne({
        where: { tenantId, name: input.name },
      });
      if (existingByName) {
        throw new ConflictException(`Feed with name "${input.name}" already exists`);
      }

      // Validate species mappings (optional)
      const speciesMappings = input.speciesMappings ?? [];
      const uniqueSpeciesIds = Array.from(new Set(speciesMappings.map((m) => m.speciesId)));

      const speciesById = new Map<string, Species>();
      if (uniqueSpeciesIds.length > 0) {
        const species = await speciesRepo.find({
          where: { tenantId, id: In(uniqueSpeciesIds) },
        });

        for (const s of species) {
          speciesById.set(s.id, s);
        }

        const missing = uniqueSpeciesIds.filter((id) => !speciesById.has(id));
        if (missing.length > 0) {
          throw new NotFoundException(`Species not found: ${missing.join(', ')}`);
        }

        const deleted = species.filter((s) => s.isDeleted);
        if (deleted.length > 0) {
          throw new BadRequestException(`Species is deleted: ${deleted.map((s) => s.id).join(', ')}`);
        }

        const inactive = species.filter((s) => !s.isActive);
        if (inactive.length > 0) {
          throw new BadRequestException(`Species is inactive: ${inactive.map((s) => s.id).join(', ')}`);
        }
      }

      // Keep legacy targetSpecies string as a derived, human-readable value for backward compatibility
      const derivedTargetSpecies =
        uniqueSpeciesIds.length > 0
          ? uniqueSpeciesIds.map((id) => speciesById.get(id)!.commonName).join(', ')
          : input.targetSpecies;

      // Create feed entity - aligned with Feed entity
      const feed = feedRepo.create({
        tenantId,
        name: input.name,
        code: normalizedCode,
        type: input.type,
        description: input.description,
        brand: input.brand,
        manufacturer: input.manufacturer,
        supplierId: input.supplierId,
        targetSpecies: derivedTargetSpecies,
        pelletSize: input.pelletSize,
        floatingType: input.floatingType ?? FloatingType.FLOATING,
        nutritionalContent: input.nutritionalContent,
        status: input.status ?? FeedStatus.AVAILABLE,
        quantity: input.quantity ?? 0,
        minStock: input.minStock ?? 0,
        unit: input.unit ?? 'kg',
        storageRequirements: input.storageRequirements,
        storageTempMin: input.storageTempMin,
        storageTempMax: input.storageTempMax,
        storageHumidityMin: input.storageHumidityMin,
        storageHumidityMax: input.storageHumidityMax,
        shelfLifeMonths: input.shelfLifeMonths,
        expiryDate: input.expiryDate,
        pricePerKg: input.pricePerKg,
        currency: input.currency ?? 'TRY',
        documents: input.documents?.map(doc => ({
          id: crypto.randomUUID(),
          name: doc.name,
          type: doc.type as 'datasheet' | 'certificate' | 'label' | 'analysis' | 'other',
          url: doc.url,
          uploadedAt: doc.uploadedAt?.toISOString() ?? new Date().toISOString(),
          uploadedBy: userId,
        })),
        notes: input.notes,
        // Yeni alanlar - Pelet ve ürün bilgileri
        pelletSizeLabel: input.pelletSizeLabel,
        productStage: input.productStage,
        composition: input.composition,
        // Yeni alanlar - Fiyatlama
        unitSize: input.unitSize,
        unitPrice: input.unitPrice,
        // Yeni alanlar - Çevresel etki ve besleme eğrisi
        environmentalImpact: input.environmentalImpact,
        feedingCurve: input.feedingCurve,
        feedingMatrix2D: input.feedingMatrix2D,
        minFishWeightG: input.minFishWeightG,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const created = await feedRepo.save(feed);

      const feedSite = feedSiteRepo.create({
        tenantId,
        feedId: created.id,
        siteId: input.siteId,
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        createdBy: userId,
      });
      await feedSiteRepo.save(feedSite);

      if (speciesMappings.length > 0) {
        const seen = new Set<string>();
        const rows = speciesMappings.map((m) => {
          const growthStage = m.growthStage ?? FeedGrowthStage.ALL;
          const key = `${m.speciesId}:${growthStage}`;
          if (seen.has(key)) {
            throw new BadRequestException(`Duplicate species mapping for ${key}`);
          }
          seen.add(key);

          return feedTypeSpeciesRepo.create({
            tenantId,
            feedId: created.id,
            speciesId: m.speciesId,
            growthStage,
            recommendedWeightMinG: m.recommendedWeightMinG,
            recommendedWeightMaxG: m.recommendedWeightMaxG,
            recommendation: m.recommendation ?? FeedSpeciesRecommendation.RECOMMENDED,
            priority: m.priority,
            notes: m.notes,
            isActive: true,
            isDeleted: false,
            createdBy: userId,
            updatedBy: userId,
          });
        });

        await feedTypeSpeciesRepo.saveMany(rows);
      }

      this.logger.log(`Feed "${created.name}" created with ID ${created.id}`);

      return created;
    });
  }
}
