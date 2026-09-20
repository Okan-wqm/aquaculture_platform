# The 2026-09-20 boot-path outage: four defects the production container was the first to run

**Date:** 2026-09-20 · **Reviewer:** claude (live diagnosis on the production droplet) · **Scope:**
`libs/backend-common/src/nats`, `platform/libs/event-bus`,
`apps/sensor-service/src/compliance/erasure`, `apps/billing-service/src/billing/services`,
`infrastructure/nats`, `.github/workflows/nats-invariants.yml`

**Trigger.** The automatic deploy of `main` at 2026-09-19 23:53Z left every backend crash-looping
and the gateway `Created`; `https://app.suderra.com` answered 502 and nobody could log in. The
deploy of `750db0409` at 06:49Z failed at `service_recreate` for the same reasons and rolled back to
images that could not boot under `main`'s compose either.

**Findings:** SENSOR-CRITICAL-127 and BILLING-CRITICAL-019 (fixed here); ORPHAN-MEDIUM-833
(baselined by the new invariant); ORPHAN-HIGH-834 (the class-level gate, tracked with owner and
deadline). The two NATS defects are INFRA-HIGH-180 and INFRA-HIGH-181, registered and fixed by PR
#1637 (012bc5f3a) while this cycle was diagnosing the same outage; this document keeps their live
evidence and adds the gate that proves them.

## What the live system said

Every service that runs the event bus died the same way:

```text
Bootstrap failed: Permissions Violation for Subscription to
  "_INBOXEVENT_STORE_SERVICE..fZsWGFQGvjYYQ75mOG8uoT.*"
```

and `aqua-nats` logged, per identity, a `Subscription Violation` for `_INBOX<CN>..<nuid>.*` followed
by a `Publish Violation` for `$JS.API.INFO`. Two services failed before reaching NATS:

```text
sensor-service:  Nest can't resolve dependencies of the MqttAuthService
                 (ConfigService, ?, DataSource, DeviceDirectoryService).
                 … "EdgeDeviceRepository" at index [1] … in the SensorErasureModule
billing-service: Nest can't resolve dependencies of the ModulePricingService
                 (ModulePriceRepository, DataSource, ?).
                 … argument Function at index [2] … in the BillingModule
```

auth-service additionally refused its environment (`FRONTEND_URL must use https in production`; the
droplet's `.env` carried `http://89.38.97.90`). That is an operator setting, not a repository
defect; the operator set it to `https://app.suderra.com` during this cycle.

None of the four defects is new. The inbox prefix dates from 0afecd4f3 (2026-08-27), the JetStream
probe from the SSoT ACL's enumeration of JetStream rights, the sensor module from 65753cb90
(2026-08-26), the billing import from 3352ceda6 (2026-09-07). Production ran older images on a
hand-edited `nats.conf` until the 2026-09-19 deploys re-materialised the repository's configuration;
the first containers built from `main` were the first thing to resolve these modules and to open a
connection under the generated ACL.

## INFRA-HIGH-180 — the scoped inbox prefix ends in a dot (fixed by #1637)

**Defect.** `scopedInboxPrefix` returned `_INBOX<CN>.`; `@nats-io/nats-core`'s `createInbox` returns
`${prefix}.${nuid}`, so the request/reply mux subscription was `_INBOX<CN>..<nuid>.*`. A subject
with an empty token is outside every grant, including the one written for it (`_INBOX<CN>.>`), so
the first request any service makes at boot (the JetStream manager's) is refused and
`NatsEventBus.connect` throws.

**Proof.** A probe from the droplet as `event_store_service` with the fixed prefix connects and gets
past the subscription; with the trailing dot it reproduces the live error verbatim. The unit spec
now derives the inbox through `createInbox` and checks every token against the grant; with the dot
restored, four of its five cases fail.

**Fix (#1637).** No trailing dot — the same convention the two fixed prefixes in
`@platform/event-contracts` (`_INBOXBILLINGCFG`, `_INBOXFARMMARINECFG`) already follow.

## INFRA-HIGH-181 — the JetStream manager probes `$JS.API.INFO` (fixed by #1637)

**Defect.** With the inbox fixed, the same probe failed on the next step:
`Permissions Violation for Publish to "$JS.API.INFO"`. `jetstreamManager(connection)` checks
JetStream availability with an account-info request by default; the SSoT ACL enumerates each
service's JetStream rights as `$JS.API.STREAM.{INFO,CREATE,UPDATE}.>` and `$JS.API.CONSUMER.>`
(SENSOR-HIGH-092), and no identity is granted `$JS.API.INFO`. The invariant that bans bare
`$JS.API.>` grants is right; the client had to fit inside the enumeration and did not.

**Fix (#1637).** `$JS.API.INFO` is granted to every JetStream identity in `services.yaml` and the
broker configuration is regenerated; a `nats-invariants` case pins the grant. The alternative —
`jetstreamManager(connection, { checkAPI: false })`, since `setupStream`'s `STREAM.INFO` fails just
as loudly when JetStream is off — was not taken, so the boot-path smoke below runs the manager with
its default probe, exactly as the bus does.

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

## Why the gates were green

- `nats-invariants.spec.ts` validates `services.yaml` and the generated `nats.conf` as files; the
  factory and the bus are unit-tested against mocks; CI's broker runs without the generated
  configuration. Nothing ever put a real certificate identity through the real boot path under the
  real ACL.
- No job compiles a service's NestJS dependency graph. Two services sat unbootable on `main` behind
  green CI for 13 and 25 days.

## Gates added

- `scripts/nats/boot-path-acl-smoke-harness.sh` + `tools/scripts/nats-boot-path-acl-smoke.ts`: a
  broker on the repository's `nats.conf`, one minted certificate per identity in `services.yaml`,
  and — for every NestJS application — the factory's own prefix derivation, a connect, and the bus's
  JetStream sequence (`jetstreamManager()` with its default `$JS.API.INFO` probe, then
  create-or-update of the three streams). Wired into `nats-invariants.yml`; the workflow now also
  triggers on `libs/backend-common/src/nats/**`. With the trailing dot restored in the factory, or
  the `$JS.API.INFO` grant removed from `services.yaml`, all fifteen identities fail.
- `tests/invariants/nest-injected-type-only-import.spec.ts`: in every `@Injectable`/`@Controller`/
  `@Resolver` class, a constructor parameter without an explicit `@Inject*` token whose type is a
  type-only import is a violation.
- `tests/invariants/nest-module-provider-duplication.spec.ts`: a module that lists a class another
  module of the same application provides and exports is a violation. Twelve pre-existing duplicates
  in farm-service and admin-api-service are baselined under ORPHAN-MEDIUM-833; the list only
  shrinks.

## ORPHAN-HIGH-834 — the class-level gap

The two invariants above catch the two shapes seen. An unresolvable token of any other origin — a
missing module import, a provider in the wrong scope, a circular `forwardRef` — still reaches
production first. The fix is a per-service dependency-graph check that builds the container from
`AppModule` metadata without instantiating providers and verifies every constructor token against
the module's providers, its imports' exports and the global modules; it needs no database or broker
and belongs in `ci-affected` for each affected application. Owner: claude. Deadline: 2026-10-04.

## Not done in this cycle

- The droplet's `FRONTEND_URL` (now `https://app.suderra.com`, set by the operator) lives outside
  the repository; nothing here verifies the deploy environment.
- ORPHAN-MEDIUM-833 (the twelve baselined duplicates) and ORPHAN-HIGH-834 (the dependency-graph
  gate) are tracked with owner and deadline above.
