# Package 11: db-migration-tree-restore

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [database-reviewer/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The canonical migration files in `database/migrations/` are zero-byte placeholders for core, alert, farm, and sensor modules. The stated source-of-truth for schema state contains no DDL, blocking reproducible bootstrap and making the migration tree useless for schema review. This covers 15 empty migration files across 4 modules.

## Findings
`CRITICAL-001` (database-reviewer): Authoritative migration tree is empty for core, alert, farm, and sensor. Files: `database/migrations/core/V001__initial_schema.sql` through `V005__add_audit_table.sql`, `database/migrations/modules/alert/V001__alert_initial_schema.sql` through `V002__add_escalation_tables.sql`, `database/migrations/modules/farm/V001__farm_initial_schema.sql` through `V004__add_feeding_tables.sql`, `database/migrations/modules/sensor/V001__sensor_initial_schema.sql` through `V004__add_retention_policies.sql`.

## Affected Files
- /var/aqua-saas/database/migrations/core/V001__initial_schema.sql
- /var/aqua-saas/database/migrations/core/V002__add_tenant_table.sql
- /var/aqua-saas/database/migrations/core/V003__add_user_table.sql
- /var/aqua-saas/database/migrations/core/V004__add_subscription_table.sql
- /var/aqua-saas/database/migrations/core/V005__add_audit_table.sql
- /var/aqua-saas/database/migrations/modules/alert/V001__alert_initial_schema.sql
- /var/aqua-saas/database/migrations/modules/alert/V002__add_escalation_tables.sql
- /var/aqua-saas/database/migrations/modules/farm/V001__farm_initial_schema.sql
- /var/aqua-saas/database/migrations/modules/farm/V002__add_production_tables.sql
- /var/aqua-saas/database/migrations/modules/farm/V003__add_ras_tables.sql
- /var/aqua-saas/database/migrations/modules/farm/V004__add_feeding_tables.sql
- /var/aqua-saas/database/migrations/modules/sensor/V001__sensor_initial_schema.sql
- /var/aqua-saas/database/migrations/modules/sensor/V002__create_hypertables.sql
- /var/aqua-saas/database/migrations/modules/sensor/V003__create_continuous_aggregates.sql
- /var/aqua-saas/database/migrations/modules/sensor/V004__add_retention_policies.sql

## Dependencies
None.

## Atomic Commit Plan
```
fix(database): restore canonical DDL in empty migration files

The 15 migration files across core, alert, farm, and sensor modules
were zero-byte placeholders with no DDL content. This made the
canonical migration tree unusable for reproducible bootstrap or schema
review. This restores the authoritative CREATE TABLE, CREATE INDEX, and
related DDL statements in each migration file, derived from the current
entity definitions and TypeORM metadata.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/11-db-migration-tree-restore.md
Closes: docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Verify each migration file is non-empty and contains valid SQL.
- Verify migration files can be applied to a clean database in order.
- Verify resulting schema matches current entity definitions.
- Integration test: fresh bootstrap from migrations produces a working schema.

## Verification Command
`for f in /var/aqua-saas/database/migrations/core/*.sql /var/aqua-saas/database/migrations/modules/alert/*.sql /var/aqua-saas/database/migrations/modules/farm/*.sql /var/aqua-saas/database/migrations/modules/sensor/*.sql; do [ -s "$f" ] || echo "EMPTY: $f"; done | grep -c EMPTY | grep '^0$'`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

