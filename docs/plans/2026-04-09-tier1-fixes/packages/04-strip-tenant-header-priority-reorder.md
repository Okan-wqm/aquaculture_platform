# Package 04: strip-tenant-header-priority-reorder

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: no
Prerequisites: 03-allowed-base-domains-fail-closed
Closing-Findings: [SEC-HIGH-001]
Source-Reviews:
  - docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

`StripInternalHeadersMiddleware` strips `x-user-payload`, `x-user-id`, `x-user-roles` but does NOT strip `X-Tenant-Id`. An attacker can send `X-Tenant-Id: <any-string>` and it reaches `TenantContextMiddleware` where it has HIGHEST priority (line 97-99) -- above JWT. Between middleware setting `req.tenantId` and guard overriding it, any code reading `req.tenantId` sees the spoofed value. `RequestLoggingMiddleware` reads it, enabling log poisoning. Additionally, the libs/backend-common `TenantContextMiddleware` priority order should prefer JWT over header.

## Findings

**SEC-HIGH-001 [MEDIUM] -- StripInternalHeadersMiddleware does not strip x-tenant-id; header has highest priority**
- Source: security-reviewer
- File: `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts` -- only strips x-user-payload, x-user-id, x-user-roles
- File: `libs/backend-common/src/middleware/tenant-context.middleware.ts`, lines 95-110 -- X-Tenant-Id header is Priority 1 (above JWT at Priority 2)
- Evidence: Gateway middleware chain runs StripInternalHeaders before TenantContext; x-tenant-id passes through
- Remaining risk: log poisoning via RequestLoggingMiddleware reading spoofed req.tenantId

## Affected Files
- `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts` (3K chars, ~1K tokens) -- add x-tenant-id to stripped headers
- `libs/backend-common/src/middleware/tenant-context.middleware.ts` (11K chars, ~3K tokens) -- reorder priority: JWT first, then header, then subdomain, then query param

## Dependencies
- **03-allowed-base-domains-fail-closed** -- both packages modify `libs/backend-common/src/middleware/tenant-context.middleware.ts`. Package 03 changes line 170 (fail-open default). Package 04 changes lines 95-110 (priority order). Package 03 must be committed first to avoid merge conflicts and ensure the fail-closed default is in place before reordering.

## Atomic Commit Plan
```
security(gateway): strip x-tenant-id header and reorder tenant source priority

StripInternalHeadersMiddleware does not strip X-Tenant-Id, allowing
attackers to inject a spoofed tenant context that reaches
TenantContextMiddleware at highest priority (above JWT). This enables
log poisoning via RequestLoggingMiddleware.

Fix: (1) Add x-tenant-id to StripInternalHeadersMiddleware stripped
headers list. (2) Reorder extractTenantContext() priority to prefer
JWT over header: JWT -> subdomain -> header -> query param.

Closes: docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md#SEC-HIGH-001
Plan: docs/plans/2026-04-09-tier1-fixes/packages/04-strip-tenant-header-priority-reorder.md
```

## Test Plan
- Verify `StripInternalHeadersMiddleware` unit tests pass with x-tenant-id in the strip list
- Add test: request with `X-Tenant-Id` header -- verify it is stripped before reaching TenantContextMiddleware
- Verify `TenantContextMiddleware` unit tests pass with new priority order
- Add test: when both JWT tenantId and X-Tenant-Id header are present, JWT value is used
- Verify RequestLoggingMiddleware no longer logs attacker-supplied tenant ID

## Verification Command
```bash
npx tsc --noEmit -p apps/gateway-api/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx jest --testPathPattern="(apps/gateway-api/src/middleware|libs/backend-common/src/middleware/tenant-context)" --coverage=false
```
[Dispatch: security-reviewer]

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
