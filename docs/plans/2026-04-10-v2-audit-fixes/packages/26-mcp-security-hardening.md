# Package 26: mcp-security-hardening

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 16K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [mcp-expert/HIGH-001, mcp-expert/HIGH-002, mcp-expert/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Three security issues in the MCP farm-management server: (1) user-controlled prompt arguments (siteId, batchId) are interpolated directly into model instructions without validation, enabling prompt injection; (2) refresh tokens are accepted as live session credentials and proxied as bearer tokens; (3) partial GraphQL failures are silently converted into apparent success, letting downstream tools reason over incomplete data as authoritative.

## Findings
`HIGH-001` (mcp-expert): User-controlled prompt arguments are interpolated directly into model instructions. Files: `mcp/farm-management/src/server.ts:198-213`, `mcp/farm-management/src/prompts/daily-operations.ts:74-115`, `mcp/farm-management/src/prompts/batch-review.ts:86-123`.

`HIGH-002` (mcp-expert): Refresh tokens are treated as live session credentials. Files: `mcp/farm-management/src/auth/session-context.ts:43-64,171-179,211-233`, `mcp/farm-management/src/server.ts:113-128`.

`HIGH-003` (mcp-expert): Partial GraphQL failures are converted into apparent success. File: `mcp/farm-management/src/graphql/client.ts:216-223`.

## Affected Files
- /var/aqua-saas/mcp/farm-management/src/server.ts
- /var/aqua-saas/mcp/farm-management/src/prompts/daily-operations.ts
- /var/aqua-saas/mcp/farm-management/src/prompts/batch-review.ts
- /var/aqua-saas/mcp/farm-management/src/auth/session-context.ts
- /var/aqua-saas/mcp/farm-management/src/graphql/client.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(mcp): fix prompt injection, token validation, and partial failure masking

Three security issues in the MCP farm-management server: (1) prompt
arguments were interpolated directly into model instructions without
validation, enabling prompt injection; (2) refresh tokens were accepted
as session credentials and proxied as bearer tokens; (3) partial
GraphQL failures were silently converted into success. This validates
prompt arguments as bounded identifiers with JSON encoding, rejects
non-access tokens at session creation, and propagates partial-failure
state to callers instead of masking it.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/26-mcp-security-hardening.md
Closes: docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md#HIGH-002
Closes: docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Unit test: siteId/batchId with injection characters are rejected.
- Unit test: prompt arguments are JSON-encoded, not interpolated.
- Unit test: refresh token at session creation is rejected.
- Unit test: only access tokens are accepted for session creation.
- Unit test: GraphQL response with errors[] raises an error or returns partial marker.
- Negative test: prompt injection payload does not alter model instructions.

## Verification Command
`cd /var/aqua-saas/mcp/farm-management && npx tsc --noEmit && npx jest --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

