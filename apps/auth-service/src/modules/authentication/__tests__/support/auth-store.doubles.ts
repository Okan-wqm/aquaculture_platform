import type { EntityManager } from 'typeorm';

import { CredentialProof } from '../../services/credential-proof';
import type { InvitationProfile, UserAccountStore } from '../../services/user-account.store';
import type { UserMfaStateStore } from '../../services/user-mfa-state.store';

/**
 * The public surface of the two column-scoped writers, as jest doubles.
 * `Pick<…, keyof …>` drops the private repository member so a plain object
 * satisfies the type without a cast.
 */
export type UserAccountStoreDouble = jest.Mocked<Pick<UserAccountStore, keyof UserAccountStore>>;
export type UserMfaStateStoreDouble = jest.Mocked<Pick<UserMfaStateStore, keyof UserMfaStateStore>>;

/**
 * Credential writes answer the way the database trigger does: the row moves
 * one version past what the caller read, and the proof carries that version.
 * `committedVersion` pins it for suites that assert the mint's proof.
 */
export function makeUserAccountStoreDouble(committedVersion = 2): UserAccountStoreDouble {
  const written = (userId: string): Promise<CredentialProof> =>
    Promise.resolve(
      CredentialProof.ofCredentialWrite({ id: userId, credentialVersion: committedVersion }),
    );
  return {
    completePasswordReset: jest.fn<Promise<CredentialProof>, [EntityManager, string, string]>(
      (_manager, userId) => written(userId),
    ),
    completeInvitation: jest.fn<
      Promise<CredentialProof>,
      [EntityManager, string, string, InvitationProfile]
    >((_manager, userId) => written(userId)),
    changePassword: jest.fn<Promise<CredentialProof>, [EntityManager, string, string]>(
      (_manager, userId) => written(userId),
    ),
    upgradeLegacyPasswordHash: jest.fn<
      Promise<CredentialProof | null>,
      [EntityManager, CredentialProof, string]
    >((_manager, verified) =>
      Promise.resolve(
        CredentialProof.ofCredentialWrite({
          id: verified.userId,
          credentialVersion: verified.credentialVersion + 1,
        }),
      ),
    ),
    recordFirstFactorVerified: jest.fn().mockResolvedValue(undefined),
    recordSignInCompleted: jest.fn().mockResolvedValue(undefined),
    issuePasswordResetToken: jest.fn().mockResolvedValue(undefined),
    updateProfile: jest.fn(),
  };
}

export function makeUserMfaStateStoreDouble(): UserMfaStateStoreDouble {
  return {
    beginEnrollment: jest.fn().mockResolvedValue(undefined),
    enable: jest.fn().mockResolvedValue(undefined),
    disable: jest.fn().mockResolvedValue(undefined),
    replaceRecoveryCodes: jest.fn().mockResolvedValue(undefined),
    consumeRecoveryCode: jest.fn().mockResolvedValue(true),
    recordSecondFactorFailure: jest
      .fn()
      .mockResolvedValue({ failedAttempts: 1, lockedUntil: null }),
    resetSecondFactorFailures: jest.fn().mockResolvedValue(undefined),
  };
}
