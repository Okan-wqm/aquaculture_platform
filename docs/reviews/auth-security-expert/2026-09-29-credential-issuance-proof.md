# Credential issuance proof — review, 2026-09-29

**Scope.** This review covers the change that closes ORPHAN-HIGH-811, ORPHAN-HIGH-812,
ORPHAN-MEDIUM-813 and ORPHAN-MEDIUM-814 (`docs/reviews/orphan-findings.md`).

**The defect on main.** Two flows save a new password and then mint a token from the `User` entity
they loaded before the write:

- `resetPassword`
- `acceptInvitation`

The trigger `trg_users_bump_credential_version` advances `auth.users.credentialVersion` on that
write, but TypeORM does not hydrate it back. The issuance fence therefore compares against the stale
version and answers 403. This happens after the one-time link has already been consumed.

**The change.**

- `TokenService.generateTokens` takes a nominal `CredentialProof` in place of a `User`.
- A credential write returns its version from the `RETURNING` of the same UPDATE, through the
  column-scoped `UserAccountStore` / `UserMfaStateStore`.
- The mint locks the row by `id`, `isActive` and `credentialVersion`, and builds the claims from the
  locked row.

**Reviewer verdict.** The auth-security-expert agent read the change and found no CRITICAL or HIGH
regression.

- Dropping `role`/`tenantId` from the fence predicate is equivalent: the trigger advances the
  version on `password`, `role`, `tenantId` and `isActive`.
- RLS context, password hashing and refresh rotation are unchanged.

Two MEDIUM defects were found. Both are present on main, and both are fixed in the same change.

## SEC-MEDIUM-170 — a passkey login could undo a reset's passkey revocation

**Where.** `WebAuthnService.verifyLogin` read the principal after the assertion and advanced the
counter with `credentialRepository.save(credential)`.

**How it failed.**

1. A password reset commits while the assertion is being verified. It deletes every passkey
   (SEC-CRITICAL-002) and bumps the version.
2. The `save()` finds no row and re-INSERTs the passkey.
3. The row read after the assertion already carries the new version, so the fence passes.

**Fix.**

- The principal is read before the assertion.
- The counter advance is `advanceCredentialCounter`: a compare-and-set UPDATE on the counter that
  was verified, run inside the minting transaction after the user-row bookkeeping (lock order User →
  credential).
- When that UPDATE matches no row, nothing is minted. This covers a passkey that was deleted and one
  that was advanced by a concurrent login.
- Real-Postgres proof in `credential-issuance.postgres.spec.ts` covers both a deleted passkey and
  two logins racing on the same assertion.

## SEC-MEDIUM-171 — the `mfa_setup` token outlived the credential that earned it

**Where.** `generateMfaSetupToken` signed no version, and `resolveSetupTokenUserId` checked only the
signature and the token type.

**How it failed.** A setup token taken with the old password stayed usable for its 600 s TTL after a
reset. Its holder could bind their own TOTP secret to the account.

**Fix.**

- The token carries the version of the proof that earned it: the authenticated password, or the
  reset/invitation write.
- The consumer re-reads the row and refuses (401, "sign in again") on any of these conditions:
  - a version mismatch;
  - a deactivated or missing account;
  - a token with no version claim.
- `resolveMfaEnrollmentGate` receives that proof, not the pre-write entity.

## Lower-severity observations, all addressed here

| Item                                                                                                                                                                      | Disposition                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1.** An MFA challenge minted before the version claim existed failed with 403 "unfenced principal".                                                                    | Now 401 "MFA session has expired".                                                                                                                                                                                                                                            |
| **L2.** A stale challenge consumed a TOTP step or recovery code before the fence refused it.                                                                              | The version is compared with the row before any code is consumed.                                                                                                                                                                                                             |
| **L3.** Recovery-code consumption was a compare-and-set on the whole list, so a second, different valid code used concurrently counted as a failure.                      | One statement now removes exactly the matched hash, only while it is still stored. Real-Postgres proof covers both the same code and two different codes.                                                                                                                     |
| **L4.** The proof factories are public, `lastUsedTotpStep` was written outside the MFA store, and the failed-password counter was a raw UPDATE outside the account store. | `credential-proof.spec.ts` pins each factory to the files whose flow gives it meaning. The TOTP step and the failed-password counter moved into the stores. `user-write-discipline.spec.ts` now fails any query-builder or raw-SQL UPDATE of `auth.users` outside the stores. |
| **L5.** The login response carried the previous `lastLoginAt`, because the mint locked the row before the bookkeeping.                                                    | The bookkeeping now runs first in the same transaction. It moves no credential column. Real Postgres confirms that a refused mint rolls it back.                                                                                                                              |
