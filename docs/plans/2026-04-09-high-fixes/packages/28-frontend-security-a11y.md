# Package 28: frontend-security-a11y

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [FE-HIGH-009, FE-HIGH-010, FE-HIGH-011, FE-HIGH-012, FE-HIGH-017, FE-HIGH-018, FE-HIGH-019]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Frontend security and accessibility HIGHs: (1) push notification URL validation missing (open redirect via notification click), (2) WebSocket reconnect uses stale token (expired JWT on reconnect), (3) no CSP meta tag in frontend SPA, (4) raw fetch() calls bypass api-client interceptors (no auth headers, no error handling), (5-7) accessibility: focus management broken after modal close, missing WCAG 2.1 AA compliance on form components, keyboard navigation traps in SCADA builder.

## Findings

**FE-HIGH-009** (frontend-expert, HIGH)
Push notification click handler does not validate destination URL. Crafted notification payload can redirect user to phishing site.

**FE-HIGH-010** (frontend-expert, HIGH)
WebSocket reconnect handler reuses the original JWT from initial connection. On reconnect after disconnect, the token may be expired, causing auth failure loop.

**FE-HIGH-011** (frontend-expert, HIGH)
No Content-Security-Policy meta tag in the SPA shell. XSS protection relies entirely on React's JSX escaping. Script injection via DOM manipulation (e.g., SCADA custom widget HTML) is not prevented.

**FE-HIGH-012** (frontend-expert, HIGH)
Multiple components use raw fetch() instead of the api-client wrapper. These calls skip auth header injection, tenant header, error interceptors, and retry logic.

**FE-HIGH-017** (frontend-expert, HIGH)
Focus management broken after modal/dialog close. Focus returns to document body instead of trigger element. Screen reader users lose context.

**FE-HIGH-018** (frontend-expert, HIGH)
Form components missing WCAG 2.1 AA compliance: no aria-describedby for error messages, no aria-required on mandatory fields, color-only error indication.

**FE-HIGH-019** (frontend-expert, HIGH)
SCADA builder has keyboard navigation traps. Tab key cycles within widget panel without escape mechanism. Screen reader cannot access toolbar.

## Affected Files
- web/shell/src/notifications/pushHandler.ts
- web/shell/src/websocket/socketManager.ts
- web/shell/index.html (CSP)
- web/shared-ui/src/api-client/ (fetch bypass detection)
- web/shared-ui/src/components/ (modal, form, a11y)
- web/modules/sensor-module/src/components/scada-builder/

## Dependencies
None.

## Atomic Commit Plan
```
security(frontend): validate push URLs, refresh WebSocket token, add CSP, fix a11y

Push notification URL not validated (open redirect). WebSocket reconnect
uses stale JWT. No CSP in SPA. Raw fetch bypasses api-client. Focus
management broken. Missing WCAG 2.1 AA. SCADA keyboard traps.

Validate notification URL against allowlist. Refresh token before WebSocket
reconnect. Add CSP meta tag. Replace raw fetch with api-client. Implement
focus trap return on modal close. Add aria attributes to forms. Fix SCADA
keyboard navigation with roving tabindex.

Plan: docs/plans/2026-04-09-high-fixes/packages/28-frontend-security-a11y.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-009
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-010
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-011
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-012
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-017
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-018
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-019
```

## Test Plan
- Unit test: notification handler rejects non-allowlisted URLs
- Unit test: WebSocket reconnect fetches fresh token
- Test: CSP meta tag present in index.html
- Unit test: no raw fetch() outside api-client (ESLint rule)
- a11y test: focus returns to trigger after modal close
- a11y test: form fields have aria-describedby on error
- a11y test: SCADA builder Tab/Escape keyboard navigation works

## Verification Command
`npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/shell && npx vitest run web/shared-ui`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
