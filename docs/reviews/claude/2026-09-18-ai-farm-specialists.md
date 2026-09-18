# AI farm specialists: persona identity, entitlement and the farm read surface

**Date:** 2026-09-18 · **Agent:** claude · **Cycle:** 2026-09-18 ai-farm-specialists
**Plan:** tier × specialty persona composition; three farm-module experts (water & fish health / production / operations); read-only tools over farm-service via NATS request-reply; user-decided actuation (`confirm_required` cap).
**Branch:** `feat/ai-farm-specialists` (from `messaging-fix-1`).
**Findings:** AISAFETY-MEDIUM-024, RBAC-MEDIUM-016, AISAFETY-MEDIUM-025, FARM-MEDIUM-328, FE-MEDIUM-065, FARM-LOW-329 — each closed by the PR named in its section; FE-HIGH-066 and INFRA-HIGH-174 (base-branch regressions found by this branch's gates, fixed here).

The product ask was "an expert agent per topic, farm module first, agents only
use the tools they are given and interpret, the decision stays with the user".
Exploring `apps/ai-service`, `apps/farm-service`, `apps/auth-service`, the
gateway, messaging and the web pickers surfaced the defects below. They are
registered here so every PR of the plan closes a tracked finding.

## AISAFETY-MEDIUM-024 — persona identity has no single source of truth

`apps/ai-service/src/agent/agent-profile.service.ts` holds a `PERSONAS` map of
four ids and derives the authority tier from the id prefix (`personaTier`,
unknown prefix → `supervisor`); an unknown id **silently** falls back to
`config.baseProfileId` and then to `operator-v1` (L75-76). The gateway
validates persona ids with `^(operator|manager|expert|supervisor)-v\d+$`
(`apps/gateway-api/src/websocket/ai-chat.gateway.ts:59`), messaging with
`^[a-z][a-z0-9-]*-v\d+$` (`create-channel.input.ts:62`), and four independent
hard-coded persona lists (ai-service, messaging `DEFAULT_PERSONAS`,
`web/modules/messaging-module/src/lib/aiPersona.ts`, aquamobil
`NewChatPage.tsx` + `AiChatPage.tsx`) had already drifted in names and
capability labels. Adding topic specialists on top of this would multiply
the copies. Fix: one grammar `<tier>[-<specialty>]-v<N>` and one published
catalogue in `libs/shared-contracts`, composed at runtime in ai-service,
consumed by every validator and picker; unknown ids are a hard error.

## RBAC-MEDIUM-016 — module entitlement for AI personas is declared but never enforced

`ToolMetadata.requiresModule` exists (`tools/core/tool.interface.ts:35`), is
`null` on all 15 tools and is read nowhere. There is no capability that
gates a module-scoped AI specialist, so a farm specialist could be driven by
any tenant holding `ai_personas:<tier>` regardless of the farm module, and a
tenant admin could not restrict farm experts per role. Fix: capability
`ai_specialties:farm` in a catalogue category whose module requirement is
`['ai','farm']` (all-of), so `entitledCapabilities()` — the SSoT used at
token mint, by the write authority and by `resolveCallerCapabilities` —
strips it when either module is missing; seeded for the five default roles;
persona resolution requires `ai_personas:<tier>` ∧ `ai_specialties:<module>`.

## AISAFETY-MEDIUM-025 — the tenant custom prompt is dropped and the raw persona prompt is hardened

`resolveProfile` appends `customSystemPrompt` to `effectiveSystemPrompt`
(L104-107) but `agent-runner.service.ts` passes `profile.persona.systemPrompt`
(the raw base) into `aiSafety.preProcess`, and with `instructionHierarchyEnabled`
(default `true`) the hardened prompt wins — the tenant text never reaches the
model, and the hierarchy's dedicated `tenantCustomPrompt` slot is unused. Fix:
the runner hands `preProcess` the composed base prompt and the tenant prompt
separately; `preProcess` becomes the single place the final system prompt is
assembled, so the wrong parts can no longer be passed.

## FARM-MEDIUM-328 — the AI has no usable read surface over the farm domain

The six farm tools (`get_farm_*`, `create_task`) appear in no persona's
`defaultToolNames`, and `tenant_agent_configs.additionalToolNames` has no
write surface, so they are unreachable. Fish health, growth, feeding plans,
harvest planning, regulatory biomass, finance, maintenance, equipment, stock
and tasks — all with tenant-pinned query handlers in farm-service — have no
NATS read responder at all. The six existing responders duplicate their DTOs
on both sides (no shared contract) and answer `[]` on failure, so the model
cannot tell "no data" from "farm-service down". Fix: a shared
`libs/event-contracts` contract (`FARM_AI_QUERY_SUBJECTS`, `AiQueryReply`
envelope, guards), a `respondAiQuery` helper in farm-service dispatching
`QueryBus.execute` (handlers already `runInTenantRead`), a `FarmAiQueryTool`
base in ai-service, ~40 read tools across the three specialists, explicit
ACL grants per subject, and a contract SSoT invariant.

## FE-MEDIUM-065 — the specialists are unreachable from the web and the web has no AI consent UI

The shell AI drawer sends no persona (`useAiAssistantSocket.ts:105`), the
messaging module has no persona picker, and the only picker (aquamobil
`NewChatPage`) filters by the prefix heuristic. The messaging bridge
fail-closes without per-user AI consent (`ai-chat-bridge.service.ts:185`),
but the consent toggle exists only in aquamobil — a web user could pick a
specialist and have every message denied. The admin page
`MessagingAiPersonasPage` renders the hard-coded messaging list. Fix:
pickers on shell drawer, messaging channel creation and aquamobil driven by
the shared catalogue with server-side capability filtering; consent toggle
in the web messaging module; admin page fed by the catalogue.

## FARM-LOW-329 — aquaculture math formulas are duplicated outside the engines lib

`mcp/farm-management/src/utils/formulas.ts` and the four pure math tools
(growth metrics, oxygen budget, carrying capacity, feeding impact) live only
in the (undeployed, stdio-only) MCP package, while `libs/aquaculture-engines`
is the pure-engines SSoT both ai-service and the MCP package import. Fix:
move the formulas into the lib with golden-value tests, expose the four
tools in ai-service, have the MCP package import the lib.

## FE-HIGH-066 — the aquamobil main-tree port regressed the FAZ 2.4 AI identity contract

Found by the pre-push `type-check-changed-files` gate on this branch (the
`messaging-fix-1` line had pushed through a dangling `node_modules` symlink, so
its own pre-push type checks never ran). `6c9d0288c8` (MSGFIX FAZ 3 mobile)
overwrote `web/apps/aquamobil/src/utils/messaging-helpers.ts`, removing
`AI_USER_ID` / `isAiAuthoredMessage` that FAZ 2.4 (`acd23a219b`) introduced,
while `ai-identity.spec.ts` still imports them; `AiChatPage.isAiMessage` went
back to `sender.displayName === 'AI Assistant' || metadata.isAi === true`
(user-forgeable), `useAiChat` lost the fake-card gate (a user message with
proposal-looking metadata rendered an action card) and its spec lost the gate
cases; `main.tsx`, `LoginPage.tsx` and `RecordFeedingPage.tsx` import
`@aquaculture/shared-ui/{i18n,brand}` with no tsconfig/vite alias, so aquamobil
neither type-checks nor builds. Fix: restore the FAZ 2.4 helpers, `Message.isAiGenerated`,
the `MessageFields` stamp, the `useAiChat` gate and both specs; alias the two
zero-dependency shared-ui folders (`config/brand.ts`, `i18n/`) in tsconfig,
vite and vitest, mirroring the shared-contracts precedent. Codegen for the
aquamobil documents is separately broken on this base (queries `feederSetup`,
`VfdDevice.driveBinding/drivenUnit` that the branch's supergraph does not
have) — not touched here; the hand-written `types/messaging.ts` is what the
AI pages consume.

## INFRA-HIGH-174 — NATS ACL SSoT drift: hand-edited nats.conf and a missing publish grant

Found when PR-3 regenerated `nats.conf` for the farm AI subjects. The
MSGFIX-FAZ3 live fix (`ec966ee2a6`) added `$JS.ACK.>` publish grants to 29
permission lists **directly in the generated `nats.conf`** — the
`services.schema.json` subject pattern did not admit `$JS.ACK.` so the SSoT
could not carry it, and an "overlay script re-applies after CI deploys". Any
regeneration silently dropped every JetStream consumer-ack grant (messages
redeliver forever). Separately, `messaging_service` had no publish grant for
`request.auth.user.resolveCallerCapabilities` (MSGFIX-FAZ2 2.3 caller
capability resolution), so the AI chat bridge's request never left the broker.
Both `nats-invariants` checks ("identical ACLs", "messaging-service RPC
coverage") were red on the base. Fix: admit `\$JS\.ACK\.` in the schema,
declare the 29 grants in `services.yaml` exactly where the live conf had them,
grant `request.auth.user.resolveCallerCapabilities` to `messaging_service.publish`,
regenerate — 85/85 invariants; no overlay needed.

## FE-HIGH-067 — MessagingAiPersonasPage was dead on arrival

Found while adding the tier / specialty column for FE-MEDIUM-065. The page's
only fetch is the "Load Personas" button handler, its mount effect is empty
("Don't auto-fetch without a tenant ID"), and the button is disabled while
`loadState.loading` — but the initial state was `{ loading: true }`. Nothing
ever cleared it, so the button rendered "Loading..." and disabled forever and
the inventory could never be loaded. The page had no spec, so the wrong state
was undetectable. Fix: start idle (`loading: false`), delete the empty effect,
and add the page's first spec, which drives the button and asserts the
catalogue-derived tier / specialty column.
