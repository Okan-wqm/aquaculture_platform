# Infrastructure Security Audit — Findings Review

**Date:** 2026-04-05
**Reviewer:** infra-expert
**Scope:** Targeted audit of six known findings from security-audit-2026-03-30.md plus new findings sweep across `infra/`, `.github/workflows/`, `docker-compose*.yml`, NATS configuration
**Prior Reviews:** None (first infra-expert review)

---

## Audit Summary

| Finding | ID | Severity | Status |
|---|---|---|---|
| NATS account-level ACLs per service | C-09 (partial) | HIGH | NOT IMPLEMENTED |
| NATS subjects not tenant-scoped | M-15 | MEDIUM | NOT IMPLEMENTED |
| No TLS for internal connections | M-09 | MEDIUM | PARTIAL (Terraform only) |
| Per-service PG roles | M-10 | MEDIUM | BROKEN — roles exist, compose uses superuser |
| SRI hash-pinning CI integration | M-02 | MEDIUM | NOT IMPLEMENTED |
| Module Federation dependency pinning | L-11 | LOW | NOT FIXED |
| NEW: docker-compose.prod.yml NATS auth silently broken | N/A | CRITICAL | NEW FINDING |
| NEW: nginx:alpine unpinned in production | N/A | MEDIUM | NEW FINDING |
| NEW: timescaledb:latest-pg16 unpinned in production | N/A | MEDIUM | NEW FINDING |
| NEW: npm install instead of npm ci in CI | N/A | MEDIUM | NEW FINDING |
| NEW: e2e-tests script fallback to npm install --with-scripts | N/A | HIGH | NEW FINDING |
| NEW: K8s network policies absent | N/A | HIGH | NEW FINDING |
| NEW: All services share one NATS credential in droplet | N/A | HIGH | NEW FINDING |

---

## Finding 1: C-09 — NATS Account-Level ACLs Per Service

**Severity:** HIGH (originally CRITICAL; authentication now partially implemented, reducing blast radius)
**Status:** Authentication partial fix present; per-service ACL enforcement absent

### Current State

The March 2026 audit flagged NATS as completely unauthenticated (H-01). That is now resolved in `docker-compose.droplet.yml`: the NATS container injects `NATS_USER`/`NATS_PASS` from environment, and `infrastructure/docker/nats/nats.conf` contains a single-user `authorization {}` block that enforces password authentication.

The remaining gap from C-09 is: all 12 backend services share **one credential** (`NATS_AUTH_USER`/`NATS_AUTH_PASS` map to the same single NATS user). The `nats.conf` `authorization {}` block supports only one user entry. There are no per-service accounts, no subject-level `publish {}` / `subscribe {}` ACL blocks.

```
# infrastructure/docker/nats/nats.conf lines 32-37
authorization {
  user: $NATS_USER
  password: $NATS_PASS
  timeout: 5
}
```

A compromised `sensor-service` container can publish `events.TenantProvisioned`, `events.UserDeleted`, `events.SubscriptionCancelled`, or any other subject, impersonating any other service. There is no server-side enforcement of subject ownership.

### Files

- `/var/aqua-saas/infrastructure/docker/nats/nats.conf` — lines 29-37 (authorization block)
- `/var/aqua-saas/docker-compose.droplet.yml` — lines 204-207, 307-310, 356-359, 406-409, 465-468, 512-515, 554-557, 596-599, 638-641, 680-683, 765-768, 811-814 (all services share `NATS_AUTH_USER`)

### Required State

NATS supports multi-user authorization with per-user `permissions` blocks governing which subjects each identity may publish to and subscribe from. The architectural fix is to replace the single-user `authorization {}` block with a `accounts {}` and per-account `users {}` structure with explicit subject permissions for each service.

### Architectural Fix

Replace `authorization {}` with NATS accounts and per-service users:

