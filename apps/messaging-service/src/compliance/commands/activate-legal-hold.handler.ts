import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { createBaseEvent, type LegalHoldToggledEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { ComplianceAction } from '../entities/compliance-audit-log.entity';
import { LegalHold } from '../entities/legal-hold.entity';
import { ComplianceAuditService } from '../services/compliance-audit.service';
import { tenantAdvisoryLockKey } from '../services/legal-hold.advisory-lock';
import { LegalHoldService } from '../services/legal-hold.service';
import { ActivateLegalHoldCommand } from './activate-legal-hold.command';

@CommandHandler(ActivateLegalHoldCommand)
export class ActivateLegalHoldHandler
  implements ICommandHandler<ActivateLegalHoldCommand, LegalHold>
{
  private readonly logger = new Logger(ActivateLegalHoldHandler.name);

  constructor(
    private readonly legalHoldService: LegalHoldService,
    private readonly auditService: ComplianceAuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ActivateLegalHoldCommand): Promise<LegalHold> {
    const reason = command.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('A reason is required to activate a legal hold');
    }
    if (!command.legalMatterId) {
      throw new BadRequestException(
        'legalMatterId is required to activate a legal hold (GDPR proportionality)',
      );
    }

    const hold = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      command.tenantId,
      async (queryRunner) => {
        const { manager } = queryRunner;
        await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          tenantAdvisoryLockKey(command.tenantId).toString(),
        ]);

        const holdRepo = tenantManagerRepo(manager, LegalHold, command.tenantId);
        const existing = await holdRepo.findOne({
          where: {
            tenantId: command.tenantId,
            channelId: command.channelId ?? IsNull(),
            isActive: true,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (existing) {
          throw new ConflictException(
            `An active legal hold already exists for this scope (hold ID: ${existing.id})`,
          );
        }
        const hold = await holdRepo.save(
          holdRepo.create({
            tenantId: command.tenantId,
            channelId: command.channelId,
            reason,
            legalMatterId: command.legalMatterId,
            legalMatterDescription: command.legalMatterDescription,
            requestedBy: command.requestedBy,
            expiresAt: command.expiresAt,
            startedBy: command.userId,
            isActive: true,
          }),
        );

        await this.auditService.log(
          {
            tenantId: command.tenantId,
            userId: command.userId,
            action: ComplianceAction.LEGAL_HOLD_ACTIVATE,
            resourceType: 'legal_hold',
            resourceId: hold.id,
            details: {
              activate: true,
              channelId: hold.channelId,
              holdId: hold.id,
              legalMatterId: hold.legalMatterId,
            },
            ipAddress: null,
            userAgent: null,
          },
          manager,
        );

        const event: LegalHoldToggledEvent = {
          ...createBaseEvent<LegalHoldToggledEvent>('LegalHoldToggled', command.tenantId),
          holdId: hold.id,
          channelId: hold.channelId,
          activate: true,
          reason: hold.reason,
          toggledBy: command.userId,
          toggledAt: new Date().toISOString(),
        };
        await this.outboxPublisher.enqueue(event, manager);

        this.logger.log(
          `Legal hold activated: id=${hold.id}, tenant=${command.tenantId}, channel=${command.channelId ?? 'all'}`,
        );
        return hold;
      },
    );

    await this.legalHoldService.invalidateLegalHoldProjection(hold.tenantId, hold.channelId);
    return hold;
  }
}
