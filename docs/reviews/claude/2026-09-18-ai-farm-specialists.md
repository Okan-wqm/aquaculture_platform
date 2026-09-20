# AI farm specialists: persona identity, entitlement and the farm read surface

**Date:** 2026-09-18 · **Agent:** claude · **Cycle:** 2026-09-18 ai-farm-specialists
**Plan:** tier × specialty persona composition; three farm-module experts (water &
fish health / production / operations); read-only tools over farm-service via NATS
request-reply; user-decided actuation (`confirm_required` cap).
**Branch:** `feat/ai-farm-specialists` (from `messaging-fix-1`).
**Findings:** AISAFETY-MEDIUM-024, RBAC-MEDIUM-016, AISAFETY-MEDIUM-025,
FARM-MEDIUM-328, FE-MEDIUM-065, FARM-LOW-329 — each closed by the PR named in its
section; FE-HIGH-150 (formerly FE-HIGH-066, 069, 080), INFRA-HIGH-174, FE-HIGH-067 and
ORPHAN-HIGH-828, INFRA-HIGH-176, INFRA-HIGH-179, INFRA-HIGH-180 and INFRA-HIGH-181
(base-branch / platform defects found by this branch's gates and work, fixed
here); FARM-LOW-330
(tracked, open — MCP analytics test debt, owner: farm-module maintainer,
deadline 2026-10-16).

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
`QueryBus.execute` (the responder helper establishes the tenant AsyncLocalStorage
frame with `withTenantContext` for EVERY subject, so the handlers that fan out to
ambient-repository services — FCR and batch cost — read the right tenant, and
most handlers additionally pin with `runInTenantRead`), a `FarmAiQueryTool`
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

## FE-HIGH-150 — the aquamobil main-tree port regressed the FAZ 2.4 AI identity contract

