# AI NATS runtime repair — live session findings (2026-09-20)

Findings raised while bringing the deployed AI chat pipeline back to life on
the droplet (main @ 8c9795f3 → nats-inbox-fix-1 / ai-tenant-ctx-1 builds).
Each was reproduced live, root-caused, fixed and E2E-verified end to end
(farm-operations specialist answered a Turkish question with real tool calls
in 16 s).

## AISAFETY-HIGH-024

- **Severity:** HIGH (durable financial evidence silently lost on every turn)
- **Layer:** 1 (architecture)
- **Evidence:**
  - `apps/ai-service/src/chat/ai-chat.responder.ts` — the NATS handler had no tenant-context
    equivalent of the HTTP `RequestContextMiddleware`
  - `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:115` — the pg pool's
    `connect` hook reads `getRequestContext()` (AsyncLocalStorage) to `SET search_path` per checkout
  - Live log, every turn: `AI turn-ledger append FAILED … TENANT_ISOLATION_VIOLATION: Direct write
to source schema ai.conversation_turns` (conversation writes survived only because they open their
    own `runInTenant*` scopes)
- **Rule violated:** tenant isolation SSoT — every tenant-scoped operation derives its schema from
  ONE tenant execution context, not per-callsite scopes.
- **Fix:** `request.ai.chat` wraps the whole turn in `withTenantContext(payload.tenantId, …)`; every
  tenant-scoped write in the turn routes by construction.
- **Verification:** live E2E — reply in 16 s; `conversation_turns` row landed in `tenant_7f6b…` with
  matching turn timestamp; 0 violations after.

## AISAFETY-MEDIUM-026

- **Severity:** MEDIUM (cost attribution determinism; per-turn warning noise)
- **Layer:** 3 (data/config)
- **Evidence:** live log per turn: `AI model 'glm-5.3' missing from MODEL_PRICING_CATALOG — turn
cost attributed at default (Sonnet-tier) rates`; `apps/ai-service/src/cost/model-pricing.ts` had no
  Z.ai entries while `ZAI_DEFAULT_MODEL = 'glm-5.3'` is the packaged default.
- **Fix:** `glm-5.3` and `glm-4.6` catalog entries at the tiers the fallback was already
  attributing; finance updates when Z.ai publishes list rates.
