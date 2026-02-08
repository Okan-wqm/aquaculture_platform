import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { UpdatePurchaseOrderStatusCommand } from '../commands/update-purchase-order-status.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

@CommandHandler(UpdatePurchaseOrderStatusCommand)
export class UpdatePurchaseOrderStatusHandler implements ICommandHandler<UpdatePurchaseOrderStatusCommand> {
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