_Renumbered three times while this branch merged onto main: FE-HIGH-066 → 069
(main's design-system wave had allocated 066), 069 → 080 (main's DataTable
ratchet took 069), 080 → 150 (main's operator-screen review took 080; 150 sits
well past the FE domain's monotonic allocator on main, which was at 093). The
closing commit's trailer names the original id; the commit-msg validator
allowlists it._

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

## ORPHAN-HIGH-828 — the in-process migration runner ignored `transaction = false`

Found by PR #1586's `E2E Tests` lane: every messaging E2E suite failed at
boot because `AddMessagesContentSearchGinIndex1802300000000` (MSGFIX-FAZ3,
`transaction = false`, per-partition `CREATE INDEX CONCURRENTLY`) threw its
runner-contract guard — the E2E harness bootstraps three `messages`
partitions, and the platform runner in `libs/backend-common` had opened a
transaction around `up()` regardless. ORPHAN-CRITICAL-058 fixed exactly this
in the db-migrate orchestrator (production); the Faz 1.1 post-condition
barrier later rewrote the in-process runner around
`executor.executeMigration()` with an unconditional `startTransaction()`,
so the two runners disagreed on TypeORM's instance-level opt-out and the
migration's docblock had to assume "E2E databases have zero partitions".
Fix: the runner reads `migration.instance.transaction !== false` and
starts / commits / rolls back only when it wrapped the call — the same
contract as the orchestrator. `migration-runner.transaction-opt-out.spec.ts`
drives the real `MigrationExecutor` (ledger I/O replaced at the prototype
seam) and proves `up()` observes no open transaction for the opt-out and a
wrapped one otherwise; the migration's guard stays as the fail-fast for any
caller that ignores the contract, and its message now names both runners.
Verified against a throwaway Postgres with the platform image: all twelve
messaging E2E suites boot, the parent index and three partition indexes land
`indisvalid = true`.

## INFRA-HIGH-176 — the production NATS could not recover its telemetry stream

Found while taking PR #1586 live: the droplet's auto-deploy (17:35 UTC,
release `ba4366830…`) applied its migration and then stopped at "Reloading
NATS certificate identities and ACL" with "NATS did not become healthy after
ACL reload". nats-server logged `Error recreating stream
"AQUACULTURE_TELEMETRY": insufficient storage resources available (10047)`
on start and failed its healthcheck every ten seconds after. `/jsz` explained
it: `max_file_store` 2 GiB, EVENTS 1.5 GiB + DLQ 256 MiB already reserved,
and the telemetry stream (SENSOR-HIGH-092, 2026-08-25) asks for 6 GiB — the
conf was never raised with the reservation, so any NATS restart leaves the
server unhealthy and every deploy dead at the same step. Fix:
`max_file_store: 10GB` (the disk has 47 GB free) and
`tests/invariants/nats-jetstream-store-budget.spec.ts`, which reads the three
`max_bytes` defaults out of `nats-event-bus.ts` and fails the build when
their sum no longer fits under the conf value.

## Withdrawn: "the registry buildcache shipped stale layers" (was INFRA-CRITICAL-178)

Raised, then withdrawn before it reached main. After the 2ee11ed6 deploy
failed its health gate, the images running on the droplet lacked the
`serviceVisibility` gate and the scoped-inbox rule, and the sensor build log
showed the `COPY dist/apps/<service>` step as `CACHED` — read together as a
poisoned registry cache. It was not: the deploy's rollback re-tags
`<service>:<sha>` onto the previous release's image, so the tag inspected
pointed at the pre-deploy build, while the digest CI actually pushed
(`sha256:39d58abf…` for sensor-service) carries the run's artifact byte for
byte. `CACHED` on an unchanged layer is the cache working. The real defect —
a rollback that recreates the previous images under the new checkout's
compose environment and `nats.conf` — is filed by the aqua-saas-0a session
against `droplet-up.sh`; the cache-key rotation this branch briefly carried is
reverted and the registry row was dropped before merge.

## INFRA-HIGH-179 — the reply inbox followed the caller's label, not the identity

`buildNatsConnectionOptions(name)` derived the scoped reply inbox from
whatever string the caller passed. The event bus passed its client id
(`aquaculture-<service>`), the gateway bridges their bridge names, the
sensor ST-language handler a pid-suffixed label — none equal to the identity
services.yaml grants (`_INBOXAUTH_SERVICE.>`, `_INBOXGATEWAY_SERVICE.>`).
Latent since 2026-08-27 and masked by a hand-edited production `nats.conf`
that still granted `_INBOX.>`; the 2026-09-19 17:35 UTC deploy loaded the SSoT
ACL and aqua-nats began logging `Subscription Violation … CN=auth_service,
Subject "_INBOXAQUACULTURE_AUTH_SERVICE.<nuid>.*"`. Fix: under mTLS the
factory reads the CN out of `NATS_TLS_CERT` and scopes the inbox from it —
the same identity `verify_and_map` binds the connection to — and the caller's
name only labels the connection; `nats-connection.factory.inbox.spec.ts`
drives it with a test certificate and a product-prefixed label.

## INFRA-HIGH-180 — the scoped inbox prefix carried a trailing dot

The first deploy with fresh images (main `750db0409f`) refused every service
at connect: config-service logged `Permissions Violation for Subscription to
"_INBOXCONFIG_SERVICE..CP4LF…*"`. nats-core's `createInbox(prefix)` joins the
prefix and the nuid with its own dot, so the factory's `_INBOX<ID>.` form —
inherited from the 2026-08-27 rule by the CN-based fix — produced an empty
token that no `_INBOX<ID>.>` grant matches. The SSoT contract is dot-less
(`CONFIG_RUNTIME_INBOX_PREFIX = '_INBOXBILLINGCFG'`, and the e2e note
"createInbox appends `.<nuid>`"). Fix: `scopedInboxPrefix` returns
`_INBOX<ID>`; the spec now derives the reply subject with nats-core's own
`createInbox` and asserts it sits under the grant with no `..`.

## INFRA-HIGH-181 — no JetStream user could publish `$JS.API.INFO`

`@nats-io/jetstream`'s `jetstreamManager(nc)` publishes `$JS.API.INFO`
(account info) at construction unless `checkAPI` is disabled, and the event
bus constructs it on every connect. services.yaml enumerated
`$JS.API.STREAM.*` / `CONSUMER.*` rights (Task 2, SENSOR-HIGH-092) but never
`INFO`, so aqua-nats logged `Publish Violation … "$JS.API.INFO"` for ten
identities within minutes of the deploy. Fix: `$JS.API.INFO` publish for every
identity holding a `$JS.API.*` grant (17 services), `nats.conf` regenerated,
and a nats-invariants case that fails when a JetStream user lacks it.

## Post-plan review round (six independent reviewers) — what changed

- **RBAC-MEDIUM-016 at execute time.** The module entitlement and tenant block
  list were evaluated only when the tool list was OFFERED; a `tool_use` the
  model emitted for a tool it was never given (every farm tool admits every
  tier) ran anyway. `ToolExecutionContext.offeredToolNames` now carries the
  offer and the executor refuses anything outside it for a human turn; a
  confirmed proposal offers exactly its stored tool.
- **Proposals fail closed, not stuck.** `executeProposal` resolved the stored
  persona after the atomic `proposed → executing` claim and outside the
  try/catch, so a retired persona id left the row in `executing` forever. The
  tier is now resolved before the claim (`catalogue.tierOf`) and an
  unpublished persona writes a terminal `failed` row.
- **Tenant frame for the farm AI read path (FARM-MEDIUM-328).** See above:
  `get_batch_performance` / `get_growth_analysis` computed FCR and cost through
  ambient repositories with no AsyncLocalStorage frame and silently returned
  zeros; `respondAiQuery` now wraps every handler in `withTenantContext`.
- **`get_water_quality_history` crashed on every call**: the chart query
  selects a sparse column set without `parameters`, which the projection reads.
  The subject now runs the paginated list query (full rows, DESC, `take` in the
  database, exact `total`) with an inclusive `toDate`.
- Closed vocabularies and SSoT constants: equipment `status` is an enum at the
  contract, responder and tool (an unknown code is `INVALID_REQUEST`, not a
  dropped filter); day/limit caps reference `FARM_AI_QUERY_LIMITS` (+
  `MAX_UPCOMING_DAYS`); species/tank responders gained specs; the free-text
  exceptions (`title`, `location`) are documented in the invariant.
- Persona grammar admits only canonical versions (`v[1-9]\d*`); the source
  catalogues are deep-frozen; the supervisor's operating contract carries the
  autonomous decision bullet instead of the contradicting advisory one; one
  reserved-delimiter list drives boot, validation and runtime sanitising.
- Messaging: `createChannel` refuses an AI persona the caller lacks the
  capabilities for (the pin is permanent); the admin inventory lists the 13
  published personas (no picker-default row); consent is optimistic and shown
  only to members holding `ai_assistant:use`.
- Math tools (FARM-LOW-329): an unfed tank above the DO floor is a `surplus`,
  species tables are own-key lookups, schemas are closed
  (`additionalProperties: false`) with explicit field mapping, results are
  presented (4/6 decimals, whole fish); boundary pins for every status.
- Auth (RBAC-MEDIUM-016): all-of entitlement pinned at the seed path and the
  write boundary; the seed template is proven ⊆ catalogue; the backfill
  migration's rationale corrected (the reconcile is admin-triggered only).
- Base-branch drift folded back: the MFA button label follows the base
  branch's wording in BOTH locales ("Verify & continue") and the shell spec
  was updated instead of reverting product copy.
