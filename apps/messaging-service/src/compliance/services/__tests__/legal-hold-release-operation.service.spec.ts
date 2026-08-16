import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { validateMessagingEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import {
  createMockDataSource,
  createMockQueryRunner,
  type MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { ComplianceAuditService } from '../compliance-audit.service';
import {
  LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID,
  LegalHoldReleaseOperationService,
} from '../legal-hold-release-operation.service';
import { LegalHoldService } from '../legal-hold.service';
import type { LegalHoldReleaseOperation } from '../../entities/legal-hold-release-operation.entity';
import type { LegalHold } from '../../entities/legal-hold.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const HOLD_ID = '22222222-2222-4222-8222-222222222222';
const INITIATOR_ID = '33333333-3333-4333-8333-333333333333';
const APPROVER_ID = '44444444-4444-4444-8444-444444444444';
const INIT_REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const AUTH_REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const REASON =
  'External counsel confirmed matter 2026-0042 is closed and the preservation mandate has ended.';

function activeHold(): LegalHold {
  return {
    id: HOLD_ID,
    tenantId: TENANT_ID,
    channelId: null,
    legalMatterId: '88888888-8888-4888-8888-888888888888',
    legalMatterDescription: null,
    reason: 'Preserve records for matter 2026-0042.',
    requestedBy: null,
    startedBy: INITIATOR_ID,
    startedAt: new Date('2026-08-15T00:00:00.000Z'),
    releasedBy: null,
    releasedByApprover: null,
    releaseReason: null,
    releasedAt: null,
    expiresAt: null,
    isActive: true,
  };
}

function pendingOperation(
  overrides: Partial<LegalHoldReleaseOperation> = {},
): LegalHoldReleaseOperation {
  return {
    id: OPERATION_ID,
    tenantId: TENANT_ID,
    holdId: HOLD_ID,
    status: 'PENDING',
    releaseReason: REASON,
    initiationRequestId: INIT_REQUEST_ID,
    initiatedBy: INITIATOR_ID,
    initiatedAt: new Date(),
    initiatorMfaVerifiedAt: new Date(),
    initiatorTokenId: 'init-token',
    expiresAt: new Date(Date.now() + 60_000),
    authorizationRequestId: null,
    authorizedBy: null,
    authorizedAt: null,
    approverMfaVerifiedAt: null,
    approverTokenId: null,
    releasedAt: null,
    expiredAt: null,
    expiredBy: null,
    ...overrides,
  };
}

function actor(actorId: string, tokenId: string) {
  return {
    actorId,
    roles: ['SUPER_ADMIN'],
    mfaVerified: true,
    tokenIssuedAt: new Date().toISOString(),
    tokenId,
  } as const;
}

describe('LegalHoldReleaseOperationService', () => {
  let service: LegalHoldReleaseOperationService;
  let queryRunner: MockQueryRunner;
  let legalHoldService: { invalidateLegalHoldProjection: jest.Mock };
  let auditService: { log: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };

  beforeEach(async () => {
    queryRunner = createMockQueryRunner();
    legalHoldService = { invalidateLegalHoldProjection: jest.fn().mockResolvedValue(undefined) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    queryRunner.manager.create.mockImplementation((value: Partial<LegalHoldReleaseOperation>) => ({
      ...value,
      id: value.id ?? OPERATION_ID,
    }));
    queryRunner.manager.save.mockImplementation((value: LegalHoldReleaseOperation) =>
      Promise.resolve(value),
    );
    queryRunner.manager.query.mockImplementation((statement: string) =>
      Promise.resolve(statement.includes('transaction_timestamp') ? [{ instant: new Date() }] : []),
    );

    const module = await Test.createTestingModule({
      providers: [
        LegalHoldReleaseOperationService,
        { provide: DataSource, useValue: createMockDataSource(queryRunner) },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: ComplianceAuditService, useValue: auditService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();
    service = module.get(LegalHoldReleaseOperationService);
  });

  it('creates a durable pending operation without releasing the hold', async () => {
    queryRunner.manager.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeHold())
      .mockResolvedValueOnce(null);

    const result = await service.request({
      tenantId: TENANT_ID,
      holdId: HOLD_ID,
      requestId: INIT_REQUEST_ID,
      releaseReason: `  ${REASON}  `,
      initiator: actor(INITIATOR_ID, 'init-token'),
    });

    expect(result.status).toBe('PENDING');
    expect(result.releaseReason).toBe(REASON);
    expect(legalHoldService.invalidateLegalHoldProjection).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(queryRunner.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1::bigint)',
      [expect.any(String)],
    );
  });

  it('returns an identical initiation replay without writing twice', async () => {
    const existing = pendingOperation();
    queryRunner.manager.findOne.mockResolvedValueOnce(existing);

    await expect(
      service.request({
        tenantId: TENANT_ID,
        holdId: HOLD_ID,
        requestId: INIT_REQUEST_ID,
        releaseReason: REASON,
        initiator: actor(INITIATOR_ID, 'init-token'),
      }),
    ).resolves.toBe(existing);
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('atomically authorizes with a distinct admin and records evidence', async () => {
    const operation = pendingOperation();
    queryRunner.manager.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(activeHold());

    const result = await service.authorize({
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      requestId: AUTH_REQUEST_ID,
      approver: actor(APPROVER_ID, 'approver-token'),
    });

    expect(result.status).toBe('RELEASED');
    expect(result.authorizedBy).toBe(APPROVER_ID);
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: HOLD_ID,
        isActive: false,
        releasedBy: INITIATOR_ID,
        releasedByApprover: APPROVER_ID,
        releaseReason: REASON,
      }),
    );
    expect(legalHoldService.invalidateLegalHoldProjection).toHaveBeenCalledWith(TENANT_ID, null);
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    const emitted = outboxPublisher.enqueue.mock.calls[0]?.[0];
    expect(emitted).toEqual(
      expect.objectContaining({
        eventType: 'LegalHoldReleased',
        version: 1,
        holdId: HOLD_ID,
        scope: 'tenant',
        resourceId: null,
        releaseOperationId: OPERATION_ID,
        releaseRequestedBy: INITIATOR_ID,
        releaseAuthorizedBy: APPROVER_ID,
        releaseReason: REASON,
      }),
    );
    expect(emitted).not.toHaveProperty('activate');
    expect(emitted).not.toHaveProperty('toggledBy');
    expect(validateMessagingEvent('LegalHoldReleased', emitted)).toEqual({ valid: true });
  });

  it('rejects self-authorization before mutating the hold', async () => {
    queryRunner.manager.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingOperation());

    await expect(
      service.authorize({
        tenantId: TENANT_ID,
        operationId: OPERATION_ID,
        requestId: AUTH_REQUEST_ID,
        approver: actor(INITIATOR_ID, 'second-token-same-user'),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(legalHoldService.invalidateLegalHoldProjection).not.toHaveBeenCalled();
  });

  it('expires a stale operation without releasing the hold', async () => {
    queryRunner.manager.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingOperation({ expiresAt: new Date(Date.now() - 1_000) }));

    const result = await service.authorize({
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      requestId: AUTH_REQUEST_ID,
      approver: actor(APPROVER_ID, 'approver-token'),
    });

    expect(result.status).toBe('EXPIRED');
    expect(result.expiredAt).toBeInstanceOf(Date);
    expect(result.expiredBy).toBe(LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID);
    expect(legalHoldService.invalidateLegalHoldProjection).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });

  it('durably reconciles expired operations before applying a list filter', async () => {
    const stale = pendingOperation({ expiresAt: new Date(Date.now() - 1_000) });
    queryRunner.manager.find.mockResolvedValueOnce([stale]).mockResolvedValueOnce([]);

    await expect(service.list(TENANT_ID, 'PENDING')).resolves.toEqual([]);

    expect(stale.status).toBe('EXPIRED');
    expect(stale.expiredBy).toBe(LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID);
    expect(queryRunner.manager.save).toHaveBeenCalledWith(stale);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'legal_hold_release_expire',
        userId: LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID,
      }),
      queryRunner.manager,
    );
  });

  it('fails closed against the database transaction clock before reading state', async () => {
    await expect(
      service.request({
        tenantId: TENANT_ID,
        holdId: HOLD_ID,
        requestId: INIT_REQUEST_ID,
        releaseReason: REASON,
        initiator: {
          ...actor(INITIATOR_ID, 'stale-token'),
          tokenIssuedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.manager.findOne).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
