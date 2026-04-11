# MCP Review
**Date:** 2026-04-10  
**Scope:** `mcp/farm-management/**` and adjacent auth/runtime integration  
**Mode:** Static review only

## Verdict
**BLOCK**

## Findings

- `HIGH-001` User-controlled prompt arguments are interpolated directly into model instructions. [`server.ts:198-213`](/var/aqua-saas/mcp/farm-management/src/server.ts#L198-L213), [`daily-operations.ts:74-115`](/var/aqua-saas/mcp/farm-management/src/prompts/daily-operations.ts#L74-L115), [`batch-review.ts:86-123`](/var/aqua-saas/mcp/farm-management/src/prompts/batch-review.ts#L86-L123). `siteId` and `batchId` are inserted into the prompt body with no escaping or identifier validation, so a malicious value can rewrite the assistant’s tool instructions. Remediation: validate these fields as bounded identifiers, and render them as structured/JSON-encoded arguments instead of free-form string interpolation.

- `HIGH-002` Refresh tokens are treated as live session credentials. [`session-context.ts:43-64`](/var/aqua-saas/mcp/farm-management/src/auth/session-context.ts#L43-L64), [`session-context.ts:171-179`](/var/aqua-saas/mcp/farm-management/src/auth/session-context.ts#L171-L179), [`session-context.ts:211-233`](/var/aqua-saas/mcp/farm-management/src/auth/session-context.ts#L211-L233), [`server.ts:113-128`](/var/aqua-saas/mcp/farm-management/src/server.ts#L113-L128). The payload model distinguishes `access` and `refresh`, but session creation never rejects `refresh`, and the resulting token is proxied as an outbound `Authorization` bearer credential. Remediation: reject non-access tokens at session creation and introduce a dedicated refresh flow if one is ever needed.

- `HIGH-003` Partial GraphQL failures are converted into apparent success. [`client.ts:216-223`](/var/aqua-saas/mcp/farm-management/src/graphql/client.ts#L216-L223). When `errors[]` is present alongside `data`, the client logs a warning and returns `data` anyway. That lets downstream tools reason over incomplete or auth-filtered backend results as if they were authoritative. Remediation: propagate partial-failure state to callers, or fail closed unless a tool explicitly handles partial data.

- `MEDIUM-004` Degraded mode is not reflected in capability discovery. [`server.ts:111-157`](/var/aqua-saas/mcp/farm-management/src/server.ts#L111-L157), [`tools/index.ts:144-187`](/var/aqua-saas/mcp/farm-management/src/tools/index.ts#L144-L187). The server still advertises the full tool catalog even when `client === null`; the “math only” behavior happens only when a caller tries a blocked tool. That makes `tools/list` misleading and weakens the graceful-degradation story. Remediation: expose a reduced catalog in degraded mode, or mark unavailable tools as disabled in discovery.

## Cross-Domain Dependencies
| To | Issue | Status |
|---|---|---|
| `security-reviewer` | Prompt-argument injection into system-level instructions | Open |
| `auth-security-expert` | Refresh/access token semantics at the MCP gateway boundary | Open |
| `platform-kernel-expert` | Shared GraphQL failure semantics used by multiple tool paths | Open |

## Notes
Static review only. I did not run tests.
