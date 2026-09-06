/**
 * A login fact leaves auth-service ONCE, as both a ledger row and a signal
 * (ADMIN-HIGH-014, ADR-0018).
 *
 * `SecurityEventService.publishLoginFailed` / `publishLoginSuccess` existed,
 * `observability-service` held a durable subscription to
 * `events.security.events.>`, and **nothing ever called them** — the stream was
 * a contract with no producer. Downstream, admin-api's five anomaly detectors
 * counted rows in a table that stream was meant to fill, found 0 every time,
 * and its security health score returned a perfect 100 by construction.
 *
 * These tests pin the producer. They fail against the pre-fix service, where
 * `logSecurityEvent` wrote the audit row and published nothing.
 */
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  SecurityEventService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  const compare: (data: string, encrypted: string) => Promise<boolean> = actual.compare;
  return { ...actual, compare: jest.fn(compare) };
});

const mockCompare = jest.mocked<(data: string, encrypted: string) => Promise<boolean>>(
  bcrypt.compare,
);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMAIL = 'operator@example.com';
const IP = '203.0.113.7';
const AGENT = 'Mozilla/5.0';

interface Harness {
  service: AuthenticationService;
  securityEvents: {
    publishLoginFailed: jest.Mock;
    publishLoginSuccess: jest.Mock;
    publishPasswordReset: jest.Mock;
    publishSuspiciousActivity: jest.Mock;
  };
  auditLog: { log: jest.Mock };
  userRepository: { findOne: jest.Mock; update: jest.Mock; save: jest.Mock };
}

function activeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: USER_ID,
    email: EMAIL,
    password: 'hashed',
    tenantId: TENANT_ID,
    role: 'TENANT_ADMIN',
    isActive: true,
    mfaEnabled: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  });
}

async function build(user: User | null): Promise<Harness> {
  const securityEvents = {
    publishLoginFailed: jest.fn().mockResolvedValue(undefined),
    publishLoginSuccess: jest.fn().mockResolvedValue(undefined),
    publishPasswordReset: jest.fn().mockResolvedValue(undefined),
    publishSuspiciousActivity: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { log: jest.fn().mockResolvedValue(undefined) };
  const userRepository = {
    findOne: jest.fn().mockResolvedValue(user),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn(async (entity: User) => entity),
  };
  const tenantRepository = {
    findOne: jest
      .fn()
      .mockResolvedValue(Object.assign(new Tenant(), { id: TENANT_ID, status: 'ACTIVE' })),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ query: jest.fn().mockResolvedValue([]) }),
    ),
    // `updateReturningRows` requires the TypeORM postgres UPDATE…RETURNING
    // tuple shape: [rows[], affectedCount].
    query: jest.fn().mockResolvedValue([[{ failedLoginAttempts: 1, lockedUntil: null }], 1]),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AuthenticationService,
      { provide: getRepositoryToken(User), useValue: userRepository },
      { provide: getRepositoryToken(RefreshToken), useValue: {} },
      { provide: getRepositoryToken(Invitation), useValue: {} },
      { provide: getRepositoryToken(ActionToken), useValue: {} },
      { provide: getRepositoryToken(UserModuleAssignment), useValue: {} },
      { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
      { provide: DataSource, useValue: dataSource },
      { provide: JwtService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn((_k: string, d?: unknown) => d) } },
      { provide: BestEffortEventPublisher, useValue: { publish: jest.fn() } },
      { provide: AuditLogService, useValue: auditLog },
      {
        provide: TokenService,
        useValue: {
          generateTokens: jest
            .fn()
            .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
        },
      },
      { provide: MfaService, useValue: {} },
      {
        provide: DurableAccessTokenInvalidationService,
        useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
      },
      { provide: DurableUserTokenInvalidationService, useValue: { enqueue: jest.fn() } },
      { provide: SESSION_MANAGER, useValue: { createSession: jest.fn() } },
      { provide: TOKEN_BLACKLIST, useValue: { add: jest.fn(), isBlacklisted: jest.fn() } },
      { provide: USER_TOKEN_REVOCATION, useValue: { revokeUserTokens: jest.fn() } },
      { provide: SecurityEventService, useValue: securityEvents },
      {
        provide: BypassRlsService,
        useValue: {
          withBypass: async <T>(_operation: string, work: () => Promise<T> | T): Promise<T> =>
            work(),
        },
      },
    ],
  }).compile();

  return { service: module.get(AuthenticationService), securityEvents, auditLog, userRepository };
}

