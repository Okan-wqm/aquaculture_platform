import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { ConflictException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateConsumableCommand } from '../commands/create-consumable.command';
import { Consumable, ConsumableStatus } from '../entities/consumable.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

@CommandHandler(CreateConsumableCommand)
export class CreateConsumableHandler implements ICommandHandler<CreateConsumableCommand, Consumable> {
  private readonly logger = new Logger(CreateConsumableHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: CreateConsumableCommand): Promise<Consumable> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating consumable "${input.name}" for tenant ${tenantId}`);

    // Currency SSoT (FARM-HIGH-146): tenant default from finance_settings,
    // never a hardcoded literal.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const consumableRepo = tenantManagerRepo(queryRunner.manager, Consumable, tenantId);
      const supplierRepo = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);

      const normalizedCode = input.code.toUpperCase();

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
      const existingByCode = await consumableRepo.findOne({
        where: { tenantId, code: normalizedCode },
      });
      if (existingByCode) {
        throw new ConflictException(`Consumable with code "${normalizedCode}" already exists`);
      }

      const consumable = consumableRepo.create({
        tenantId,
        name: input.name,
        code: normalizedCode,
        category: input.category,
        description: input.description,
        unit: input.unit,
        brand: input.brand,
        supplierId: input.supplierId,
        status: ConsumableStatus.AVAILABLE,
        quantity: input.quantity ?? 0,
        minStock: input.minStock ?? 0,
        unitPrice: input.unitPrice,
        currency: input.currency ?? defaultCurrency,
        storageTempMin: input.storageTempMin,
        storageTempMax: input.storageTempMax,
        storageHumidityMin: input.storageHumidityMin,
        storageHumidityMax: input.storageHumidityMax,
        storageRequirements: input.storageRequirements,
        notes: input.notes,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await consumableRepo.save(consumable);

      this.logger.log(`Consumable "${saved.name}" created with ID ${saved.id}`);
      return saved;
    });
  }
}
