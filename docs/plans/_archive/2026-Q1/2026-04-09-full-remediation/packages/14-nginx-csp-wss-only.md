# Package 14: nginx-csp-wss-only

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes (independent of 05-nginx-socketio-config-sync, different files/lines)
Prerequisites: 05-nginx-socketio-config-sync (recommended but not blocking — 05 adds /socket.io/ block, 14 tightens CSP)

## Context
The nginx CSP header allows `ws:` (unencrypted WebSocket) in production. Production should restrict to `wss:` only to prevent WebSocket downgrade attacks. This is a defense-in-depth measure complementing the TLS-only nginx configuration.

## Findings

**MEDIUM-018 [frontend-expert]: nginx CSP allows ws: (unencrypted WebSocket)**
- File: `nginx/nginx.conf` (line 103)
- Production should be `wss:` only
- All three nginx configs should be updated for consistency

Closing-Findings: [MEDIUM-018]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/nginx/nginx.conf`
- `/var/aqua-saas/infrastructure/docker/nginx/nginx.prod.conf`
- `/var/aqua-saas/infrastructure/nginx/droplet.conf`

## Dependencies
Soft dependency on package 05 (nginx-socketio-config-sync) which also modifies nginx configs. Recommended to execute after 05 to avoid merge conflicts, but not a hard prerequisite (different lines).

## Atomic Commit Plan
```
security(infra): restrict nginx CSP to wss: only, remove unencrypted ws:

Update Content-Security-Policy connect-src directive across all three
nginx configs to replace ws: with wss:. Production environment enforces
TLS via HSTS preload; allowing unencrypted WebSocket is inconsistent
with the TLS posture.

Plan: docs/plans/2026-04-09-full-remediation/packages/14-nginx-csp-wss-only.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-018
```

## Test Plan
- Verify nginx config syntax: `docker run --rm -v $(pwd)/nginx:/etc/nginx/conf.d nginx:alpine nginx -t` (or local nginx -t)
- Verify CSP header no longer contains `ws:` (only `wss:`)
- Check all three config files for consistency

## Verification Command
`grep -r "ws:" nginx/nginx.conf infrastructure/docker/nginx/nginx.prod.conf infrastructure/nginx/droplet.conf | grep -v "wss:" | grep -c "ws:" && echo "FAIL: ws: still present" || echo "PASS: no unencrypted ws:"`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
