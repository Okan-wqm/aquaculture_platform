# Package 03: allowed-base-domains-fail-closed

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes (no prerequisites)
Prerequisites: none
Closing-Findings: [SEC-HIGH-003, TENANT-HIGH-001]
Source-Reviews:
  - docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md
  - docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

The `isAllowedBaseDomain()` method in `tenant-context.middleware.ts` at line 170 returns `true` when `ALLOWED_BASE_DOMAINS` is not configured in production, creating a fail-open default. An attacker who controls a subdomain like `<victim-tenant-uuid>.attacker.com` pointed at the production IP can inject a tenant context via subdomain extraction. While guards override this before data access (making it not directly exploitable), it violates OWASP A05 Security Misconfiguration and is a latent vulnerability vector. Fix is trivial: change `return true` to `return false`.

## Findings

**SEC-HIGH-003 [MEDIUM, trivial fix] -- ALLOWED_BASE_DOMAINS fails open in production**
- Source: security-reviewer
- File: `libs/backend-common/src/middleware/tenant-context.middleware.ts`, lines 160-179
- Evidence: Line 168-170: `if (!allowedDomainsEnv) { return true; }` -- fail-open when env var unset
- Comment says "backward compatible" but violates fail-closed security principle
- Fix: Change line 170 from `return true` to `return false`

**TENANT-HIGH-001 [corroborates] -- TenantContextMiddleware + ALLOWED_BASE_DOMAINS assessment**
- Source: multi-tenant-saas-expert
- Confirms defense-in-depth gap; recommends `return false` + production env var requirement

## Affected Files
- `libs/backend-common/src/middleware/tenant-context.middleware.ts` (11K chars, ~3K tokens) -- line 170 only

## Dependencies
None. This is a 1-line change. Package 04 touches the same file but at different lines (95-110 for header stripping). Both can be authored independently, but if executed in the same session, 04 should come after 03 to avoid merge conflicts.

## Atomic Commit Plan
```
security(backend-common): invert ALLOWED_BASE_DOMAINS default to fail-closed

isAllowedBaseDomain() at line 170 returns true when ALLOWED_BASE_DOMAINS
is not configured in production, creating a fail-open default that
violates OWASP A05. An attacker-controlled subdomain can inject a
tenant context via subdomain extraction.

Fix: Change `return true` to `return false`. When ALLOWED_BASE_DOMAINS
is not configured in production, reject all subdomain-based tenant
extraction (fail-closed).

Closes: docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md#SEC-HIGH-003
Closes: docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md#TENANT-HIGH-001
Plan: docs/plans/2026-04-09-tier1-fixes/packages/03-allowed-base-domains-fail-closed.md
```

## Test Plan
- Existing unit tests for `TenantContextMiddleware` must pass
- Add/update test case: when `ALLOWED_BASE_DOMAINS` is not set and `NODE_ENV=production`, `isAllowedBaseDomain()` returns `false`
- Add/update test case: when `ALLOWED_BASE_DOMAINS` is set, valid domains still return `true`
- Verify no regression on subdomain extraction for configured domains

## Verification Command
```bash
npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx jest --testPathPattern="libs/backend-common/src/middleware/tenant-context" --coverage=false
```
[Dispatch: security-reviewer]

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
