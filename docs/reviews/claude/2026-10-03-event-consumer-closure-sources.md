# Event-consumer enumeration: the ACL grants hide most consumers (2026-10-03)

Context: while repairing the plan-coverage witness (ARIA-HIGH-306,
`docs/reviews/claude/2026-10-03-plan-coverage-witness-live-services-yaml.md`), two adjacent defects
were measured that ARIA-HIGH-306 does not close. Both concern how a consumer of an event contract is
enumerated from `infrastructure/nats/services.yaml`. Measured on
`fix/coverage-witness-live-services-yaml @ 7275de34e` (main 4ce31871d plus the ARIA-HIGH-306 fix).

Owner: claude (implementation), okan (review). Deadlines: ARIA-HIGH-313 2026-10-17, ARIA-MEDIUM-314
2026-10-24.

## ARIA-HIGH-313 — JetStream durable consumers have no subscribe grant naming their event

`infrastructure/nats/services.yaml` lists NATS ACL grants. A service that consumes an event through
the platform event bus creates a durable JetStream pull consumer
(`platform/libs/event-bus/src/nats/nats-event-bus.ts:1303-1308`) and receives through
`$JS.API.CONSUMER.>` and its scoped inbox, so its subscribe grants never name the event it consumes.
The plan-coverage witness derives the `event-consumer:<svc>:<T>` closure from those subscribe
grants alone (`tools/gates/plan-coverage-witness.ts:481`), so it sees only the services that hold a
core-NATS grant covering the subject.

Example: `notification-service` handles `UserInvited`
(`apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:109`), but its
subscribe list (`infrastructure/nats/services.yaml:438-446`) holds commands, JetStream API subjects
and its inbox only. The SSoT shows `gateway-api` (`:406`) and `messaging-service` (`:713`) as the
only `events.*.UserInvited` subscribers, through `events.>`.

Measured: a lexical scan of `apps/*/src` (non-test `.ts`) for `subscribeWildcard`, `subscribe`,
`subscribeForTenant`, `subscribeTo` and `@EventPattern` call sites with a literal event type finds
50 (service, event type) consumer pairs. With the same subject rule the repaired witness applies,
6 are visible in the SSoT (gateway-api: EdgeDeviceAlarm, EdgeDeviceIoData, SensorReading;
messaging-service: MessageSent, TenantProvisioned, UserDeleted) and 44 are not, across 8 services:
notification-service 21, alert-engine 7, farm-service 7, auth-service 3, sensor-service 2,
ai-service 2, hr-service 1, billing-service 1. The scan is a lower bound; subscription forms it does
not recognize would only add invisible pairs.

Severity HIGH, not MEDIUM: the event-consumer node class is the gate's only machine check that a
contract change reaches its consumers, and it misses 44 of 50 known consumer pairs. A plan changing
an event contract can reach `covered` while the services that actually handle the event are
unaddressed, which is the blind spot the coverage gate exists to close.

Evidence:

- `platform/libs/event-bus/src/nats/nats-event-bus.ts:1303-1308` (durable pull consumer per
  subscription)
- `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:109`
  (`subscribeWildcard('UserInvited', this)`)
- `infrastructure/nats/services.yaml:438-446` (notification_service subscribe grants name no event)
- `infrastructure/nats/services.yaml:406` and `:713` (`events.>` for gateway and messaging)
- `tools/gates/plan-coverage-witness.ts:481` (consumers matched against subscribe grants only)

Rule: The event-consumer closure is computed from a source that names every event type each service
consumes, and that source is checked against the code's subscription sites so a consumer cannot
exist without appearing in it. NATS ACL grants are not that source.

## ARIA-MEDIUM-314 — ripple-tracer still parses the old services.yaml format

`tools/ripple-tracer/cli.ts` keeps the parser the witness was ported from. It accepts only quoted
list items (`:107`), the format the SSoT left on 2026-08-01 (a297b45dd), and matches consumers
against `AQUACULTURE_EVENTS.<T>.>` (`:195`), the namespace the grants left on 2026-07-02
(0b1596576). It also names services by their NATS identity and never reads `application:`.

Measured: `ts-node tools/ripple-tracer/cli.ts --event UserInvited --format json` reports
`yaml_service_count: 17`, subject `AQUACULTURE_EVENTS.UserInvited.>`, `producers: []`,
`subscribers: []`.

Severity MEDIUM: ripple-tracer is not a merge gate. The change-event-contract skill names its
output as the authoritative consumer set for the dual-publish protocol
(`.claude/skills/change-event-contract.md:66`), so an agent following the skill enumerates no
consumers and no producers for any event.

Evidence:

- `tools/ripple-tracer/cli.ts:107` (quoted-only list item regex)
- `tools/ripple-tracer/cli.ts:195` (`AQUACULTURE_EVENTS.${eventType}.>`)
- `.claude/skills/change-event-contract.md:66` (the skill's consumer enumeration step)

Rule: Every reader of `infrastructure/nats/services.yaml` reads it with a YAML parser, holds it to
the shape `scripts/nats/generate-nats-conf.py` enforces, derives subjects from the declared grants
and maps identities through `application:`; one shared reader, not per-tool copies, so a format
change cannot leave one consumer behind.
