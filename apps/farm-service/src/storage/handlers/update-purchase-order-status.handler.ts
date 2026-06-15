import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { UpdatePurchaseOrderStatusCommand } from '../commands/update-purchase-order-status.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';

/**
 * State machine for the generic updatePurchaseOrderStatus mutation (any
 * MODULE_MANAGER may call it). The maker-checker approval gate is deliberately
 * carved OUT of this table:
 *
 *   - DRAFT -> SUBMITTED       maker submits for review (or CANCELLED).
 *   - SUBMITTED -> DRAFT       maker pulls it back to edit (or CANCELLED).
 *   - SUBMITTED -> APPROVED    is NOT here. APPROVED is reachable ONLY through the
 *     dedicated approvePurchaseOrder command (checker gate, TENANT_ADMIN, self-approval
 *     blocked). If SUBMITTED->APPROVED were allowed here, any MODULE_MANAGER could
 *     self-approve and bypass SOC2 CC3.4 separation of duties.
 *   - APPROVED -> ORDERED      the spend is placed AFTER approval (or CANCELLED).
 *     ORDERED is reachable ONLY from APPROVED, so spend can never bypass the checker.
 *   - ORDERED -> PARTIALLY_RECEIVED | RECEIVED | CANCELLED   delivery lifecycle.
 *   - PARTIALLY_RECEIVED -> RECEIVED | CANCELLED.
 *   - RECEIVED / CANCELLED     terminal.
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['DRAFT', 'CANCELLED'],
  APPROVED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

@CommandHandler(UpdatePurchaseOrderStatusCommand)
export class UpdatePurchaseOrderStatusHandler implements ICommandHandler<UpdatePurchaseOrderStatusCommand, PurchaseOrder> {
  private readonly logger = new Logger(UpdatePurchaseOrderStatusHandler.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
  ) {}

  async execute(command: UpdatePurchaseOrderStatusCommand): Promise<PurchaseOrder> {
    const { input, tenantId } = command;

    const po = await this.poRepository.findOne({
      where: { id: input.id, tenantId, isDeleted: false },
      relations: ['items'],
    });

    if (!po) {
      throw new NotFoundException(`Purchase order "${input.id}" not found`);
    }

    const allowed = VALID_TRANSITIONS[po.status] || [];
    if (!allowed.includes(input.status)) {
      throw new BadRequestException(
        `Cannot transition from ${po.status} to ${input.status}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }

    po.status = input.status;
    if (input.status === PurchaseOrderStatus.RECEIVED) {
      po.actualDeliveryDate = new Date();
    }

    const saved = await this.poRepository.save(po);
    this.logger.log(`PO ${po.orderNumber} status updated to ${input.status}`);
    return saved;
  }
}
