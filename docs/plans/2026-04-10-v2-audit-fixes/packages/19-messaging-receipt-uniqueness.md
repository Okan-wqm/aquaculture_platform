# Package 19: messaging-receipt-uniqueness

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [database-reviewer/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The `message_receipts` table is partitioned by `receiptCreatedAt`, but its unique key includes the partition column instead of the logical identity alone. The application treats receipts as one row per `messageId + userId`, but duplicate logical receipts can survive across partitions/months and `mark-read` cannot reliably enforce a single current receipt row.

## Findings
`HIGH-003` (database-reviewer): `message_receipts` partitioning makes the intended logical uniqueness unenforceable. Files: `apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts:231-247`, `apps/messaging-service/src/message/commands/mark-read.handler.ts:63-88`.

## Affected Files
- /var/aqua-saas/apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts
- /var/aqua-saas/apps/messaging-service/src/message/commands/mark-read.handler.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(messaging): enforce logical receipt uniqueness independent of partitions

message_receipts was partitioned by receiptCreatedAt with the partition
column in the unique key, allowing duplicate logical receipts (same
messageId+userId) across partition boundaries. This redesigns the
receipt table to enforce logical uniqueness via a separate
current-receipt tracking mechanism that is independent of the partition
scheme, ensuring mark-read reliably operates on a single current row.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/19-messaging-receipt-uniqueness.md
Closes: docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Migration test: duplicate receipts across partitions are prevented.
- Unit test: mark-read handler finds exactly one receipt per messageId+userId.
- Integration test: receipts created in different months do not produce duplicates.
- GDPR test: export/delete can locate all receipts for a given user.

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

