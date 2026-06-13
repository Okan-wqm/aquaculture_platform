import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { RefreshToken } from '../../modules/authentication/entities/refresh-token.entity';
import { User } from '../../modules/authentication/entities/user.entity';
import { AuthenticationService } from '../../modules/authentication/services/authentication.service';
import { WebAuthnService } from '../../modules/authentication/services/webauthn.service';
import { GdprComplianceService } from '../gdpr-compliance.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

/**
 * DATA-HIGH-001: the cross-service GDPR-cleanup trigger (UserDeleted) must be
 * DURABLE — enqueued in the same transaction as the auth-layer erasure so the
 * event and the anonymisation commit atomically. These tests pin that the
 * event goes through OutboxPublisher.enqueue with the transaction's manager
 * (never the raw event bus), and carries the erasure payload.
 */
describe('GdprComplianceService — UserDeleted durability (DATA-HIGH-001)', () => {
  let service: GdprComplianceService;
  let manager: { update: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };

  beforeEach(async () => {
    manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) => cb(manager)),
    };
    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GdprComplianceService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: { update: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthenticationService, useValue: { logoutAllDevices: jest.fn() } },
        { provide: WebAuthnService, useValue: { removeAllCredentials: jest.fn() } },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    service = module.get<GdprComplianceService>(GdprComplianceService);
  });

  it('enqueues UserDeleted via the OUTBOX (durable), not the raw event bus', async () => {
    await service.executeErasure(USER_ID, TENANT_ID, ACTOR_ID);
    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues with the transaction manager so the event commits with the erasure', async () => {
    await service.executeErasure(USER_ID, TENANT_ID, ACTOR_ID);
    const [, passedManager] = outboxPublisher.enqueue.mock.calls[0] as [unknown, unknown];
    expect(passedManager).toBe(manager);
  });

  it('carries the canonical UserDeleted erasure payload', async () => {
    await service.executeErasure(USER_ID, TENANT_ID, ACTOR_ID);
    const [event] = outboxPublisher.enqueue.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({
      eventType: 'UserDeleted',
      tenantId: TENANT_ID,
      deletedUserId: USER_ID,
      erasureType: 'gdpr_right_to_erasure',
    });
  });
});
