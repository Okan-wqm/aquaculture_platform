/**
 * SubmitInventoryCount Handler
 *
 * Transitions a count from IN_PROGRESS to COMPLETED after validating
 * that all items have been physically counted.
 *
 * Business rationale: A count cannot be submitted for approval unless
 * every item has an actualQuantity. This prevents partial counts from
 * being accidentally approved, which would create inaccurate adjustments.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { SubmitInventoryCountCommand } from '../commands/submit-inventory-count.command';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';

@CommandHandler(SubmitInventoryCountCommand)
export class SubmitInventoryCountHandler implements ICommandHandler<SubmitInventoryCountCommand, InventoryCount> {
  private readonly logger = new Logger(SubmitInventoryCountHandler.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
    @InjectRepository(InventoryCountItem)
    private readonly itemRepository: Repository<InventoryCountItem>,
  ) {}

  async execute(command: SubmitInventoryCountCommand): Promise<InventoryCount> {
    const { countId, tenantId } = command;

    const count = await this.countRepository.findOne({
      where: { id: countId, tenantId },
      relations: ['items'],
    });

    if (!count) {
      throw new NotFoundException(`Inventory count "${countId}" not found`);
    }

    if (count.status !== InventoryCountStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Cannot submit a count with status "${count.status}". ` +
        `Only IN_PROGRESS counts can be submitted for approval.`,
      );
    }

    // Validate completeness: every item must have an actual quantity recorded.
    // This is a hard requirement — partial counts produce inaccurate variance
    // reports and could lead to incorrect inventory adjustments on approval.
    const uncountedItems = count.items.filter(item => item.actualQuantity == null);
    if (uncountedItems.length > 0) {
      throw new BadRequestException(
        `Cannot submit: ${uncountedItems.length} item(s) have not been counted yet. ` +
        `All items must have an actual quantity before submission.`,
      );
    }

    count.status = InventoryCountStatus.COMPLETED;
    count.completedAt = new Date();

    const saved = await this.countRepository.save(count);

    this.logger.log(
      `Inventory count ${count.countNumber} submitted for approval, ` +
      `totalVariance=${count.totalVariance}, tenant ${tenantId}`,
    );

    return saved;
  }
}
