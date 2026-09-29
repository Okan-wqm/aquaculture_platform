import { ConflictException } from '@nestjs/common';
import { DataSource, type EntityManager, Repository } from 'typeorm';

import { User } from '../entities/user.entity';
import { CredentialProof } from '../services/credential-proof';
import { UserAccountStore } from '../services/user-account.store';
import { UserMfaStateStore } from '../services/user-mfa-state.store';

/**
 * The column contract of the two stores (ORPHAN-HIGH-811/812): which columns
 * each write names, which predicates guard it, and how RETURNING rows are
 * read. The database semantics (trigger, races) are proven against real
 * Postgres in credential-issuance.postgres.spec.ts.
 */
interface RecordedUpdate {
  entity: unknown;
  set: Record<string, unknown>;
  where: Array<[string, Record<string, unknown> | undefined]>;
  returning: string[] | undefined;
  parameters: Record<string, unknown>;
}

function recordingBuilder(result: { raw?: unknown; affected?: number }): {
  builder: object;
  recorded: RecordedUpdate;
} {
  const recorded: RecordedUpdate = {
    entity: undefined,
    set: {},
    where: [],
    returning: undefined,
    parameters: {},
  };
  const builder = {
    update(entity: unknown) {
      recorded.entity = entity;
      return builder;
    },
    set(columns: Record<string, unknown>) {
      recorded.set = columns;
      return builder;
    },
    where(clause: string, params?: Record<string, unknown>) {
      recorded.where.push([clause, params]);
      return builder;
    },
    andWhere(clause: string, params?: Record<string, unknown>) {
      recorded.where.push([clause, params]);
      return builder;
    },
    returning(columns: string[]) {
      recorded.returning = columns;
      return builder;
    },
    setParameters(parameters: Record<string, unknown>) {
      recorded.parameters = parameters;
      return builder;
    },
    execute: () => Promise.resolve({ raw: result.raw ?? [], affected: result.affected ?? 1 }),
  };
  return { builder, recorded };
}

function harness(result: { raw?: unknown; affected?: number } = {}): {
  manager: EntityManager;
  repository: Repository<User>;
  recorded: RecordedUpdate;
  findOneOrFail: jest.Mock;
} {
  const { builder, recorded } = recordingBuilder(result);
  const findOneOrFail = jest.fn();
  // Real TypeORM objects (no driver connection is opened) with only the query
  // builder entry point replaced — the same no-cast pattern token.service.spec uses.
  const dataSource = new DataSource({ type: 'postgres' });
  const manager = Object.assign(dataSource.manager, { createQueryBuilder: () => builder });
  const repository = Object.assign(new Repository<User>(User, dataSource.manager), {
    createQueryBuilder: () => builder,
    findOneOrFail,
  });
  return { manager, repository, recorded, findOneOrFail };
}

const USER_ID = '5a0e3c2b-7f41-4d8e-9c3a-2b1d0e9f8a77';
const CREDENTIAL_COLUMNS = ['password', 'role', 'tenantId', 'isActive'];

