# Package 07: hr-handlers-post-commit-refetch

## Metadata
Status: PENDING
Estimated Tokens: 35K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (no prerequisites)
Prerequisites: none
Closing-Findings: [AUTH-HIGH-003]
Source-Reviews:
  - docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

17 HR performance/training handlers use a fragile post-commit re-fetch pattern: after `queryRunner.commitTransaction()`, they call `this.dataSource.getRepository(Entity).findOne()` which acquires a DIFFERENT pool connection. While `tenantId` is present in the WHERE clause (so this is not a tenant leak), the new connection may have a different search_path if the pool patch timing changes. This becomes a real bug if read replicas are added (replication lag means the re-fetch may return stale or null data). The fix is to return the entity from the transaction's own QueryRunner instead of re-fetching on a separate connection.

## Findings

**AUTH-HIGH-003 [MEDIUM] -- 17 HR handlers post-commit re-fetch on different connection**
- Source: auth-security-expert
- Pattern across 17 handlers:
  ```
  await queryRunner.commitTransaction();
  const result = await this.dataSource.getRepository(Entity).findOne({
    where: { id, tenantId }, relations: [...]
  });
  ```
- Not a tenant leak (tenantId present), but acquires different pool connection after commit
- Fragile if read replicas added (replication lag)
- Handlers include: acknowledge-review, update-goal, defer-goal, and 14 others in hr-service performance/training domains

## Affected Files
- `apps/hr-service/src/performance/handlers/acknowledge-review.handler.ts` (~3K tokens)
- `apps/hr-service/src/performance/handlers/update-goal.handler.ts` (~3K tokens)
- `apps/hr-service/src/performance/handlers/defer-goal.handler.ts` (~3K tokens)
- Plus ~14 additional HR performance/training handlers with the same pattern (~42K tokens total across all 17)

**NOTE:** This package estimates at ~35K tokens due to 17 handler files. If the executor finds that loading all 17 files exceeds session budget, split into sub-packages:
- 07a: performance handlers (acknowledge-review, update-goal, defer-goal, + others in performance/)
- 07b: training handlers (remaining handlers in training/)

## Dependencies
None. HR handler files are independent of all other packages.

## Atomic Commit Plan
```
refactor(hr): replace post-commit re-fetch with transaction-scoped return

17 HR performance/training handlers call
dataSource.getRepository().findOne() after queryRunner.commitTransaction(),
which acquires a different pool connection. This is fragile: read
replicas would return stale/null data due to replication lag.

Fix: Return the entity from the queryRunner.manager operations within
the transaction scope instead of re-fetching on a new connection after
commit. Use queryRunner.manager.findOne() before releasing the
queryRunner if relations need eager loading.

Closes: docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md#AUTH-HIGH-003
Plan: docs/plans/2026-04-09-tier1-fixes/packages/07-hr-handlers-post-commit-refetch.md
```

## Test Plan
- All existing HR handler unit tests must pass
- For each modified handler, verify the returned entity comes from the transaction's QueryRunner, not from a new connection
- Add test: mock dataSource.getRepository to throw if called after commitTransaction -- ensures the re-fetch pattern is fully removed
- Verify that eager-loaded relations are correctly populated from the transaction-scoped query

## Verification Command
```bash
npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(performance|training)/handlers" --coverage=false
```

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
