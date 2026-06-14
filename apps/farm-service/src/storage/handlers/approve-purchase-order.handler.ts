/**
 * ApprovePurchaseOrder Handler
 *
 * Transitions a purchase order from SUBMITTED to APPROVED. This is the checker
 * half of the maker-checker control: the generic updatePurchaseOrderStatus
 * mutation deliberately CANNOT move SUBMITTED -> APPROVED, so the only path to
 * an authorized spend (APPROVED -> ORDERED) is through this command.
 *
 * SOC2 CC3.4 (separation of duties): the approver MUST be a different user than
 * the creator. This prevents a single person from both raising and approving a
 * purchase order — the identical control already enforced on inventory counts
 * (approve-inventory-count.handler.ts). NOTE: a purchase order tracks its maker
 * in `createdBy` (inventory counts use `performedBy`); the self-approval guard
 * therefore checks `createdBy`.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ApprovePurchaseOrderCommand } from '../commands/approve-purchase-order.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';

@CommandHandler(ApprovePurchaseOrderCommand)
export class ApprovePurchaseOrderHandler implements ICommandHandler<ApprovePurchaseOrderCommand, PurchaseOrder> {
  private readonly logger = new Logger(ApprovePurchaseOrderHandler.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ApprovePurchaseOrderCommand): Promise<PurchaseOrder> {
    const { purchaseOrderId, tenantId, userId, userName } = command;

    const po = await this.poRepository.findOne({
      where: { id: purchaseOrderId, tenantId, isDeleted: false },
      relations: ['items'],
    });

    if (!po) {
      throw new NotFoundException(`Purchase order "${purchaseOrderId}" not found`);
    }

    if (po.status !== PurchaseOrderStatus.SUBMITTED) {
      throw new BadRequestException(
        `Cannot approve a purchase order with status "${po.status}". ` +
        `Only SUBMITTED purchase orders can be approved.`,
      );
    }

    // SOC2 CC3.4 — Separation of duties enforcement.
    // The person who created the purchase order cannot also approve it.
    // Identical control + message shape as approve-inventory-count.handler.ts,
    // adapted to the PO maker field (createdBy, not performedBy).
    if (po.createdBy === userId) {
      throw new ForbiddenException(
        'Separation of duties violation: the approver must be a different user ' +
        'than the person who created the purchase order (SOC2 CC3.4).',
      );
    }

    // Persist through the tenant-scoped path so tenantId is structurally enforced
    // on the write (same pattern as approve-inventory-count.handler.ts).
    return this.dataSource.transaction(async (manager) => {
      const poRepo = tenantManagerRepo(manager, PurchaseOrder, tenantId);

      po.status = PurchaseOrderStatus.APPROVED;
      po.approvedBy = userId;
      po.approvedByName = userName;
      po.approvedAt = new Date();

      const saved = await poRepo.save(po);

      this.logger.log(
        `PO ${po.orderNumber} approved by ${userId}, tenant ${tenantId}`,
      );

      return saved;
    });
  }
}