```text
accounts {
  AUTH_SVC: {
    users: [{ user: auth_service, password: $NATS_PASS_AUTH }]
    exports: [{ stream: "events.User*" }, { stream: "events.Invitation*" }]
    imports: [{ stream: { account: NOTIF_SVC, subject: "events.Notification*" } }]
  }
  BILLING_SVC: {
    users: [{ user: billing_service, password: $NATS_PASS_BILLING }]
    exports: [{ stream: "events.Subscription*" }, { stream: "events.Invoice*" }, { stream: "events.Payment*" }]
    imports: [{ stream: { account: AUTH_SVC, subject: "events.User*" } }]
  }
  ...
}
```

Each service gets its own NATS account with `exports` (subjects it may publish) and `imports` (subjects from other accounts it may subscribe to). Environment variables per service (`NATS_PASS_AUTH`, `NATS_PASS_BILLING`, etc.) are individually rotatable secrets.

This requires: (a) updating `nats.conf` to accounts model, (b) adding per-service NATS password env vars to all compose files, (c) updating `NatsEventBus` in `platform/libs/event-bus/src/nats/nats-event-bus.ts` to use `NATS_AUTH_USER`/`NATS_AUTH_PASS` environment variables per service (the code at lines 113-115 already reads them; the compose just needs distinct values).

---

## Finding 2 (NEW — CRITICAL): docker-compose.prod.yml — NATS Auth Silently Disabled

**Severity:** CRITICAL
**Status:** NEW FINDING (not in the March audit)

### Current State

`docker-compose.prod.yml` mounts `nats.conf` (which contains the `authorization {}` block referencing `$NATS_USER` and `$NATS_PASS`) but does **not** inject `NATS_USER` or `NATS_PASS` environment variables into the NATS container. NATS performs variable substitution at startup from the container's environment. With the variables absent, NATS substitutes empty strings, producing:

```
authorization {
  user: ""
  password: ""
  timeout: 5
}
```

This means NATS accepts connections with an empty username and password, or potentially rejects all connections (depending on NATS version behavior). Either way the auth intent is silently broken. Services in `docker-compose.prod.yml` also have no `NATS_AUTH_USER`/`NATS_AUTH_PASS` environment variables set — they connect to `nats://nats:4222` with no credentials.

The `docker-compose.droplet.yml` correctly injects `NATS_USER`/`NATS_PASS` into the NATS container (lines 114-115) and `NATS_AUTH_USER`/`NATS_AUTH_PASS` into all services. `docker-compose.prod.yml` is missing both.

### Files

- `/var/aqua-saas/docker-compose.prod.yml` — lines 74-91 (nats service, no environment block)
- `/var/aqua-saas/docker-compose.prod.yml` — lines 100-165 (backend services, no NATS auth env vars)

### Architectural Fix

The `docker-compose.prod.yml` NATS service block must be aligned with `docker-compose.droplet.yml`. The NATS container needs:

```yaml
environment:
  NATS_USER: ${NATS_USER:-nats_internal}
  NATS_PASS: "${NATS_PASS:?NATS_PASS is required}"
```

And every backend service needs:
```yaml
NATS_AUTH_USER: ${NATS_AUTH_USER:-nats_internal}
NATS_AUTH_PASS: "${NATS_AUTH_PASS:?NATS_AUTH_PASS is required}"
```

This is a deploy-blocking defect. Until fixed, `docker-compose.prod.yml` provides no NATS authentication in production despite the config file containing an auth block.

---

## Finding 3: M-15 — NATS Subjects Not Tenant-Scoped

**Severity:** MEDIUM
**Status:** NOT IMPLEMENTED

### Current State

Event subjects use flat `events.{EventType}` format. The `NatsEventBus.publish()` method at line 276 of `platform/libs/event-bus/src/nats/nats-event-bus.ts` constructs subjects as `events.${event.eventType}`:

```typescript
// Line 276
await this.publishTo(`events.${event.eventType}`, event, options);
```

