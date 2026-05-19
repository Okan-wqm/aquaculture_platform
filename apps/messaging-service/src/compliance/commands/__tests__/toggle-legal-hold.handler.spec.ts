import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ToggleLegalHoldHandler } from '../toggle-legal-hold.handler';
import { ToggleLegalHoldCommand } from '../toggle-legal-hold.command';
import { LegalHoldService } from '../../services/legal-hold.service';
import { ComplianceAuditService } from '../../services/compliance-audit.service';
import { OutboxPublisher } from '@platform/outbox';
import {
  createMockDataSource,
  createMockQueryRunner,
  fakeUuid,
  resetUuidCounter,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LONG_REASON =
  'Regulatory investigation under SEC matter 24-C-19821 ' +
  'concerning historical messaging records preservation';
const LONG_RELEASE_REASON =
  'Matter SEC 24-C-19821 closed by court order dated 2026-04-29; ' +
  'no further preservation obligation per outside counsel.';

/**
 * LEGAL-MEDIUM-002 — dual-approver protocol enforcement at the
 * command-handler boundary. The service layer pins the same invariants
 * (tested in legal-hold.service.spec.ts) but the handler is the FIRST
 * line of defense the resolver hits, so its rejection must be a
 * BadRequestException (HTTP 400) — not a ForbiddenException leaked from
 * deep inside the transaction.
 */
describe('ToggleLegalHoldHandler — LEGAL-MEDIUM-002 boundary checks', () => {
  let handler: ToggleLegalHoldHandler;
  let legalHoldService: { activate: jest.Mock; release: jest.Mock };
  let auditService: { log: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let queryRunner: MockQueryRunner;

  const userId = fakeUuid('usr');
  const approverId = fakeUuid('usr');
  const holdId = fakeUuid('lh');

  beforeEach(async () => {
    resetUuidCounter();

    legalHoldService = {
      activate: jest.fn(),
      release: jest.fn(),
    };
    auditService = { log: jest.fn() };
    outboxPublisher = { enqueue: jest.fn() };
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToggleLegalHoldHandler,
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: ComplianceAuditService, useValue: auditService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    handler = module.get(ToggleLegalHoldHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('release without approverId is rejected at the handler boundary', async () => {
    const cmd = new ToggleLegalHoldCommand(
      TENANT_A, userId,
      false, // release
      holdId, null, null, null, null, null, null,
      null, // approverId missing
      LONG_RELEASE_REASON,
    );

    await expect(handler.execute(cmd)).rejects.toBeInstanceOf(BadRequestException);
    expect(legalHoldService.release).not.toHaveBeenCalled();
  });

  it('release with self-approval (releaser === approver) is rejected', async () => {
    const cmd = new ToggleLegalHoldCommand(
      TENANT_A, userId,
      false,
      holdId, null, null, null, null, null, null,
      userId, // self-approval
      LONG_RELEASE_REASON,
    );

    await expect(handler.execute(cmd)).rejects.toBeInstanceOf(BadRequestException);
    expect(legalHoldService.release).not.toHaveBeenCalled();
  });

  it('release without releaseReason is rejected', async () => {
    const cmd = new ToggleLegalHoldCommand(
      TENANT_A, userId,
      false,
      holdId, null, null, null, null, null, null,
      approverId,
      null, // missing reason
    );

    await expect(handler.execute(cmd)).rejects.toBeInstanceOf(BadRequestException);
    expect(legalHoldService.release).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // LEGAL-MEDIUM-004 — advisory lock acquisition inside the transaction
  // -----------------------------------------------------------------------
  it('activate pins the tenant transaction before acquiring the advisory lock', async () => {
    legalHoldService.activate.mockResolvedValue({
      id: fakeUuid('lh'),
      tenantId: TENANT_A,
      channelId: null,
      reason: LONG_REASON,
      isActive: true,
    });

    const cmd = new ToggleLegalHoldCommand(
      TENANT_A, userId,
      true, // activate
      null, null,
      LONG_REASON,
      fakeUuid('lm'),
      null, null, null,
    );

    await handler.execute(cmd);

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining(`set_config('search_path'`),
      [expect.stringContaining('"tenant_aaaaaaaaaaaa4aaa"')],
    );
    // The transaction's manager should have run pg_advisory_xact_lock before
    // legalHoldService.activate fired. The mock callback receives
    // queryRunner.manager — that's where the advisory-lock SELECT lands.
    const lockCalls = queryRunner.manager.query.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls.length).toBe(1);
  });

  it('release with all dual-approver fields populated reaches the service', async () => {
    legalHoldService.release.mockResolvedValue({
      id: holdId,
      tenantId: TENANT_A,
      channelId: null,
      reason: LONG_REASON,
      isActive: false,
      releasedBy: userId,
      releasedByApprover: approverId,
      releaseReason: LONG_RELEASE_REASON,
      releasedAt: new Date(),
    });

    const cmd = new ToggleLegalHoldCommand(
      TENANT_A, userId,
      false,
      holdId, null, null, null, null, null, null,
      approverId,
      LONG_RELEASE_REASON,
    );

    await handler.execute(cmd);

    expect(legalHoldService.release).toHaveBeenCalledWith(
      holdId, TENANT_A, userId, approverId, LONG_RELEASE_REASON, expect.anything(),
    );
  });
});
