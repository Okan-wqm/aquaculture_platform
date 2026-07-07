# Runbook — ai-service activation (deploy steps)

**Status:** the code is complete on `main` — ai-service is a first-class federated
Apollo **subgraph** (AI settings CRUD is GraphQL) and AI chat rides the platform's
real-time path (gateway `AiChatGateway` socket.io → NATS `request.ai.chat` →
ai-service `AiChatResponder`). The hand-rolled REST proxy + SSE controller are
deleted. Catalog, compose, NATS allowlist, and the supergraph are all wired.

What remains is **operational** and needs a session with droplet/deploy access: mint
the NATS cert, provision two secrets, deploy, and smoke-verify. The gateway HMAC
round-trip, NATS mTLS handshake, and cold boot can only be confirmed live.

---

## Architecture (as merged)

- **AI settings** — federated GraphQL on the ai subgraph: `aiSettings` query +
  `updateAiSettings` mutation (`AgentConfigResolver`), gated by `ai_settings:view` /
  `ai_settings:manage` (Faz 7c). The gateway federates it like every other subgraph,
  so identity is the HMAC-verified assertion (resourcePermissions included).
- **AI chat** — ONE NATS request-reply entrypoint `request.ai.chat`
  (`AiChatResponder`, `@MessagePattern`), served for BOTH:
  - the messaging AI-in-channel bridge (`AiChatBridgeService` already sends it), and
  - the panel/mobile assistant, via the gateway `AiChatGateway` socket.io `/ai`
    namespace (`ai:chat` → NATS → `ai:response`), gated by `ai_assistant:use`.
- **BYOK** — per-tenant AES-256-GCM keys decrypted with `AI_TENANT_SECRET_ENCRYPTION_KEY`.

## 0. Mint the ai-service NATS client cert (ADR-015)

`services.yaml` + `nats.conf` already declare `CN=ai_service` (subscribe
`request.ai.chat` + the 3 other `request.ai.*`; the gateway now publishes
`request.ai.chat`). The compose block mounts `certs/nats/clients/ai_service-cert.pem`
+ `ai_service-key.pem` — mint them per `docs/runbooks/nats-service-addition.md`.
Without the cert, `nats_auth_mode_mtls` never clears and ai-service crash-loops.

## 1. Provision secrets on the droplet (.env)

- `AI_SERVICE_DB_PASS` — the `ai_service` DB role password (role already in the catalog).
- `AI_TENANT_SECRET_ENCRYPTION_KEY` — 32-byte base64; decrypts BYOK keys at rest.
  The service serves no tenant's AI without it.

`SERVICE_IDENTITY_KEYRING` / `SIGNING_KID`, `REDIS_PASSWORD`, JWT key are shared/existing.

## 2. Deploy

The image + compose + supergraph are catalog-driven and already regenerated. A normal
deploy pulls the new ai-service image and recreates ai-service + gateway. **Ordering:**
ai-service must be `healthy` before the gateway recomposes the supergraph (it
introspects the ai subgraph schema); `db-migrate` runs the `ai` migrations first.

## 3. MT-HIGH-057 — backfill BEFORE enforcement is user-visible

Existing tenants' seeded roles gain the messaging/AI capabilities only after the
`1801300000000-BackfillMessagingAiRoleCapabilities` migration (admin-api) runs — the
`db-migrate` one-shot runs it before services start. Verify it completed, else every
non-admin loses group-create + the AI assistant (fail-closed).

## 4. Smoke (live verification)

1. `docker ps` → `aqua-ai` healthy; `nats_auth_mode_mtls` + `schema_drift_clean` in logs.
2. Supergraph: the gateway composed with the ai subgraph (no composition error in logs);
   a federated `{ aiSettings { provider isEnabled } }` query returns for a MODULE_USER.
3. BYOK: as TENANT_ADMIN, `updateAiSettings(input:{anthropicApiKey:"..."})` → 200 masked
   hint; clear it → `aiSettings.enablementReason == "key_missing"`. Second tenant isolated.
4. Chat: in a messaging AI channel, send a message → an AI reply posts live (socket.io);
   with no key it posts the "add a key in AI settings" message (AI_KEY_MISSING). Direct
   assistant: connect socket.io `/ai`, emit `ai:chat` → `ai:response`; a user WITHOUT
   `ai_assistant:use` gets `ai:error FORBIDDEN`.

## 5. Rollback

ai-service is additive; if boot fails, set catalog `deploymentStatus:'inactive'`
(or scale the compose service to 0) and redeploy — but note the gateway image now
expects the ai subgraph. If the gateway must roll back too, redeploy the prior gateway
image; the RetryableIntrospectAndCompose path composes without a down subgraph. The
backfill migration is additive + idempotent (its `down()` removes only its own grants).
