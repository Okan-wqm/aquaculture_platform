# `as never` removal — one production contract violation, 23 unchecked doubles

Date: 2026-09-05 · Agent: zcode · Cycle: `2026-09-05-as-never-typed-doubles` · Base:
`claude/branch-evaluation-merge-s5grgw`

## Scope

`tools/gates/banned-construct.ts --mode=range origin/main HEAD` reported 24 `as never`
occurrences added by this branch, across 7 files. This pass removes all 24 by giving each
value a real type. No other file is touched, no assertion is weakened, and no test is
skipped or deleted.

## PLAT-MEDIUM-909 — a NATS subscriber that is not an `IEventHandler`

**Verified state (before this pass).** `ErasedTenantTombstoneService.attachEventBus`
subscribed with an object literal carrying a single member:

```
eventBus.subscribeTo('events.*.TenantErased', { handle: (event) => { … } } as never)
```

`IEventSubscriber.subscribeTo` declares `handler: IEventHandler<TEvent>`, and
`IEventHandler` is `handle()` **plus** `getEventType()`
(`platform/libs/event-bus/src/interfaces/event-bus.interface.ts:44`). The literal had no
`getEventType`, so it was not an `IEventHandler` — and the cast is exactly what stopped the
compiler from saying so. It is latent rather than firing today only because the current
JetStream dispatch path reads `handler.handle` and never consults the declared type
(`nats-event-bus.ts:1381`); the first bus path that does — routing, filtering, a
registration audit — gets `undefined` from a subscriber that type-checked clean.

The handler's parameter was typed `Record<string, unknown>`, which is not assignable to the
`TEvent extends IEvent` constraint either. That is the second thing the cast hid, and it is
why the fix cannot be pushed to the call site: there is no caller to fix. The wrong shape
was constructed here.

**Resolution.** The subscriber is now a declared `IEventHandler<IEvent>` const, with
`getEventType()` present and `handle` typed. Both members are checked against the interface,
so the missing-member class cannot recur in this file without failing the build.

**Why `IEvent` and not `TenantErasedEvent`.** The contract type looks stronger and would be
the wrong choice. What the bus actually proves before dispatch is `isIEvent`: a decoded
object with string `eventId` / `eventType` / `timestamp` (`nats-event-bus.ts:126`). The
subject-anchored schema validator that would otherwise guarantee the payload consults only
the farm, sensor and messaging registries (`validateEventBySubject`,
`libs/event-contracts/src/schemas/validator.ts:485`) — tenant events are not among them, so a
`TenantErased` message reaches this handler **unvalidated** and the compiled `TenantErased`
schema in `tenant-events.schema.ts` is never applied on this path. Declaring the parameter as
the contract would assert a guarantee nothing enforces, and would turn the two existing
runtime guards into code that looks dead. They are not: `tenantId` is optional on `IEvent`,
so the `typeof` test is the narrowing that makes `.slice(0, 8)` safe. Behaviour is therefore
unchanged — same guards, same log, same subject — with the handler contract now enforced.

## The 23 spec doubles — the same defect one layer down

Each was a value forced into a type nobody checked it against. Replaced using the SSoT
helpers in `libs/testing/src/doubles/typed-double.ts`, choosing by what the double stands in
for:

| Double                                       | Was                                                                         | Now                                                                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NatsConnection` (telemetry + dlq specs)     | `Object.assign({} as NatsConnection, …)` then cast into `mockResolvedValue` | `stub<NatsConnection>` — a VALUE: the bus reads `info` on the replica clamp and must see `undefined`, as a standalone server yields. `status()` is a typed `AsyncIterable<Status>` helper, checked against the real signature for the first time |
| `JetStreamManager` / `JetStreamClient`       | `Object.assign({} as never, …)`                                             | `stub<JetStreamManager>` / `stub<JetStreamClient>` with nested `stub<StreamAPI>`, `stub<ConsumerAPI>`, `stub<Consumers>`                                                                                                                         |
| `buildNatsConnectionOptions()` return        | cast                                                                        | nothing — the literal already satisfies the real return type; the cast was covering a fit that existed                                                                                                                                           |
| `bus.publish({…})` events                    | cast                                                                        | nothing — the literals satisfy `TEvent extends IEvent` by inference                                                                                                                                                                              |
| `subscribeTo` / `subscribeWildcard` handlers | cast                                                                        | real handlers with `getEventType()` — the same missing member as the production defect above, in two more places                                                                                                                                 |
| `EntityManager` (erasure hooks)              | `Partial<EntityManager>` with a cast member                                 | `collaborator<EntityManager>` + `stubMember<EntityManager['query']>` — BEHAVIOUR, so an unmodelled call names itself                                                                                                                             |
| `TenantErasureRequestedEvent`                | inline literal cast                                                         | `stub<TenantErasureRequestedEvent>` — `tenantId`/`dryRun` now checked against the contract                                                                                                                                                       |
| `MqttAuthService`, `TankBatchService`        | cast                                                                        | `collaborator<T>(…, 'T')`                                                                                                                                                                                                                        |
| `DataSource` (tombstone spec)                | `{} as never`                                                               | `collaborator<DataSource>({}, 'DataSource')` — the empty shape is the assertion: the ingress gate is pure in-memory state, so any DataSource touch fails by name                                                                                 |
| `DataSource` (retention orchestrator)        | cast member on a `Partial`                                                  | `collaborator<DataSource>` + `stubMember<DataSource['createQueryBuilder']>` (a 3-signature overload set, which no single-signature `jest.fn` can satisfy)                                                                                        |
| billing `FakeManager` row indexing           | `(row as never)[k]`                                                         | a key list pinned by `satisfies readonly (keyof StoredRow)[]`, so `row[key]` needs no cast; an unmodelled `where` column now throws instead of matching every row                                                                                |
| billing `StoredRow`                          | hand-declared beside the entity                                             | `Pick<TelemetryCapacityEntitlementEntity, …>` — a renamed column breaks the fixture                                                                                                                                                              |
| billing `FakeDataSource` → service           | `ds as never`                                                               | `collaborator<DataSource>` + `stubMember` for `transaction` / `query`, with a `collaborator<EntityManager>` inside it                                                                                                                            |

`stubMember` is used only where TypeScript genuinely cannot check a single-signature mock
against an overloaded or generic member; every other member stays fully checked, which is the
whole reason that helper forces the call site to name the member type.

## Verification

- `banned-construct --mode=range origin/main HEAD` — 0 violations (was 24).
- `tsc --noEmit` on `tsconfig.spec.json` for `platform/libs/event-bus`, `apps/sensor-service`,
  `apps/billing-service`, `apps/farm-service`, plus `tsconfig.app.json` for the three apps —
  clean. This is the check the casts were suppressing, so it is the one that matters: every
  double now compiles against the type it stands in for.
- Jest, per project: event-bus 10/10, sensor-service 21/21, billing-service 7/7,
  farm-service 4/4.
- `prettier --check` clean on all 7 files. `eslint` clean on 5 of 7; the two event-bus specs
  carry pre-existing errors (module-boundary cycle via `@aquaculture/backend-common/nats`,
  `no-unsafe-member-access` on `jest.Mock` call records, `no-non-null-assertion`) that this
  pass neither introduces nor inherits responsibility for — a before/after ESLint run over the
  committed versions shows an identical error set minus one
  `no-unnecessary-type-assertion` per file, which was the removed cast itself. The
  `event-bus` project has no `lint` target in `project.json`, which is why they were never
  gated; that gap is not fixed here and is not claimed to be.
