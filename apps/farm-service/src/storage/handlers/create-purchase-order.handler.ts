import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CreatePurchaseOrderCommand } from '../commands/create-purchase-order.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

@CommandHandler(CreatePurchaseOrderCommand)
export class CreatePurchaseOrderHandler implements ICommandHandler<CreatePurchaseOrderCommand, PurchaseOrder> {
  private readonly logger = new Logger(CreatePurchaseOrderHandler.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
    private readonly dataSource: DataSource,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: CreatePurchaseOrderCommand): Promise<PurchaseOrder> {
    const { input, tenantId, userId } = command;

    // Currency SSoT (FARM-HIGH-146): the purchase order books under the
    // tenant default currency from finance_settings, never a hardcoded
    // literal.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    return this.dataSource.transaction(async (manager) => {
      const poRepo = tenantManagerRepo(manager, PurchaseOrder, tenantId);
      const itemRepo = tenantManagerRepo(manager, PurchaseOrderItem, tenantId);

      // Generate order number: PO-YYYY-NNN.
      // tenantId is auto-injected by poRepo.createQueryBuilder() — dropping
      // the explicit WHERE clause avoids the redundant AND tenantId = ...
      // that TypeORM would emit otherwise.
      const year = new Date().getFullYear();
      const countResult = await poRepo
        .createQueryBuilder('po')
        .andWhere('po.orderNumber LIKE :prefix', { prefix: `PO-${year}-%` })
        .getCount();
      const orderNumber = `PO-${year}-${String(countResult + 1).padStart(3, '0')}`;

      // Calculate total
      let totalAmount = 0;
      const itemEntities: PurchaseOrderItem[] = [];

      for (const item of input.items) {
        const totalPrice = item.unitPrice ? item.unitPrice * item.quantity : undefined;
        if (totalPrice) totalAmount += totalPrice;

        itemEntities.push(itemRepo.create({
          tenantId,
          itemId: item.itemId,
          itemName: item.itemName,
          itemCode: item.itemCode,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          totalPrice,
          quantityReceived: 0,
          isFullyReceived: false,
          notes: undefined,
        }));
      }

      const po = poRepo.create({
        tenantId,
        orderNumber,
        category: input.category,
        supplierName: input.supplierName,
        supplierContact: input.supplierContact,
        status: PurchaseOrderStatus.DRAFT,
        expectedDeliveryDate: input.expectedDeliveryDate ? new Date(input.expectedDeliveryDate) : undefined,
        notes: input.notes,
        totalAmount: totalAmount > 0 ? totalAmount : undefined,
        currency: defaultCurrency,
        createdBy: userId,
        isDeleted: false,
      });

      const savedPO = await poRepo.save(po);

      // Save items with PO reference
      for (const item of itemEntities) {
        item.purchaseOrderId = savedPO.id;
      }
      // saveMany — TenantScopedRepository's array counterpart to save()
      // auto-injects tenantId on every entity before upsert.
      const savedItems = await itemRepo.saveMany(itemEntities);

      this.logger.log(`Created PO ${orderNumber} with ${savedItems.length} items for tenant ${tenantId}`);

      savedPO.items = savedItems;
      return savedPO;
    });
  }
}