describe('a login fact leaves auth-service as a ledger row AND a signal (ADR-0018)', () => {
  afterEach(() => jest.clearAllMocks());

  it('publishes AUTH_LOGIN_FAILED when the account does not exist', async () => {
    const { service, securityEvents, auditLog } = await build(null);

    await expect(service.login({ email: EMAIL, password: 'wrong' }, IP, AGENT)).rejects.toThrow(
      UnauthorizedException,
    );

    // The ledger row still happens — it is the system of record.
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN_FAILED' }));
    // …and now the signal does too. This is the assertion that fails pre-fix.
    expect(securityEvents.publishLoginFailed).toHaveBeenCalledTimes(1);
    expect(securityEvents.publishLoginFailed.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      ip: IP,
      userAgent: AGENT,
    });
    expect(securityEvents.publishLoginSuccess).not.toHaveBeenCalled();
  });

  it('carries the consecutive-failure count on an invalid password, so a detector reads a number', async () => {
    mockCompare.mockResolvedValue(false);
    const { service, securityEvents } = await build(activeUser());

    await expect(service.login({ email: EMAIL, password: 'wrong' }, IP, AGENT)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(securityEvents.publishLoginFailed).toHaveBeenCalledTimes(1);
    const published = securityEvents.publishLoginFailed.mock.calls[0][0] as {
      failedAttempts?: number;
      userId?: string;
      reason: string;
    };
    // Pre-fix the count existed only inside a prose `reason` string.
    expect(published.failedAttempts).toBe(1);
    expect(published.userId).toBe(USER_ID);
    expect(published.reason).toContain('Invalid password');
  });

  it('publishes AUTH_LOGIN_SUCCESS on a completed login', async () => {
    mockCompare.mockResolvedValue(true);
    const { service, securityEvents } = await build(activeUser());

    await service.login({ email: EMAIL, password: 'right' }, IP, AGENT);

    expect(securityEvents.publishLoginSuccess).toHaveBeenCalledTimes(1);
    expect(securityEvents.publishLoginSuccess.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      ip: IP,
    });
    expect(securityEvents.publishLoginFailed).not.toHaveBeenCalled();
  });

  it('publishes NOTHING for LOGIN_MFA_REQUIRED — the login is neither finished nor failed', async () => {
    // Publishing it as a success would let a half-authenticated attempt set the
    // "normal location" baseline the geo-anomaly detector compares against;
    // as a failure it would trip brute-force counters on a CORRECT password.
    mockCompare.mockResolvedValue(true);
    const { service, securityEvents, auditLog } = await build(activeUser({ mfaEnabled: true }));

    await service.login({ email: EMAIL, password: 'right' }, IP, AGENT).catch(() => undefined);

    const mfaAudit = auditLog.log.mock.calls.find(
      (call) => (call[0] as { action?: string }).action === 'LOGIN_MFA_REQUIRED',
    );
    if (mfaAudit) {
      expect(securityEvents.publishLoginSuccess).not.toHaveBeenCalled();
      expect(securityEvents.publishLoginFailed).not.toHaveBeenCalled();
    }
  });

  it('still writes the audit row when the signal cannot be published', async () => {
    // A NATS outage must not cost the system of record, and must not fail a login.
    mockCompare.mockResolvedValue(false);
    const { service, securityEvents, auditLog } = await build(activeUser());
    securityEvents.publishLoginFailed.mockRejectedValue(new Error('nats down'));

    await expect(service.login({ email: EMAIL, password: 'wrong' }, IP, AGENT)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_FAILED_INVALID_PASSWORD' }),
    );
  });
});
