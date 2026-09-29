import { verifyPassword } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, Repository } from 'typeorm';

import { AddUserCredentialVersion1819200000000 } from '../../../migrations/1819200000000-AddUserCredentialVersion';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { CredentialProof } from '../services/credential-proof';
import { lockProvenPrincipal } from '../services/token.service';
import { UserAccountStore } from '../services/user-account.store';
import { UserMfaStateStore } from '../services/user-mfa-state.store';
import { advanceCredentialCounter } from '../services/webauthn.service';

jest.setTimeout(180_000);

/**
 * ORPHAN-HIGH-811 / ORPHAN-HIGH-812 / ORPHAN-MEDIUM-814 — the credential
 * issuance contract on a real PostgreSQL, through the real `User` entity
 * mapping, the authoritative credential-version trigger migration, the two
 * column-scoped stores and the exact fence predicate the mint uses.
 *
 * The unit suites double every collaborator; the defects this closes lived in
 * the seams they cannot see: TypeORM does not hydrate a trigger-maintained
 * `update: false` column after a write (811), and `save()` of a stale entity
 * writes every stale column back (812).
 */
describe('credential issuance on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let users: Repository<User>;
  let accounts: UserAccountStore;
  let mfa: UserMfaStateStore;
  let passkeys: Repository<WebAuthnCredential>;
  const previousPepper = process.env['PASSWORD_PEPPER'];
  const previousRounds = process.env['BCRYPT_SALT_ROUNDS'];

  beforeAll(async () => {
    // The peppered format production writes; low cost factor keeps the suite fast.
    process.env['PASSWORD_PEPPER'] = 'credential-issuance-spec-pepper-0123456789abcdef';
    process.env['BCRYPT_SALT_ROUNDS'] = '4';
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await harness.dataSource.query('CREATE SCHEMA IF NOT EXISTS auth');
    dataSource = new DataSource({
      type: 'postgres',
      host: harness.connectionOptions.host,
      port: harness.connectionOptions.port,
      username: harness.connectionOptions.username,
      password: harness.connectionOptions.password,
      database: harness.connectionOptions.database,
      entities: [User, Tenant, WebAuthnCredential],
      // The entity's own table shape; the trigger comes from the migration
      // that owns it in production.
      synchronize: true,
    });
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();
    try {
      await new AddUserCredentialVersion1819200000000().up(queryRunner);
    } finally {
      await queryRunner.release();
    }
    // auth.users is the pre-tenant identity table (login resolves the tenant
    // from it), so the store is bound to it exactly as Nest binds
    // @InjectRepository(User): a plain repository on the connection's manager.
    users = new Repository<User>(User, dataSource.manager);
    accounts = new UserAccountStore(users);
    mfa = new UserMfaStateStore(users);
    passkeys = new Repository<WebAuthnCredential>(WebAuthnCredential, dataSource.manager);
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await shutdownHarness(harness);
    restoreEnv('PASSWORD_PEPPER', previousPepper);
    restoreEnv('BCRYPT_SALT_ROUNDS', previousRounds);
  });

  const requireDataSource = (): DataSource => {
    if (!dataSource) throw new Error('DataSource not initialised');
    return dataSource;
  };

  /** A persisted user through the real entity (BeforeInsert hashes the password). */
  async function persistUser(overrides: Partial<User> = {}): Promise<User> {
    const created = users.create({
      email: `user-${Math.random().toString(36).slice(2)}@credential.test`,
      password: 'Original-Pass-1',
      role: Role.MODULE_USER,
      isActive: true,
      ...overrides,
    });
    const saved = await users.save(created);
    return users.findOneByOrFail({ id: saved.id });
  }

  const reload = (id: string): Promise<User> => users.findOneByOrFail({ id });

  describe('ORPHAN-HIGH-811 — mint after a credential write', () => {
    it('refuses the entity read before a password reset and mints on the proof the reset returned', async () => {
      const beforeReset = await persistUser();
      expect(beforeReset.credentialVersion).toBe(1);

      const proof = await requireDataSource().transaction((manager) =>
        accounts.completePasswordReset(manager, beforeReset.id, 'Reset-Pass-2'),
      );

      // The write's RETURNING observed the trigger's advance …
      expect(proof.credentialVersion).toBe(2);
      expect((await reload(beforeReset.id)).credentialVersion).toBe(2);
      // … and TypeORM did not: the entity the caller holds is still at 1.
      expect(beforeReset.credentialVersion).toBe(1);

      const stale = CredentialProof.ofAuthenticatedPrincipal(beforeReset);
      await requireDataSource().transaction(async (manager) => {
        expect(await lockProvenPrincipal(manager.withRepository(users), stale)).toBeNull();
        const locked = await lockProvenPrincipal(manager.withRepository(users), proof);
        expect(locked?.id).toBe(beforeReset.id);
      });
    });

    it('completes a reset with exactly its columns: hashed password, cleared token, cleared lockout', async () => {
      const user = await persistUser({
        passwordResetToken: 'a'.repeat(64),
        passwordResetExpires: new Date(Date.now() + 3_600_000),
        failedLoginAttempts: 4,
        lockedUntil: new Date(Date.now() + 600_000),
      });

      await requireDataSource().transaction((manager) =>
        accounts.completePasswordReset(manager, user.id, 'Reset-Pass-3'),
      );

      const row = await reload(user.id);
      expect(row.passwordResetToken).toBeNull();
      expect(row.passwordResetExpires).toBeNull();
      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
      expect(row.password?.startsWith('p1:')).toBe(true);
      expect((await verifyPassword('Reset-Pass-3', row.password ?? '')).matched).toBe(true);
    });

    it('completes an invitation: password set, invitation cleared, email verified, proof advanced', async () => {
      const invited = await persistUser({
        password: undefined,
        invitationToken: 'b'.repeat(64),
        invitationExpiresAt: new Date(Date.now() + 86_400_000),
        isEmailVerified: false,
      });

      const proof = await requireDataSource().transaction((manager) =>
        accounts.completeInvitation(manager, invited.id, 'Invite-Pass-1', {
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      );

      const row = await reload(invited.id);
      expect(proof.credentialVersion).toBe(row.credentialVersion);
      expect(row.credentialVersion).toBe(2);
      expect(row.invitationToken).toBeNull();
      expect(row.invitationExpiresAt).toBeNull();
      expect(row.isEmailVerified).toBe(true);
      expect(row.firstName).toBe('Ada');
      expect((await verifyPassword('Invite-Pass-1', row.password ?? '')).matched).toBe(true);
    });
  });

  describe('ORPHAN-HIGH-812 — no stale write-back', () => {
    it('the hazard: save() of a snapshot taken before a password change writes the old hash back', async () => {
      const snapshot = await persistUser();
      await requireDataSource().transaction((manager) =>
        accounts.changePassword(manager, snapshot.id, 'Changed-Pass-4'),
      );

      snapshot.lastLoginAt = new Date();
      await users.save(snapshot);

      // This is what the login/MFA/WebAuthn flows used to do.
      const row = await reload(snapshot.id);
      expect((await verifyPassword('Changed-Pass-4', row.password ?? '')).matched).toBe(false);
    });

    it('the store: sign-in bookkeeping on the same stale id leaves the newer password and version alone', async () => {
      const snapshot = await persistUser({ failedLoginAttempts: 2 });
      await requireDataSource().transaction((manager) =>
        accounts.changePassword(manager, snapshot.id, 'Changed-Pass-5'),
      );

      await requireDataSource().transaction((manager) =>
        accounts.recordSignInCompleted(manager, snapshot.id, '203.0.113.7'),
      );

      const row = await reload(snapshot.id);
      expect((await verifyPassword('Changed-Pass-5', row.password ?? '')).matched).toBe(true);
      expect(row.credentialVersion).toBe(2);
      expect(row.lastLoginAt).toBeInstanceOf(Date);
      expect(row.lastLoginIp).toBe('203.0.113.7');
      expect(row.failedLoginAttempts).toBe(0);
    });

    it('first-factor bookkeeping records the address but not a completed login, and moves no version', async () => {
      const user = await persistUser({ failedLoginAttempts: 3 });

      await accounts.recordFirstFactorVerified(user.id, '198.51.100.4');

      const row = await reload(user.id);
      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lastLoginIp).toBe('198.51.100.4');
      expect(row.lastLoginAt).toBeNull();
      expect(row.credentialVersion).toBe(1);
    });

    it('the legacy-hash upgrade is compare-and-set on the verified version', async () => {
      const user = await persistUser();
      const verified = CredentialProof.ofAuthenticatedPrincipal(user);
      await requireDataSource().transaction((manager) =>
        accounts.changePassword(manager, user.id, 'Concurrent-Pass-6'),
      );

      const lost = await accounts.upgradeLegacyPasswordHash(
        requireDataSource().manager,
        verified,
        'Original-Pass-1',
      );
      expect(lost).toBeNull();
      const afterLost = await reload(user.id);
      expect((await verifyPassword('Concurrent-Pass-6', afterLost.password ?? '')).matched).toBe(
        true,
      );

      const current = CredentialProof.ofAuthenticatedPrincipal(afterLost);
      const upgraded = await accounts.upgradeLegacyPasswordHash(
        requireDataSource().manager,
        current,
        'Concurrent-Pass-6',
      );
      expect(upgraded?.credentialVersion).toBe(current.credentialVersion + 1);
    });
  });

  describe('ORPHAN-MEDIUM-813 — a refused mint commits nothing', () => {
    it('rolls back the sign-in bookkeeping that preceded a fence refusal', async () => {
      const user = await persistUser();
      const authenticated = CredentialProof.ofAuthenticatedPrincipal(user);
      // A password change commits after authentication.
      await requireDataSource().transaction((manager) =>
        accounts.changePassword(manager, user.id, 'Changed-Pass-7'),
      );

      // The sign-in transaction, in the order the flows run it: bookkeeping,
      // then the fence the mint uses. The stale proof is refused and the
      // transaction rolls back.
      await expect(
        requireDataSource().transaction(async (manager) => {
          await accounts.recordSignInCompleted(manager, user.id, '198.51.100.7');
          const principal = await lockProvenPrincipal(manager.withRepository(users), authenticated);
          if (!principal) {
            throw new Error('fence refused');
          }
        }),
      ).rejects.toThrow('fence refused');

      const row = await reload(user.id);
      expect(row.lastLoginAt).toBeNull();
      expect(row.lastLoginIp).toBeNull();
    });

    it('the bookkeeping moves no version, so the principal the mint locks carries this sign-in', async () => {
      const user = await persistUser();
      const proof = CredentialProof.ofAuthenticatedPrincipal(user);

      const locked = await requireDataSource().transaction(async (manager) => {
        await accounts.recordSignInCompleted(manager, user.id, '198.51.100.8');
        return lockProvenPrincipal(manager.withRepository(users), proof);
      });

      expect(locked?.credentialVersion).toBe(proof.credentialVersion);
      expect(locked?.lastLoginAt).toBeInstanceOf(Date);
      expect(locked?.lastLoginIp).toBe('198.51.100.8');
    });
  });

  describe('WebAuthn — a reset revocation survives a concurrent passkey login', () => {
    const registerPasskey = async (userId: string): Promise<WebAuthnCredential> =>
      passkeys.save(
        passkeys.create({
          userId,
          credentialId: `cred-${Math.random().toString(36).slice(2)}`,
          publicKey: 'cHVibGljLWtleQ',
          counter: 3,
          deviceName: 'spec key',
        }),
      );

    it('the counter advance does not resurrect a passkey the reset deleted', async () => {
      const user = await persistUser();
      const passkey = await registerPasskey(user.id);
      // The reset deletes every passkey between the assertion and the mint.
      await passkeys.delete({ userId: user.id });

      const advanced = await requireDataSource().transaction((manager) =>
        advanceCredentialCounter(manager, passkey, 4),
      );

      expect(advanced).toBe(false);
      expect(await passkeys.countBy({ userId: user.id })).toBe(0);
    });

    it('advances exactly once for two logins presenting the same assertion', async () => {
      const user = await persistUser();
      const passkey = await registerPasskey(user.id);

      const outcomes = await Promise.all([
        requireDataSource().transaction((manager) => advanceCredentialCounter(manager, passkey, 4)),
        requireDataSource().transaction((manager) => advanceCredentialCounter(manager, passkey, 4)),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await passkeys.findOneByOrFail({ id: passkey.id })).counter).toBe(4);
    });
  });

  describe('MFA state — database-computed counters and one-time codes', () => {
    it('counts concurrent wrong codes without losing any and locks at the threshold', async () => {
      const user = await persistUser({ mfaEnabled: true, mfaSecret: 'secret' });
      const lockoutUntil = new Date(Date.now() + 15 * 60_000);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => mfa.recordSecondFactorFailure(user.id, 5, lockoutUntil)),
      );

      const counts = results.map((failure) => failure.failedAttempts).sort((a, b) => a - b);
      expect(counts).toEqual([1, 2, 3, 4, 5]);
      const row = await reload(user.id);
      expect(row.mfaFailedAttempts).toBe(5);
      expect(row.mfaLockedUntil?.getTime()).toBe(lockoutUntil.getTime());
    });

    it('lets exactly one of two concurrent requests consume the same recovery code', async () => {
      const stored = 'c'.repeat(64) + ',' + 'd'.repeat(64);
      const user = await persistUser({ mfaEnabled: true, mfaRecoveryCodes: stored });

      const outcomes = await Promise.all([
        mfa.consumeRecoveryCode(user.id, 'c'.repeat(64)),
        mfa.consumeRecoveryCode(user.id, 'c'.repeat(64)),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await reload(user.id)).mfaRecoveryCodes).toBe('d'.repeat(64));
    });

    it('lets two DIFFERENT valid recovery codes used at once both succeed, and the last leaves NULL', async () => {
      const user = await persistUser({
        mfaEnabled: true,
        mfaRecoveryCodes: `${'e'.repeat(64)},${'f'.repeat(64)}`,
      });

      const outcomes = await Promise.all([
        mfa.consumeRecoveryCode(user.id, 'e'.repeat(64)),
        mfa.consumeRecoveryCode(user.id, 'f'.repeat(64)),
      ]);

      expect(outcomes).toEqual([true, true]);
      expect((await reload(user.id)).mfaRecoveryCodes).toBeNull();
      await expect(mfa.consumeRecoveryCode(user.id, 'e'.repeat(64))).resolves.toBe(false);
    });

    it('consumes a TOTP step once: a replay of the same step and an older step are refused', async () => {
      const user = await persistUser({ mfaEnabled: true });

      const outcomes = await Promise.all([
        mfa.consumeTotpStep(user.id, 59_000_010),
        mfa.consumeTotpStep(user.id, 59_000_010),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      await expect(mfa.consumeTotpStep(user.id, 59_000_009)).resolves.toBe(false);
      await expect(mfa.consumeTotpStep(user.id, 59_000_011)).resolves.toBe(true);
    });

    it('refuses to begin enrollment over an enabled factor and to enable one never enrolled', async () => {
      const enabled = await persistUser({ mfaEnabled: true, mfaSecret: 'kept' });
      await expect(mfa.beginEnrollment(enabled.id, 'replacement', 'e'.repeat(64))).rejects.toThrow(
        'MFA is already enabled for this account',
      );
      expect((await reload(enabled.id)).mfaSecret).toBe('kept');

      const bare = await persistUser();
      await expect(mfa.enable(bare.id)).rejects.toThrow('MFA setup has not been initiated');
      expect((await reload(bare.id)).mfaEnabled).toBe(false);
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
