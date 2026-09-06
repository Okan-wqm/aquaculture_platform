/**
 * E-mailed invitation ids and raw tokens use the same canonical resolver for
 * preview and redemption. Completion consumes the action without starting a
 * session; Tenant → User → ActionToken → Invitation locks protect the writes.
 */
import { createHash } from 'node:crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { TOKEN_BLACKLIST, USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { ActionTokenResolver } from '../services/action-token-resolver.service';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_TOKEN_ID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';
const TOKEN_HASH = 'd'.repeat(64);
const RAW_TOKEN = 'e'.repeat(64);

function actionToken(overrides: Partial<ActionToken> = {}): ActionToken {
  return Object.assign(new ActionToken(), {
    id: ACTION_TOKEN_ID,
    purpose: ActionTokenPurpose.INVITATION,
    tenantId: TENANT_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    status: ActionTokenStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return Object.assign(new Invitation(), {
    id: '44444444-4444-4444-8444-444444444444',
    token: TOKEN_HASH,
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: Role.MODULE_USER,
    tenantId: TENANT_ID,
    status: InvitationStatus.PENDING,
    expiresAt: new Date(Date.now() + 60_000),
    sendCount: 1,
    ...overrides,
  });
}

function user(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: USER_ID,
    email: 'ada@example.com',
    role: Role.MODULE_USER,
    tenantId: TENANT_ID,
    isActive: true,
    credentialVersion: 4,
    accessTokenInvalidBeforeEpochSeconds: 0,
    invitationToken: TOKEN_HASH,
    ...overrides,
  });
}

