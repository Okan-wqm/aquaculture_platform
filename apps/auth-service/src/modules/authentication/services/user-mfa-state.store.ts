import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { User } from '../entities/user.entity';

export interface SecondFactorFailure {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

/**
 * The single writer of the MFA columns on `auth.users`.
 *
 * WHY (ORPHAN-HIGH-812, same class): MfaService used to mutate a loaded
 * `User` and `save()` it — a whole-entity diff that could write a stale
 * password, role or active flag back, and two read-modify-write races:
 *   - failed-attempt counting (`attempts + 1` computed in JS) under-counted
 *     concurrent wrong codes, so the lockout threshold could be outrun;
 *   - recovery-code consumption removed the matched hash from the list the
 *     request had read, so two concurrent requests presenting the same code
 *     both succeeded — a one-time code used twice.
 * Each method below is one column-scoped statement; the counter is computed
 * by the database and consumption is compare-and-set on the stored list.
 */
@Injectable()
export class UserMfaStateStore {
  constructor(@InjectRepository(User) private readonly userRepository: Repository<User>) {}

  /** Store the pending secret + recovery codes; refused once MFA is enabled. */
  async beginEnrollment(
    userId: string,
    encryptedSecret: string,
    recoveryCodeHashes: string,
  ): Promise<void> {
    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({
        mfaSecret: encryptedSecret,
        mfaRecoveryCodes: recoveryCodeHashes,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
      })
      .where('id = :id', { id: userId })
      .andWhere('"mfaEnabled" = false')
      .execute();
    this.requireOneRow(result.affected, 'MFA is already enabled for this account');
  }

  /** Activate the enrolled secret; refused if enrollment was never begun. */
  async enable(userId: string): Promise<void> {
    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ mfaEnabled: true, mfaFailedAttempts: 0, mfaLockedUntil: null })
      .where('id = :id', { id: userId })
      .andWhere('"mfaSecret" IS NOT NULL')
      .execute();
    this.requireOneRow(result.affected, 'MFA setup has not been initiated');
  }

  async disable(userId: string): Promise<void> {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({
        mfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: null,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
      })
      .where('id = :id', { id: userId })
      .execute();
  }

  async replaceRecoveryCodes(userId: string, recoveryCodeHashes: string): Promise<void> {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ mfaRecoveryCodes: recoveryCodeHashes })
      .where('id = :id', { id: userId })
      .execute();
  }

  /**
   * Compare-and-set: succeeds only if the stored list is still exactly the
   * list the caller matched against. A concurrent consumption changes the
   * list first, so the second request observes `false` and is rejected.
   */
  async consumeRecoveryCode(
    userId: string,
    storedHashesMatched: string,
    remainingHashes: string | null,
  ): Promise<boolean> {
    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ mfaRecoveryCodes: remainingHashes })
      .where('id = :id', { id: userId })
      .andWhere('"mfaRecoveryCodes" = :storedHashesMatched', { storedHashesMatched })
      .execute();
    return result.affected === 1;
  }

  /**
   * Count a wrong second factor in the database and lock at the threshold,
   * returning the committed values.
   */
  async recordSecondFactorFailure(
    userId: string,
    maxAttempts: number,
    lockoutUntil: Date,
  ): Promise<SecondFactorFailure> {
    const result = await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({
        mfaFailedAttempts: () => '"mfaFailedAttempts" + 1',
        // The CASE reads the pre-update column, so `+ 1` is the count this
        // statement commits: the attempt that reaches the threshold locks.
        mfaLockedUntil: () =>
          'CASE WHEN "mfaFailedAttempts" + 1 >= :maxAttempts THEN CAST(:lockoutUntil AS timestamptz) ELSE "mfaLockedUntil" END',
      })
      .setParameters({ maxAttempts, lockoutUntil })
      .where('id = :id', { id: userId })
      .returning(['mfaFailedAttempts', 'mfaLockedUntil'])
      .execute();
    return readFailureRow(result.raw);
  }

  async resetSecondFactorFailures(manager: EntityManager, userId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(User)
      .set({ mfaFailedAttempts: 0, mfaLockedUntil: null })
      .where('id = :id', { id: userId })
      .execute();
  }

  private requireOneRow(affected: number | null | undefined, refusal: string): void {
    if (affected !== 1) {
      throw new ConflictException(refusal);
    }
  }
}

function readFailureRow(raw: unknown): SecondFactorFailure {
  const row: unknown = Array.isArray(raw) ? raw[0] : undefined;
  if (
    typeof row === 'object' &&
    row !== null &&
    'mfaFailedAttempts' in row &&
    'mfaLockedUntil' in row &&
    typeof row.mfaFailedAttempts === 'number' &&
    (row.mfaLockedUntil === null || row.mfaLockedUntil instanceof Date)
  ) {
    return { failedAttempts: row.mfaFailedAttempts, lockedUntil: row.mfaLockedUntil };
  }
  throw new Error('UserMfaStateStore: RETURNING row lacks mfaFailedAttempts/mfaLockedUntil');
}
