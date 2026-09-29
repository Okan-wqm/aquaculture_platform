import { hashPassword } from '@aquaculture/backend-common/auth';
import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { User } from '../entities/user.entity';

import { CredentialProof } from './credential-proof';

interface VersionRow {
  readonly id: string;
  readonly credentialVersion: number;
}

export interface InvitationProfile {
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface ProfilePatch {
  firstName?: string | null;
  lastName?: string | null;
  preferredLanguage?: string | null;
}

/**
 * The single writer of `auth.users` columns for the authentication flows
 * (login, invitation, password reset/change, WebAuthn, MFA completion).
 *
 * WHY (ORPHAN-HIGH-812): those flows used to `save()` a whole `User` they had
 * loaded earlier. TypeORM's `save` diffs the in-memory entity against the row
 * and writes every difference, so bookkeeping on a stale snapshot could write
 * an old password hash, role or active flag back over a change that
 * committed in between. Every method here issues one column-scoped UPDATE:
 * bookkeeping touches only bookkeeping columns, and a credential write names
 * exactly the credential columns it changes.
 *
 * WHY credential writes return a {@link CredentialProof} (ORPHAN-HIGH-811):
 * the database trigger advances `credentialVersion` on a password change, and
 * `RETURNING` is the one place that version is observed inside the writing
 * statement itself. A caller that mints after a credential write mints from
 * that proof, never from the entity it read before the write.
 *
 * `@BeforeUpdate` listeners do not run for query-builder updates, so password
 * hashing is explicit here (HMAC-peppered, HIGH-006).
 */
@Injectable()
export class UserAccountStore {
  constructor(@InjectRepository(User) private readonly userRepository: Repository<User>) {}

  completePasswordReset(
    manager: EntityManager,
    userId: string,
    plaintextPassword: string,
  ): Promise<CredentialProof> {
    return this.writeCredential(manager, userId, plaintextPassword, {
      passwordResetToken: null,
      passwordResetExpires: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  completeInvitation(
    manager: EntityManager,
    userId: string,
    plaintextPassword: string,
    profile: InvitationProfile,
  ): Promise<CredentialProof> {
    return this.writeCredential(manager, userId, plaintextPassword, {
      invitationToken: null,
      invitationExpiresAt: null,
      isEmailVerified: true,
      ...(profile.firstName ? { firstName: profile.firstName } : {}),
      ...(profile.lastName ? { lastName: profile.lastName } : {}),
    });
  }

  changePassword(
    manager: EntityManager,
    userId: string,
    plaintextPassword: string,
  ): Promise<CredentialProof> {
    return this.writeCredential(manager, userId, plaintextPassword, {
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  /**
   * HIGH-006 lazy upgrade of a legacy (unpeppered) hash to the peppered
   * format, compare-and-set on the version the password was verified
   * against. Returns the new proof, or `null` when the row has moved past
   * that version (a concurrent credential change) — the caller decides
   * whether that refuses its operation (login) or just skips the upgrade.
   */
  async upgradeLegacyPasswordHash(
    manager: EntityManager,
    verified: CredentialProof,
    verifiedPlaintext: string,
  ): Promise<CredentialProof | null> {
    const rows = await this.updateReturningVersion(
      manager,
      verified.userId,
      { password: await hashPassword(verifiedPlaintext) },
      verified.credentialVersion,
    );
    const row = rows[0];
    return row ? CredentialProof.ofCredentialWrite(row) : null;
  }

  /**
   * The first factor passed but the sign-in is not complete (MFA challenge or
   * MFA-enrollment gate): clear the failed-attempt counters and record the
   * address, but not `lastLoginAt`.
   */
  async recordFirstFactorVerified(userId: string, lastLoginIp: string | null): Promise<void> {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginIp })
      .where('id = :id', { id: userId })
      .execute();
  }

  /**
   * The sign-in completed. Runs inside the minting transaction so the row
   * only records a login that actually produced a session (ORPHAN-MEDIUM-813).
   * `lastLoginIp: undefined` keeps the address the first factor recorded.
   */
  async recordSignInCompleted(
    manager: EntityManager,
    userId: string,
    lastLoginIp: string | null | undefined,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(User)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: () => 'CURRENT_TIMESTAMP',
        ...(lastLoginIp === undefined ? {} : { lastLoginIp }),
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async issuePasswordResetToken(
    manager: EntityManager,
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(User)
      .set({ passwordResetToken: tokenHash, passwordResetExpires: expiresAt })
      .where('id = :id', { id: userId })
      .execute();
  }

  /** Profile columns only; returns the row as committed. */
  async updateProfile(userId: string, patch: ProfilePatch): Promise<User> {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set(patch)
      .where('id = :id', { id: userId })
      .execute();
    return this.userRepository.findOneOrFail({ where: { id: userId } });
  }

  private async writeCredential(
    manager: EntityManager,
    userId: string,
    plaintextPassword: string,
    columns: QueryDeepPartialEntity<User>,
  ): Promise<CredentialProof> {
    const rows = await this.updateReturningVersion(manager, userId, {
      ...columns,
      password: await hashPassword(plaintextPassword),
    });
    const row = rows[0];
    if (!row) {
      throw new ConflictException('The account no longer exists');
    }
    return CredentialProof.ofCredentialWrite(row);
  }

  private async updateReturningVersion(
    manager: EntityManager,
    userId: string,
    columns: QueryDeepPartialEntity<User>,
    expectedCredentialVersion?: number,
  ): Promise<VersionRow[]> {
    const update = manager
      .createQueryBuilder()
      .update(User)
      .set(columns)
      .where('id = :id', { id: userId });
    if (expectedCredentialVersion !== undefined) {
      update.andWhere('"credentialVersion" = :expectedCredentialVersion', {
        expectedCredentialVersion,
      });
    }
    const result = await update.returning(['id', 'credentialVersion']).execute();
    return readVersionRows(result.raw);
  }
}

/**
 * The postgres driver hands `UpdateResult.raw` back untyped. A RETURNING drift
 * (a renamed column, a driver change) must fail here, loudly, rather than
 * reach the fence as `undefined` (the ORPHAN-HIGH-318 class).
 */
function readVersionRows(raw: unknown): VersionRow[] {
  if (!Array.isArray(raw)) {
    throw new Error('UserAccountStore: UPDATE … RETURNING did not produce a row list');
  }
  return raw.map((row: unknown): VersionRow => {
    if (
      typeof row === 'object' &&
      row !== null &&
      'id' in row &&
      'credentialVersion' in row &&
      typeof row.id === 'string' &&
      typeof row.credentialVersion === 'number'
    ) {
      return { id: row.id, credentialVersion: row.credentialVersion };
    }
    throw new Error('UserAccountStore: RETURNING row lacks id/credentialVersion');
  });
}
