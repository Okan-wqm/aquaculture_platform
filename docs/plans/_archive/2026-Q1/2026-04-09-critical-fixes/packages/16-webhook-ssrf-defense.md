# Package 16: webhook-ssrf-defense

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [PLAT-CRITICAL-006]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The webhook/notification dispatcher makes outbound HTTP requests to user-configured URLs without SSRF protections: no DNS resolution validation, no IP address pinning, and HTTP redirects are followed. An attacker can configure a webhook URL pointing to internal services (169.254.169.254 for cloud metadata, internal Kubernetes service DNS names, localhost ports) to exfiltrate secrets or scan the internal network.

## Findings
- **PLAT-CRITICAL-006**: Webhook SSRF no DNS resolve, no IP pin, redirects enabled
  - File: `apps/notification-service/src/notification/services/notification-dispatcher.service.ts` (~29K chars)
  - Outbound HTTP calls use default axios/fetch with no SSRF guards
  - Root cause: webhook dispatch treats user URLs as trusted

## Affected Files
- `/var/aqua-saas/apps/notification-service/src/notification/services/notification-dispatcher.service.ts` (~29K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(notification): add SSRF defense to webhook dispatcher

1. Add DNS resolution step before HTTP request: resolve hostname,
   reject if IP is in private/loopback/link-local/metadata ranges
   (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
   169.254.0.0/16, ::1, fc00::/7, fe80::/10).
2. Pin resolved IP in the HTTP request to prevent DNS rebinding
   (resolve once, connect to that IP with Host header).
3. Disable HTTP redirect following (maxRedirects: 0).
4. Add URL scheme allowlist: only https:// (no http://, no file://).

Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-006
Plan: docs/plans/2026-04-09-critical-fixes/packages/16-webhook-ssrf-defense.md
```

## Test Plan
- Unit test: webhook to 169.254.169.254 -- rejected (cloud metadata)
- Unit test: webhook to 10.0.0.1 -- rejected (private network)
- Unit test: webhook to 127.0.0.1 -- rejected (loopback)
- Unit test: webhook to valid public IP -- succeeds
- Unit test: webhook with http:// scheme -- rejected
- Unit test: redirect response -- not followed

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/notification-service/tsconfig.json && npx jest --testPathPattern="apps/notification-service/src/notification" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