The stream configuration at lines 432-445 accepts `events.>` as a wildcard. There is no tenant token in the subject hierarchy. `tenantId` is present in the event payload (enforced by `BaseEvent` interface in `libs/event-contracts/src/base-event.ts` line 29) but not in the subject path.

A subscription to `events.UserCreated` receives UserCreated events from all tenants. Any service with NATS access can subscribe to all tenant events, requiring application-level filtering to prevent cross-tenant leakage. With the current single-account model (Finding 1), a compromised service can receive events from tenants it should not serve.

Additionally, the `subscribe()` method at line 315 subscribes to `events.{eventType}` — subscribing to `events.UserCreated` means receiving all tenants' UserCreated events. Filtering is left to the handler.

### Files

- `/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts` — lines 276, 315-316, 434
- `/var/aqua-saas/libs/event-contracts/src/auth-events.ts` — all event types (subjects are global)
- `/var/aqua-saas/libs/event-contracts/src/base-event.ts` — line 29 (tenantId in payload only)

### Architectural Fix

Move `tenantId` into the subject hierarchy: `events.{tenantId}.{EventType}`. This enables per-tenant ACL enforcement at the NATS server level and prevents cross-tenant event consumption without requiring application-layer filtering.

Changes required:
1. `NatsEventBus.publish()`: construct subject as `events.${event.tenantId}.${event.eventType}`
2. `NatsEventBus.subscribe()`: accept a `tenantId` parameter or subscribe to `events.*.{eventType}` with a filter (NATS JetStream supports `filter_subject` on consumers)
3. Stream `subjects` configuration: change `events.>` to `events.>` (no change needed — wildcard already covers the deeper hierarchy)
4. NATS per-service ACLs (Finding 1): permissions become `events.<own-tenantId>.*` per service, preventing cross-tenant publish

A transition plan is required: existing JetStream consumers use `events.{eventType}` filter subjects; migrating requires a consumer rename and brief dual-publish period.

---

## Finding 4: M-09 — No TLS for Redis/PostgreSQL/NATS Internal Connections

**Severity:** MEDIUM
**Status:** PARTIAL — Terraform (AWS) path has TLS; Docker Compose (production droplet) path does not

### Current State

**Terraform/AWS path (resolved):** `infrastructure/terraform/environments/production/main.tf` line shows `transit_encryption_enabled = true` for ElastiCache. RDS uses SSL by default with engine-level enforcement.

**Docker Compose/Droplet path (not resolved):**

- **Redis:** `docker-compose.droplet.yml` line 82 uses plain `redis:7-alpine` with `--requirepass` flag only. No TLS configuration. Services connect via `redis://:${REDIS_PASSWORD}@redis:6379` (plaintext). No `rediss://` URLs appear in any compose file.

- **PostgreSQL:** Services use `DATABASE_URL: postgres://...@postgres:5432/...` (plaintext). No `sslmode=require` or `sslmode=verify-full` appended to any DATABASE_URL in `docker-compose.droplet.yml`.

- **NATS:** Services connect via `NATS_URL: nats://nats:4222` (plaintext). The TLS-capable config files (`nats-tls.conf`, `nats-tls-enabled.conf`) exist in `infrastructure/docker/nats/` but are not mounted. `NATS_TLS_ENABLED` is not set in any compose service. The `NatsEventBus` constructor at lines 107-115 reads TLS config from env but finds nothing, so TLS is disabled.

The threat model comment in `docker-compose.droplet.yml` lines 13-16 acknowledges this: "SEC-013: Trust boundary — all inter-service traffic travels on the aqua-internal Docker bridge network in plain HTTP/TCP." The `aqua-internal: internal: true` network prevents external routing but all containers sharing the network can observe each other's traffic with packet capture after a single container escape.

### Files

