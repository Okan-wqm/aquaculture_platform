# Package 23: fe-csp-remove-unsafe-inline

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 8K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [frontend-expert/FE-HIGH-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The shell fallback CSP in `index.html` includes `'unsafe-inline'` in both `script-src` and `script-src-elem` directives. There is no inline script requirement in the document, so the allowance is broader than needed and materially weakens XSS defense-in-depth when the HTTP header is absent or misconfigured.

## Findings
`FE-HIGH-001` (frontend-expert): Shell fallback CSP still allows inline script execution. File: `web/shell/index.html:17`. The fallback CSP includes `script-src 'self' 'unsafe-inline' ...` and `script-src-elem 'self' 'unsafe-inline' ...`.

## Affected Files
- /var/aqua-saas/web/shell/index.html

## Dependencies
None.

## Atomic Commit Plan
```
security(shell): remove unsafe-inline from fallback CSP directives

The shell fallback CSP permitted inline script execution via
'unsafe-inline' in script-src and script-src-elem directives, with no
inline script requirement in the document. This removes unsafe-inline,
moves any necessary inline scripts behind nonce-based enforcement, and
aligns the fallback policy with the production HTTP header.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/23-fe-csp-remove-unsafe-inline.md
Closes: docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md#FE-HIGH-001
```

## Test Plan
- Verify `'unsafe-inline'` does not appear in any CSP directive in index.html.
- Verify the application loads correctly without inline scripts.
- If nonces are used, verify nonce rotation on each page load.
- Manual test: XSS payload via inline script injection is blocked by CSP.

## Verification Command
`grep -c "unsafe-inline" /var/aqua-saas/web/shell/index.html | grep '^0$'`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

