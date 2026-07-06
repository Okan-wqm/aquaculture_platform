# Runbook — ai-service activation (Faz 0 deploy chain)

**Status:** deploy-gated. All AI + RBAC code is merged to `main` (PR #887/#888) but
`ai-service` is `deploymentStatus: 'inactive'` — the AI assistant + BYOK are dormant
in production. This runbook is the ordered, verified-as-far-as-possible checklist to
activate it. Run it in a session **with droplet/deploy access** — the gateway HMAC
round-trip, NATS mTLS handshake, and cold boot can only be verified live.

> Why gated (from the plan): the gateway identity chain (`buildGatewayVerifiedUserAssertion`
> HMAC + `x-verified-user-assertion` verification), the NATS mTLS cert handshake, and
> the cold-start budget are only observable with a live gateway + ai-service + auth
> triad. Local invariants verify **config consistency**, not runtime boot.

---

## 0. Prerequisite — mint the ai-service NATS client cert (ADR-015)

`infrastructure/nats/services.yaml` + `nats.conf` already declare `CN=ai_service`
(the identity exists), but the compose block below mounts a client cert/key that must
physically exist on the droplet. Follow `docs/runbooks/nats-service-addition.md`:

- Mint the `ai_service` client cert/key (CN=ai_service) into the droplet's NATS client
  cert dir (same location the other services' certs live).
- Confirm `scripts/nats/generate-nats-conf.py` output already contains the `ai_service`
  user between the `# BEGIN/END GENERATED` sentinels (it does — verify, don't hand-edit).

Without the cert, `nats_auth_mode_mtls` never clears and ai-service crash-loops on boot.

## 1. Catalog promotion — `platform/libs/service-catalog/src/index.ts`

Change the `ai-service` entry (verified against the catalog taxonomy + validators):

```diff
-    deploymentStatus: 'inactive',
-    deployTarget: 'unsupported',
-    criticality: 'ignored',
-    classification: 'subgraph',
-    gatewayParticipation: 'none',
-    startupBudgetSeconds: 60,
-    requiredSignals: [],
-    requiredEnv: ['AI_SERVICE_DB_PASS'],
+    deploymentStatus: 'active',
+    deployTarget: 'droplet',
+    criticality: 'required',            // feature-down, not data-loss/life-safety
+    classification: 'internal-service', // REST-proxied, NOT an Apollo subgraph → no gatewaySubgraph
+    gatewayParticipation: 'none',
+    startupBudgetSeconds: 60,           // == compose start_period
+    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
+    requiredEnv: ['AI_SERVICE_DB_PASS', 'AI_TENANT_SECRET_ENCRYPTION_KEY'],
```

`AI_TENANT_SECRET_ENCRYPTION_KEY` (AES-256-GCM) decrypts the per-tenant BYOK
credentials at rest — the service serves no tenant without it.

## 2. Regenerate the catalog-derived deploy artifacts

```bash
npm run service-catalog:generate   # regenerates infrastructure/deploy/service-catalog.generated.json
                                   # + the droplet-up.sh / post-deploy-verify.sh derived lists
```
Commit the regenerated artifacts (the `platform service catalog parity` invariant fails
otherwise — it asserts the generated image-targets/shell contain `ai-service`).

## 3. Droplet compose — `docker-compose.droplet.yml`

There is no `x-nats-ai-env` anchor yet — add one next to the others (line ~104), then
add the `ai-service` service mirroring `messaging-service` (line ~1434). Key deltas:

```yaml
x-nats-ai-env: &nats-ai-env
  NATS_SERVERS: nats://nats:4222
  NATS_AUTH_MODE: mtls-cert
  NATS_CLIENT_CERT: /etc/ssl/nats/clients/ai_service.crt
  NATS_CLIENT_KEY:  /etc/ssl/nats/clients/ai_service.key
  NATS_CA_CERT:     /etc/ssl/nats/ca.crt
```

```yaml
  ai-service:
    image: ghcr.io/okan-wqm/aquaculture_platform/ai-service:${TAG:?TAG required}
    container_name: aqua-ai
    restart: unless-stopped
    environment:
      SERVICE_NAME: ai-service
      NODE_ENV: production
      PORT: 3000                     # containerPort in catalog; keep in sync (INFRA-HIGH-014)
      NODE_OPTIONS: '--max-old-space-size=384'
      DATABASE_HOST: postgres
      DATABASE_SSL: 'false'
      DATABASE_PORT: 5432
      DATABASE_USER: ${AI_SERVICE_DB_USER:-ai_service}
      DATABASE_PASSWORD: ${AI_SERVICE_DB_PASS:?AI_SERVICE_DB_PASS required}
      DATABASE_NAME: ${POSTGRES_DB:-aquaculture}
      DB_MIGRATE_AUTHORITATIVE: 'true'
      DATABASE_MIGRATIONS_RUN: 'false'
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
      REDIS_DB: '9'                  # unused DB index (rate-limit/cost); confirm no collision
      <<: *nats-ai-env
      JWT_PUBLIC_KEY_PATH: /etc/ssl/jwt/public.pem
      # gateway HMAC-signs every gateway→ai-service REST call (SEC-HIGH-054) → the
      # ServiceIdentityGuard needs the shared keyring or every AI request 403s.
      SERVICE_IDENTITY_KEYRING: ${SERVICE_IDENTITY_KEYRING:?SERVICE_IDENTITY_KEYRING required}
      SERVICE_IDENTITY_SIGNING_KID: ${SERVICE_IDENTITY_SIGNING_KID:?SERVICE_IDENTITY_SIGNING_KID required}
      # BYOK: per-tenant key decryption
      AI_TENANT_SECRET_ENCRYPTION_KEY: ${AI_TENANT_SECRET_ENCRYPTION_KEY:?required}
      TRUST_PROXY: 'true'
      CORS_ORIGINS: ${CORS_ORIGINS:-https://aquamonitoring.net}
    volumes:
      - *nats-ca-mount
      - *nats-clients-mount
      - *jwt-public-key-mount
    networks: [aqua-internal]
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
      nats:     { condition: service_started }
      db-migrate: { condition: service_completed_successfully }   # migrations pre-applied
    deploy:
      resources:
        limits: { memory: 512M, cpus: '0.5' }
    healthcheck:
      # mirror messaging: curl -f localhost:3000/health, start_period 60s
```
No MinIO block (ai-service has no object-storage dependency until the Faz 3c document corpus).

## 4. CI image — build + push the ai-service image

Add `ai-service` to the ghcr build matrix in the deploy workflow (mirror the
`messaging-service` matrix entry). Without this, `${TAG}` has no ai-service image to pull.

## 5. Gateway identity chain — REST proxy for /api/v2/ai (AISAFETY-HIGH-007/009)

**This is the functional blocker, not just hardening.** ai-service registers
`VerifiedUserAssertionMiddleware`, which REQUIRES `x-verified-user-assertion` on the
production gateway path. The current `apps/gateway-api/src/routes/v2/ai.routes.ts` is a
hand-rolled `http.request` proxy that forwards only `authorization` + `x-tenant-id` — NO
signed assertion, NO HMAC — so every AI request 400s at ai-service.

Route AI through `ServiceProxyService` (the same SSoT messaging/farm use):
- Register `ai-service` in `loadServiceConfigs` (`stripPrefix: '/api/v2/ai'`, target
  `AI_SERVICE_URL`), and fix `AI_SERVICE_URL` default from `http://localhost:3008` to the
  compose service name `http://ai-service:3000`.
- Align the path: ChatController is `@Controller('api/v2/ai')` under global prefix
  `api/v1` → real path `/api/v1/api/v2/ai/chat`; either `addPrefix` accordingly OR
  simplify ChatController/AgentConfigController to `@Controller('ai')` → `/api/v1/ai`.
- Proxy REST via `proxyRequest` and the SSE chat via `proxySSE` so
  `buildGatewayVerifiedUserAssertion` (incl. the SEC-HIGH-054 `resourcePermissions`) +
  `buildSignedInternalHeaders` are emitted.
- On ai-service: remove `api/v2/ai` from any `VerifiedUserAssertionMiddleware` exclusion
  so it verifies the HMAC assertion (not a bare `x-user-payload` presence check).
- nginx `/api/v2/ai/`: `proxy_buffering off` + long read timeout for SSE.

## 6. Secrets/env to provision on the droplet (.env)

`AI_SERVICE_DB_PASS`, `AI_TENANT_SECRET_ENCRYPTION_KEY` (32-byte base64), the ai_service
NATS cert/key (step 0), `AI_SERVICE_URL=http://ai-service:3000`. `SERVICE_IDENTITY_KEYRING`
/`SIGNING_KID` already exist (shared).

## 7. DEPLOY ORDERING — MT-HIGH-057 backfill BEFORE enforcement activates

The messaging/AI RBAC enforcement (group-create, AI chat/settings/persona gates) is
already on `main` and goes live the moment messaging + ai-service (re)deploy. Existing
tenants' seeded roles do NOT carry the new capabilities until the
`1801300000000-BackfillMessagingAiRoleCapabilities` migration (admin-api) runs. The
`db-migrate` one-shot runs migrations before the services start, so a normal deploy
orders this correctly — **verify** `db-migrate` completed the backfill before smoke.
If skipped, every non-admin loses group creation + the AI assistant (fail-closed).

## 8. Smoke (live verification — the reason this is gated)

1. `docker ps` → `aqua-ai` healthy; schema-drift validator clean; `nats_auth_mode_mtls`
   signal set (check logs).
2. Gateway HMAC round-trip (SEC-HIGH-054): as a MODULE_USER, `POST /api/v2/ai/chat` →
   NOT 400 "assertion required"; ai-service logs show a verified assertion carrying
   `resourcePermissions`.
3. BYOK: as TENANT_ADMIN, `PUT /api/v2/ai/settings` with an Anthropic key → 200; `GET`
   → masked hint; `POST /api/v2/ai/chat` → real streamed Claude reply. Clear key →
   `AI_KEY_MISSING`. Second tenant's key isolated.
4. RBAC: a non-admin WITHOUT `channels:create_group` cannot create a group (403); a
   Supervisor-role user CAN; persona picker respects `ai_personas:<tier>`.

## 9. Rollback

`ai-service` is additive — if boot fails, set catalog `deploymentStatus: 'inactive'`
(or scale the compose service to 0) and redeploy; messaging/gateway are unaffected
(the RBAC enforcement there is already independent). The backfill migration is additive
+ idempotent; its `down()` removes only the messaging/ai grants it added.
