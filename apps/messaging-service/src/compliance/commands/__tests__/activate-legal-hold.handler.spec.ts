import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { validateMessagingEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import {
  createMockDataSource,
  createMockQueryRunner,
  type MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { ActivateLegalHoldCommand } from '../activate-legal-hold.command';
import { ActivateLegalHoldHandler } from '../activate-legal-hold.handler';
import { ComplianceAuditService } from '../../services/compliance-audit.service';
import { LegalHoldService } from '../../services/legal-hold.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('ActivateLegalHoldHandler', () => {
  it('commits hold, audit, and outbox under the same tenant lock', async () => {
    const queryRunner: MockQueryRunner = createMockQueryRunner();
    const hold = {
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: TENANT_ID,
      channelId: null,
      legalMatterId: '33333333-3333-4333-8333-333333333333',
      reason: 'Preservation requirement from external counsel.',
    };
    queryRunner.manager.findOne.mockResolvedValue(null);
    queryRunner.manager.create.mockImplementation((value: Record<string, unknown>) => ({
      ...value,
      id: hold.id,
    }));
    queryRunner.manager.save.mockImplementation((value: Record<string, unknown>) =>
      Promise.resolve(value),
    );
    const legalHoldService = {
      invalidateLegalHoldProjection: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = { log: jest.fn().mockResolvedValue(undefined) };
    const outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        ActivateLegalHoldHandler,
        { provide: DataSource, useValue: createMockDataSource(queryRunner) },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: ComplianceAuditService, useValue: auditService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    await module
      .get(ActivateLegalHoldHandler)
      .execute(
        new ActivateLegalHoldCommand(
          TENANT_ID,
          '44444444-4444-4444-8444-444444444444',
          null,
          hold.reason,
          hold.legalMatterId,
        ),
      );

    expect(queryRunner.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1::bigint)',
      [expect.any(String)],
    );
    expect(queryRunner.manager.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID, isActive: true }),
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        channelId: null,
        reason: hold.reason,
        legalMatterId: hold.legalMatterId,
        startedBy: '44444444-4444-4444-8444-444444444444',
        isActive: true,
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(expect.any(Object), queryRunner.manager);
    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(expect.any(Object), queryRunner.manager);
    expect(legalHoldService.invalidateLegalHoldProjection).toHaveBeenCalledWith(TENANT_ID, null);
    expect(queryRunner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      legalHoldService.invalidateLegalHoldProjection.mock.invocationCallOrder[0]!,
    );
    const emitted = outboxPublisher.enqueue.mock.calls[0]?.[0];
    expect(emitted).toEqual(expect.objectContaining({ channelId: null, activate: true }));
    expect(validateMessagingEvent('LegalHoldToggled', emitted)).toEqual({ valid: true });
  });
});
