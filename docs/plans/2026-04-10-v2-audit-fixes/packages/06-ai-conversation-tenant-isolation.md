# Package 06: ai-conversation-tenant-isolation

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [messaging-expert/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
AI conversation sessions are readable and writable across tenants/users by conversation UUID alone. `getById(id)` has no tenant or owner predicate, and `agent-runner.service.ts` accepts a caller-supplied `conversationId`, loads that record, then appends turns without any ownership check. This is a tenant-boundary confidentiality breach and a prompt-injection vector.

## Findings
`CRITICAL-001` (messaging-expert): AI conversation sessions are readable and writable across tenants/users by conversation UUID. Files: `apps/ai-service/src/conversation/conversation.service.ts:31`, `apps/ai-service/src/agent/agent-runner.service.ts:99`. A user who knows or obtains another conversation UUID can hydrate another user's history into the prompt and mutate that conversation.

## Affected Files
- /var/aqua-saas/apps/ai-service/src/conversation/conversation.service.ts
- /var/aqua-saas/apps/ai-service/src/agent/agent-runner.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(ai): enforce tenant and user ownership on conversation access

AI conversation lookups and mutations used only the conversation UUID
with no tenant or user predicate, allowing any user who knows a
conversation ID to read or mutate another user's conversation history.
This is a cross-tenant confidentiality breach and prompt-injection
vector. All conversation queries now require tenantId plus userId in the
SQL predicate, and the agent runner rejects any conversationId not owned
by the current tenant/user before loading history.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/06-ai-conversation-tenant-isolation.md
Closes: docs/reviews/messaging-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Unit test: `getById` with wrong tenantId returns null or throws.
- Unit test: `getById` with wrong userId returns null or throws.
- Unit test: `addMessage` rejects conversationId not owned by caller.
- Integration test: user A cannot read user B's conversation.
- Integration test: tenant A cannot access tenant B's conversations.

## Verification Command
`npx tsc --noEmit -p apps/ai-service/tsconfig.json && npx jest --testPathPattern="apps/ai-service/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

