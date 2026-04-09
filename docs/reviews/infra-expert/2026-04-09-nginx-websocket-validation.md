# Validation Report: HIGH-005 — WebSocket Namespaces Missing from Nginx Reverse Proxy

**Date:** 2026-04-09
**Agent:** infra-expert
**Scope:** Validate nginx WebSocket routing for Socket.IO namespaces

---

## Verdict: PARTIALLY CONFIRMED — Downgrade from HIGH to MEDIUM

The original finding identified a real problem but targeted the wrong file and partly mischaracterized the failure mode.

---

## Evidence Summary

### Three distinct nginx configs exist:

| Config file | Used by | Mount path |
|---|---|---|
| `nginx/nginx.conf` | standalone/development | Not mounted by any compose file directly |
| `infrastructure/docker/nginx/nginx.prod.conf` | `docker-compose.prod.yml` | Mounted as `/etc/nginx/conf.d/default.conf` (line 484) |
| `infrastructure/nginx/droplet.conf` | `docker-compose.droplet.yml` | Mounted as `/etc/nginx/nginx.conf` (line 1120) |

### Production config (`droplet.conf`) is CORRECT

`droplet.conf` has a `/socket.io/` location block at lines 255-272:
```nginx
location /socket.io/ {
    set $backend_gw_ws gateway-api;
    proxy_pass http://$backend_gw_ws:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 300s;
}
```

### Socket.IO namespace routing

Socket.IO does NOT use namespace as URL path prefix. When connecting to namespace `/farms`, the HTTP request is:
```
GET /socket.io/?EIO=4&transport=polling&nsp=/farms
```

The namespace is a query parameter, not a path prefix. All namespaces hit `/socket.io/`.

Client-side confirms:
- `useFarmRealtimeStream.ts` line 69: `return \`${baseUrl}/farms\`` → `io()` namespace param
- `useSensorSocket.ts` line 17: defaults to `'/sensors'`
- `st-websocket.service.ts` line 22: defaults to `'/st-language'`
- `useMessageSocket.ts` line 96: `io('/messaging', {...})`

---

## Confirmed Findings

### INFRA-HIGH-001: Two nginx configs missing `/socket.io/` location block [MEDIUM]

`nginx/nginx.conf` and `infrastructure/docker/nginx/nginx.prod.conf` have NO `/socket.io/` location block. WebSocket connections to any namespace would be caught by `location /` and proxied to `shell:80` (static file server), returning 404 or `index.html`.

**Impact:** If these configs were used in production, ALL real-time features silently fail:
- `/farms` — real-time batch/harvest/mortality/feeding events
- `/messaging` — real-time chat, presence, typing indicators
- `/sensors` — live sensor readings, SCADA displays
- `/st-language` — ST language editor diagnostics

**Severity: MEDIUM** (downgraded) — Production (`droplet.conf`) is correct. Risk is config drift / wrong compose file usage.

### INFRA-MEDIUM-001: Catch-all `location /` lacks WebSocket upgrade [MEDIUM]

`droplet.conf` catch-all at line 394-401 does NOT set WebSocket upgrade headers. Fine because `/socket.io/` catches first, but fragile for future WebSocket features.

### INFRA-MEDIUM-002: Three divergent nginx configs [MEDIUM]

Three config files serve the same purpose but have diverged:
- `droplet.conf` has: `/socket.io/`, MQTT stream proxy, `/install/`, `/api/devices/`, `robots.txt`, debug blocks
- `nginx.prod.conf` and `nginx/nginx.conf` are missing all of these
- Maintenance trap: fixes applied to one config not propagated

---

## Remediation

Add to `nginx.prod.conf` (before `location /graphql`):
```nginx
location /socket.io/ {
    proxy_pass http://gateway;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

Same block for `nginx/nginx.conf`.

**Long-term:** Consolidate to single nginx config template with environment-specific overrides.

---

## Finding Summary

| ID | Severity | Description | Status |
|---|---|---|---|
| INFRA-HIGH-001 | MEDIUM (downgraded) | `nginx.prod.conf` and `nginx/nginx.conf` missing `/socket.io/` block | OPEN |
| INFRA-MEDIUM-001 | MEDIUM | Catch-all `location /` lacks WebSocket upgrade headers | OPEN |
| INFRA-MEDIUM-002 | MEDIUM | Three divergent nginx config files | OPEN |
