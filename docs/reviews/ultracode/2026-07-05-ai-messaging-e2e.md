# AI + Messaging End-to-End Audit — Review of Record

- **Date:** 2026-07-05
- **Method:** ultracode multi-agent audit (6 deep-readers over ai-service, messaging AI bridge, messaging core+realtime, AquaMobil, panel surfaces, gateway+deploy chain; 30+ adversarial verifiers: 10+ CONFIRMED, 9 PARTIAL, 1 REFUTED; workflow `wf_b187a32a-3d8`)
- **Scope:** why the AI assistant and mobile messaging do not work end-to-end in production, plus gaps vs the approved target: per-tenant BYOK AI keys (OpenAI + Anthropic), AI assistant on mobile AND panel, WhatsApp-like messaging on mobile AND panel, advanced RAG (self-hosted embeddings, hybrid retrieval, GraphRAG, agentic planner).
- **Remediation plan:** approved phase plan Faz 0–6 (plan `mutable-wiggling-prism`); every fix commit references a finding below.
- **ID prefixes:** AI-service / AI-domain findings use `AISAFETY-*`; messaging-service, mobile-messaging, and messaging-embedded-RAG findings use `MSG-*` (both are governed prefixes in `docs/reviews/_registry/findings.jsonl.schema.json`).
- **State machine:** OPEN → IN-PROGRESS → RESOLVED (merged commit carries `Closes:`).

## Findings

