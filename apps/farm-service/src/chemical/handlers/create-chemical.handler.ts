/**
 * Create Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateChemicalCommand } from '../commands/create-chemical.command';
import { Chemical, ChemicalStatus } from '../entities/chemical.entity';
import { ChemicalSite } from '../entities/chemical-site.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Site } from '../../site/entities/site.entity';

@CommandHandler(CreateChemicalCommand)
export class CreateChemicalHandler implements ICommandHandler<CreateChemicalCommand> {
  private readonly logger = new Logger(CreateChemicalHandler.name);

  constructor(
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(command: CreateChemicalCommand): Promise<Chemical> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating chemical "${input.name}" for tenant ${tenantId}`);

    const normalizedCode = input.code.toUpperCase();

    const site = await this.siteRepository.findOne({
      where: { id: input.siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
    }
    if (site.isDeleted) {
      throw new BadRequestException(`Site with ID "${input.siteId}" is deleted`);
    }

    if (input.supplierId) {
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

    // Check for duplicate code within tenant
    const existingByCode = await this.chemicalRepository.findOne({
      where: { tenantId, code: normalizedCode },
    });
    if (existingByCode) {
      throw new ConflictException(`Chemical with code "${normalizedCode}" already exists`);
    }

    const savedChemical = await this.chemicalRepository.manager.transaction(async (manager) => {
      const chemicalRepo = manager.getRepository(Chemical);
      const chemicalSiteRepo = manager.getRepository(ChemicalSite);

      // Create chemical entity - aligned with Chemical entity and CreateChemicalInput
      const chemical = chemicalRepo.create({
        tenantId,
        name: input.name,
        code: normalizedCode,
        type: input.type,
        description: input.description,
        brand: input.brand,
        activeIngredient: input.activeIngredient,
        concentration: input.concentration,
        formulation: input.formulation,
        supplierId: input.supplierId,
        status: ChemicalStatus.AVAILABLE,
        quantity: input.quantity ?? 0,
        minStock: input.minStock ?? 0,
        unit: input.unit,
        usageProtocol: input.usageProtocol,
        safetyInfo: input.safetyInfo,
        storageRequirements: input.storageRequirements,
        shelfLifeMonths: input.shelfLifeMonths,
        expiryDate: input.expiryDate,
        usageAreas: input.usageAreas,
        documents: input.documents?.map(doc => ({
          id: crypto.randomUUID(),
          name: doc.name,
          type: doc.type as 'msds' | 'label' | 'protocol' | 'certificate' | 'other',
          url: doc.url,
          uploadedAt: doc.uploadedAt?.toISOString() ?? new Date().toISOString(),
          uploadedBy: userId,
        })),
        unitPrice: input.unitPrice,
        currency: input.currency ?? 'TRY',
        notes: input.notes,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const created = await chemicalRepo.save(chemical);

      const chemicalSite = chemicalSiteRepo.create({
        tenantId,
        chemicalId: created.id,
        siteId: input.siteId,
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        createdBy: userId,
      });
      await chemicalSiteRepo.save(chemicalSite);

      return created;
    });

    this.logger.log(`Chemical "${savedChemical.name}" created with ID ${savedChemical.id}`);

    return savedChemical;
  }
}
