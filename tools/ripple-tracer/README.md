# ripple-tracer

**Phase 3 deliverable** (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-3). Answers: "which services may publish event type `X`, which services consume it, and whose NATS grants admit it?"

ripple-tracer reads `infrastructure/nats/services.yaml` (the ADR-015 cert-is-identity SSoT) through `tools/gates/nats-services.ts`, the one tool-side reader of that file: a YAML parse held to `infrastructure/nats/services.schema.json`, NATS subject matching, and the rule for the subjects an event travels on. The plan-coverage witness and the boot-path ACL smoke read the SSoT through the same module, so a format change reaches every tool at once (ARIA-MEDIUM-314: this CLI's private parser accepted only quoted list items and a retired `AQUACULTURE_EVENTS.<T>.>` subject, and reported nothing for every event after the SSoT changed).

Consumed by:

- `change-event-contract` skill (Step 3).
- `data-expert` agent CATCHER mode.
- `implementation-planner`, for Phase-4 cross-domain dispatch targets.

## Usage

```bash
npm run ripple -- --event <EventType> [--subject <override>] [--services-yaml <path>] [--format markdown|json]
```

## What it does

1. Loads services.yaml through `loadNatsServices()`; a file the schema refuses is exit 3.
2. Resolves the event's subjects with `eventSubjectsFor()`: every publish grant whose tokens include the event type (`events.*.UserInvited`, `telemetry.*.SensorReading`), else the event bus's default `events.*.<EventType>`. `--subject` replaces them.
3. Producers: services whose `publish:` grants overlap a subject.
4. ACL subscribers: services whose `subscribe:` grants overlap a subject, with the grant, the subject and `catch_all` (true when the grant admits the event only through wildcards, such as `events.>`).
5. Consumers: `eventConsumersFor()` from `tools/gates/event-consumer-index.ts`, the same set the plan-coverage witness uses. It scans this checkout's `apps/`, `libs/` and `platform/libs/` sources with the TypeScript checker for subscription sites (event-bus `subscribe`, `subscribeWildcard`, `subscribeForTenant`, `subscribeTo`, NATS client `subscribe`, `@SubscribeTo`, `@EventHandler`, `@EventPattern`) and unites them with the grants that name the event. Catch-all grants are listed apart.
6. Prints Markdown, or JSON with `event_type`, `subjects`, `subject_source` (`declared`, `default_root` or `override`), `yaml_service_count`, `producers` and `acl_subscribers` (each with `name`, `application`, `description`, `grant`, `subject`, `catch_all`), `consumer_source` (`code_subscriptions+acl_grants`), `consumers` (each with `application`, `sources`, `code_sites`, `grant`, `subject`), `acl_catch_all` and `unresolved` (subscription sites whose value the scan cannot resolve).

Subject matching follows NATS: `*` is exactly one token, `>` is the last token and matches one or more, every other token is literal.

## What an ACL grant proves

A subscribe grant says a service MAY receive the event. JetStream durable consumers receive through `$JS.API.CONSUMER.>` and their inbox, so their grants never name the event they consume, and a catch-all grant is a permission, not consumption. That is why `consumers` come from the code (ARIA-HIGH-313) and `acl_subscribers` is kept only as the ACL view.

## Exit codes

- `0` — at least one service may publish the event on its subjects.
- `1` — no service may publish it (a typo, a non-NATS event, or an override subject nobody publishes on).
- `2` — usage error.
- `3` — services.yaml unreadable or refused by its schema.

## Tests

`tools/gates/ripple-tracer.spec.ts` runs this CLI against the live SSoT; `tools/gates/nats-services.spec.ts` pins the reader, the matcher and the subject rule; `tools/gates/event-consumer-index.spec.ts` pins the code scan (all run by `npm run gates:test`).

## Related

- ADR-014 — NATS mTLS-only auth.
- ADR-015 — NATS cert-is-identity SSoT (services.yaml).
- `e2e/tests/integration/nats-invariants.spec.ts` — validates the yaml-vs-nats.conf agreement.
