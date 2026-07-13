import * as crypto from 'crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
} from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { AuthenticationService } from '../services/authentication.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

/**
 * validateToken type-discipline — SEC-MEDIUM-004 regression guard.
 *
 * validateToken is a bearer-token introspection surface. Without an
 * access-token-type check it returns valid:true (plus role/tenantId) for a
 * REFRESH or MFA-challenge token — a token-introspection oracle. These tests
 * pin that only type='access' tokens validate, and that verification uses the
 * RS256 + issuer + audience options (not a bare verifyAsync).
 */
describe('AuthenticationService.validateToken (SEC-MEDIUM-004)', () => {
  let service: AuthenticationService;

  const ISSUER = 'aquaculture-platform';
  const AUDIENCE = 'aquaculture-platform';
  const keypair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // A REAL JwtService signs/verifies with the RS256 keypair so the production
  // getJwtVerifyOptions path (algorithm/issuer/audience enforcement) runs.
  const jwtService = new JwtService({
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    signOptions: { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: '15m' },
  });

  const config: Record<string, unknown> = {
    JWT_PUBLIC_KEY: keypair.publicKey,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    NODE_ENV: 'production',
    HASH_REFRESH_TOKENS: true,
  };
  // Real ConfigService over the test config object — type-safe, no cast.
  const mockConfigService = new ConfigService(config);

  const mockTokenBlacklist = {
    add: jest.fn(),
    isBlacklisted: jest.fn().mockResolvedValue(false),
    isUserBlacklisted: jest.fn().mockResolvedValue(false),
  };

  const signToken = (type: string): string =>
    jwtService.sign({ sub: 'user-1', role: 'MODULE_USER', tenantId: 'tenant-1', type, jti: 'jti-1' });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(RefreshToken), useValue: { update: jest.fn() } },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: getRepositoryToken(ActionToken), useValue: {} },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Tenant), useValue: {} },
        { provide: getRepositoryToken(WebAuthnCredential), useValue: { count: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn(), query: jest.fn() } },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: { publish: jest.fn() } },
        {
          provide: BestEffortEventPublisher,
          useValue: new BestEffortEventPublisher({ publish: jest.fn() }),
        },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
        { provide: MfaService, useValue: {} },
        { provide: TimingSafeService, useValue: { ensureMinDuration: jest.fn() } },
        { provide: SESSION_MANAGER, useValue: { revokeAllSessions: jest.fn() } },
        { provide: TOKEN_BLACKLIST, useValue: mockTokenBlacklist },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_op: string, cb: () => Promise<T> | T): Promise<T> => cb(),
            withBypassSync: <T>(_op: string, cb: () => T): T => cb(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
  });

  it('validates a genuine access token', async () => {
    const result = await service.validateToken(signToken('access'));
    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe('user-1');
  });

  it('REJECTS a refresh token presented to the introspection surface', async () => {
    const result = await service.validateToken(signToken('refresh'));
    expect(result.valid).toBe(false);
    expect(result.payload).toBeUndefined();
  });

  it('REJECTS an MFA-challenge token presented as an access token', async () => {
    const result = await service.validateToken(signToken('mfa'));
    expect(result.valid).toBe(false);
  });

  it('rejects a token signed by the WRONG key (RS256 verification enforced)', async () => {
    const wrong = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forged = new JwtService({
      privateKey: wrong.privateKey,
      signOptions: { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: '15m' },
    }).sign({ sub: 'user-1', type: 'access', jti: 'jti-1' });

    const result = await service.validateToken(forged);
    expect(result.valid).toBe(false);
  });

  it('rejects a valid access token once it is blacklisted by jti', async () => {
    mockTokenBlacklist.isBlacklisted.mockResolvedValueOnce(true);
    const result = await service.validateToken(signToken('access'));
    expect(result.valid).toBe(false);
  });
});