- `/var/aqua-saas/docker-compose.droplet.yml` — lines 82 (Redis), 195-202 (gateway DATABASE_URL), 204 (NATS_URL for every service)
- `/var/aqua-saas/infrastructure/docker/nats/nats-tls-enabled.conf` — exists but not mounted
- `/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts` — lines 107-115 (TLS config read from env, disabled)

### Architectural Fix

For the Docker Compose production path, the resolution is a service mesh or per-connection mTLS rather than manual TLS configuration on each service:

1. **Immediate (pragmatic):** Enable Redis TLS by running redis with `--tls-port 6380 --tls-cert-file ... --tls-key-file ...` and updating REDIS_URL to `rediss://`. Mount NATS TLS config (`nats-tls-enabled.conf`). Set `NATS_TLS_ENABLED=true` on all services. Append `?sslmode=require` to all PostgreSQL DATABASE_URLs (PostgreSQL image must have SSL enabled via `ssl = on` in postgresql.conf).

2. **Long-term (preferred):** Deploy a sidecar mTLS service mesh (e.g., Envoy/Consul Connect) on the Docker host. This encrypts all inter-container TCP without per-service TLS configuration. The `aqua-internal` network provides network-layer isolation; mTLS adds transport-layer encryption and mutual authentication between services.

---

## Finding 5: M-10 — Per-Service PostgreSQL Roles Not Used by Services

**Severity:** HIGH (escalated from MEDIUM — unfixed, structural gap directly enables lateral movement)
**Status:** BROKEN — roles created at init time but all services authenticate as superuser

### Current State

`infrastructure/docker/init-scripts/00-init-schemas.sh` creates per-service roles (`auth_service`, `farm_service`, `sensor_service`, etc.) with schema-scoped grants. This is correct and complete.

However, every service in `docker-compose.droplet.yml` connects with:

```yaml
DATABASE_USER: ${POSTGRES_USER:-aquaculture}      # the superuser
DATABASE_PASSWORD: ${POSTGRES_PASSWORD:?...}
```

And in `docker-compose.prod.yml`, all DATABASE_URLs are:

```
postgres://${POSTGRES_USER:-aquaculture}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-aquaculture}
```

`POSTGRES_USER` defaults to `aquaculture`, which is the PostgreSQL superuser created at image startup. The per-service roles exist in the database but no service uses them. Every service has unrestricted access to every schema, negating the isolation the init script was designed to provide.

### Files

- `/var/aqua-saas/docker-compose.droplet.yml` — lines 197-198 (gateway), 301-302 (auth), 351-352 (farm), 398-399 (sensor), 458-459 (admin), 507-508 (alert), 549-550 (billing), 591-592 (hr), 633-634 (hydroponics), 675-676 (notification), 760-761 (config), 802-803 (messaging)
- `/var/aqua-saas/docker-compose.prod.yml` — lines 104, 143, 167, 191, 214, 237, 262, 288, 317, 320-321, 352 (all use POSTGRES_USER)
- `/var/aqua-saas/infrastructure/docker/init-scripts/00-init-schemas.sh` — lines for role creation (roles exist but unused)

### Architectural Fix

Each service must be configured with its own per-service credential:

```yaml
# auth-service in docker-compose.droplet.yml
DATABASE_USER: auth_service
DATABASE_PASSWORD: "${AUTH_SERVICE_DB_PASS:?AUTH_SERVICE_DB_PASS is required}"
```

The `AUTH_SERVICE_DB_PASS` variable is already passed to the postgres init container (line 20 in droplet compose) so the password is set during `00-init-schemas.sh`. The gap is that services are not told to use their specific role.

For services using `DATABASE_URL` (single connection string), the format becomes:
```
postgres://auth_service:${AUTH_SERVICE_DB_PASS}@postgres:5432/${POSTGRES_DB:-aquaculture}?search_path=auth
```

The `search_path` query parameter ensures the service's default schema resolves without further configuration. TypeORM requires the `schema` option to match; NestJS TypeORM module accepts `schema` in the DataSource options.

