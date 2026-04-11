# Package 33: ai-quota-fail-closed

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [multi-tenant-saas-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
AI quota enforcement falls back to in-memory counters when Redis is unavailable. Multi-instance deployments multiply the configured limit, and counters are lost on restart. Monthly tenant budgets also use the same in-memory fallback. This means tenants can exceed plan limits by scaling the service or surviving restarts.

## Findings
`HIGH-002` (multi-tenant-saas-expert): AI quota enforcement fails open when Redis is unavailable. Files: `apps/ai-service/src/app.module.ts:196-205`, `apps/ai-service/src/cost/rate-limit.service.ts:28-37,82-90,131-171`, `apps/ai-service/src/cost/token-budget.service.ts:25-35,96-160`.

## Affected Files
- /var/aqua-saas/apps/ai-service/src/app.module.ts
- /var/aqua-saas/apps/ai-service/src/cost/rate-limit.service.ts
- /var/aqua-saas/apps/ai-service/src/cost/token-budget.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(ai): fail closed when Redis unavailable for quota enforcement

AI quota enforcement fell back to in-memory counters when Redis was
unavailable, allowing tenants to exceed plan limits across
multi-instance deployments or restarts. This makes Redis a required
dependency in production with an explicit startup health check, removes
the in-memory fallback, and rejects AI requests when quota state cannot
be authoritatively verified.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/33-ai-quota-fail-closed.md
Closes: docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test: rate-limit service rejects requests when Redis is unavailable.
- Unit test: token-budget service rejects requests when Redis is unavailable.
- Unit test: startup health check fails when Redis is unreachable.
- Integration test: AI requests are blocked when Redis connection drops.
- Negative test: in-memory fallback code path is removed.

## Verification Command
`npx tsc --noEmit -p apps/ai-service/tsconfig.json && npx jest --testPathPattern="apps/ai-service/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

