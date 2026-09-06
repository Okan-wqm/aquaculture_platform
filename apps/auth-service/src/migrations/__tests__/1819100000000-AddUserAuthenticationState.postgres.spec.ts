import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { hashPassword } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource, FindOneOptions, QueryRunner } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';

import { AuditLogService } from '../../audit/audit-log.service';
import { WebAuthnCredential } from '../../modules/authentication/entities/webauthn-credential.entity';
import { WebAuthnService } from '../../modules/authentication/services/webauthn.service';
import { TokenService, OriginatingAccessSession } from '../../modules/authentication/services/token.service';
import { WebAuthnRegisterCredentialInput, WebAuthnVerifyLoginInput } from '../../modules/authentication/dto/webauthn.dto';

import { Tenant } from '../../modules/tenant/entities/tenant.entity';
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
    // Non-superuser auth connection: identity tables remain cross-tenant; no synchronize-created schema.
    await harness.dataSource.query(`CREATE ROLE auth_service LOGIN PASSWORD 'auth-contract-test-only' NOSUPERUSER NOBYPASSRLS`);
    await harness.dataSource.query('GRANT USAGE ON SCHEMA auth TO auth_service');
    await harness.dataSource.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_service');
    await harness.dataSource.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO auth_service');
    orm = new DataSource({ type: 'postgres', ...harness.connectionOptions,
      username: 'auth_service', password: 'auth-contract-test-only', schema: 'auth',
      entities: [User, Tenant, RefreshToken, WebAuthnCredential], synchronize: false });
    await orm.initialize();
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
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await migrator.query<Array<{ blocked: boolean }>>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [pid]);
      if (rows[0]?.blocked) return;
    }
    throw new Error('The competing authentication transaction never waited for the User lock');
  }

  async function webAuthnServiceFor(user: User, challenge: string,
    type: 'registration' | 'authentication',
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
      { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: TokenService, useValue: {
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

  it.each(['registration', 'authentication'] as const)(
    'reset serializes against a verified WebAuthn %s and rejects the old proof', async (ceremony) => {
      const user = await newUser();
      const credential = Object.assign(new WebAuthnCredential(), { id: randomUUID(), userId: user.id,
        credentialId: randomUUID(), publicKey: Buffer.from([1, 2, 3]).toString('base64url'), counter: 3,
        deviceName: 'Contract authenticator' });
      await orm.manager.insert(WebAuthnCredential, credential);
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
    await orm.manager.insert(WebAuthnCredential, credential);
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
