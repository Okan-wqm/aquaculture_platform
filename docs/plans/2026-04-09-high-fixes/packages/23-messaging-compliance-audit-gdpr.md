# Package 23: messaging-compliance-audit-gdpr

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [MSG-HIGH-015, MSG-HIGH-016, MSG-HIGH-020, MSG-HIGH-021, MSG-HIGH-022, MSG-HIGH-025, MSG-HIGH-026, MSG-HIGH-027]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Messaging service compliance and audit HIGHs: (1) no idempotency constraint on message processing, (2) Redis TTL 7d for compliance data, (3) compliance audit writes happen after commit (not transactional), (4) audit records have no immutability protection, (5) legal hold has no row-level locking, (6) GDPR partition key for data isolation not implemented, (7) no blob/attachment delete on message deletion, (8) no erasure metric for GDPR compliance reporting.

## Findings

**MSG-HIGH-015** (messaging-expert, HIGH)
No idempotency constraint on message processing. Duplicate delivery creates duplicate messages visible to users.

**MSG-HIGH-016** (messaging-expert, HIGH)
Redis TTL 7 days for compliance-sensitive data (message read receipts, delivery status). Compliance requires longer retention.

**MSG-HIGH-020** (messaging-expert, HIGH)
Compliance audit log writes happen after the main transaction commits. If audit write fails, the action is committed but unaudited.

**MSG-HIGH-021** (messaging-expert, HIGH)
Audit records have no immutability protection. UPDATE and DELETE are possible on audit_log table rows.

**MSG-HIGH-022** (messaging-expert, HIGH)
Legal hold implementation has no row-level locking. Concurrent legal hold + delete race can destroy held messages.

**MSG-HIGH-025** (messaging-expert, HIGH)
GDPR partition key not implemented. Data subject erasure requires full table scan instead of partition-based delete.

**MSG-HIGH-026** (messaging-expert, HIGH)
No blob/attachment delete cascade when message is deleted. Orphan files accumulate in object storage.

**MSG-HIGH-027** (messaging-expert, HIGH)
No erasure metric counter. GDPR compliance reporting cannot quantify how many erasure requests were processed.

## Affected Files
- apps/messaging-service/src/compliance/ (audit, legal-hold, erasure)
- apps/messaging-service/src/messaging/services/message.service.ts
- apps/messaging-service/src/storage/ (blob cleanup)

## Dependencies
None.

## Atomic Commit Plan
```
security(messaging): add message idempotency, transactional audit, legal hold locks, GDPR metrics

No idempotency constraint allows duplicate messages. Compliance audit is
post-commit (lossy). Audit records are mutable. Legal hold has race condition.
No GDPR partition key, blob cleanup, or erasure metrics.

Add unique constraint on (messageId, tenantId) for idempotency. Move audit
writes inside main transaction. Add PostgreSQL triggers preventing UPDATE/DELETE
on audit_log. Add SELECT FOR UPDATE on legal hold check. Implement GDPR
partition key for efficient erasure. Add blob deletion cascade. Add
gdpr_erasure_total counter.

Plan: docs/plans/2026-04-09-high-fixes/packages/23-messaging-compliance-audit-gdpr.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-015
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-016
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-020
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-021
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-022
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-025
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-026
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-027
```

## Test Plan
- Unit test: duplicate message insert returns existing instead of creating new
- Unit test: audit write is inside same transaction as main operation
- Unit test: UPDATE on audit_log row throws trigger error
- Unit test: legal hold prevents message deletion (FOR UPDATE lock)
- Unit test: GDPR erasure deletes partition for data subject
- Unit test: blob cleanup triggered on message delete
- Unit test: gdpr_erasure_total counter increments on successful erasure

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/(compliance|messaging|storage)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
