# The 2026-09-20 boot-path outage: four defects the production container was the first to run

**Date:** 2026-09-20 · **Reviewer:** claude (live diagnosis on the production droplet) · **Scope:**
`libs/backend-common/src/nats`, `platform/libs/event-bus`,
`apps/sensor-service/src/compliance/erasure`, `apps/billing-service/src/billing/services`,
`infrastructure/nats`, `.github/workflows/nats-invariants.yml`

**Trigger.** The automatic deploy of `main` at 2026-09-19 23:53Z left every backend crash-looping
and the gateway `Created`; `https://app.suderra.com` answered 502 and nobody could log in. The
deploy of `750db0409` at 06:49Z failed at `service_recreate` for the same reasons and rolled back to
images that could not boot under `main`'s compose either.

**Findings:** SENSOR-CRITICAL-127, BILLING-CRITICAL-019, FARM-CRITICAL-331 and SEC-CRITICAL-169
(fixed here); ORPHAN-MEDIUM-833 (the twelve re-provided farm/admin services, removed here);
ORPHAN-HIGH-834 (no gate compiled any service's dependency graph — the per-service DI-graph spec
lands here). The two NATS defects are INFRA-HIGH-180 and INFRA-HIGH-181, registered and fixed by
pull request 1637 (012bc5f3a) while this cycle was diagnosing the same outage; this document keeps
their live evidence and adds the gate that proves them.

## What the live system said

Every service that runs the event bus died the same way:

```text
Bootstrap failed: Permissions Violation for Subscription to
  "_INBOXEVENT_STORE_SERVICE..fZsWGFQGvjYYQ75mOG8uoT.*"
```

and `aqua-nats` logged, per identity, a `Subscription Violation` for `_INBOX<CN>..<nuid>.*` followed
by a `Publish Violation` for `$JS.API.INFO`. Four services failed before reaching NATS — two in the
first crash loop, two more (farm-service, gateway-api) once they were started by hand, since their
`depends_on` had kept them `Created` behind the unhealthy auth-service:

```text
sensor-service:  Nest can't resolve dependencies of the MqttAuthService
                 (ConfigService, ?, DataSource, DeviceDirectoryService).
                 … "EdgeDeviceRepository" at index [1] … in the SensorErasureModule
billing-service: Nest can't resolve dependencies of the ModulePricingService
                 (ModulePriceRepository, DataSource, ?).
                 … argument Function at index [2] … in the BillingModule
farm-service:    Nest can't resolve dependencies of the DayPlanRecalcService
                 (OutboxPublisher, ?). … ProtocolResolutionService at index [1]
                 … in the FeedingModule
gateway-api:     Nest can't resolve dependencies of the TenantConnectionLimiter (?).
                 … argument at index [0] … appears to be undefined at runtime
```

