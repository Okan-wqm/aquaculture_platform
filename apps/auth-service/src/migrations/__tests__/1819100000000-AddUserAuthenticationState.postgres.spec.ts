import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { hashPassword } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { stub } from '@platform/testing';
import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource, EntityManager, FindOneOptions, QueryRunner, Repository, ObjectLiteral } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { applyTenantRlsToSchema, applyInfrastructureLedgerRls, getInfrastructureAuditLedgers, createRlsConnectionBootstrap, BypassRlsService } from '@aquaculture/backend-common/database';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { TOKEN_BLACKLIST, USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';

import { SCHEMA_REGISTRY } from '../../../../db-migrate/src/schema-registry';
import { AuditLog } from '../../audit/audit-log.entity';
import { AuthOutbox } from '../../outbox/auth-outbox.entity';
import { BestEffortEventPublisher } from '../../outbox/best-effort-event-publisher';
import { AuthenticationService } from '../../modules/authentication/services/authentication.service';
import { ActionTokenResolver } from '../../modules/authentication/services/action-token-resolver.service';
import { InternalAuthController } from '../../modules/authentication/controllers/internal-auth.controller';
import { AccountService } from '../../modules/authentication/services/account.service';
import { MfaService } from '../../modules/authentication/services/mfa.service';
import { DurableAccessTokenInvalidationService } from '../../modules/authentication/services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../../modules/authentication/services/durable-user-token-invalidation.service';
import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../../modules/authentication/entities/action-token.entity';
import { Invitation } from '../../modules/authentication/entities/invitation.entity';
import { UserModuleAssignment } from '../../modules/authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../modules/authentication/entities/user-site-assignment.entity';
import { Module } from '../../modules/system-module/entities/module.entity';
import { MobileUserSettings } from '../../modules/tenant/entities/mobile-user-settings.entity';
import { MobileSettingsService } from '../../modules/tenant/services/mobile-settings.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { WebAuthnCredential } from '../../modules/authentication/entities/webauthn-credential.entity';
import { WebAuthnService } from '../../modules/authentication/services/webauthn.service';
import { TokenService, OriginatingAccessSession, JwtPayload } from '../../modules/authentication/services/token.service';
import { WebAuthnRegisterCredentialInput, WebAuthnVerifyLoginInput } from '../../modules/authentication/dto/webauthn.dto';

import { Tenant, TenantStatus } from '../../modules/tenant/entities/tenant.entity';
import { TenantProvisioningCommandService } from '../../modules/tenant/services/tenant-provisioning-command.service';
import { RefreshToken } from '../../modules/authentication/entities/refresh-token.entity';
import { User } from '../../modules/authentication/entities/user.entity';
import { LockedAuthContext, snapshotCredentialProof } from '../../modules/authentication/services/credential-state';
import { AddUserAuthenticationState1819100000000 } from '../1819100000000-AddUserAuthenticationState';

jest.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: jest.fn(), verifyRegistrationResponse: jest.fn(),
}));

jest.setTimeout(180_000);