describe('invitation links resolve through ActionTokenResolver (SEC-HIGH-158)', () => {
  let service: AuthenticationService;
  let manager: EntityManager;
  let action: ActionToken | null;
  let row: Invitation | null;
  let principal: User;
  let findOne: jest.SpyInstance;
  let update: jest.SpyInstance;
  let hashRawToken: jest.SpyInstance;
  const tokens = { generateTokens: jest.fn(), generateTokensInContext: jest.fn() };
  const invalidation = { enqueue: jest.fn(), applyImmediately: jest.fn() };
  const outbox = { enqueue: jest.fn() };
  const audit = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    action = actionToken();
    row = invitation();
    principal = user();
    const tenant = Object.assign(new Tenant(), { id: TENANT_ID, status: TenantStatus.ACTIVE });
    const source = new DataSource({ type: 'postgres' });
    const runner = source.createQueryRunner();
    jest.replaceProperty(runner, 'isTransactionActive', true);
    manager = runner.manager;
    findOne = jest.spyOn(manager, 'findOne').mockImplementation(async (entity) => {
      if (entity === ActionToken) return action;
      if (entity === Invitation) return row;
      if (entity === User) return principal;
      if (entity === Tenant) return tenant;
      throw new Error('Unexpected invitation lookup');
    });
    update = jest.spyOn(manager, 'update').mockImplementation(async (entity, _criteria, values) => {
      if (entity === ActionToken && action) Object.assign(action, values);
      if (entity === Invitation && row) Object.assign(row, values);
      if (entity === User) Object.assign(principal, values);
      return { affected: 1, raw: [], generatedMaps: [] };
    });
    const resolver = new ActionTokenResolver();
    hashRawToken = jest.spyOn(resolver, 'hashRawToken');
    const module = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: ActionTokenResolver, useValue: resolver },
        ...[User, RefreshToken, Invitation, ActionToken, Tenant, WebAuthnCredential].map((entity) => ({
          provide: getRepositoryToken(entity),
          useValue: {},
        })),
        {
          provide: DataSource,
          useValue: {
            manager,
            transaction: jest.fn(async (operation: (active: EntityManager) => Promise<unknown>) =>
              operation(manager),
            ),
          },
        },
        { provide: JwtService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback?: unknown): unknown => fallback },
        },
        { provide: BestEffortEventPublisher, useValue: { publish: jest.fn() } },
        { provide: OutboxPublisher, useValue: outbox },
        { provide: AuditLogService, useValue: audit },
        { provide: TokenService, useValue: tokens },
        { provide: DurableAccessTokenInvalidationService, useValue: {} },
        { provide: DurableUserTokenInvalidationService, useValue: invalidation },
        { provide: MfaService, useValue: { isMfaAvailable: () => false } },
        { provide: TOKEN_BLACKLIST, useValue: {} },
        { provide: USER_TOKEN_REVOCATION, useValue: {} },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_reason: string, operation: () => Promise<T>): Promise<T> =>
              operation(),
          },
        },
      ],
    }).compile();
    service = module.get(AuthenticationService);
  });

  function expectNoCompletion(): void {
    expect(update).not.toHaveBeenCalled();
    expect(invalidation.enqueue).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(tokens.generateTokens).not.toHaveBeenCalled();
    expect(tokens.generateTokensInContext).not.toHaveBeenCalled();
  }

  describe('validateInvitation', () => {
    it('accepts the actionToken.id segment the e-mail carries without hashing the id or locking rows', async () => {
      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: true,
        email: 'ada@example.com',
        role: Role.MODULE_USER,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(findOne.mock.calls).toEqual([
        [ActionToken, { where: { id: ACTION_TOKEN_ID, purpose: ActionTokenPurpose.INVITATION } }],
        [Invitation, { where: { token: TOKEN_HASH } }],
      ]);
      expect(hashRawToken).not.toHaveBeenCalled();
      expectNoCompletion();
    });

    it('reports expired for an expired active action token without reading the invitation', async () => {
      action = actionToken({ expiresAt: new Date(Date.now() - 1_000) });
      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: false,
        expired: true,
      });
      expect(findOne).toHaveBeenCalledTimes(1);
      expect(hashRawToken).not.toHaveBeenCalled();
      expectNoCompletion();
    });

    it.each([ActionTokenStatus.CONSUMED, ActionTokenStatus.REVOKED, ActionTokenStatus.EXPIRED])(
      'rejects a %s action token without reading an invitation or falling back to a hash',
      async (status) => {
        action = actionToken({ status });
        await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
          valid: false,
          expired: false,
        });
        expect(findOne).toHaveBeenCalledTimes(1);
        expect(hashRawToken).not.toHaveBeenCalled();
        expectNoCompletion();
      },
    );

    it('accepts a RESENT invitation through the same canBeAccepted gate as redemption', async () => {
      row = invitation({ status: InvitationStatus.RESENT });
      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toMatchObject({ valid: true });
    });

    it('reports an expired invitation row as expired', async () => {
      row = invitation({ expiresAt: new Date(Date.now() - 1_000) });
      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: false,
        expired: true,
      });
      expectNoCompletion();
    });

    it('rejects a plaintext token without touching the database', async () => {
      await expect(service.validateInvitation('plaintext-invite-token')).resolves.toEqual({ valid: false });
      await expect(service.acceptInvitation('plaintext-invite-token', 'NewPass123!'))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(findOne).not.toHaveBeenCalled();
      expect(hashRawToken).not.toHaveBeenCalled();
      expectNoCompletion();
    });

    it('honours a raw 64-hex token from a pre-deploy e-mail using its SHA-256 hash (SEC-LOW-160)', async () => {
      const storedHash = createHash('sha256').update(RAW_TOKEN).digest('hex');
      action = null;
      row = invitation({ token: storedHash });
      principal = user({ invitationToken: storedHash });
      await expect(service.validateInvitation(RAW_TOKEN)).resolves.toMatchObject({ valid: true });
      expect(findOne.mock.calls).toEqual([[Invitation, { where: { token: storedHash } }]]);
      await expect(service.acceptInvitation(RAW_TOKEN, 'NewPass123!')).resolves.toEqual({
        success: true,
        loginRequired: true,
      });
      expect(hashRawToken).toHaveBeenCalledWith(RAW_TOKEN);
      expect(findOne.mock.calls.filter(([entity]) => entity === ActionToken)).toEqual([]);
      expect(update.mock.calls.filter(([entity]) => entity === ActionToken)).toEqual([]);
      expect(tokens.generateTokens).not.toHaveBeenCalled();
      expect(tokens.generateTokensInContext).not.toHaveBeenCalled();
    });

    it('never hashes an unknown UUID even when an invitation has the hash of that UUID', async () => {
      action = null;
      row = invitation({ token: createHash('sha256').update(ACTION_TOKEN_ID).digest('hex') });
      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({ valid: false });
      await expect(service.acceptInvitation(ACTION_TOKEN_ID, 'NewPass123!'))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(findOne.mock.calls.every(([entity]) => entity === ActionToken)).toBe(true);
      expect(hashRawToken).not.toHaveBeenCalled();
      expectNoCompletion();
    });
  });

  describe('acceptInvitation agrees with validateInvitation on every fixture', () => {
    const fixtures: ReadonlyArray<{
      readonly name: string;
      readonly token: () => ActionToken | null;
      readonly row: () => Invitation | null;
      readonly accepts: boolean;
    }> = [
      { name: 'active token + pending invitation', token: actionToken, row: invitation, accepts: true },
      { name: 'active token + resent invitation', token: actionToken,
        row: () => invitation({ status: InvitationStatus.RESENT }), accepts: true },
      { name: 'expired active token',
        token: () => actionToken({ expiresAt: new Date(Date.now() - 1_000) }), row: invitation, accepts: false },
      ...[ActionTokenStatus.CONSUMED, ActionTokenStatus.REVOKED, ActionTokenStatus.EXPIRED].map((status) => ({
        name: `${status} token`, token: (): ActionToken => actionToken({ status }), row: invitation, accepts: false,
      })),
      { name: 'accepted invitation', token: actionToken,
        row: () => invitation({ status: InvitationStatus.ACCEPTED }), accepts: false },
      { name: 'expired invitation', token: actionToken,
        row: () => invitation({ expiresAt: new Date(Date.now() - 1_000) }), accepts: false },
      { name: 'unknown action token id', token: () => null, row: () => null, accepts: false },
    ];

    it.each(fixtures)('$name', async ({ token, row: buildInvitation, accepts }) => {
      action = token();
      row = buildInvitation();
      const validation = await service.validateInvitation(ACTION_TOKEN_ID);
      expect(validation.valid).toBe(accepts);
      const acceptance = service.acceptInvitation(ACTION_TOKEN_ID, 'NewPass123!', 'Ada', 'Lovelace');
      if (accepts) {
        await expect(acceptance).resolves.toEqual({ success: true, loginRequired: true });
        expect(tokens.generateTokens).not.toHaveBeenCalled();
        expect(tokens.generateTokensInContext).not.toHaveBeenCalled();
        expect(invalidation.enqueue).toHaveBeenCalledTimes(1);
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      } else {
        await expect(acceptance).rejects.toBeInstanceOf(BadRequestException);
        expectNoCompletion();
      }
      expect(hashRawToken).not.toHaveBeenCalled();
    });

    it('locks Tenant then User before locking and consuming the action and invitation', async () => {
      await expect(service.acceptInvitation(ACTION_TOKEN_ID, 'NewPass123!'))
        .resolves.toEqual({ success: true, loginRequired: true });
      expect(findOne).toHaveBeenCalledWith(User, { where: { invitationToken: TOKEN_HASH } });
      expect(findOne.mock.calls.filter(([, options]) => 'lock' in options)).toEqual([
        [Tenant, { where: { id: TENANT_ID }, lock: { mode: 'pessimistic_read' } }],
        [User, { where: { id: USER_ID }, lock: { mode: 'pessimistic_write' } }],
        [ActionToken, { where: { id: ACTION_TOKEN_ID, purpose: ActionTokenPurpose.INVITATION },
          lock: { mode: 'pessimistic_write' } }],
        [Invitation, { where: { token: TOKEN_HASH }, lock: { mode: 'pessimistic_write' } }],
      ]);
      expect(update).toHaveBeenCalledWith(ActionToken, { id: ACTION_TOKEN_ID }, {
        status: ActionTokenStatus.CONSUMED,
        consumedAt: expect.any(Date),
      });
      expect(action).toMatchObject({ status: ActionTokenStatus.CONSUMED });
      expect(row).toMatchObject({ status: InvitationStatus.ACCEPTED, userId: USER_ID });
      expect(principal).toMatchObject({ invitationToken: null, isEmailVerified: true });
      expect(invalidation.enqueue).toHaveBeenCalledWith(manager, expect.objectContaining({ userId: USER_ID }));
      expect(invalidation.applyImmediately).not.toHaveBeenCalled();
      expect(tokens.generateTokens).not.toHaveBeenCalled();
      expect(tokens.generateTokensInContext).not.toHaveBeenCalled();
    });
  });
});
