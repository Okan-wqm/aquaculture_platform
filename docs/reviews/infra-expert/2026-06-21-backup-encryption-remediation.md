# Backup Encryption Deploy Remediation

## INFRA-HIGH-024

**Severity:** HIGH

**Finding:** DigitalOcean deploy reached `aqua-db-migrate`, then failed on
`BackupEncryptionInvariant1800800000000` because `admin.schema_backups` still
contained historical rows where `isEncrypted` was not true.

**Evidence:**

- GitHub Actions run `27906073440`, job `82576067268`, failed during
  `deploy-production / deploy` after image verification and capacity preflight
  passed.
- `apps/admin-api-service/src/migrations/1800800000000-BackupEncryptionInvariant.ts`
  correctly refuses to enforce the encrypted-backup constraint while active
  plaintext backup rows remain.
- `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`
  now rejects new plaintext backup requests, so the deploy failure is historical
  data remediation, not the current write path.

**Rule violated:**

Active database backup records must be restorable only when they point to
encrypted artifacts. Historical plaintext backup records must be retired into a
separate evidence ledger before the strict active-table encryption invariant is
validated; they must not be marked encrypted by metadata rewrite.

**Required remediation:**

- Add a pre-invariant migration that moves legacy plaintext rows out of
  `admin.schema_backups` into an `admin.retired_schema_backups` ledger.
- Preserve cleanup-run and restore-history evidence by repointing historical
  references to the retired ledger before deleting the active backup row.
- Keep the retired ledger immutable: conflict handling must not rewrite the
  captured original backup record, and active-row deletion must keep the same
  plaintext predicate used by the retirement step.
- Keep retired plaintext artifacts under lifecycle cleanup authority so moving
  metadata out of `admin.schema_backups` does not strand dump files outside
  retention.
- Keep `chk_schema_backups_encrypted` strict for active rows: no conditional
  plaintext exception in `admin.schema_backups`.
- Add an invariant test that proves the migration order and active-table
  encryption contract.