Note: The `init-schemas.sh` currently generates random passwords when `AUTH_SERVICE_DB_PASS` is not set. For production, all service DB passwords must be set explicitly — add them to the `.env` file managed by the deployment process, analogous to how `NATS_PASS` is required.

---

## Finding 6: M-02 — SRI Hash-Pinning Not Wired in CI

**Severity:** MEDIUM
**Status:** NOT IMPLEMENTED — structure ready, pipeline step absent

### Current State

`web/shell/src/utils/remoteIntegrity.ts` at lines 71-80 contains `REMOTE_HASH_PINS: Record<string, string> = {}` with commented-out entries and a `TODO(CI/CD)` comment at lines 63-68 describing exactly what needs to be done:

```typescript
// TODO(CI/CD): Add a post-build step that:
//   - Runs: for module in dashboard farm-module hr-module ...
//       HASH=$(cat web/modules/$module/dist/assets/remoteEntry.js | openssl dgst -sha256 -binary | openssl base64 -A)
//       echo "  '/remotes/$module/assets/remoteEntry.js': 'sha256-$HASH',"
//     done
//   - Writes the output to web/shell/src/generated/remoteHashes.json
//   - This file imports and re-exports the generated map
```

No CI workflow implements this step. Searching across all 16 workflow files for `remoteHash`, `REMOTE_HASH`, `remoteEntry`, `sha256sum`, `integrity hash`, `SRI` finds no matches in any workflow YAML. The hash map is always empty in production.

In production, `installRemoteIntegrityGuard()` at lines 187-210 dispatches `aquaculture:security-violation` events with `type: SRI_HASH_MISSING` for each unverified remote script — but this is monitoring output only, not enforcement. Scripts load without integrity verification.

### Files

- `/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts` — lines 63-80 (TODO + empty hash map)
- All workflow files in `/var/aqua-saas/.github/workflows/` — no SRI step present
- `/var/aqua-saas/.github/workflows/deploy-digitalocean.yml` — build steps at lines 280-340 build frontend but do not generate hashes

### Architectural Fix

The hash generation must occur after the MFE module builds and before the shell is built. In `deploy-digitalocean.yml`, after the frontend build job completes:

1. Add a `generate-sri-hashes` step that runs the hash computation from the TODO comment
2. Write output to `web/shell/src/generated/remoteHashes.json`
3. Update `remoteIntegrity.ts` to `import hashes from './generated/remoteHashes.json'` and use it as `REMOTE_HASH_PINS`
4. The shell build step runs after hash injection, embedding the hashes

This creates a build-time cryptographic chain: each MFE's `remoteEntry.js` hash is computed from the actual build artifact, injected into the shell build, and verified at runtime by the browser's native SRI mechanism (via the `integrity` attribute set by the patch function at line 177).

The `remoteHashes.json` file must be git-ignored and generated fresh each CI run to prevent stale hashes from blocking legitimate deployments.

---

## Finding 7: L-11 — Module Federation Dependency Range Constraints

**Severity:** LOW
**Status:** NOT FIXED

### Current State

`web/shell/vite.config.ts` lines 32-73 use `requiredVersion` with semver range constraints for all shared dependencies:

```typescript
react: { singleton: true, requiredVersion: '^18.2.0' },
'react-dom': { singleton: true, requiredVersion: '^18.2.0' },
'react-router-dom': { singleton: true, requiredVersion: '^6.21.0' },
'@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' },
reactflow: { singleton: true, requiredVersion: '^11.10.0', version: '11.11.4' },
```

Range constraints (`^`) mean a remote MFE built with react@18.3.1 would pass version negotiation against a host providing react@18.2.0. Module Federation version negotiation uses the constraint to determine compatibility; with `^`, any minor/patch bump is accepted, meaning behavioral differences between the host's singleton and a remote's expected version are silently swallowed.

