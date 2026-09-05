# ADR-0009 — WAL-G Is the Sole PostgreSQL Backup and Restore Authority; Admin-API Backup Subsystem Deleted

**Status:** accepted
**Date:** 2026-09-05
**Amends:** `docs/adr/016-deploy-resilience-architecture.md`, `docs/adr/033-deploy-migration-recovery-architecture.md`
**Resolves:** admin-expert#SURF-002, #SURF-012, #SURF-016; performance-expert#PERF-017; observability-expert#OBS-010; access-boundary-auditor#ACCESS-019; tenant-isolation-auditor#ISO-008, #ISO-011; auth-security-expert#AUTH-019; button-action-auditor#BTN-003, #BTN-004
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#INFRA-CRITICAL-140

## Context

Two backup narratives coexist. The admin-api in-process per-tenant `pg_dump` subsystem (`apps/admin-api-service/src/database-management/services/backup-restore.service.ts`) requires `BACKUP_ENCRYPTION_KEY` (`:556-564`) which `docker-compose.droplet.yml` never sets, writes to `/backups/schemas` on no mounted volume (`:61`), runs its three crons on every replica, encrypts on the main thread, and its `executeRestore` unconditionally sets `status='failed'` and throws (`:455-471`). `docs/runbooks/database-restore-drill.md:548` tells operators to re-run the drill after changing that dead executor's flags.

The WAL-G path is a hash-pinned, gated control plane: `tools/scripts/database/{backup-databases.sh, restore-databases.sh, walg-base-backup.sh, walg-pitr-restore.sh, …}`, `.github/manifests/backup-script.sha256`, `.github/manifests/postgres-dr-contract.sha256`, workflows `backup-production.yml` / `pitr-restore-production.yml`, and invariants `walg-pitr-contract.spec.ts`, `walg-evidence-attestation.spec.ts`, `backup-restore-verification-contract.spec.ts`.

## Decision

We make `tools/scripts/database/backup-databases.sh` + WAL-G the sole backup and restore authority for PostgreSQL. We delete the admin-api backup subsystem: the service, `backup.controller.ts`, the `SchemaBackup` / `SchemaRestore` / `RetiredSchemaBackup` entities, `admin.schema_backups` and `admin.schema_restores`, the three crons, and the backup / restore / PITR UI in `DatabaseManagementPage.tsx` with its client. `fk_cleanup_runs_backup` is re-pointed at the WAL-G backup epoch label, the artifact that actually exists. The runbook clause at `:545-549` is struck.

We do not add a `BACKUP_ENCRYPTION_KEY` boot assertion: with the subsystem gone there is no key to assert. Deleting the surface removes the need for the guard.

Gate: `tests/invariants/backup-restore-verification-contract.spec.ts` gains a single-authority assertion — no file outside `tools/scripts/database/` and the two DR workflows may spawn `pg_dump` / `pg_restore` or declare a backup cron.

## Consequences

- Operators lose an in-panel "Start Backup / Start Restore" button that never worked in production; restore is reached through `pitr-restore-production.yml` and the drill runbook.
- ISO-011 (caller-chosen `targetSchemaName` cross-tenant restore) and ISO-008 (un-shredded `.dump.enc` files) disappear with the subsystem.
- This decision gates every destructive migration in the remediation: no table drop or data migration proceeds while SURF-002 (no production backups) stands.
- `MODULE_SCHEMAS['admin'].tables` loses two entries; the cleanup ledger FK changes shape.