| ID | Sev | Finding | Evidence | Phase | State |
|---|---|---|---|---|---|
| AISAFETY-CRITICAL-001 | CRITICAL | ai-service is not deployable: service-catalog `deploymentStatus:'inactive'`, no ghcr image target in CI, no droplet compose service, no env plumbing | `platform/libs/service-catalog/src/index.ts:833`, `docker-compose.droplet.yml` | Faz 0 | OPEN |
| AISAFETY-CRITICAL-002 | CRITICAL | messaging→AI NATS request-reply has NO responder: `request.ai.chat/executeAction/analyzeSentiment/generateEmbeddings` published, ai-service registers no NATS handler (permissions already granted in `infrastructure/nats/services.yaml:303`) | `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:394`, `apps/ai-service/src/main.ts` | Faz 2 | OPEN |
| AISAFETY-CRITICAL-003 | CRITICAL | Single process-global `ANTHROPIC_API_KEY` (defined in no env), Anthropic-only; no per-tenant key, no provider selection — BYOK target impossible as coded | `apps/ai-service/src/agent/agent-runner.service.ts:85-87` | Faz 1 | OPEN |
| AISAFETY-HIGH-004 | HIGH | `AiOutbox` entity absent from the DataSource `entities:` list — outbox repository DI/metadata failure; outbox table never created by schema bootstrap/sync | `apps/ai-service/src/app.module.ts:130` | Faz 0 | IN-PROGRESS |
| AISAFETY-HIGH-005 | HIGH | Tool registry receives ZERO tools: `TOOL_PROVIDERS` wiring assumes Angular-style `multi: true` providers NestJS does not have; registry's own `useValue: []` always wins | `apps/ai-service/src/tools/tool-registry.module.ts:29` | Faz 0 | IN-PROGRESS |
| AISAFETY-HIGH-006 | HIGH | All four personas hardcode nonexistent dated Anthropic model IDs (`claude-haiku-4-5-20250515`, `claude-sonnet-4-5-20250514`) — every chat request 404s at the API; model not configurable | `apps/ai-service/src/agent/personas/*.ts:6` | Faz 0 | IN-PROGRESS |
| AISAFETY-HIGH-007 | HIGH | Gateway AI proxy chain broken: `AI_SERVICE_URL` undefined in droplet compose (defaults localhost:3008), path mismatch (`/api/v2/ai/*` → service global prefix `/api/v1`), no `x-user-payload` / v2 service-identity signature forwarded | `apps/gateway-api/src/routes/v2/ai.routes.ts:29,60`, `libs/backend-common/src/bootstrap/create-service-app.ts:610` | Faz 0 | OPEN |
| AISAFETY-HIGH-008 | HIGH | `TenantAgentConfig` has no CRUD surface (no controller/resolver) — no admin can set any AI setting; `upsertConfig` dead | `apps/ai-service/src/tenant-config/agent-config.module.ts:6-11` | Faz 1 | OPEN |
| AISAFETY-HIGH-009 | HIGH | ai-service REST path performs no JWT signature verification; naive header forwarding would make tenant identity spoofable | `apps/ai-service/src/chat/guards/jwt-auth.guard.ts:59` | Faz 0 | OPEN |
| AISAFETY-HIGH-010 | HIGH | Farm AI insights disabled in prod: `MCP_ENABLED` defaults false, prod compose never sets it — mobile AI cards render "unavailable" | `apps/farm-service/src/ai-insights/services/mcp-client.service.ts:81` | Faz 3 | OPEN |
| AISAFETY-MEDIUM-011 | MEDIUM | Chat SSE is fake streaming (full agent loop awaited before first event) and nginx `/api/v2/ai/` lacks SSE settings (buffering on, 60s read timeout) | `apps/ai-service/src/chat/chat.controller.ts:114`, `infrastructure/nginx/droplet.conf:337` | Faz 0 | OPEN |
| AISAFETY-MEDIUM-012 | MEDIUM | Conversations endpoint is a stub returning an empty list — no conversation history API | `apps/ai-service/src/chat/chat.controller.ts:170` | Faz 5 | OPEN |
| AISAFETY-MEDIUM-013 | MEDIUM | Persona `applicableRoles` never enforced (any user can request supervisor-v1); actuation confirmation is a no-op; tool-execution audit dead; `TenantScopedTool` stores QueryRunner as singleton state (cross-request race, zero subclasses) | `apps/ai-service/src/chat/chat.controller.ts:42`, `tools/core/tool-executor.service.ts:74`, `tools/core/base-tenant-tool.ts:22` | Faz 2 | OPEN |
| AISAFETY-MEDIUM-014 | MEDIUM | Admin-panel AI pages are placebo surfaces (hardcoded "not yet available", persona editing 501) | `web/modules/admin-panel/src/pages/messaging/MessagingAiDashboardPage.tsx:8` | Faz 5 | OPEN |
| AISAFETY-LOW-015 | LOW | GraphQL complexity cache grows without bound | `apps/ai-service/src/app.module.ts:92` | orphan | OPEN |
| AISAFETY-LOW-016 | LOW | ChatController derives tenant schema by string-slicing the tenant ID instead of the schema-manager SSoT | `apps/ai-service/src/chat/chat.controller.ts:84` | orphan | OPEN |
| MSG-CRITICAL-058 | CRITICAL | `AnalyzeMessageCommand` has zero dispatch sites — the message→AI bridge is unreachable from the send flow | `apps/messaging-service/src/ai/commands/analyze-message.handler.ts:17` | Faz 2 | OPEN |
| MSG-CRITICAL-059 | CRITICAL | Messaging attachments broken in prod: S3 client built from bare `minio` hostname (port never read), presigned URLs internal-only, no nginx object-storage route, `messaging` bucket never provisioned, PWA CSP blocks upload PUT | `apps/messaging-service/src/message/services/media.service.ts:71,79`, `infrastructure/nginx/droplet.conf:255` | Faz 4 | OPEN |
| MSG-HIGH-060 | HIGH | Per-channel `aiServiceUrl` lets any member point a channel's AI at an arbitrary HTTPS endpoint and exfiltrate the last 50 messages + tenantId | `apps/messaging-service/src/channel/dto/create-channel.input.ts:76` | Faz 2 | OPEN |
| MSG-HIGH-061 | HIGH | AI chat path bypasses the tenant AI master switch AND the egress gate — tenant disabling AI would not stop AI chat | `apps/messaging-service/src/ai/commands/analyze-message.handler.ts:57` | Faz 2 | OPEN |
| MSG-HIGH-062 | HIGH | Embedding cron queries the messaging TEMPLATE schema, never tenant schemas — processes 0 rows forever | `apps/messaging-service/src/ai/services/embedding.service.ts:98` | Faz 3 | OPEN |
| MSG-HIGH-063 | HIGH | `request.farm.getTankRegistry` has no responder in farm-service — knowledge extraction can never produce entity refs | `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:352` | Faz 3 | OPEN |
| MSG-HIGH-064 | HIGH | Presence/typing dead end-to-end: gateway `REDIS_SERVICE` token has no provider (optional inject silently null), DB index mismatch, no writer in messaging-service | `apps/gateway-api/src/websocket/messaging.gateway.ts:118` | Faz 4 | OPEN |
| MSG-HIGH-065 | HIGH | Push notifications structurally off in prod: `PUSH_ENABLED` defaults false, no FCM credentials in compose, `VITE_FIREBASE_*` never reach the aquamobil image | `apps/notification-service/src/notification/services/push.service.ts:105`, `web/apps/aquamobil/src/hooks/useFirebaseMessaging.ts:11` | Faz 4 | OPEN |
| MSG-HIGH-066 | HIGH | Permissions-Policy denies microphone — voice messages cannot record in production | `infrastructure/docker/nginx/snippets/security-headers.conf:17` | Faz 4 | OPEN |
| MSG-HIGH-067 | HIGH | AI response `MessageSent` event carries `isAiResponse` rejected by the strict event schema — AI replies would never broadcast live; `Message.metadata` not exposed in GraphQL so clients cannot render AI attribution | `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:377,351` | Faz 2 | OPEN |
| MSG-HIGH-068 | HIGH | Mobile AI UX structurally broken: `AiChatPage` checks metadata fields never on the wire; AI action cards never call `confirmAiAction` (literal TODO); channel list reopens AI channels as plain `ChatRoomPage` | `web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx:83`, `src/hooks/useAiChat.ts:130`, `ChannelListPage.tsx:263` | Faz 4 | OPEN |
| MSG-HIGH-069 | HIGH | Panel has ZERO member-facing AI or messaging surface and no tenant AI-key entry anywhere | `web/modules/tenant-admin/src/pages/TenantSettings.tsx:31` | Faz 5 | OPEN |
| MSG-MEDIUM-070 | MEDIUM | Mobile offers group creation to all members; backend restricts GROUP channels to MODULE_MANAGER+ — product decision is WhatsApp-like (members may create) | `apps/messaging-service/src/channel/commands/create-channel.handler.ts:63` | Faz 4 | OPEN |
| MSG-MEDIUM-071 | MEDIUM | `ChannelCreated` broadcast never reaches new members' clients (socket room does not exist yet) | `apps/gateway-api/src/websocket/messaging-nats-bridge.service.ts:217` | Faz 4 | OPEN |
| MSG-MEDIUM-072 | MEDIUM | Embedding/sentiment reference implementations are fictional (384-dim vector + `distilbert-sst2-v1.0` exist nowhere); `request.ai.analyzeSentiment`/`generateEmbeddings` unimplemented | `apps/messaging-service/src/ai/services/sentiment-analysis.service.ts:35` | Faz 3 | OPEN |
| MSG-MEDIUM-073 | MEDIUM | Service-worker media route intercepts SPA navigations and caches HTML under the media cache | `web/apps/aquamobil/src/pwa/messaging-sw.ts:245` | Faz 4 | OPEN |
| MSG-MEDIUM-074 | MEDIUM | Knowledge extraction ignores consent (`AiPrivacyService` injected, never called); `UserDeleted` cascade misses `knowledge_entries` | `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:97` | Faz 3 | OPEN |

