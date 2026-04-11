# Package 12: migration-search-path-fix

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [data-expert/CRITICAL-004]

## Source-Reviews
- /var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Farm-service migrations use session-scoped `SET search_path TO farm, public` which persists on the pooled connection after the migration completes. In TypeORM-style pooled migration runners, this contaminates later queries on the same connection and can point them at the wrong schema. The SQL migration script also relies on the same pattern.

## Findings
`CRITICAL-004` (data-expert): Migration code uses session-scoped `SET search_path TO farm, public`, which can contaminate pooled connections. Files: `apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts:24-29,141-146`, `apps/farm-service/src/database/migrations/add-system-hierarchy.sql:9-10`.

## Affected Files
- /var/aqua-saas/apps/farm-service/src/database/migrations/1769000000000-AddRegulatorySettings.ts
- /var/aqua-saas/apps/farm-service/src/database/migrations/add-system-hierarchy.sql

## Dependencies
None.

## Atomic Commit Plan
```
fix(farm): replace session-scoped SET search_path with schema-qualified identifiers

Farm-service migrations used SET search_path TO farm, public which
persists on pooled connections and can contaminate later queries. This
replaces all session-scoped search_path mutations with either SET LOCAL
search_path inside explicit transactions, or fully schema-qualified
identifiers so connection state is never mutated.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/12-migration-search-path-fix.md
Closes: docs/reviews/data-expert/2026-04-10-full-repo-audit.md#CRITICAL-004
```

## Test Plan
- Verify no `SET search_path` without `LOCAL` keyword exists in migration files.
- Verify all table references are fully schema-qualified (e.g., `farm.regulatory_settings`).
- Integration test: run migration, then verify connection search_path is unchanged after migration completes.

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && grep -rn 'SET search_path' /var/aqua-saas/apps/farm-service/src/database/migrations/ | grep -v 'SET LOCAL' | grep -c '' | grep '^0$'`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

