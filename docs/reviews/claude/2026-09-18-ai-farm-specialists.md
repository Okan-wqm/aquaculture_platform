# AI farm specialists: persona identity, entitlement and the farm read surface

**Date:** 2026-09-18 · **Agent:** claude · **Cycle:** 2026-09-18 ai-farm-specialists
**Plan:** tier × specialty persona composition; three farm-module experts (water & fish health / production / operations); read-only tools over farm-service via NATS request-reply; user-decided actuation (`confirm_required` cap).
**Branch:** `feat/ai-farm-specialists` (from `messaging-fix-1`).
**Findings:** AISAFETY-MEDIUM-024, RBAC-MEDIUM-016, AISAFETY-MEDIUM-025, FARM-MEDIUM-328, FE-MEDIUM-065, FARM-LOW-329 — each closed by the PR named in its section.

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
