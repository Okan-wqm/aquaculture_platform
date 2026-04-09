# Package 05: nginx-socketio-config-sync

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (no prerequisites)
Prerequisites: none
Closing-Findings: [INFRA-HIGH-001, INFRA-MEDIUM-001, INFRA-MEDIUM-002]
Source-Reviews:
  - docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

Three divergent nginx configs exist: `nginx/nginx.conf`, `infrastructure/docker/nginx/nginx.prod.conf`, and `infrastructure/nginx/droplet.conf`. The production config (`droplet.conf`) correctly has a `/socket.io/` location block, but the other two configs are missing it entirely. If either non-droplet config is used (e.g., staging with `docker-compose.prod.yml`), all real-time features silently fail: farm events, messaging, sensor readings, and ST language diagnostics. Additionally, the catch-all `location /` in `droplet.conf` lacks WebSocket upgrade headers, creating a fragile fallback for future WebSocket features. All three findings are grouped because they touch the same three files and share the root cause of config drift.

## Findings

**INFRA-HIGH-001 [MEDIUM] -- nginx.prod.conf and nginx/nginx.conf missing /socket.io/ location block**
- Source: infra-expert
- Files: `nginx/nginx.conf`, `infrastructure/docker/nginx/nginx.prod.conf`
- Evidence: No `/socket.io/` location block. WebSocket connections caught by `location /` and proxied to `shell:80` (static file server)
- Impact: ALL real-time features silently fail if these configs are used
- Reference config: `infrastructure/nginx/droplet.conf` lines 255-272 has the correct block

**INFRA-MEDIUM-001 [MEDIUM] -- Catch-all location / lacks WebSocket upgrade headers**
- Source: infra-expert
- File: `infrastructure/nginx/droplet.conf`, lines 394-401
- Catch-all does not set `proxy_set_header Upgrade` / `Connection` -- fine because /socket.io/ catches first, but fragile

**INFRA-MEDIUM-002 [MEDIUM] -- Three divergent nginx config files**
- Source: infra-expert
- Config drift: droplet.conf has /socket.io/, MQTT stream proxy, /install/, /api/devices/, robots.txt, debug blocks that the other two configs are missing
- Maintenance trap: fixes applied to one config not propagated to others

## Affected Files
- `nginx/nginx.conf` (18K chars, ~5K tokens) -- add /socket.io/ location block
- `infrastructure/docker/nginx/nginx.prod.conf` (16K chars, ~5K tokens) -- add /socket.io/ location block
- `infrastructure/nginx/droplet.conf` (17K chars, ~5K tokens) -- add WebSocket upgrade to catch-all

## Dependencies
None. Nginx config files are independent of all other packages.

## Atomic Commit Plan
```
fix(infra): add /socket.io/ to nginx.prod.conf and nginx.conf, add WebSocket upgrade to droplet catch-all

nginx.prod.conf and nginx/nginx.conf are missing the /socket.io/
location block that droplet.conf has at lines 255-272. If these configs
are used (e.g., staging via docker-compose.prod.yml), all real-time
WebSocket features silently fail. Additionally, droplet.conf catch-all
location / lacks WebSocket upgrade headers.

Fix: (1) Copy /socket.io/ location block from droplet.conf into
nginx.prod.conf and nginx/nginx.conf. (2) Add WebSocket upgrade
headers to droplet.conf catch-all location /.

Closes: docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md#INFRA-HIGH-001
Closes: docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md#INFRA-MEDIUM-001
Closes: docs/reviews/infra-expert/2026-04-09-nginx-websocket-validation.md#INFRA-MEDIUM-002
Plan: docs/plans/2026-04-09-tier1-fixes/packages/05-nginx-socketio-config-sync.md
```

## Test Plan
- Validate nginx config syntax: `docker run --rm -v $(pwd)/nginx:/etc/nginx/conf.d nginx:stable nginx -t` (or equivalent for each config)
- Manual verification: confirm `/socket.io/` location block is present in all three configs
- Compare the three configs for feature parity on key blocks: /socket.io/, /graphql, /api/
- If a staging environment is available, test WebSocket connection to /farms namespace

## Verification Command
```bash
docker run --rm -v /var/aqua-saas/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro nginx:stable nginx -t 2>&1 && docker run --rm -v /var/aqua-saas/infrastructure/docker/nginx/nginx.prod.conf:/etc/nginx/conf.d/default.conf:ro nginx:stable nginx -t 2>&1 && echo "All nginx configs valid"
```

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
