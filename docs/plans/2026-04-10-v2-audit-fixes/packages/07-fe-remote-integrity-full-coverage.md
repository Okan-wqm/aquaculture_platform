# Package 07: fe-remote-integrity-full-coverage

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [frontend-expert/FE-CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The shell's remote integrity guard only inspects script URLs containing `remoteEntry`, while any other injected script path skips allowlist and SRI enforcement entirely. A compromised remote or malicious extension can load arbitrary scripts without any security check.

## Findings
`FE-CRITICAL-001` (frontend-expert): Remote integrity guard bypasses every non-`remoteEntry` script. File: `web/shell/src/utils/remoteIntegrity.ts:113`. `validateAndEnforceScriptSrc()` exits early unless `src.includes('remoteEntry')` is true.

## Affected Files
- /var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(shell): extend remote integrity guard to all federation scripts

The shell integrity guard only validated script URLs containing
'remoteEntry', allowing any other injected script to bypass allowlist
and SRI enforcement entirely. This extends validation to every script
URL inserted by the federation runtime, fails closed when a script URL
has no manifest pin in production, and enforces integrity at the runtime
createScript hook so the browser performs the check before execution.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/07-fe-remote-integrity-full-coverage.md
Closes: docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md#FE-CRITICAL-001
```

## Test Plan
- Unit test: non-remoteEntry script URLs are validated against allowlist.
- Unit test: script URL not in manifest is blocked in production mode.
- Unit test: SRI integrity attribute is enforced for all federation scripts.
- Negative test: injecting a script with no manifest entry fails.

## Verification Command
`npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/shell/src/utils`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