## Refuted during verification

- "AI bridge reads/writes the source `messaging` schema instead of tenant schemas" — REFUTED: messaging repositories are tenant-pinned architecturally; no change required. A cross-tenant isolation test is still added in Faz 2 because the revived code path sees real traffic for the first time.

## Notes

- NATS side is already prepared for ai-service: `services.yaml` carries the `ai_service` identity with exactly the four `request.ai.*` subscribe permissions; `nats.conf` CN mapping generated. Only the client cert mount needs verification during Faz 0.
- `ai` module schema is already declared in `MODULE_SCHEMAS` (`libs/backend-common/src/database/schema-manager.service.ts:553`) — tenant provisioning needs no change, existing tenants need a schema backfill run.
- Product-owner decisions binding this remediation: BYOK-only (no platform-key fallback), panel gets BOTH AI assistant and full messaging, advanced RAG in scope with self-hosted multilingual embeddings, message history is NOT a raw RAG corpus.

## Self-review round 2 (2026-07-05) — defects found in the fix commits themselves

Adversarial self-review of the stacked PRs (#880-#883) surfaced defects in the fixes:

| ID | Sev | Finding | Fix |
|---|---|---|---|
| AISAFETY-HIGH-019 | HIGH | ai-service BYOK defects: (a) migration schema-qualified `"ai"."tenant_agent_configs"` never reaches per-tenant clones → existing tenants 500 on every chat/settings; (b) chatModel persisted but never applied; (c) persona applicableRoles gate bricks manager/expert/supervisor for everyone (no admin write surface); (d) key CRUD returns 500/401 instead of 400; (e) validateCredential treats 403 as invalid key; (f) unknown-tool not audited | migration unqualified fan-out; chatModel in model resolution; drop applicableRoles gate (role-ceiling stays, allowlist→Faz 7); 400s; only 401→invalid; audit unknown-tool |
| MSG-HIGH-075 | HIGH | messaging: (a) DropChannelAiServiceUrl schema-qualified → column persists in tenant clones; (b) semantic-search egress ships query text to ai-service with NO egress gate | migration unqualified; route semantic search through AiEgressGateService |
| AISAFETY-MEDIUM-020 | MEDIUM | AI egress consent checks only the trigger sender; fetchContextMessages forwards ALL members' last 50 incl. non-consenting; confirmAiAction egress bypasses the gate (dead endpoint today) | TODO — per-author consent filter on context; gate confirmAiAction |
| AISAFETY-MEDIUM-021 | MEDIUM | Tool requiredPermissions vocabulary (`operator`/`manager`) mismatches ctx.userRoles (`MODULE_USER`/`TENANT_ADMIN`) → every tool call denied (pre-existing since initial commit) | TODO — align tool permission vocabulary with platform roles or capabilities (Faz 7) |

## Faz 7c enforcement (2026-07-05) — tenant-RBAC capability gate on group creation

| ID | Sev | Finding | Fix |
|---|---|---|---|
| MSG-HIGH-076 | HIGH | Group-channel creation had no tenant-RBAC gate: MSG-MEDIUM-070 (rightly) removed the hardcoded MODULE_MANAGER role gate for WhatsApp-like behaviour, but nothing then let a tenant admin restrict WHO may start groups — the tenant-configurable RBAC (Faz 7) capability `channels:create_group` was not enforced on the create path | createChannel resolver now conditionally enforces `channels:create_group` for `ChannelType.GROUP` (DM + AI stay open) via the shared SSoT `hasResourcePermission` — the same check `TenantPermissionGuard` uses (admins bypass), matching the AquaMobil FE gate. Also consolidated the guard's inline bypass+membership logic into that one SSoT helper (`hasAllResourcePermissions` in backend-common) so guard + programmatic callsites share one implementation. Depends on the messaging/AI capabilities being in the catalogue (auth-service PR #885). |

## Root-cause prerequisite (2026-07-05) — resourcePermissions never reached subgraphs

| ID | Sev | Finding | Fix |
|---|---|---|---|
| SEC-HIGH-054 | HIGH | The gateway verified-user-assertion threaded assignedSiteIds/mobileFeatures/planLevel but NOT `resourcePermissions`. On the production gateway path `req.user` is rebuilt from the assertion (not the raw JWT), so `req.user.resourcePermissions` was `undefined` at EVERY subgraph → every `@RequireTenantPermission` / `hasResourcePermission` check failed closed for all non-admins (a functional outage of tenant-RBAC in prod). Same class as SEC-HIGH-051/052, which fixed sites/mobileFeatures. | Thread `resourcePermissions` through the whole chain exactly like mobileFeatures: gateway JwtPayload type → 3 assertion callsites (service-proxy, marine.routes, authenticated-data-source) → GatewayVerifiedUserAssertionInput + built assertion (integrity-covered by assertionHash, no signing change) → VerifiedUserAssertion interface → middleware validation + req.user. Round-trip + malformed-reject specs added. |

## Faz 7c AI-side enforcement (2026-07-05)

| ID | Sev | Finding | Fix |
|---|---|---|---|
| AISAFETY-HIGH-022 | HIGH | AI endpoints were not tenant-RBAC gated: AI settings CRUD was hard `@Roles(TENANT_ADMIN)` (no tenant delegation), and AI chat had no capability gate — a tenant could not decide who may use the assistant or manage the BYOK keys | agent-config.controller: `@Roles(TENANT_ADMIN)` → programmatic `ai_settings:view` (GET) / `ai_settings:manage` (PUT) via the shared SSoT `hasResourcePermission` (admins bypass; delegatable per role). chat.controller: `ai_assistant:use` gate before any SSE flush. Also consolidated TWO local `TenantRequest` duplicate interfaces (agent-config + chat controllers) onto the canonical `@aquaculture/backend-common/types` TenantRequest, and completed the JwtUser type with `resourcePermissions` (the consumer side of SEC-HIGH-054). Persona-tier → `ai_personas:<tier>` migration tracked separately (agent-profile.service refactor). |

## Faz 7c persona-tier capability migration (2026-07-05)

| ID | Sev | Finding | Fix |
|---|---|---|---|
| AISAFETY-HIGH-023 | HIGH | Persona-tier authorization used a FIXED platform-role ceiling (ROLE_TIER_CEILING) — not tenant-configurable. A tenant admin could not decide which role may drive which AI persona tier (e.g. grant a senior operator the expert assistant, or forbid the autonomous supervisor for everyone but themselves) | AgentProfileService migrated from the platform-role ceiling to the tenant-RBAC capability `ai_personas:<tier>`, resolved via the shared SSoT hasResourcePermission (admins bypass). resourcePermissions threaded ChatRequest → agent-runner → resolveProfile (now available at ai-service via SEC-HIGH-054). Removed the now-dead TIER_RANK / ROLE_TIER_CEILING / userTierCeiling. Seeded defaults grant operator to all, manager/expert to senior roles, supervisor to none (admin-only) — same effective floor as the old ceiling, now tenant-customizable. Persona spec rewritten for the capability model. |

## Finding splits from AISAFETY-MEDIUM-013

The original combined finding AISAFETY-MEDIUM-013 (persona authorization + actuation + audit + TenantScopedTool race) was split into focused findings for independent tracking:

- **AISAFETY-MEDIUM-017** — AI tool actuation confirmation is a no-op and tool-execution audit is dead code (split from AISAFETY-MEDIUM-013). Fixed: fail-closed actuation gate (only `allowed` executes) + real AuditService.logToolExecution.
- **AISAFETY-LOW-018** — `TenantScopedTool` stores the QueryRunner as singleton instance state (cross-request race). Fixed: AsyncLocalStorage-backed per-execution runner.
