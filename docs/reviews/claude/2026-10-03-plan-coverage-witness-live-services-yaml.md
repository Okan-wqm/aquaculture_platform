# The plan-coverage witness reads none of the live services.yaml (2026-10-03)

Context: ARIA's plan-coverage gate (`aria-kernel/aria_kernel/plan_coverage.py`) runs
`tools/gates/plan-coverage-witness.ts` to compute a plan's impact closure before CONVERGED. One of
its three node classes, `event-consumer:<svc>:<EventType>`, comes from the NATS SSoT
`infrastructure/nats/services.yaml`. The completeness review of program rev3 (§1 M1) and the
architecture attack on rev3.1 (ARCH-BLOCKER-001) found that this class has been empty on main
without anyone seeing it. The rev3.1 plan of record (R3-D3) splits the repair: CR-0a restores the
declared behaviour before the first end-to-end run; CR-0b (migration semantics, kebab→snake) lands
with K41. Re-checked on `main @ 4ce31871d`.

Owner: claude (implementation), okan (review). Deadline 2026-10-08, before the first end-to-end run.

## ARIA-HIGH-306 — The event-consumer closure is silently empty on the live services.yaml

Three independent defects, each sufficient on its own to empty the closure:

1. **The parser accepts only quoted list items.** `parseServicesYaml` matches items with
   `/^\s+-\s+"([^"]+)"\s*$/` (`tools/gates/plan-coverage-witness.ts:145`). The SSoT dropped the
   quotes in a297b45dd (2026-08-01, "feat(farm): add tenant environment monitoring"); the last quoted
   revision had 435 quoted items. Run verbatim on `main @ 4ce31871d`, the parser returns 17 services
   with 0 publish and 0 subscribe patterns. The file holds 549 publish and 194 subscribe patterns
   (743 items, all unquoted).
2. **The subject is hard-coded to a namespace the platform left.** `defaultSubjectFor` returns
   `AQUACULTURE_EVENTS.<T>.>` (`:181-183`). The witness landed in 3afc83e8f (2026-07-02 13:43);
   0b1596576 (2026-07-02 18:21) migrated the grants to the canonical `events.*.<T>` scheme the event
   bus builds; high-rate telemetry types route to `telemetry.*.<T>`
   (`platform/libs/event-bus/src/nats/event-route-registry.ts:38-40`, `:90-94`). Even a correctly
   parsed file matched no consumer from that day.
3. **Service names never map to nx projects.** The consumer's project is looked up by the yaml
   `name` (`:403`). Names are NATS identities (`auth_service`); the nx project is the `application:`
   field (`auth-service`), which the witness never reads. A touched consumer was therefore never
   recognized as touched, and every node id named an identity, not a project.

The spec stayed green because `tools/gates/fixtures/plan-coverage/services.yaml` kept the April
format (quoted items, `AQUACULTURE_EVENTS.*` subjects, nx names in `name:`). A plan touching
`libs/event-contracts/**` received no `event-consumer:*` node and could reach `covered` with every
NATS consumer of the changed contract unaddressed. Production recorded 0 `coverage_computed` events
(completeness §1 M10), so no plan has yet been judged on this empty closure; the first end-to-end
run would have been.

Evidence:

- `tools/gates/plan-coverage-witness.ts:145` (quoted-only item regex)
- `tools/gates/plan-coverage-witness.ts:181-183` (`AQUACULTURE_EVENTS.<T>.>` subject)
- `tools/gates/plan-coverage-witness.ts:403` (consumer project = yaml `name`)
- `tools/gates/fixtures/plan-coverage/services.yaml:6` (fixture in the pre-2026-08-01 format)
- `infrastructure/nats/services.yaml:3-4` (`name: auth_service`, `application: auth-service`) and
  `:16` (`- events.*.UserInvited`, unquoted)

Rule: The witness reads the live SSoT with a real YAML parser, derives each event's subjects from
the publish grants the SSoT declares, maps consumers through `application:`, and records what it
parsed. Services present with zero parsed patterns is an environment failure (exit 2, which
`aria-kernel/aria_kernel/plan_coverage.py:353` maps to `environment_unable`), never an empty
closure. The spec fixture follows the live format, with one quoted item so both spellings stay
pinned.

### Pre-registered: F-007 meets the migration node through the critic waiver

The first end-to-end run (F-007) touches `apps/hr-service/src/leave/entities/leave-request.entity.ts`
(ADR-0022 `:34-36`). This finding does not change migration semantics: the ARIA-AUDIT-056 rule (a
migration path alone is not coverage; the migration file must content-bind to the entity stem,
`tools/gates/plan-coverage-witness.ts:429-446`, spec `:173-188`) stays exactly as it is. A legal
migration is always a new file, absent at plan time, so the `migration:hr-service` node cannot be
covered by path at plan time and goes through the completeness-critic waiver path. That outcome is
expected and registered here before the run; it is not a defect of this repair. The migration
semantics belong to CR-0b with K41.

### Not part of this finding

Two adjacent defects were seen while measuring and are reported for separate registration; this
finding does not close them:

- The services.yaml subscribe lists are NATS ACL grants. A JetStream durable consumer receives
  through `$JS.API.CONSUMER.>` and its inbox, so the grants do not name the event it consumes:
  `notification-service` consumes `UserInvited`
  (`apps/notification-service/src/notification/event-handlers/auth-event.handler.ts:109`), but only
  `gateway-api` and `messaging-service` (`events.>`) are visible as `events.*.UserInvited`
  subscribers in the SSoT.
- `tools/ripple-tracer/cli.ts`, which the witness's parser was ported from, still carries defects 1
  and 2 (`:107`, `:195`); the change-event-contract skill names it as the consumer enumerator.
