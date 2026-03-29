import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ToggleLegalHoldCommand } from './toggle-legal-hold.command';
import { LegalHold } from '../entities/legal-hold.entity';
import { LegalHoldService } from '../services/legal-hold.service';
import { ComplianceAuditService } from '../services/compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';

/**
 * Handler for ToggleLegalHoldCommand.
 *
 * Activates or releases a legal hold, logs to compliance audit,
 * and publishes a LegalHoldToggled outbox event.
 *
 * All three operations (hold + audit + outbox) execute inside a single
 * database transaction for atomicity.
 *
 * @see ADR-012 Phase 3 (Legal Hold Support)
 */
@CommandHandler(ToggleLegalHoldCommand)
export class ToggleLegalHoldHandler
  implements ICommandHandler<ToggleLegalHoldCommand, LegalHold>
{
  private readonly logger = new Logger(ToggleLegalHoldHandler.name);

  constructor(
    private readonly legalHoldService: LegalHoldService,
    private readonly auditService: ComplianceAuditService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ToggleLegalHoldCommand): Promise<LegalHold> {
    const { tenantId, userId, activate, holdId, channelId, reason } = command;

    // Validate before entering transaction
    if (activate && (!reason || reason.trim().length === 0)) {
      throw new BadRequestException('A reason is required to activate a legal hold');
    }
    if (!activate && !holdId) {
      throw new BadRequestException('holdId is required to release a legal hold');
    }

    // Wrap hold + audit + outbox in a single transaction
    return this.dataSource.transaction(async (manager) => {
      let hold: LegalHold;

      if (activate) {
        hold = await this.legalHoldService.activate(
          tenantId,
          channelId,
          reason!,
          userId,
        );

        this.logger.log(
          `Legal hold activated: id=${hold.id}, tenant=${tenantId}, channel=${channelId ?? 'all'}`,
        );
      } else {
        hold = await this.legalHoldService.release(holdId!, userId);

        this.logger.log(`Legal hold released: id=${holdId}, by=${userId}`);
      }

      // Log to compliance audit within the transaction
      await this.auditService.log({
        tenantId,
        userId,
        action: ComplianceAction.LEGAL_HOLD_TOGGLE,
        resourceType: 'legal_hold',
        resourceId: hold.id,
        details: {
          activate,
          channelId: hold.channelId,
          reason: hold.reason,
          holdId: hold.id,
        },
        ipAddress: null,
        userAgent: null,
      });

      // Publish outbox event within the transaction
      const outboxEvent = manager.create(MessagingOutbox, {
        eventType: 'LegalHoldToggled',
        payload: {
          tenantId,
          holdId: hold.id,
          channelId: hold.channelId,
          activate,
          reason: hold.reason,
          toggledBy: userId,
          toggledAt: new Date().toISOString(),
        },
      });
      await manager.save(MessagingOutbox, outboxEvent);

      return hold;
    });
  }
}