auth-service additionally refused its environment (`FRONTEND_URL must use https in production`; the
droplet's `.env` carried `http://89.38.97.90`). That is an operator setting, not a repository
defect; the operator set it to `https://app.suderra.com` during this cycle.

None of the defects is new. The inbox prefix dates from 0afecd4f3 (2026-08-27), the JetStream probe
from the SSoT ACL's enumeration of JetStream rights, the sensor module from 65753cb90 (2026-08-26),
the billing import from 3352ceda6 (2026-09-07), the gateway guards from a77b0f74f (2026-08-27).
Production ran older images on a hand-edited `nats.conf` until the 2026-09-19 deploys
re-materialised the repository's configuration; the first containers built from `main` were the
first thing to resolve these modules and to open a connection under the generated ACL.

## INFRA-HIGH-180 — the scoped inbox prefix ends in a dot (fixed by pull request 1637)

**Defect.** `scopedInboxPrefix` returned `_INBOX<CN>.`; `@nats-io/nats-core`'s `createInbox` returns
`${prefix}.${nuid}`, so the request/reply mux subscription was `_INBOX<CN>..<nuid>.*`. A subject
with an empty token is outside every grant, including the one written for it (`_INBOX<CN>.>`), so
the first request any service makes at boot (the JetStream manager's) is refused and
`NatsEventBus.connect` throws.

**Proof.** A probe from the droplet as `event_store_service` with the fixed prefix connects and gets
past the subscription; with the trailing dot it reproduces the live error verbatim. The unit spec
now derives the inbox through `createInbox` and checks every token against the grant; with the dot
restored, four of its five cases fail.

**Fix (pull request 1637).** No trailing dot — the same convention the two fixed prefixes in
`@platform/event-contracts` (`_INBOXBILLINGCFG`, `_INBOXFARMMARINECFG`) already follow.

## INFRA-HIGH-181 — the JetStream manager probes `$JS.API.INFO` (fixed by pull request 1637)

**Defect.** With the inbox fixed, the same probe failed on the next step:
`Permissions Violation for Publish to "$JS.API.INFO"`. `jetstreamManager(connection)` checks
JetStream availability with an account-info request by default; the SSoT ACL enumerates each
service's JetStream rights as `$JS.API.STREAM.{INFO,CREATE,UPDATE}.>` and `$JS.API.CONSUMER.>`
(SENSOR-HIGH-092), and no identity is granted `$JS.API.INFO`. The invariant that bans bare
`$JS.API.>` grants is right; the client had to fit inside the enumeration and did not.

**Fix (pull request 1637).** `$JS.API.INFO` is granted to every JetStream identity in
`services.yaml` and the broker configuration is regenerated; a `nats-invariants` case pins the
grant. The alternative — `jetstreamManager(connection, { checkAPI: false })`, since `setupStream`'s
`STREAM.INFO` fails just as loudly when JetStream is off — was not taken, so the boot-path smoke
below runs the manager with its default probe, exactly as the bus does.

## SENSOR-CRITICAL-127 — SensorErasureModule re-provides MqttAuthService

**Defect.** The module listed `MqttAuthService` under its own `providers` "so the class token is
resolvable for the hook". Listing a class under `providers` makes Nest build a second instance
inside that module, resolved against that module's imports — where the `EdgeDevice` repository only
`EdgeDeviceModule` registers does not exist. Had it resolved, the second instance would have carried
its own empty auth cache, and `MqttAuthCacheInvalidationHook` would have invalidated a cache the
MQTT auth controller never reads.

**Fix.** `imports: [EdgeDeviceModule]` (which exports the service) and the provider entry removed.
`IngestionModule` already imports both modules, so no cycle is introduced.

## BILLING-CRITICAL-019 — a type-only import of an injected class

**Defect.** `import type { DiscountCodeService }` is erased at compile time, so
`emitDecoratorMetadata` records `Function` for that constructor parameter and the container has no
token to resolve. The compiler, the linter and the hand-built unit tests all pass; only a container
boot notices.

**Fix.** A value import. The repository-wide scan found one other instance, `ClaudeApiBudgetService`
in backend-common, a hand-built class (its second parameter is a plain options object) wearing a
decorative `@Injectable()`; the decorator is removed rather than the import changed.

## FARM-CRITICAL-331 — a re-provided recalculation service and a `Pick<>`-typed dependency

**Defect.** FeedingModule, BatchModule, GrowthModule, HarvestModule and WaterQualityModule each
listed ProtocolRateService / DayPlanRecalcService / BiomassGrowthApplierService under their own
`providers` because FeedingProtocolModule imports FeedingModule and GrowthModule, so none of them
could import it back without a cycle. Each copy resolves its dependencies where it lives; when
DayPlanRecalcService gained a ProtocolResolutionService dependency, FeedingModule's copy had nowhere
to find it. Behind that, TenantOnboardingEventHandler typed its readiness checker as
`Pick<FeedingReadinessCheckerService, 'check'>` — for test convenience — which leaves `Object` in
the metadata.

**Fix.** `FeedingProtocolCoreModule`, a leaf module providing and exporting the four shared protocol
services (they depend only on each other and on `@Global` providers); every consumer imports it and
FeedingProtocolModule re-exports it. FeedingProtocolModule likewise imports BatchModule for
BatchDomainService instead of re-providing it, and admin-api's SystemModulesModule imports
TenantManagementModule for AuthTenantProvisioningClientService. The handler's parameter is the
class; its spec passes a typed collaborator double. That removes all twelve duplicates the
duplication invariant first baselined (ORPHAN-MEDIUM-833), so it now carries no baseline.

## SEC-CRITICAL-169 — a `useClass` limiter and a root-scoped revocation store

**Defect.** WebSocketModule registered TenantConnectionLimiter with `useClass`, but the class takes
a plain options object (an interface) — the same erasure as BILLING-CRITICAL-019. Behind it, the
WsTokenRevalidator factory injects `TOKEN_BLACKLIST_STORE`, which AppModule declared among its own
providers; a child module cannot see the root's providers, so the token was unresolvable in
WebSocketModule.

**Fix.** The limiter is built by a `useFactory` (both socket guards lose their decorative
`@Injectable()`), and `GatewayTokenBlacklistModule` owns and exports the revocation store, imported
by AppModule (for the global AuthGuard and JwtMiddleware) and by WebSocketModule.

## PLAT-CRITICAL-918 — durable consumers are created, never updated

**Defect.** With the ACL and the four DI defects fixed, release `ab0f8b203@20260920T111748Z` reached
JetStream and twelve services died on `Bootstrap failed: consumer already exists` (config-service,
event-store-service and observability-service, which hold no changed durables, came up healthy).
`@nats-io/jetstream` 3.x `consumers.add()` sends the server action `create`, which nats-server
refuses (10148) whenever the durable exists with any other configuration. The `nats` v2 client the
bus was written against sent the empty create-or-update action; the v3 migration changed that
silently, and the library's `add()` cannot send the empty action at all (`opts.action || 'create'`).
The stored consumer `aquaculture-auth-service-events---TenantSubscriptionChanged` carries
`max_deliver: 3`; the code has sent `-1` since the dead-letter route landed. Nothing before
production held a previous release's consumers.

**Proof.** Against nats:2.10.24: `add` with a differing updatable field → 10148; `update` by durable
name → accepted, ack position kept; an identical `add` is idempotent; a non-updatable change
(`deliver_policy`) → 10012 "deliver policy can not be updated".

**Fix.** The bus creates, and on 10148 updates the durable in place (`consumers.update`); every
other failure still propagates. `nats-event-bus.durable-consumer.spec.ts` pins the three branches.
The real-broker gate that would have caught it — a boot against a store holding a previous release's
consumers — is tracked as PLAT-HIGH-919 (owner claude, deadline 2026-09-27).

## Why the gates were green

- `nats-invariants.spec.ts` validates `services.yaml` and the generated `nats.conf` as files; the
  factory and the bus are unit-tested against mocks; CI's broker runs without the generated
  configuration. Nothing ever put a real certificate identity through the real boot path under the
  real ACL.
- No job compiled a service's NestJS dependency graph. Four services sat unbootable on `main` behind
  green CI, two of them for 13 and 25 days.

## Gates added

- `scripts/nats/boot-path-acl-smoke-harness.sh` + `tools/scripts/nats-boot-path-acl-smoke.ts`: a
  broker on the repository's `nats.conf`, one minted certificate per identity in `services.yaml`,
  and — for every NestJS application — the factory's own prefix derivation, a connect, and the bus's
  JetStream sequence (`jetstreamManager()` with its default `$JS.API.INFO` probe, then
  create-or-update of the three streams). Wired into `nats-invariants.yml`; the workflow now also
  triggers on `libs/backend-common/src/nats/**`. With the trailing dot restored in the factory, or
  the `$JS.API.INFO` grant removed from `services.yaml`, all fifteen identities fail.
- `apps/<service>/src/__tests__/di-graph.spec.ts` in all fifteen NestJS applications, through
  `assertNestGraphResolves` in `@platform/testing`: Nest's own container is built from AppModule in
  preview mode — every module, provider, controller and resolver resolved, nothing instantiated, no
  database, broker or cache. It reproduces each of the four DI errors above verbatim in under a
  second and runs with the application's unit suite on every affected change. This closes
  ORPHAN-HIGH-834. (GraphQLModule is on Nest's preview allowlist and its factory injects
  ConfigService, so the helper allowlists the config modules too; nothing else is instantiated.)
- `tests/invariants/nest-injected-type-only-import.spec.ts`: in every `@Injectable`/`@Controller`/
  `@Resolver` class, a constructor parameter without an explicit `@Inject*` token (and not
  `@Optional()`) must be a plain reference to a value-level class — not a type-only import, a
  same-file interface or type alias, a utility type such as `Pick<>`, a union, a literal or a
  primitive. The repository-wide sweep found nine hand-built classes wearing a decorative
  `@Injectable()`; the decorators are removed, the classes unchanged.
- `tests/invariants/nest-module-provider-duplication.spec.ts`: a module that lists a class another
  module of the same application provides and exports is a violation. No baseline.

## Not done in this cycle

- The droplet's `FRONTEND_URL` (now `https://app.suderra.com`, set by the operator) lives outside
  the repository; nothing here verifies the deploy environment.
- The DI-graph spec proves the container resolves; it does not run module hooks, so a failure inside
  `onModuleInit` (a connection, a migration check) is still first seen at boot — PLAT-CRITICAL-918
  was exactly that, and PLAT-HIGH-919 is the real-broker boot test that closes the gap for the event
  bus.
