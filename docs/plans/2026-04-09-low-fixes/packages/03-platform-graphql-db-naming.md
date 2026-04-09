# Package 03: platform-graphql-db-naming

## Metadata
Status: PENDING
Estimated Tokens: 15K
Priority: LOW
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
Five LOW findings grouped by the shared theme of schema/type correctness and naming: GraphQL Float usage for monetary fields in billing entities, missing SECURITY marker comments in security-critical code paths, and database column naming inconsistencies (storedAt vs createdAt, feedingTime VARCHAR vs TIME). These are all documentation/naming/type precision issues with no runtime behavioral change.

## Findings

**PLAT-LOW-001: InvoiceLineItem Float GraphQL**
- Source agent: platform-services
- Severity: LOW
- File: `apps/billing-service/src/billing/entities/invoice.entity.ts` (lines 37, 40, 43, 52, 55, 132, 142, 152, 158, 164)
- Description: 10 `@Field(() => Float)` decorators on monetary fields (unitPrice, totalPrice, taxAmount, discountAmount, subtotal, taxTotal, total, amountPaid, balance, etc.). GraphQL Float is IEEE 754 double-precision, which causes rounding errors for monetary values. Consider using a custom `Decimal` scalar or `String` for monetary fields. This is LOW because the current implementation works for typical aquaculture billing amounts, but should be addressed before high-volume invoicing.

**PLAT-LOW-002: PlanPricing Float GraphQL**
- Source agent: platform-services
- Severity: LOW
- File: `apps/billing-service/src/billing/entities/plan.entity.ts` (line 44)
- Description: `@Field(() => Float)` on pricing field in plan entity. Same Float precision concern as PLAT-LOW-001. Part of the same billing domain Float-to-Decimal migration.

**PLAT-LOW-003: missing SECURITY marker comments**
- Source agent: platform-services
- Severity: LOW
- Files: Multiple security-critical files across `apps/` (guards, middleware, auth services)
- Description: CLAUDE.md requires `// SECURITY:` marker comments at critical security decision points. While 173 files already use this pattern, several security-critical code paths (guards, middleware, token validation) lack explicit markers. Executor should audit the top-priority files: guards in gateway-api, auth-service token.service.ts, tenant-context middleware. Add `// SECURITY:` comments at authorization decision points.

**DB-LOW-001: storedAt vs createdAt naming inconsistency**
- Source agent: database-reviewer
- Severity: LOW
- Files: `apps/event-store-service/src/event-store/entities/stored-event.entity.ts` (line 118), `apps/event-store-service/src/event-store/dto/event-store.dto.ts` (lines 246-247), `apps/event-store-service/src/event-store/services/event-store.service.ts` (lines 25, 531, 694)
- Description: Event store uses `storedAt` while most other entities use `createdAt` for the same semantic (record creation timestamp). The `storedAt` naming is actually intentional for event sourcing (it distinguishes "when the event occurred" from "when it was stored"), but this should be documented with a `// WHY:` comment to prevent future "consistency" refactors from renaming it.

**DB-LOW-002: feedingTime VARCHAR not TIME**
- Source agent: database-reviewer
- Severity: LOW
- Files: `apps/farm-service/src/feeding/entities/feeding-record.entity.ts` (line 168-169), `apps/farm-service/src/feeding/dto/create-feeding-record.input.ts` (line 130), `apps/farm-service/src/feeding/commands/create-feeding-record.command.ts` (line 21)
- Description: `feedingTime` is stored as `VARCHAR(10)` with format "HH:MM". PostgreSQL has a native `TIME` type that would provide type-safe time operations. This is LOW because the current VARCHAR works correctly, but a migration to TIME type would enable database-level time comparisons and prevent malformed time strings. Document the current choice with a `// WHY:` or plan a future migration.

Closing-Findings: [PLAT-LOW-001, PLAT-LOW-002, PLAT-LOW-003, DB-LOW-001, DB-LOW-002]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/apps/billing-service/src/billing/entities/invoice.entity.ts`
- `/var/aqua-saas/apps/billing-service/src/billing/entities/plan.entity.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/entities/stored-event.entity.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/dto/event-store.dto.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/entities/feeding-record.entity.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/dto/create-feeding-record.input.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/commands/create-feeding-record.command.ts`
- Security-critical files for PLAT-LOW-003 (executor to enumerate top-priority files)

## Dependencies
None. All findings are documentation, naming, or type annotation fixes.

## Atomic Commit Plan
```
chore(billing,event-store,farm): address 5 LOW schema and naming findings

Add documentation and type precision improvements:
- Document Float usage on billing monetary fields with TODO for Decimal scalar migration
- Add SECURITY marker comments to undocumented security decision points
- Add WHY comment on storedAt naming in event store (intentional, not createdAt)
- Document feedingTime VARCHAR(10) choice with WHY comment or plan TIME migration

Plan: docs/plans/2026-04-09-low-fixes/packages/03-platform-graphql-db-naming.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-LOW-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-LOW-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#PLAT-LOW-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-LOW-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-LOW-002
```

## Test Plan
- Verify billing-service compilation: `npx tsc --noEmit -p apps/billing-service/tsconfig.json`
- Verify event-store-service compilation: `npx tsc --noEmit -p apps/event-store-service/tsconfig.json`
- Verify farm-service compilation: `npx tsc --noEmit -p apps/farm-service/tsconfig.json`
- No behavioral changes expected; comment-only modifications should not affect tests

## Verification Command
`npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx tsc --noEmit -p apps/event-store-service/tsconfig.json && npx tsc --noEmit -p apps/farm-service/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
