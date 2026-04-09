# Package 20: gdpr-race-cascade

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [MSG-CRITICAL-019, MSG-CRITICAL-024]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two GDPR anonymization defects: (1) the anonymize operation checks for legal holds (TOCTOU) without holding a lock, so a concurrent legal hold creation between the check and the anonymize execution allows anonymization of legally-held data -- destroying evidence; (2) the anonymize operation does not cascade to AgentConversation records, leaving PII in AI chat history even after the user exercises their right to erasure (GDPR Article 17 violation).

## Findings
- **MSG-CRITICAL-019**: GDPR anonymize legal hold check TOCTOU race
  - File: `apps/messaging-service/src/gdpr/gdpr.service.ts` (~14.6K chars)
  - Check for legal hold and anonymize are not in the same transaction with a lock
  - Root cause: legal hold check is a read-only query before the write operation

- **MSG-CRITICAL-024**: GDPR anonymize doesn't cascade to AgentConversation
  - File: `apps/messaging-service/src/gdpr/gdpr.service.ts`
  - Anonymization covers messages and contacts but not AI agent conversations

## Affected Files
- `/var/aqua-saas/apps/messaging-service/src/gdpr/gdpr.service.ts` (~14.6K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(messaging): fix GDPR anonymize TOCTOU race and add AgentConversation cascade

1. gdpr.service.ts: wrap legal hold check + anonymize in a single
   transaction with SELECT FOR UPDATE on the legal_hold table for the
   target user. This serializes concurrent hold creation and anonymization.
2. gdpr.service.ts: add AgentConversation anonymization to the cascade
   list -- replace user messages with '[ANONYMIZED]', remove embeddings,
   clear metadata containing PII.

Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-019
Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-024
Plan: docs/plans/2026-04-09-critical-fixes/packages/20-gdpr-race-cascade.md
```

## Test Plan
- Unit test: anonymize with active legal hold -- rejects with LegalHoldActiveError
- Integration test: concurrent legal hold creation during anonymize -- one wins, other fails
- Unit test: anonymize cascades to AgentConversation records
- Unit test: anonymized AgentConversation has no PII (messages, embeddings, metadata cleared)

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/messaging-service/src/gdpr" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
