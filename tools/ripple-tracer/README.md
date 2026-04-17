# ripple-tracer

**Phase 3 deliverable** (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-3). Answers a single question: "if the contract of event type `X` changes, which services are affected?"

The naive grep-for-event-name approach misses wildcard NATS subscribers (`AQUACULTURE_EVENTS.Sensor.>`) and silently under-reports the ripple set. ripple-tracer reads `infrastructure/nats/services.yaml` (the ADR-015 cert-is-identity SSoT) and does NATS-spec-correct subject matching to enumerate every subscriber whose filter matches the event's subject.

Consumed by:
- `change-event-contract` skill (Step 3) — produces the consumer-service list that feeds the dual-publish protocol.
- `data-expert` agent CATCHER mode — verifies every breaking event change has a matching ripple audit.
- `implementation-planner` — turns the ripple list into Phase-4 cross-domain dispatch targets in the orchestrator cycle.

## Usage

```bash
npx ts-node --project tools/ripple-tracer/tsconfig.json \
  tools/ripple-tracer/cli.ts --event <EventType>
```

Example:

```
$ npx ts-node --project tools/ripple-tracer/tsconfig.json \
    tools/ripple-tracer/cli.ts --event SensorReading

Ripple set for event "SensorReading" (subject pattern
AQUACULTURE_EVENTS.SensorReading.>):

| Service                  | Match reason                                     |
|--------------------------|--------------------------------------------------|
| alert_engine             | subscribes to AQUACULTURE_EVENTS.>               |
| observability_service    | subscribes to AQUACULTURE_EVENTS.>               |
| event_store_service      | subscribes to AQUACULTURE_EVENTS.>               |
| messaging_service        | subscribes to AQUACULTURE_EVENTS.Sensor*.>       |

Excluded (do not subscribe to this event): auth_service, farm_service, hr_service, ...

Producer: sensor_service (publishes AQUACULTURE_EVENTS.SensorReading.>)
```

### Exit codes

- `0` — ripple computed successfully.
- `1` — event type not found in any producer's publish list.
- `2` — usage error (missing `--event`).
- `3` — services.yaml parse error.

## What it does

1. Parses `infrastructure/nats/services.yaml` into `{ name, publish: [...], subscribe: [...] }[]`.
2. Resolves the event's NATS subject from the event type name. Default resolution: `AQUACULTURE_EVENTS.<EventType>.>` (matches aqua-saas convention; override via `--subject` flag when the event uses a non-default subject).
3. Identifies the PRODUCER — the service whose `publish:` list contains a pattern that matches the subject.
4. Identifies SUBSCRIBERS — every service whose `subscribe:` list contains a pattern that matches the subject, using NATS-spec subject matching:
   - `*` matches exactly one subject segment (between dots).
   - `>` matches one or more tail segments.
   - A literal segment matches only itself.
5. Emits the ripple set as a Markdown table.

## What it deliberately does NOT do (yet)

- **Consumer file enumeration** — identifying the specific `*.subscriber.ts` file in each subscribing service is a Phase 2 extension requiring ts-morph AST traversal. The Phase 3 MVP stays at the service-level — the receiving agent's CATCHER + the existing `@EventPattern` / `@MessagePattern` grep inside the subscribing service is sufficient for the dispatch.
- **Dynamic subject interpolation** — events whose subject includes a runtime variable (e.g. `events.tenant.${tenantId}.>`) are matched by the STATIC portion. A `--verbose` flag could emit a "requires runtime check" warning; left for v2.
- **Subject glob escaping** — the NATS spec does not support `*` or `>` inside a literal segment, so no escape handling is needed.

## Invariants

- The services.yaml is the ONLY source of subscription truth. A service that runs code calling `nats.subscribe(...)` with a subject NOT in its yaml `subscribe:` list WILL be rejected at runtime by the NATS authorization ACL (per `verify_and_map: true` + generated `nats.conf`). Any divergence between the yaml and the running service is caught by `e2e/tests/integration/nats-invariants.spec.ts`.
- Adding a new event subject requires:
  1. Producer's yaml `publish:` list gets the subject pattern.
  2. Regenerate `nats.conf` via `scripts/nats/generate-nats-conf.py`.
  3. Commit all changes together per the NATS services-yaml maintenance contract.
  4. The new subject becomes immediately traceable via this tool.

## Related

- ADR-014 — NATS mTLS-only auth.
- ADR-015 — NATS cert-is-identity SSoT (services.yaml).
- `.claude/agents-enterprise-v2/data-expert.md` — ripple-tracer consumer enumeration requirement for event-shape changes.
- `.claude/skills/change-event-contract.md` — primary consumer of this tool.
- `infrastructure/nats/services.yaml` — input data source.
- `e2e/tests/integration/nats-invariants.spec.ts` — validates the yaml-vs-nats.conf agreement.

## Implementation shape

```
tools/ripple-tracer/
├── README.md            (this file)
├── cli.ts               (single-file: argv parsing + narrow yaml parser + NATS subject matcher + Markdown/JSON render)
└── tsconfig.json        (CommonJS + noUncheckedIndexedAccess, same as tools/gates/)
```

Two code files. No new runtime dependencies — the yaml parser is a narrow regex-based path targeting the specific shape of infrastructure/nats/services.yaml (flat `services:` list with `name` / `publish` / `subscribe` string arrays); the NATS subject matcher is pure regex (no external NATS dependency needed for the static analysis). Single-file CLI avoids ts-node + ESM auto-detect module-resolution fragility that bit the initial 3-file split — helpers stay inlined since total LOC is ~300.
