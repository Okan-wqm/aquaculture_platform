# Grants for tenant iteration — architectural-arbiter, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks,
tracking agents, AI configuration). Four reviewers (alert-engine, AI safety, farm domain,
architecture) attacked plan rev 2 against origin/main `dae95efb3`; the main session re-verified the
load-bearing claims in code, and ALERT-CRITICAL-004 on the live database. MT-HIGH-064 and
MT-MEDIUM-065 come from the PR-T1 audit. Each finding names the plan PR that closes it; "owner
decision" entries need a product decision before any code.

## PLAT-MEDIUM-920

Only farm_service is granted EXECUTE on list_active_tenant_schema_mappings, yet messaging and sensor
call it.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C1.
- **Evidence:** `apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql:630` —
  single grant.
- **Rule:** Grants derived from the service catalog.

Closed by plan PR-C1 (catalog-derived grants + invariant).