This is distinct from a security issue (no supply chain attack vector) and more of a behavioral stability risk. The audit finding is accurate: exact version pinning (`requiredVersion: '18.2.0'` without caret) forces the MFE ecosystem to align, surfacing version drift at build time rather than runtime.

### File

- `/var/aqua-saas/web/shell/vite.config.ts` — lines 33-73

### Fix Approach

Replace `^` range constraints with exact versions matching the installed `package-lock.json` entries. Add a CI lint step that asserts `requiredVersion` values in all vite.config.ts files match `package-lock.json` resolved versions.

---

## New Finding 8: E2E Tests — npm install Without --ignore-scripts on Server

**Severity:** HIGH
**Status:** NEW FINDING

### Current State

`.github/workflows/e2e-tests.yml` line 59 executes on the production server via SSH:

```bash
npm ci --prefer-offline 2>/dev/null || npm install
```

The fallback `npm install` has no `--ignore-scripts` flag. If `npm ci` fails (e.g., offline mode unavailable, cache cold), the fallback runs `npm install` without `--ignore-scripts`, executing all package lifecycle scripts (`postinstall`, `prepare`, etc.) on the production server. This is a supply chain attack surface: a malicious transitive dependency with a postinstall script would execute directly on the production host.

Additionally, `npm ci --prefer-offline` does not include `--ignore-scripts` either, meaning even the primary path executes lifecycle scripts.

All other CI workflows correctly use `npm install --legacy-peer-deps --ignore-scripts --no-audit`. The e2e workflow runs on the actual production droplet server, not in an isolated CI runner, making this gap more consequential.

### File

- `/var/aqua-saas/.github/workflows/e2e-tests.yml` — line 59

### Fix

```bash
npm ci --prefer-offline --ignore-scripts 2>/dev/null || npm install --ignore-scripts
```

---

## New Finding 9: Unpinned Infrastructure Images in Production

**Severity:** MEDIUM
**Status:** NEW FINDING

### Current State

`docker-compose.droplet.yml` uses mutable tags for infrastructure images that run in production:

- Line 38: `timescale/timescaledb:latest-pg16` — `latest-pg16` is a mutable tag that receives TimescaleDB major version updates silently
- Line 82: `redis:7-alpine` — minor/patch updates applied on next pull
- Line 103: `nats:2.10-alpine` — patch updates applied silently
- Line 160: `quay.io/minio/minio:latest` — fully mutable, any version can be pulled
- Line 1001: `nginx:alpine` — fully mutable

`Dockerfile.backend.simple` (base) correctly pins to `node:22.12.0-alpine3.20`. The discrepancy is that infrastructure services use mutable tags in production.

`timescale/timescaledb:latest-pg16` is particularly risky because a TimescaleDB major version bump can include backward-incompatible on-disk storage format changes, and PostgreSQL upgrades require pg_upgrade. Pulling `latest-pg16` after a new minor release during a routine deployment restart could break the database.

### Files

- `/var/aqua-saas/docker-compose.droplet.yml` — lines 38, 82, 103, 160, 1001

### Fix

Pin to digest-based or full version tags:
```yaml
image: timescale/timescaledb:2.17.2-pg16        # or specific patch
image: redis:7.4.2-alpine
image: nats:2.10.24-alpine
image: quay.io/minio/minio:RELEASE.2025-01-20T15-46-22Z  # already pinned in dev, use same
image: nginx:1.27.4-alpine
```

Add a quarterly dependency update process (Dependabot or Renovate) to track upstream releases with changelog review.

---

## New Finding 10: Kubernetes Network Policies Absent

**Severity:** HIGH
**Status:** NEW FINDING

### Current State

`infrastructure/kubernetes/base/` (21 manifests) contains no `NetworkPolicy` resources. The base `kustomization.yaml`, production overlay, staging overlay, and dev overlay contain no NetworkPolicy references.