// Both paths use the authoritative TypeORM migration ledger, then the actual ORM entities.
describe.each(['fresh', 'populated'] as const)('authentication state: %s database', (path) => {
  let harness: HarnessContext;
  let migrator: DataSource;
  let orm: DataSource;
  const populatedUserId = randomUUID();
  const password = 'Credential-Contract-42!';
  const passwordHashPromise = hashPassword(password);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await harness.dataSource.query('CREATE SCHEMA auth');
    await harness.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    const migrations = readdirSync(join(__dirname, '..'))
      .filter((name) => /^\d.*\.ts$/u.test(name))
      .map((name) => join(__dirname, '..', name));
    migrator = new DataSource({ type: 'postgres', ...harness.connectionOptions, schema: 'auth',
      migrationsTableName: 'migrations', synchronize: false,
      migrations: path === 'populated' ? migrations.filter((name) => !name.includes('1819100000000')) : migrations });
    await migrator.initialize();
    await migrator.runMigrations({ transaction: 'each' });
    if (path === 'populated') {
      await migrator.query(`INSERT INTO auth.users (id,email,password,role,"updatedAt")
        VALUES ($1,$2,$3,'SUPER_ADMIN','2026-09-01 12:00:00.123456+00')`,
        [populatedUserId, 'upgrade@example.test', await passwordHashPromise]);
      await migrator.destroy();
      migrator = new DataSource({ type: 'postgres', ...harness.connectionOptions, schema: 'auth',
        migrationsTableName: 'migrations', synchronize: false, migrations });
      await migrator.initialize();
      await migrator.runMigrations({ transaction: 'each' });
    }
    // Install the production registry's policies with the same db-migrate helpers.
    const authRegistry = SCHEMA_REGISTRY.find((entry) => entry.schema === 'auth');
    const tenantRls = authRegistry?.postMigrationHardening?.tenantRls;
    if (!tenantRls) throw new Error('Auth registry does not declare tenant RLS');
    const rlsOptions = tenantRls === true ? {} : tenantRls;
    const ledgers = getInfrastructureAuditLedgers('auth');
    const hardeningRunner = migrator.createQueryRunner();
    const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      await hardeningRunner.connect();
      await applyTenantRlsToSchema(hardeningRunner, { schemaOverride: 'auth',
        ...rlsOptions, excludeTables: [...(rlsOptions.excludeTables ?? []), ...ledgers] });
      await applyInfrastructureLedgerRls(hardeningRunner, { schema: 'auth', ledgers });
    } finally {
      await hardeningRunner.release();
      if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }
    // Non-superuser auth connection: identity tables remain cross-tenant; no synchronize-created schema.
    await harness.dataSource.query(`CREATE ROLE auth_service LOGIN PASSWORD 'auth-contract-test-only' NOSUPERUSER NOBYPASSRLS`);
    await harness.dataSource.query('GRANT USAGE ON SCHEMA auth TO auth_service');
    await harness.dataSource.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_service');
    await harness.dataSource.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO auth_service');
    orm = new DataSource({ type: 'postgres', ...harness.connectionOptions,
      username: 'auth_service', password: 'auth-contract-test-only', schema: 'auth',
      entities: [User, Tenant, RefreshToken, WebAuthnCredential, UserModuleAssignment,
        UserSiteAssignment, Module, MobileUserSettings, ActionToken, Invitation, AuditLog, AuthOutbox], synchronize: false });
    await orm.initialize();
    const RlsBootstrap = createRlsConnectionBootstrap('auth-service');
    await new RlsBootstrap(orm).onModuleInit();
  });

  beforeEach(() => {
    jest.mocked(verifyRegistrationResponse).mockReset();
    jest.mocked(verifyAuthenticationResponse).mockReset();
  });

  afterAll(async () => {
    if (orm?.isInitialized) await orm.destroy();
    if (migrator?.isInitialized) await migrator.destroy();
    await shutdownHarness(harness);
  });

  async function newUser(): Promise<User> {
    const user = orm.manager.create(User, { email: `${randomUUID()}@example.test`,
      password, role: Role.SUPER_ADMIN, tenantId: null, isActive: true });
    await orm.manager.save(user);
    expect(user.credentialVersion).toBe(1); // INSERT RETURNING hydrates the DB-owned anchor.
    return orm.manager.findOneByOrFail(User, { id: user.id });
  }

  it('records the new migration once and initializes a populated principal without touching hash precision', async () => {
    const rows = await migrator.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM auth.migrations WHERE name = 'AddUserAuthenticationState1819100000000'`);
    expect(rows).toEqual([{ count: '1' }]);
    if (path === 'populated') {
      const user = await orm.manager.findOneByOrFail(User, { id: populatedUserId });
      expect(user.credentialVersion).toBe(1);
      expect(user.accessTokenInvalidBeforeEpochSeconds).toBe(0);
      expect(await user.validatePassword(password)).toBe(true);
    }
  });

  it('ignores client-assigned versions on INSERT and UPDATE; bookkeeping preserves the proof', async () => {
    const user = await newUser();
    expect(user.credentialVersion).toBe(1);
    const proof = snapshotCredentialProof(user);
    await orm.manager.query(`UPDATE auth.users SET "credentialVersion" = 100,
      "lastLoginAt" = CURRENT_TIMESTAMP, "updatedAt" = '2026-09-01 12:00:00.123456+00' WHERE id = $1`, [user.id]);
    await orm.transaction(async (manager) => {
      const context = await LockedAuthContext.lock(manager, proof);
      context.assertSessionAdmission();
      expect(context.user.credentialVersion).toBe(1);
    });
    const rows = await orm.query<Array<{ credentialVersion: number }>>(`INSERT INTO auth.users
      (email,role,"credentialVersion") VALUES ($1,'SUPER_ADMIN',500) RETURNING "credentialVersion"`,
      [`${randomUUID()}@example.test`]);
    expect(rows[0]?.credentialVersion).toBe(1);
  });

  it('rejects an authenticated proof after a concurrent password change', async () => {
    const user = await newUser();
    const proof = snapshotCredentialProof(user);
    await orm.manager.update(User, { id: user.id }, { password: await hashPassword('Changed-Credential-73!') });
    await expect(orm.transaction((manager) => LockedAuthContext.lock(manager, proof))).rejects.toThrow('credentials changed');
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).credentialVersion).toBe(2);
  });

  it('increments once for multiple credential fields and excludes pending MFA bookkeeping', async () => {
    const user = await newUser();
    await orm.manager.update(User, { id: user.id }, { mfaSecret: 'pending', lastUsedTotpStep: '1' });
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).credentialVersion).toBe(1);
    await orm.manager.update(User, { id: user.id }, { mfaEnabled: true, mfaSecret: 'enabled', isActive: false });
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).credentialVersion).toBe(2);
    await orm.manager.update(User, { id: user.id }, { mfaSecret: 'rotated' });
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).credentialVersion).toBe(3);
  });

  it('keeps cutoff monotonic and rolls credential changes back with their transaction', async () => {
    const user = await newUser();
    await orm.manager.update(User, { id: user.id }, { accessTokenInvalidBeforeEpochSeconds: 100 });
    await orm.manager.update(User, { id: user.id }, { accessTokenInvalidBeforeEpochSeconds: 50 });
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).accessTokenInvalidBeforeEpochSeconds).toBe(100);
    await expect(orm.transaction(async (manager) => {
      await LockedAuthContext.lock(manager, user.id);
      await manager.update(User, { id: user.id }, { isActive: false });
      throw new Error('audit failed');
    })).rejects.toThrow('audit failed');
    const current = await orm.manager.findOneByOrFail(User, { id: user.id });
    expect(current.isActive).toBe(true);
    expect(current.credentialVersion).toBe(1);
  });

  async function authenticationStack(hashed: boolean, maxSessions = 3): Promise<{
    authentication: AuthenticationService;
    account: AccountService;
    internal: InternalAuthController;
    outbox: OutboxPublisher;
    tokens: TokenService;
    jwt: JwtService;
    audit: AuditLogService;
    invalidation: DurableUserTokenInvalidationService;
    accessInvalidation: DurableAccessTokenInvalidationService;
    lifecycle: TenantProvisioningCommandService;
    mfa: MfaService;
  }> {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const config = new ConfigService({ HASH_REFRESH_TOKENS: hashed, MIN_LOGIN_DURATION_MS: 0,
      MAX_SESSIONS_PER_USER: maxSessions, FRONTEND_URL: 'https://app.example.test',
      JWT_PRIVATE_KEY: keyPair.privateKey, JWT_PUBLIC_KEY: keyPair.publicKey,
      JWT_KEY_ID: 'authentication-contract', JWT_EXPIRES_IN: '15m', MFA_ENCRYPTION_KEY: '11'.repeat(32),
      JWT_AUDIENCE: 'aquaculture-platform', JWT_ISSUER: 'aquaculture-platform' });
    const jwt = new JwtService({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey,
      signOptions: { algorithm: 'RS256', issuer: 'aquaculture-platform', audience: 'aquaculture-platform' },
      verifyOptions: { algorithms: ['RS256'], audience: 'aquaculture-platform', issuer: 'aquaculture-platform' } });
    const repositories = [User, Tenant, RefreshToken, WebAuthnCredential, UserModuleAssignment,
      UserSiteAssignment, Module, MobileUserSettings, ActionToken, Invitation, AuditLog];
    const module = await Test.createTestingModule({ providers: [
      AuthenticationService, AccountService, InternalAuthController, TokenService, AuditLogService, MobileSettingsService, MfaService, ActionTokenResolver,
      DurableUserTokenInvalidationService, DurableAccessTokenInvalidationService, BypassRlsService, TenantProvisioningCommandService,
      ...repositories.map((entity) => ({ provide: getRepositoryToken(entity), useValue: new Repository<ObjectLiteral>(entity, orm.manager) })),
      { provide: DataSource, useValue: orm }, { provide: ConfigService, useValue: config },
      { provide: JwtService, useValue: jwt },
      { provide: OutboxPublisher, useValue: new OutboxPublisher(AuthOutbox, { allowSystemRouting: true, allowSecurityRecovery: true }) },
      { provide: BestEffortEventPublisher, useValue: new BestEffortEventPublisher({ publish: jest.fn().mockResolvedValue(undefined) }) },
      { provide: TOKEN_BLACKLIST, useValue: { isBlacklisted: jest.fn().mockResolvedValue(false), add: jest.fn() } },
      // Deliberately stale Redis projection: only the durable row knows about a reset.
      { provide: USER_TOKEN_REVOCATION, useValue: { isTokenValid: jest.fn().mockResolvedValue(true), revokeUserTokens: jest.fn() } },
    ] }).compile();
    return { authentication: module.get(AuthenticationService), account: module.get(AccountService),
      internal: module.get(InternalAuthController), outbox: module.get(OutboxPublisher), tokens: module.get(TokenService),
      jwt, audit: module.get(AuditLogService), invalidation: module.get(DurableUserTokenInvalidationService),
      accessInvalidation: module.get(DurableAccessTokenInvalidationService),
      lifecycle: module.get(TenantProvisioningCommandService), mfa: module.get(MfaService) };
  }

  async function principal(role: Role): Promise<User> {
    const tenant = role === Role.SUPER_ADMIN ? null : await orm.manager.save(Tenant,
      orm.manager.create(Tenant, { name: 'Authentication contract', slug: randomUUID(), status: TenantStatus.ACTIVE }));
    const user = await newUser();
    await orm.manager.update(User, { id: user.id }, { role, tenantId: tenant?.id ?? null });
    return orm.manager.findOneByOrFail(User, { id: user.id });
  }

  async function seedResetAction(user: User): Promise<ActionToken> {
    return new BypassRlsService().withBypass('auth-contract:seed-reset', () => orm.transaction(async (manager) => {
      const expiresAt = new Date(Date.now() + 60_000);
      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
      await manager.update(User, { id: user.id }, { passwordResetToken: tokenHash, passwordResetExpires: expiresAt });
      return manager.save(ActionToken, manager.create(ActionToken, { purpose: ActionTokenPurpose.PASSWORD_RESET,
        tenantId: user.tenantId, userId: user.id, tokenHash, expiresAt, status: ActionTokenStatus.ACTIVE }));
    }));
  }

  it.each([
    [Role.TENANT_ADMIN, false], [Role.TENANT_ADMIN, true],
    [Role.SUPER_ADMIN, false], [Role.SUPER_ADMIN, true],
  ] as const)('runs actual %s login, refresh and reset under production RLS (hashed=%s)', async (role, hashed) => {
    const user = await principal(role);
    const { authentication, tokens, jwt, invalidation } = await authenticationStack(hashed);
    const first = await authentication.login({ email: user.email, password });
    const claims = await jwt.verifyAsync<JwtPayload>(first.accessToken);
    expect(claims).toMatchObject({ sub: user.id, tenantId: user.tenantId ?? null, role, type: 'access' });
    expect(claims.iat).toEqual(expect.any(Number));
    expect(claims.exp).toBeGreaterThan(claims.iat ?? 0);
    const rotated = await authentication.refreshToken(first.refreshToken);
    expect((await jwt.verifyAsync<JwtPayload>(rotated.accessToken)).sub).toBe(user.id);
    const historyBeforeReset = await migrator.query<Array<{ familyId: string; isRevoked: boolean }>>(
      'SELECT "familyId", "isRevoked" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(historyBeforeReset).toHaveLength(2);
    expect(new Set(historyBeforeReset.map((row) => row.familyId)).size).toBe(1);
    expect(historyBeforeReset.filter((row) => !row.isRevoked)).toHaveLength(1);
    // Context is cleared on the next pool checkout; no-tenant reads cannot see credentials.
    expect(await orm.manager.count(RefreshToken, { where: { userId: user.id } })).toBe(0);
    const unrelatedTenant = randomUUID();
    expect(await requestContextStorage.run({ tenantId: unrelatedTenant }, () =>
      orm.manager.count(RefreshToken, { where: { userId: user.id } }))).toBe(0);
    if (user.tenantId) {
      expect(await requestContextStorage.run({ tenantId: user.tenantId }, () =>
        orm.manager.count(RefreshToken, { where: { userId: user.id } }))).toBe(2);
    }
    const action = await seedResetAction(user);
    const mint = jest.spyOn(tokens, 'generateTokensInContext');
    const immediate = jest.spyOn(invalidation, 'applyImmediately');
    expect(await authentication.resetPassword(action.id, 'Recovered-Credential-73!'))
      .toEqual({ success: true, loginRequired: true });
    expect(mint).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
    const resetUser = await orm.manager.findOneByOrFail(User, { id: user.id });
    expect(resetUser.credentialVersion).toBe(user.credentialVersion + 1);
    expect(resetUser.accessTokenInvalidBeforeEpochSeconds).toBeGreaterThanOrEqual(claims.iat ?? 0);
    expect(await resetUser.validatePassword(password)).toBe(false);
    expect(await resetUser.validatePassword('Recovered-Credential-73!')).toBe(true);
    const oldHistory = await migrator.query<Array<{ isRevoked: boolean; revokedReason: string }>>(
      'SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(oldHistory).toHaveLength(2);
    expect(oldHistory.every((row) => row.isRevoked && row.revokedReason === 'Password reset')).toBe(true);
    await expect(authentication.refreshToken(first.refreshToken)).rejects.toThrow();
    await expect(authentication.refreshToken(rotated.refreshToken)).rejects.toThrow();
    const fresh = await authentication.login({ email: user.email, password: 'Recovered-Credential-73!' });
    const freshClaims = await jwt.verifyAsync<JwtPayload>(fresh.accessToken);
    expect(freshClaims.iat).toBeGreaterThan(resetUser.accessTokenInvalidBeforeEpochSeconds);
    const events = await orm.manager.find(AuthOutbox, { where: { aggregateId: user.id } });
    expect(events.map((event) => event.eventType).sort())
      .toEqual(['PasswordResetCompleted', 'UserAccessTokenInvalidationRequested']);
    expect(await migrator.query('SELECT action FROM auth.audit_logs WHERE "entityId" = $1 AND action = $2',
      [user.id, 'PASSWORD_RESET_SUCCESS'])).toHaveLength(1);
    mint.mockRestore();
    immediate.mockRestore();
  });

  async function verifiedSession(jwt: JwtService, accessToken: string): Promise<OriginatingAccessSession> {
    const claims = await jwt.verifyAsync<JwtPayload>(accessToken);
    if (!claims.jti || claims.iat === undefined || claims.exp === undefined) {
      throw new Error('Verified access token is missing its session identity');
    }
    return { sub: claims.sub, role: claims.role, tenantId: claims.tenantId,
      jti: claims.jti, iat: claims.iat, exp: claims.exp };
  }

  it.each([Role.TENANT_ADMIN, Role.SUPER_ADMIN])('logs out %s history under authenticated RLS even after account deactivation', async (role) => {
    const user = await principal(role);
    const { authentication, jwt } = await authenticationStack(false);
    const first = await authentication.login({ email: user.email, password });
    const second = await authentication.refreshToken(first.refreshToken);
    const session = await verifiedSession(jwt, second.accessToken);
    await orm.manager.update(User, { id: user.id }, { isActive: false });
    // No caller tenant/bypass frame: the verified session owns its cleanup scope.
    expect(await authentication.logout(session)).toBe(true);
    const history = await migrator.query<Array<{ isRevoked: boolean; revokedReason: string }>>(
      'SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.isRevoked && row.revokedReason === 'User logged out')).toBe(true);
    expect(await orm.manager.find(AuthOutbox, { where: { eventType: 'AccessTokenInvalidationRequested' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ targetJti: session.jti }) })]));
    await expect(authentication.refreshToken(first.refreshToken)).rejects.toThrow();
    await expect(authentication.refreshToken(second.refreshToken)).rejects.toThrow();
    expect(await orm.manager.count(RefreshToken, { where: { userId: user.id } })).toBe(0);
  });

  it('revalidates platform cleanup identity under the User lock before changing history', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { authentication, jwt } = await authenticationStack(false);
    const first = await authentication.login({ email: user.email, password });
    const session = await verifiedSession(jwt, first.accessToken);
    await expect(authentication.logout({ ...session, role: Role.SUPER_ADMIN, tenantId: null })).rejects.toThrow();
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1 AND NOT "isRevoked"', [user.id]))
      .toHaveLength(1);
  });

  it('platform password change revokes full history and persists cutoff under its authenticated credential proof', async () => {
    const user = await principal(Role.SUPER_ADMIN);
    const { authentication, account, jwt } = await authenticationStack(false);
    const first = await authentication.login({ email: user.email, password });
    const second = await authentication.refreshToken(first.refreshToken);
    const claims = await jwt.verifyAsync<JwtPayload>(second.accessToken);
    await expect(account.changeMyPassword(user.id, { currentPassword: password, newPassword: 'Changed-Platform-91!' }))
      .resolves.toMatchObject({ success: true });
    const history = await migrator.query<Array<{ isRevoked: boolean; revokedReason: string }>>(
      'SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.isRevoked && row.revokedReason === 'Password changed')).toBe(true);
    const current = await orm.manager.findOneByOrFail(User, { id: user.id });
    expect(current.accessTokenInvalidBeforeEpochSeconds).toBeGreaterThanOrEqual(claims.iat ?? 0);
    expect(current.credentialVersion).toBe(user.credentialVersion + 1);
    expect(await current.validatePassword('Changed-Platform-91!')).toBe(true);
    await expect(authentication.refreshToken(first.refreshToken)).rejects.toThrow();
    await expect(authentication.refreshToken(second.refreshToken)).rejects.toThrow();
    expect(await migrator.query('SELECT id FROM auth.audit_logs WHERE "entityId" = $1 AND action = $2',
      [user.id, 'PASSWORD_CHANGED'])).toHaveLength(1);
  });

  function notificationRequest(tenantId: string | null): TenantRequest {
    return stub<TenantRequest>({ verifiedIdentity: { serviceName: 'notification-service',
      tenantId: tenantId ?? '', effectiveTenantId: tenantId ?? '', keyId: 'contract',
      audience: 'auth-service', nonce: randomUUID(), version: 'v2' } });
  }

  it.each([Role.TENANT_ADMIN, Role.SUPER_ADMIN])('persists %s recovery and resolves its emailed action under canonical RLS', async (role) => {
    const user = await principal(role);
    const { authentication, internal } = await authenticationStack(false);
    await authentication.initiatePasswordReset(user.email);
    const actions = await migrator.query<Array<{ id: string }>>(
      'SELECT id FROM auth.action_tokens WHERE "userId" = $1 AND status = $2', [user.id, ActionTokenStatus.ACTIVE]);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (!action) throw new Error('Reset request did not persist its action');
    const events = await orm.manager.find(AuthOutbox, { where: { aggregateId: user.id, eventType: 'PasswordResetRequested' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: user.tenantId, payload: {
      tenantId: user.tenantId ?? 'system', userId: user.id, actionTokenId: action.id,
    } });
    // The signed notification identity is already verified at this controller
    // boundary; its tenant/platform binding must establish RLS before checkout.
    await expect(internal.getActionTokenUrl(action.id, notificationRequest(user.tenantId)))
      .resolves.toEqual({ actionUrl: `https://app.example.test/reset-password/${action.id}` });
    await expect(internal.getActionTokenUrl(action.id, notificationRequest(randomUUID()))).rejects.toThrow();
    if (user.tenantId) {
      await expect(internal.getActionTokenUrl(action.id, notificationRequest(null))).rejects.toThrow();
    }
    expect(await orm.manager.count(ActionToken, { where: { userId: user.id } })).toBe(0);
    await expect(authentication.resetPassword(action.id, 'Recovered-Credential-73!'))
      .resolves.toEqual({ success: true, loginRequired: true });
    await expect(internal.getActionTokenUrl(action.id, notificationRequest(user.tenantId))).rejects.toThrow();
  });

  it('rolls back the platform recovery credential when its durable delivery event cannot be appended', async () => {
    const user = await principal(Role.SUPER_ADMIN);
    const { authentication, outbox } = await authenticationStack(false);
    const failure = jest.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('Recovery delivery unavailable'));
    // The public response remains non-enumerating even when persistence fails.
    await authentication.initiatePasswordReset(user.email);
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).passwordResetToken).toBeNull();
    expect(await migrator.query('SELECT id FROM auth.action_tokens WHERE "userId" = $1', [user.id])).toHaveLength(0);
    expect(await orm.manager.find(AuthOutbox, { where: { aggregateId: user.id } })).toHaveLength(0);
    failure.mockRestore();
  });

  it('rolls back the actual refresh INSERT and successful-login bookkeeping when the audit append fails', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { authentication, audit } = await authenticationStack(false);
    const failure = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('audit append unavailable'));
    await expect(authentication.login({ email: user.email, password })).rejects.toThrow('audit append unavailable');
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1', [user.id])).toHaveLength(0);
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).lastLoginAt).toBeNull();
    failure.mockRestore();
  });

  function signal(): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => { throw new Error('Signal was not initialized'); };
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  async function waitForBlockedUserLock(blocker: QueryRunner): Promise<void> {
    const backends: Array<{ pid: number }> = await blocker.query('SELECT pg_backend_pid() AS pid');
    const backend = backends[0];
    if (!backend) throw new Error('Missing blocker backend PID');
    const { pid } = backend;
    // Observe PostgreSQL's actual lock graph, not elapsed wall-clock sleeps.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await migrator.query<Array<{ blocked: boolean }>>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [pid]);
      if (rows[0]?.blocked) return;
    }
    throw new Error('The competing authentication transaction never waited for the identity lock');
  }

  interface TransactionPause {
    ready: Promise<QueryRunner>;
    hold: (manager: EntityManager) => Promise<void>;
    release: () => void;
    restore: () => void;
  }

  function transactionPause(): TransactionPause {
    let identify: (runner: QueryRunner) => void = () => { throw new Error('Pause was not initialized'); };
    const ready = new Promise<QueryRunner>((resolve) => { identify = resolve; });
    const gate = signal();
    return { ready, release: gate.release, restore: () => undefined,
      hold: async (manager) => {
        if (!manager.queryRunner || !manager.queryRunner.isTransactionActive) {
          throw new Error('Pause requires a live transaction manager');
        }
        identify(manager.queryRunner);
        await gate.promise;
      } };
  }

  function pauseAudit(audit: AuditLogService, action: string): TransactionPause {
    const pause = transactionPause();
    const append = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (dto, manager) => {
      const result = await append(dto, manager);
      if (dto.action === action) {
        if (!(manager instanceof EntityManager)) throw new Error('Audit is outside its mutation transaction');
        await pause.hold(manager);
      }
      return result;
    });
    return { ...pause, restore: () => spy.mockRestore() };
  }

  function pauseUserInvalidation(service: DurableUserTokenInvalidationService): TransactionPause {
    const pause = transactionPause();
    const enqueue = service.enqueue.bind(service);
    const spy = jest.spyOn(service, 'enqueue').mockImplementation(async (manager, intent) => {
      await enqueue(manager, intent);
      await pause.hold(manager);
    });
    return { ...pause, restore: () => spy.mockRestore() };
  }

  function pauseAccessInvalidation(service: DurableAccessTokenInvalidationService): TransactionPause {
    const pause = transactionPause();
    const enqueue = service.enqueue.bind(service);
    const spy = jest.spyOn(service, 'enqueue').mockImplementation(async (manager, intent) => {
      await enqueue(manager, intent);
      await pause.hold(manager);
    });
    return { ...pause, restore: () => spy.mockRestore() };
  }

  function observe<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
    return operation.then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason }));
  }

  function valueOf<T>(outcome: PromiseSettledResult<T>): T {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  }

  async function orderedRace<T, U>(
    first: () => Promise<T>, pause: TransactionPause, second: () => Promise<U>,
  ): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
    const leading = observe(first());
    let competing: Promise<PromiseSettledResult<U>> | undefined;
    try {
      const blocker = await Promise.race([pause.ready, leading.then((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        throw new Error('Leading transaction finished before the lock barrier');
      })]);
      competing = observe(second());
      await waitForBlockedUserLock(blocker);
      pause.release();
      return await Promise.all([leading, competing]);
    } finally {
      pause.release();
      await leading;
      if (competing) await competing;
      pause.restore();
    }
  }

  it('a login that wins the User lock commits first and reset terminally revokes its complete family', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const action = await seedResetAction(user);
    const { authentication, audit, jwt } = await authenticationStack(false);
    const [login, reset] = await orderedRace(
      () => authentication.login({ email: user.email, password }), pauseAudit(audit, 'LOGIN_SUCCESS'),
      () => authentication.resetPassword(action.id, 'Reset-Racing-Credential-91!'));
    const issued = valueOf(login);
    expect(valueOf(reset)).toEqual({ success: true, loginRequired: true });
    const claims = await jwt.verifyAsync<JwtPayload>(issued.accessToken);
    const current = await orm.manager.findOneByOrFail(User, { id: user.id });
    expect(current.accessTokenInvalidBeforeEpochSeconds).toBeGreaterThanOrEqual(claims.iat ?? 0);
    expect(await migrator.query('SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]))
      .toEqual([{ isRevoked: true, revokedReason: 'Password reset' }]);
    await expect(authentication.refreshToken(issued.refreshToken)).rejects.toThrow();
  });

  it('a reset that wins the User lock rejects a login authenticated against the old password', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const action = await seedResetAction(user);
    const { authentication, audit } = await authenticationStack(false);
    const [reset, login] = await orderedRace(
      () => authentication.resetPassword(action.id, 'Reset-Racing-Credential-91!'), pauseAudit(audit, 'PASSWORD_RESET_SUCCESS'),
      () => authentication.login({ email: user.email, password }));
    expect(valueOf(reset)).toEqual({ success: true, loginRequired: true });
    expect(login).toEqual({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('credentials changed') }) });
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1', [user.id])).toHaveLength(0);
    expect(await migrator.query('SELECT status FROM auth.action_tokens WHERE id = $1', [action.id]))
      .toEqual([{ status: ActionTokenStatus.CONSUMED }]);
  });

  it('suspension waits for the winning login, retries its serializable snapshot and revokes that committed family', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    if (!user.tenantId) throw new Error('Missing tenant fixture');
    const tenantId = user.tenantId;
    const { authentication, lifecycle, audit, jwt } = await authenticationStack(false);
    const command = { operationId: randomUUID(), tenantId, actor: { id: randomUUID(), type: 'user' as const }, reason: 'Authentication lock contract' };
    const [login, suspension] = await orderedRace(
      () => authentication.login({ email: user.email, password }), pauseAudit(audit, 'LOGIN_SUCCESS'),
      () => lifecycle.suspendTenant(command));
    const issued = valueOf(login);
    expect(valueOf(suspension)).toMatchObject({ status: TenantStatus.SUSPENDED });
    const claims = await jwt.verifyAsync<JwtPayload>(issued.accessToken);
    expect((await orm.manager.findOneByOrFail(User, { id: user.id })).accessTokenInvalidBeforeEpochSeconds)
      .toBeGreaterThanOrEqual(claims.iat ?? 0);
    expect(await migrator.query('SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]))
      .toEqual([{ isRevoked: true, revokedReason: `Tenant ${TenantStatus.SUSPENDED}` }]);
    expect(await migrator.query('SELECT status FROM auth.tenant_command_receipts WHERE "operationId" = $1', [command.operationId]))
      .toEqual([{ status: 'SUCCEEDED' }]);
    await expect(authentication.refreshToken(issued.refreshToken)).rejects.toThrow();
  });

  it('a suspension that wins the Tenant lock prevents a waiting login from minting', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    if (!user.tenantId) throw new Error('Missing tenant fixture');
    const tenantId = user.tenantId;
    const { authentication, lifecycle, invalidation } = await authenticationStack(false);
    const [suspension, login] = await orderedRace(
      () => lifecycle.suspendTenant({ operationId: randomUUID(), tenantId,
        actor: { id: randomUUID(), type: 'user' }, reason: 'Authentication lock contract' }),
      pauseUserInvalidation(invalidation), () => authentication.login({ email: user.email, password }));
    expect(valueOf(suspension)).toMatchObject({ status: TenantStatus.SUSPENDED });
    expect(login).toMatchObject({ status: 'rejected' });
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1', [user.id])).toHaveLength(0);
  });

  it('family admission that wins the User lock is included in the waiting logout terminal update', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { authentication, audit, jwt } = await authenticationStack(false, 1);
    const original = await authentication.login({ email: user.email, password });
    const origin = await verifiedSession(jwt, original.accessToken);
    const [login, logout] = await orderedRace(
      () => authentication.login({ email: user.email, password }), pauseAudit(audit, 'LOGIN_SUCCESS'),
      () => authentication.logout(origin));
    const admitted = valueOf(login);
    expect(valueOf(logout)).toBe(true);
    const history = await migrator.query<Array<{ isRevoked: boolean; revokedReason: string }>>(
      'SELECT "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.isRevoked && row.revokedReason === 'User logged out')).toBe(true);
    await expect(authentication.refreshToken(original.refreshToken)).rejects.toThrow();
    await expect(authentication.refreshToken(admitted.refreshToken)).rejects.toThrow();
  });

  it('logout that wins the User lock closes old history while a later password login establishes one new family', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { authentication, accessInvalidation, jwt } = await authenticationStack(false, 1);
    const original = await authentication.login({ email: user.email, password });
    const origin = await verifiedSession(jwt, original.accessToken);
    const [logout, login] = await orderedRace(() => authentication.logout(origin), pauseAccessInvalidation(accessInvalidation),
      () => authentication.login({ email: user.email, password }));
    expect(valueOf(logout)).toBe(true);
    const admitted = valueOf(login);
    await expect(authentication.refreshToken(original.refreshToken)).rejects.toThrow();
    const history = await migrator.query<Array<{ familyId: string; isRevoked: boolean; revokedReason: string }>>(
      'SELECT "familyId", "isRevoked", "revokedReason" FROM auth.refresh_tokens WHERE "userId" = $1', [user.id]);
    expect(history).toHaveLength(2);
    expect(new Set(history.map((row) => row.familyId)).size).toBe(2);
    expect(history.filter((row) => !row.isRevoked)).toHaveLength(1);
    expect(history.find((row) => row.isRevoked)?.revokedReason).toBe('User logged out');
    await expect(authentication.refreshToken(admitted.refreshToken)).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  async function webAuthnServiceFor(user: User, challenge: string,
    type: 'registration' | 'authentication', tokenService?: TokenService, auditService?: AuditLogService,
  ): Promise<WebAuthnService> {
    const module = await Test.createTestingModule({ providers: [
      WebAuthnService,
      { provide: getRepositoryToken(User), useValue: {
        findOne: (options: FindOneOptions<User>) => orm.manager.findOne(User, options),
      } },
      { provide: getRepositoryToken(Tenant), useValue: {
        findOne: (options: FindOneOptions<Tenant>) => orm.manager.findOne(Tenant, options),
      } },
      { provide: getRepositoryToken(WebAuthnCredential), useValue: {
        findOne: (options: FindOneOptions<WebAuthnCredential>) => orm.manager.findOne(WebAuthnCredential, options),
      } },
      { provide: ConfigService, useValue: new ConfigService({ WEBAUTHN_RP_ID: 'localhost' }) },
      { provide: AuditLogService, useValue: auditService ?? { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: TokenService, useValue: tokenService ?? {
        assertOriginatingSessionInContext: jest.fn().mockResolvedValue(undefined),
        generateTokensInContext: jest.fn().mockRejectedValue(new Error('Stale ceremony reached mint')),
      } },
      { provide: RedisService, useValue: {
        getdel: jest.fn().mockResolvedValueOnce(JSON.stringify({ challenge, userId: user.id, type, createdAt: Date.now() })),
      } },
      { provide: DataSource, useValue: orm },
    ] }).compile();
    return module.get(WebAuthnService);
  }

  it('public MFA proof binds tenant RLS before actual refresh mint', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { authentication, jwt, mfa } = await authenticationStack(false);
    const initial = await authentication.login({ email: user.email, password });
    const claims = await jwt.verifyAsync<JwtPayload>(initial.accessToken);
    if (!claims.jti || claims.iat === undefined || claims.exp === undefined || !user.tenantId) {
      throw new Error('Initial session is incomplete');
    }
    const session: OriginatingAccessSession = { sub: claims.sub, role: claims.role,
      tenantId: claims.tenantId, jti: claims.jti, iat: claims.iat, exp: claims.exp };
    const setup = await requestContextStorage.run({ tenantId: user.tenantId }, () =>
      mfa.setupMfa({ kind: 'session', session }));
    // Enrollment confirmation is exercised through GraphQL in mfa-login.spec.ts.
    // This fixture isolates public challenge admission and the real RLS mint.
    await orm.manager.update(User, user.id, { mfaEnabled: true });
    const challenge = await authentication.login({ email: user.email, password });
    const recoveryCode = setup.recoveryCodes[0];
    if (!challenge.mfaToken || !recoveryCode) throw new Error('Missing MFA challenge fixture');
    const authenticated = await mfa.verifyMfaLogin(challenge.mfaToken, recoveryCode);
    expect(await jwt.verifyAsync<JwtPayload>(authenticated.accessToken))
      .toMatchObject({ sub: user.id, tenantId: user.tenantId, mfaVerified: true });
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1', [user.id])).toHaveLength(2);
    expect(await orm.manager.count(RefreshToken, { where: { userId: user.id } })).toBe(0);
  });

  it('public WebAuthn proof binds tenant RLS before actual refresh mint', async () => {
    const user = await principal(Role.TENANT_ADMIN);
    const { tokens, jwt, audit } = await authenticationStack(false);
    const credentialId = randomUUID();
    await orm.manager.insert(WebAuthnCredential, { userId: user.id, credentialId,
      publicKey: Buffer.from([1, 2, 3]).toString('base64url'), counter: 3, deviceName: 'Contract authenticator' });
    const challenge = randomUUID();
    jest.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({ verified: true, authenticationInfo: {
      credentialID: credentialId, newCounter: 4, userVerified: true, credentialDeviceType: 'singleDevice',
      credentialBackedUp: false, origin: 'http://localhost:5173', rpID: 'localhost',
    } });
    const webAuthn = await webAuthnServiceFor(user, challenge, 'authentication', tokens, audit);
    const result = await webAuthn.verifyLogin({ challenge, credentialId,
      authenticatorData: 'YXV0aA', clientDataJSON: 'e30', signature: 'c2ln' });
    expect(await jwt.verifyAsync<JwtPayload>(result.accessToken))
      .toMatchObject({ sub: user.id, tenantId: user.tenantId, mfaVerified: true });
    expect(await migrator.query('SELECT id FROM auth.refresh_tokens WHERE "userId" = $1', [user.id])).toHaveLength(1);
    expect(await orm.manager.count(RefreshToken, { where: { userId: user.id } })).toBe(0);
  });

  it.each(['registration', 'authentication'] as const)(
    'reset serializes against a verified WebAuthn %s and rejects the old proof', async (ceremony) => {
      const user = await newUser();
      const credential = Object.assign(new WebAuthnCredential(), { id: randomUUID(), userId: user.id,
        credentialId: randomUUID(), publicKey: Buffer.from([1, 2, 3]).toString('base64url'), counter: 3,
        deviceName: 'Contract authenticator' });
      await orm.manager.insert(WebAuthnCredential, { id: credential.id, userId: credential.userId,
        credentialId: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter,
        deviceName: credential.deviceName });
      const challenge = randomUUID();
      const verified = signal();
      const allowVerification = signal();
      jest.mocked(verifyRegistrationResponse).mockImplementationOnce(async () => {
        verified.release();
        await allowVerification.promise;
        return { verified: true, registrationInfo: {
          fmt: 'none', aaguid: '00000000-0000-0000-0000-000000000000',
          credential: { id: randomUUID(), publicKey: new Uint8Array([4, 5, 6]), counter: 0 },
          credentialType: 'public-key', attestationObject: new Uint8Array(), userVerified: true,
          credentialDeviceType: 'singleDevice', credentialBackedUp: false,
          origin: 'http://localhost:5173', rpID: 'localhost',
        } };
      });
      jest.mocked(verifyAuthenticationResponse).mockImplementationOnce(async () => {
        verified.release();
        await allowVerification.promise;
        return { verified: true, authenticationInfo: {
          credentialID: credential.credentialId, newCounter: 4, userVerified: true,
          credentialDeviceType: 'singleDevice', credentialBackedUp: false,
          origin: 'http://localhost:5173', rpID: 'localhost',
        } };
      });
      const service = await webAuthnServiceFor(user, challenge, ceremony);
      const session: OriginatingAccessSession = { sub: user.id, role: user.role, tenantId: null,
        jti: randomUUID(), iat: 1, exp: 4_000_000_000 };
      const registration: WebAuthnRegisterCredentialInput = { challenge, credentialId: randomUUID(),
        currentPassword: password, attestationObject: 'YXR0ZXN0YXRpb24', clientDataJSON: 'e30', publicKeyAlgorithm: -7 };
      const authentication: WebAuthnVerifyLoginInput = { challenge, credentialId: credential.credentialId,
        authenticatorData: 'YXV0aA', clientDataJSON: 'e30', signature: 'c2ln' };
      const attempt = ceremony === 'registration'
        ? service.registerCredential(session, registration) : service.verifyLogin(authentication);
      // Attach rejection handling before releasing any concurrent operation.
      const outcome = attempt.then(() => ({ completed: true }), (error: unknown) => ({ error }));
      const reset = orm.createQueryRunner();
      await reset.connect();
      await reset.startTransaction();
      try {
        await Promise.race([verified.promise, attempt.then(() => { throw new Error('Ceremony completed before verification'); })]);
        await LockedAuthContext.lock(reset.manager, user.id);
        await reset.manager.update(User, user.id, { password: await hashPassword('Reset-Racing-Credential-91!') });
        await reset.manager.delete(WebAuthnCredential, { userId: user.id });
        allowVerification.release();
        await waitForBlockedUserLock(reset);
        await reset.commitTransaction();
        expect(await outcome).toEqual({ error: expect.objectContaining({ message: expect.stringContaining('credentials changed') }) });
        expect(await orm.manager.count(WebAuthnCredential, { where: { userId: user.id } })).toBe(0);
      } finally {
        allowVerification.release();
        if (reset.isTransactionActive) await reset.rollbackTransaction();
        await reset.release();
        await attempt.catch(() => undefined);
      }
    },
  );

  it('a credential removed under the User lock cannot be recreated by a verified login', async () => {
    const user = await newUser();
    const credential = Object.assign(new WebAuthnCredential(), { id: randomUUID(), userId: user.id,
      credentialId: randomUUID(), publicKey: Buffer.from([1, 2, 3]).toString('base64url'), counter: 3,
      deviceName: 'Removed authenticator' });
    await orm.manager.insert(WebAuthnCredential, { id: credential.id, userId: credential.userId,
        credentialId: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter,
        deviceName: credential.deviceName });
    const challenge = randomUUID();
    const verified = signal();
    const allowVerification = signal();
    jest.mocked(verifyAuthenticationResponse).mockImplementationOnce(async () => {
      verified.release();
      await allowVerification.promise;
      return { verified: true, authenticationInfo: { credentialID: credential.credentialId, newCounter: 4,
        userVerified: true, credentialDeviceType: 'singleDevice', credentialBackedUp: false,
        origin: 'http://localhost:5173', rpID: 'localhost' } };
    });
    const service = await webAuthnServiceFor(user, challenge, 'authentication');
    const attempt = service.verifyLogin({ challenge, credentialId: credential.credentialId,
      authenticatorData: 'YXV0aA', clientDataJSON: 'e30', signature: 'c2ln' });
    const outcome = attempt.then(() => ({ completed: true }), (error: unknown) => ({ error }));
    const removal = orm.createQueryRunner();
    await removal.connect();
    await removal.startTransaction();
    try {
      await Promise.race([verified.promise, attempt.then(() => { throw new Error('Ceremony completed before verification'); })]);
      await LockedAuthContext.lock(removal.manager, user.id);
      await removal.manager.delete(WebAuthnCredential, { id: credential.id, userId: user.id });
      allowVerification.release();
      await waitForBlockedUserLock(removal);
      await removal.commitTransaction();
      expect(await outcome).toEqual({ error: expect.objectContaining({ message: expect.stringContaining('Credential changed') }) });
      expect(await orm.manager.count(WebAuthnCredential, { where: { userId: user.id } })).toBe(0);
    } finally {
      allowVerification.release();
      if (removal.isTransactionActive) await removal.rollbackTransaction();
      await removal.release();
      await attempt.catch(() => undefined);
    }
  });

  it('replays without resetting positive versions and rejects an incompatible named constraint', async () => {
    const user = await newUser();
    await orm.manager.update(User, { id: user.id }, { mfaEnabled: true });
    const migration = new AddUserAuthenticationState1819100000000();
    const runner = migrator.createQueryRunner();
    await runner.connect();
    try {
      await migration.up(runner);
      expect((await orm.manager.findOneByOrFail(User, { id: user.id })).credentialVersion).toBe(2);
      await runner.startTransaction();
      await runner.query('ALTER TABLE auth.users DROP CONSTRAINT "CHK_users_credential_version_positive"');
      await runner.query('ALTER TABLE auth.users ADD CONSTRAINT "CHK_users_credential_version_positive" CHECK ("credentialVersion" > -1)');
      await expect(migration.up(runner)).rejects.toThrow('Incompatible');
      await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
  });
});
