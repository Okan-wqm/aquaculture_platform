# Package 22: db-pii-encryption

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [DB-CRITICAL-001]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The employee entity stores `nationalId` (government identification number) and `bankDetails` (bank account/routing numbers) as plain text in the database. A database breach (SQL injection, backup theft, replica compromise) exposes this PII directly. These fields require application-level encryption at rest with a managed key (KMS or Vault), separate from the database encryption-at-rest which protects against disk theft but not application-level access.

## Findings
- **DB-CRITICAL-001**: nationalId and bankDetails stored plain text -- no encryption
  - File: `apps/hr-service/src/hr/entities/employee.entity.ts` (~8.2K chars)
  - Both columns are plain VARCHAR with no transformer or encryption
  - Root cause: encryption was not implemented during initial entity design

## Affected Files
- `/var/aqua-saas/apps/hr-service/src/hr/entities/employee.entity.ts` (~8.2K chars)

## Dependencies
Cross-references Package 08 (HR PII exposure) which touches the same entity. Both can execute independently -- Package 08 handles GraphQL/event PII, this package handles database-level encryption. If Package 08 is executed first, this package's diff is smaller (fewer fields to touch).

## Atomic Commit Plan
```
security(hr): encrypt nationalId and bankDetails at application level

1. Create EncryptedColumnTransformer using AES-256-GCM with key from
   environment variable (EMPLOYEE_PII_ENCRYPTION_KEY, sourced from KMS).
2. employee.entity.ts: apply EncryptedColumnTransformer to nationalId
   and bankDetails columns.
3. Add migration to encrypt existing plain-text values in place.
4. Add key rotation support: store key version prefix in encrypted value.

BREAKING CHANGE: Direct SQL queries against nationalId/bankDetails
columns will return encrypted ciphertext, not readable values.

Closes: docs/reviews/2026-04-09-critical-fixes#DB-CRITICAL-001
Plan: docs/plans/2026-04-09-critical-fixes/packages/22-db-pii-encryption.md
```

## Test Plan
- Unit test: EncryptedColumnTransformer encrypt/decrypt round-trip
- Unit test: encrypted value is not equal to plain text
- Unit test: different encryption keys produce different ciphertext
- Integration test: save and read employee -- nationalId decrypted correctly
- Migration test: existing plain-text values encrypted in place

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/hr/entities" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
