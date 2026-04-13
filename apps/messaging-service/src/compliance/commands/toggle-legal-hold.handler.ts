import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { ToggleLegalHoldCommand } from './toggle-legal-hold.command';
import { LegalHold } from '../entities/legal-hold.entity';
import { LegalHoldService } from '../services/legal-hold.service';
import { ComplianceAuditService } from '../services/compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

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
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ToggleLegalHoldCommand): Promise<LegalHold> {
    const {
      tenantId, userId, activate, holdId, channelId, reason,
      legalMatterId, legalMatterDescription, requestedBy, expiresAt,
    } = command;

    // Validate before entering transaction
    if (activate && (!reason || reason.trim().length === 0)) {
      throw new BadRequestException('A reason is required to activate a legal hold');
    }
    if (activate && !legalMatterId) {
      throw new BadRequestException(
        'legalMatterId is required to activate a legal hold (GDPR proportionality)',
      );
    }
    if (!activate && !holdId) {
      throw new BadRequestException('holdId is required to release a legal hold');
    }

    // Wrap hold + audit + outbox in a single transaction
    return this.dataSource.transaction(async (manager) => {
      let hold: LegalHold;

      if (activate) {
        // Pass manager so activate() uses the same transaction context.
        // BEFORE: activate() used its own injected repo — it was outside this transaction.
        // If outbox.save() failed below, the hold was already committed but had no audit log.
        hold = await this.legalHoldService.activate(
          tenantId,
          channelId,
          reason!,
          userId,
          legalMatterId!,
          {
            legalMatterDescription: legalMatterDescription ?? undefined,
            requestedBy: requestedBy ?? undefined,
            expiresAt: expiresAt ?? undefined,
          },
          manager,
        );

        this.logger.log(
          `Legal hold activated: id=${hold.id}, tenant=${tenantId}, channel=${channelId ?? 'all'}`,
        );
      } else {
        hold = await this.legalHoldService.release(holdId!, userId, manager);

        this.logger.log(`Legal hold released: id=${holdId}, by=${userId}`);
      }

      // Log to compliance audit within the same transaction.
      // BEFORE: auditService.log() used its own repo — outside this transaction.
      // Passing manager makes the audit entry part of the atomic hold+audit+outbox unit.
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
      }, manager);

      // Publish outbox event within the transaction
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('LegalHoldToggled', tenantId),
        holdId: hold.id,
        channelId: hold.channelId,
        activate,
        reason: hold.reason,
        toggledBy: userId,
        toggledAt: new Date().toISOString(),
      },  manager);

      return hold;
    });
  }
}