describe('UserAccountStore', () => {
  it('a password reset writes the hashed password and clears exactly the reset + lockout columns', async () => {
    const h = harness({ raw: [{ id: USER_ID, credentialVersion: 4 }] });
    const proof = await new UserAccountStore(h.repository).completePasswordReset(
      h.manager,
      USER_ID,
      'Plain-Reset-1',
    );

    expect(h.recorded.entity).toBe(User);
    expect(Object.keys(h.recorded.set).sort()).toEqual(
      [
        'failedLoginAttempts',
        'lockedUntil',
        'password',
        'passwordResetExpires',
        'passwordResetToken',
      ].sort(),
    );
    expect(h.recorded.set['password']).not.toBe('Plain-Reset-1');
    expect(h.recorded.returning).toEqual(['id', 'credentialVersion']);
    expect(proof.credentialVersion).toBe(4);
    expect(proof.provenance).toBe('credential-write');
  });

  it('an invitation writes the password, clears the invitation and names only the supplied profile fields', async () => {
    const h = harness({ raw: [{ id: USER_ID, credentialVersion: 2 }] });
    await new UserAccountStore(h.repository).completeInvitation(h.manager, USER_ID, 'Invite-1', {
      firstName: 'Grace',
    });

    expect(h.recorded.set).toEqual(
      expect.objectContaining({
        invitationToken: null,
        invitationExpiresAt: null,
        isEmailVerified: true,
        firstName: 'Grace',
      }),
    );
    expect(h.recorded.set).not.toHaveProperty('lastName');
  });

  it('refuses to produce a proof for a row the write did not reach', async () => {
    const h = harness({ raw: [] });
    await expect(
      new UserAccountStore(h.repository).changePassword(h.manager, USER_ID, 'Pass-9'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('the legacy upgrade is compare-and-set on the verified version and yields null when it lost', async () => {
    const h = harness({ raw: [] });
    const verified = CredentialProof.ofAuthenticatedPrincipal({
      id: USER_ID,
      credentialVersion: 6,
    });

    const result = await new UserAccountStore(h.repository).upgradeLegacyPasswordHash(
      h.manager,
      verified,
      'Verified-Plain',
    );

    expect(result).toBeNull();
    expect(Object.keys(h.recorded.set)).toEqual(['password']);
    expect(h.recorded.where).toContainEqual([
      '"credentialVersion" = :expectedCredentialVersion',
      { expectedCredentialVersion: 6 },
    ]);
  });

  it('sign-in bookkeeping never names a credential column', async () => {
    const h = harness();
    await new UserAccountStore(h.repository).recordSignInCompleted(h.manager, USER_ID, '192.0.2.1');

    expect(Object.keys(h.recorded.set).sort()).toEqual(
      ['failedLoginAttempts', 'lastLoginAt', 'lastLoginIp', 'lockedUntil'].sort(),
    );
    for (const column of CREDENTIAL_COLUMNS) {
      expect(h.recorded.set).not.toHaveProperty(column);
    }
  });

  it('sign-in bookkeeping keeps the first-factor address when none is given', async () => {
    const h = harness();
    await new UserAccountStore(h.repository).recordSignInCompleted(h.manager, USER_ID, undefined);
    expect(h.recorded.set).not.toHaveProperty('lastLoginIp');
  });

  it('first-factor bookkeeping records the address but not lastLoginAt', async () => {
    const h = harness();
    await new UserAccountStore(h.repository).recordFirstFactorVerified(USER_ID, null);
    expect(h.recorded.set).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginIp: null,
    });
  });

  it('the reset-token write names only the two reset columns', async () => {
    const h = harness();
    const expiresAt = new Date('2026-09-29T12:00:00Z');
    await new UserAccountStore(h.repository).issuePasswordResetToken(
      h.manager,
      USER_ID,
      'f'.repeat(64),
      expiresAt,
    );
    expect(h.recorded.set).toEqual({
      passwordResetToken: 'f'.repeat(64),
      passwordResetExpires: expiresAt,
    });
  });

  it('a profile update writes the patch and returns the committed row', async () => {
    const h = harness();
    const committed = Object.assign(new User(), { id: USER_ID, firstName: 'Ada' });
    h.findOneOrFail.mockResolvedValue(committed);

    const row = await new UserAccountStore(h.repository).updateProfile(USER_ID, {
      firstName: 'Ada',
    });

    expect(h.recorded.set).toEqual({ firstName: 'Ada' });
    expect(row).toBe(committed);
  });

  it('fails loudly on a RETURNING row without the version (the ORPHAN-HIGH-318 class)', async () => {
    const h = harness({ raw: [{ id: USER_ID }] });
    await expect(
      new UserAccountStore(h.repository).completePasswordReset(h.manager, USER_ID, 'Pass-7'),
    ).rejects.toThrow('RETURNING row lacks id/credentialVersion');
  });
});

describe('UserMfaStateStore', () => {
  it('begins enrollment only while MFA is disabled', async () => {
    const h = harness({ affected: 0 });
    await expect(
      new UserMfaStateStore(h.repository).beginEnrollment(USER_ID, 'secret', 'codes'),
    ).rejects.toThrow('MFA is already enabled for this account');
    expect(h.recorded.where).toContainEqual(['"mfaEnabled" = false', undefined]);
  });

  it('enables only an enrolled secret', async () => {
    const h = harness({ affected: 0 });
    await expect(new UserMfaStateStore(h.repository).enable(USER_ID)).rejects.toThrow(
      'MFA setup has not been initiated',
    );
    expect(h.recorded.where).toContainEqual(['"mfaSecret" IS NOT NULL', undefined]);
  });

  it('consumes a recovery code by compare-and-set on the matched list', async () => {
    const h = harness({ affected: 0 });
    const consumed = await new UserMfaStateStore(h.repository).consumeRecoveryCode(
      USER_ID,
      'a,b',
      'b',
    );
    expect(consumed).toBe(false);
    expect(h.recorded.set).toEqual({ mfaRecoveryCodes: 'b' });
    expect(h.recorded.where).toContainEqual([
      '"mfaRecoveryCodes" = :storedHashesMatched',
      { storedHashesMatched: 'a,b' },
    ]);
  });

  it('counts a failure in the database and reads the committed counter back', async () => {
    const lockedUntil = new Date('2026-09-29T12:15:00Z');
    const h = harness({ raw: [{ mfaFailedAttempts: 5, mfaLockedUntil: lockedUntil }] });

    const failure = await new UserMfaStateStore(h.repository).recordSecondFactorFailure(
      USER_ID,
      5,
      lockedUntil,
    );

    expect(failure).toEqual({ failedAttempts: 5, lockedUntil });
    expect(typeof h.recorded.set['mfaFailedAttempts']).toBe('function');
    expect(h.recorded.parameters).toEqual({ maxAttempts: 5, lockoutUntil: lockedUntil });
    expect(h.recorded.returning).toEqual(['mfaFailedAttempts', 'mfaLockedUntil']);
  });

  it('fails loudly when the failure RETURNING row is malformed', async () => {
    const h = harness({ raw: [{ mfaFailedAttempts: '5' }] });
    await expect(
      new UserMfaStateStore(h.repository).recordSecondFactorFailure(USER_ID, 5, new Date()),
    ).rejects.toThrow('RETURNING row lacks mfaFailedAttempts/mfaLockedUntil');
  });

  it('disables, replaces codes and resets counters by naming only MFA columns', async () => {
    const store = (h: ReturnType<typeof harness>): UserMfaStateStore =>
      new UserMfaStateStore(h.repository);

    const disabled = harness();
    await store(disabled).disable(USER_ID);
    expect(disabled.recorded.set).toEqual({
      mfaEnabled: false,
      mfaSecret: null,
      mfaRecoveryCodes: null,
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
    });

    const replaced = harness();
    await store(replaced).replaceRecoveryCodes(USER_ID, 'x,y');
    expect(replaced.recorded.set).toEqual({ mfaRecoveryCodes: 'x,y' });

    const reset = harness();
    await store(reset).resetSecondFactorFailures(reset.manager, USER_ID);
    expect(reset.recorded.set).toEqual({ mfaFailedAttempts: 0, mfaLockedUntil: null });
  });
});
