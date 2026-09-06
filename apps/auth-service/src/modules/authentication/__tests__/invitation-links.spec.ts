/**
 * Invitation + reset links redeem through ONE resolution (SEC-HIGH-158).
 *
 * The e-mailed link carries `/accept-invitation/{actionToken.id}`. Before
 * this, validateInvitation hashed that segment and looked it up as an
 * invitation token (never matching) while acceptInvitation resolved the
 * ActionToken first — the pre-check that fronts the form rejected every
 * invitation the redemption would have accepted. Both now read through
 * ActionTokenResolver, so these tests assert them against the SAME fixtures.
 */
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
  TimingSafeService,
} from '@aquaculture/backend-common/security';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
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

const resolver = new ActionTokenResolver();

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
    id: 'inv-1',
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
    invitationToken: TOKEN_HASH,
    ...overrides,
  });
}

// Query-builder fake: every chain method returns itself; getOne yields the
// invitation the test primed (or null).
function invitationQueryBuilder(row: Invitation | null): {
  where: jest.Mock;
  andWhere: jest.Mock;
  setLock: jest.Mock;
  getOne: jest.Mock;
} {
  const qb = {
    where: jest.fn(),
    andWhere: jest.fn(),
    setLock: jest.fn(),
    getOne: jest.fn().mockResolvedValue(row),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.setLock.mockReturnValue(qb);
  return qb;
}

const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

describe('invitation links resolve through ActionTokenResolver (SEC-HIGH-158)', () => {
  const actionTokenRepository = { findOne: jest.fn(), save: jest.fn() };
  const invitationRepository = { createQueryBuilder: jest.fn(), findOne: jest.fn() };
  const userRepository = { findOne: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };
  const transactionManager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Invitation) return invitationRepository;
      if (entity === User) return userRepository;
      if (entity === ActionToken) return actionTokenRepository;
      return {};
    }),
    // ActionTokenResolver reads through EntityManager.findOne (pre-tenant flow).
    findOne: jest.fn((_entity: unknown, options: unknown) =>
      actionTokenRepository.findOne(options),
    ),
    save: jest.fn(async (_entity: unknown, value: unknown) => value),
  };
  const dataSource = {
    transaction: jest.fn(
      async <T>(callback: (manager: typeof transactionManager) => Promise<T>): Promise<T> =>
        callback(transactionManager),
    ),
    query: jest.fn(),
  };
  const eventBus = { publish: jest.fn().mockResolvedValue(undefined) };
  const tokenService = {
    generateTokens: jest.fn(async (u: User) => ({ accessToken: 'a', refreshToken: 'r', user: u })),
    getUserModules: jest.fn().mockResolvedValue([]),
  };
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: ActionTokenResolver, useValue: resolver },
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn(), save: jest.fn(), update: jest.fn() },
        },
        { provide: getRepositoryToken(Invitation), useValue: invitationRepository },
        { provide: getRepositoryToken(ActionToken), useValue: actionTokenRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Tenant), useValue: { findOne: jest.fn() } },
        // Password login refuses a password when the account has enrolled
        // WebAuthn credentials, so AuthenticationService injects the repo.
        // Zero credentials keeps this suite on the link-resolution path.
        {
          provide: getRepositoryToken(WebAuthnCredential),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('t') } },
        {
          provide: ConfigService,
          useValue: new ConfigService({ MIN_LOGIN_DURATION_MS: 0, HASH_REFRESH_TOKENS: false }),
        },
        { provide: 'EVENT_BUS', useValue: eventBus },
        { provide: BestEffortEventPublisher, useValue: new BestEffortEventPublisher(eventBus) },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: TokenService, useValue: tokenService },
        {
          provide: DurableAccessTokenInvalidationService,
          useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
        },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
        },
        { provide: MfaService, useValue: { isMfaAvailable: () => false } },
        { provide: TimingSafeService, useValue: { ensureMinDuration: jest.fn() } },
        { provide: SESSION_MANAGER, useValue: { revokeAllSessions: jest.fn() } },
        { provide: TOKEN_BLACKLIST, useValue: { add: jest.fn(), isBlacklisted: jest.fn() } },
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: { revokeUserTokens: jest.fn(), isTokenValid: jest.fn() },
        },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: jest.fn(
              async <T>(_op: string, cb: () => Promise<T> | T): Promise<T> => cb(),
            ),
            withBypassSync: <T>(_op: string, cb: () => T): T => cb(),
          },
        },
      ],
    }).compile();
    service = module.get(AuthenticationService);
  });

  describe('validateInvitation', () => {
    it('accepts the actionToken.id segment the e-mail carries', async () => {
      actionTokenRepository.findOne.mockResolvedValue(actionToken());
      invitationRepository.createQueryBuilder.mockReturnValue(invitationQueryBuilder(invitation()));

      const result = await service.validateInvitation(ACTION_TOKEN_ID);

      expect(result).toEqual({
        valid: true,
        email: 'ada@example.com',
        role: Role.MODULE_USER,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      // The invitation row is looked up by the ActionToken's hash, not by a hash of the id.
      const qb = invitationRepository.createQueryBuilder.mock.results[0]?.value as ReturnType<
        typeof invitationQueryBuilder
      >;
      expect(qb.where).toHaveBeenCalledWith('invitation.token = :tokenHash', {
        tokenHash: TOKEN_HASH,
      });
      expect(qb.setLock).not.toHaveBeenCalled();
    });

    it('reports expired for an expired action token without reading the invitation', async () => {
      actionTokenRepository.findOne.mockResolvedValue(
        actionToken({ expiresAt: new Date(Date.now() - 1_000) }),
      );
      invitationRepository.createQueryBuilder.mockReturnValue(invitationQueryBuilder(invitation()));

      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: false,
        expired: true,
      });
    });

    it('rejects a consumed action token as invalid, not expired', async () => {
      actionTokenRepository.findOne.mockResolvedValue(
        actionToken({ status: ActionTokenStatus.CONSUMED }),
      );
      invitationRepository.createQueryBuilder.mockReturnValue(invitationQueryBuilder(invitation()));

      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: false,
        expired: false,
      });
    });

    it('accepts a RESENT invitation — the same gate acceptInvitation applies (canBeAccepted)', async () => {
      actionTokenRepository.findOne.mockResolvedValue(actionToken());
      invitationRepository.createQueryBuilder.mockReturnValue(
        invitationQueryBuilder(invitation({ status: InvitationStatus.RESENT })),
      );

      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toMatchObject({
        valid: true,
      });
    });

    it('reports an expired invitation row as expired', async () => {
      actionTokenRepository.findOne.mockResolvedValue(actionToken());
      invitationRepository.createQueryBuilder.mockReturnValue(
        invitationQueryBuilder(invitation({ expiresAt: new Date(Date.now() - 1_000) })),
      );

      await expect(service.validateInvitation(ACTION_TOKEN_ID)).resolves.toEqual({
        valid: false,
        expired: true,
      });
    });

    it('rejects a plaintext token without touching the database (no legacy plaintext fallback)', async () => {
      await expect(service.validateInvitation('plaintext-invite-token')).resolves.toEqual({
        valid: false,
      });
      expect(actionTokenRepository.findOne).not.toHaveBeenCalled();
      expect(invitationRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(invitationRepository.findOne).not.toHaveBeenCalled();
    });

    it('still honours a raw 64-hex token from a pre-deploy e-mail (SEC-LOW-160)', async () => {
      invitationRepository.createQueryBuilder.mockReturnValue(
        invitationQueryBuilder(invitation({ token: resolver.hashRawToken(RAW_TOKEN) })),
      );

      await expect(service.validateInvitation(RAW_TOKEN)).resolves.toMatchObject({ valid: true });
      expect(actionTokenRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvitation agrees with validateInvitation on every fixture', () => {
    const fixtures: ReadonlyArray<{
      readonly name: string;
      readonly token: ActionToken | null;
      readonly row: Invitation | null;
      readonly accepts: boolean;
    }> = [
      {
        name: 'active token + pending invitation',
        token: actionToken(),
        row: invitation(),
        accepts: true,
      },
      {
        name: 'active token + resent invitation',
        token: actionToken(),
        row: invitation({ status: InvitationStatus.RESENT }),
        accepts: true,
      },
      {
        name: 'expired token',
        token: actionToken({ expiresAt: new Date(Date.now() - 1_000) }),
        row: invitation(),
        accepts: false,
      },
      {
        name: 'consumed token',
        token: actionToken({ status: ActionTokenStatus.CONSUMED }),
        row: invitation(),
        accepts: false,
      },
      {
        name: 'accepted invitation',
        token: actionToken(),
        row: invitation({ status: InvitationStatus.ACCEPTED }),
        accepts: false,
      },
      { name: 'unknown action token id', token: null, row: null, accepts: false },
    ];

    it.each(fixtures)('$name', async ({ token, row, accepts }) => {
      actionTokenRepository.findOne.mockResolvedValue(token);
      invitationRepository.createQueryBuilder.mockImplementation(() => invitationQueryBuilder(row));
      userRepository.findOne.mockResolvedValue(user());

      const validation = await service.validateInvitation(ACTION_TOKEN_ID);
      const acceptance = service.acceptInvitation(
        ACTION_TOKEN_ID,
        'NewPass123!',
        'Ada',
        'Lovelace',
      );

      expect(validation.valid).toBe(accepts);
      if (accepts) {
        await expect(acceptance).resolves.toMatchObject({ accessToken: 'a' });
      } else {
        await expect(acceptance).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('acceptInvitation locks the invitation row and consumes the action token', async () => {
      const token = actionToken();
      actionTokenRepository.findOne.mockResolvedValue(token);
      const qb = invitationQueryBuilder(invitation());
      invitationRepository.createQueryBuilder.mockReturnValue(qb);
      userRepository.findOne.mockResolvedValue(user());

      await service.acceptInvitation(ACTION_TOKEN_ID, 'NewPass123!');

      expect(transactionManager.findOne).toHaveBeenCalledWith(ActionToken, {
        where: { id: ACTION_TOKEN_ID, purpose: ActionTokenPurpose.INVITATION },
        lock: { mode: 'pessimistic_write' },
      });
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { invitationToken: TOKEN_HASH },
      });
      expect(token.status).toBe(ActionTokenStatus.CONSUMED);
      expect(transactionManager.save).toHaveBeenCalledWith(ActionToken, token);
    });
  });
});
