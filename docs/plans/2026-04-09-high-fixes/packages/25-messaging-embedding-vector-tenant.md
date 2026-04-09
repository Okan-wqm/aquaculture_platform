# Package 25: messaging-embedding-vector-tenant

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 25K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [MSG-HIGH-039, MSG-HIGH-040, MSG-HIGH-042, MSG-HIGH-044]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Messaging embedding and vector search HIGHs: (1) embedding worker does not use SKIP LOCKED (duplicate processing across replicas), (2) embedding uses wrong schema (writes to public instead of tenant schema), (3) vector search query does not include tenantId filter (cross-tenant semantic search), (4) presence tracking uses wrong data structure (race condition on concurrent updates).

## Findings

**MSG-HIGH-039** (messaging-expert, HIGH)
Embedding worker does not use SELECT FOR UPDATE SKIP LOCKED. Multiple worker replicas process the same embedding jobs, causing duplicate embeddings and wasted API calls to embedding provider.

**MSG-HIGH-040** (messaging-expert, HIGH)
Embedding worker writes to wrong schema. Embeddings are stored in public schema instead of tenant-specific schema, mixing all tenants' embeddings in a single table.

**MSG-HIGH-042** (messaging-expert, HIGH)
Vector search query does not include tenantId in WHERE clause. Semantic search across conversations returns results from all tenants. Cross-tenant information disclosure via natural language query.

**MSG-HIGH-044** (messaging-expert, HIGH)
Presence tracking (online/offline status) uses a data structure with race condition on concurrent updates. Two simultaneous status changes can produce inconsistent presence state.

## Affected Files
- apps/messaging-service/src/embedding/ (worker, search)
- apps/messaging-service/src/presence/ (presence tracking)

## Dependencies
None.

## Atomic Commit Plan
```
security(messaging): fix embedding SKIP LOCKED, tenant schema, vector search tenantId, presence race

Embedding worker lacks SKIP LOCKED (duplicate processing). Embeddings written
to public schema instead of tenant schema. Vector search has no tenantId
filter (cross-tenant disclosure). Presence tracking has race condition.

Add FOR UPDATE SKIP LOCKED to embedding job selection. Set search_path to
tenant schema before embedding writes. Add tenantId to vector search WHERE
clause. Use Redis MULTI/EXEC for atomic presence updates.

Plan: docs/plans/2026-04-09-high-fixes/packages/25-messaging-embedding-vector-tenant.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-039
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-040
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-042
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-044
```

## Test Plan
- Unit test: embedding worker skips locked rows
- Unit test: embeddings written to tenant schema not public
- Unit test: vector search returns only same-tenant results
- Unit test: concurrent presence updates are serialized via Redis MULTI

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/(embedding|presence)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