The RBAC manifest creates per-service service accounts with `automountServiceAccountToken: false` and restricts secret access. However, without NetworkPolicy, any pod in the `aquaculture` namespace can make TCP connections to any other pod directly, bypassing the intended service topology.

In the current architecture without NetworkPolicy:
- A compromised `dashboard` frontend pod can connect directly to the PostgreSQL service (`postgres:5432`)
- A compromised notification-service pod can call the billing-service GraphQL API directly
- Any pod can reach the NATS service on port 4222

The K8s path is currently marked inactive (CD production disabled) but the manifests are the canonical K8s configuration. Deploying them without NetworkPolicy means the K8s cluster has no inter-pod communication controls.

### Files

- `/var/aqua-saas/infrastructure/kubernetes/base/` — no NetworkPolicy manifests present
- `/var/aqua-saas/infrastructure/kubernetes/overlays/production/kustomization.yaml` — no NetworkPolicy patches or additions

### Fix

Add a `network-policy.yaml` to `infrastructure/kubernetes/base/`. The default-deny policy (deny all ingress and egress, then explicitly allow only required paths) is the correct baseline:

```yaml
# Default deny-all for the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: aquaculture
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

Then add explicit allow policies for each service's required communication paths. The ingress topology is: external → nginx ingress → gateway-api → microservices. NATS receives only from backend services. PostgreSQL receives only from microservices. This maps cleanly to a set of NetworkPolicy resources scoped by `app` labels already present on all deployments.

---

## Previously-Fixed Findings (Confirmed Resolved)

The following Critical findings from the March 2026 audit are confirmed resolved:

- **C-01 (00-trust-auth.sh):** File is absent — `find /var/aqua-saas/infrastructure/docker/init-scripts/` shows no `00-trust-auth.sh`. RESOLVED.
- **C-02 (Hardcoded CREDENTIAL_ENCRYPTION_KEY):** `docker-compose.droplet.yml` line 417 now uses `${CREDENTIAL_ENCRYPTION_KEY:?CREDENTIAL_ENCRYPTION_KEY is required}` with no default. RESOLVED.
- **H-01 (NATS Authentication Disabled):** Authentication is now enabled in `nats.conf` and `docker-compose.droplet.yml`. RESOLVED in droplet path; BROKEN in prod path (see Finding 2).
- **M-06 (Docker base images unpinned):** `Dockerfile.backend.simple` pins `node:22.12.0-alpine3.20`. RESOLVED for application images. Infrastructure images remain unpinned (see Finding 9).
- **M-07 (ws: in CSP connect-src):** `infrastructure/docker/nginx/nginx.prod.conf` and `nginx/nginx.conf` both remove `ws:` from `connect-src`, using only `wss:`. RESOLVED.
- **M-08 (Redis dangerous commands):** Not in scope for this review pass.

---

## Priority Ranking for Implementation

| Priority | Finding | Rationale |
|---|---|---|
| P0 — Block deploy | Finding 2 (prod NATS auth broken) | NATS auth silently disabled on prod compose path |
| P0 — Block deploy | Finding 5 (superuser DATABASE_URL) | All services run as DB superuser, negating schema isolation |
| P1 — Sprint 1 | Finding 8 (e2e npm install on prod server) | Script execution on prod host |
| P1 — Sprint 1 | Finding 10 (no K8s NetworkPolicy) | Required before K8s path activation |
| P2 — Sprint 2 | Finding 1 (NATS single credential) | Per-service ACLs replace shared credential |
| P2 — Sprint 2 | Finding 4 (no TLS internal) | Internal network encryption |
| P3 — Sprint 3 | Finding 3 (tenant scope in subjects) | Requires coordinated migration |
| P3 — Sprint 3 | Finding 6 (SRI hash CI step) | Build pipeline addition |
| P4 — Backlog | Finding 9 (unpinned images) | Quarterly maintenance cadence |
| P4 — Backlog | Finding 7 (MFE version ranges) | Low risk, build-time fix |
