/**
 * Create Chemical Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CreateChemicalCommand } from '../commands/create-chemical.command';
import { Chemical, ChemicalStatus } from '../entities/chemical.entity';
import { ChemicalSite } from '../entities/chemical-site.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { Site } from '../../site/entities/site.entity';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

@CommandHandler(CreateChemicalCommand)
export class CreateChemicalHandler implements ICommandHandler<CreateChemicalCommand, Chemical> {
  private readonly logger = new Logger(CreateChemicalHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: CreateChemicalCommand): Promise<Chemical> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating chemical "${input.name}" for tenant ${tenantId}`);

    // Currency SSoT (FARM-HIGH-146): tenant default resolved from
    // finance_settings, never a hardcoded literal — so chemicals book in
    // the same currency as the rest of the tenant's finance ledger.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const chemicalRepo = tenantManagerRepo(queryRunner.manager, Chemical, tenantId);
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);
      const siteRepo = tenantManagerRepo(queryRunner.manager, Site, tenantId);
      const chemicalSiteRepo = tenantManagerRepo(queryRunner.manager, ChemicalSite, tenantId);

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
      const existingByCode = await chemicalRepo.findOne({
        where: { tenantId, code: normalizedCode },
      });
      if (existingByCode) {
        throw new ConflictException(`Chemical with code "${normalizedCode}" already exists`);
      }

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
        currency: input.currency ?? defaultCurrency,
        notes: input.notes,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedChemical = await chemicalRepo.save(chemical);

      const chemicalSite = chemicalSiteRepo.create({
        tenantId,
        chemicalId: savedChemical.id,
        siteId: input.siteId,
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        createdBy: userId,
      });
      await chemicalSiteRepo.save(chemicalSite);

      this.logger.log(`Chemical "${savedChemical.name}" created with ID ${savedChemical.id}`);

      return savedChemical;
    });
  }
}
