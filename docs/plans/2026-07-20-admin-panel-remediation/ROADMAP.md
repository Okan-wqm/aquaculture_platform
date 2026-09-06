<!-- markdownlint-disable MD011 MD013 MD029 MD033 MD034 MD037 MD038 MD049 MD052 -->
<!-- WHY: imported verbatim FE<->BE<->DB audit evidence. The quoted TypeScript is
     what makes a finding checkable, and markdown's inline rules cannot tell it
     from markup: `Record<string, T>` and `[P]['req']` read as inline HTML and a
     reference link, `(typeof X)[number]` as a reversed link, snake_case
     fragments as emphasis, a template literal as a code span with spaces, an
     internal service URL as a bare URL, and an inline "1)" enumeration as an
     ordered list that starts at 2. Long lines are identifier-dense finding
     titles and evidence paths that cannot wrap without breaking the reference.
     Reflowing them would corrupt the record this file exists to preserve --
     the same rationale scripts/ci/markdownlint-changed.mjs states for its
     changed-line filter. Structure is enforced by the parsers instead:
     tools/gates/finding-registry.ts and tools/gates/commit-msg-validator.ts. -->

# Admin Panel Remediation Roadmap

**Date:** 2026-07-20 · **Source audit:**
[`docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/`](../../reviews/claude/2026-07-20-admin-panel-e2e-audit/README.md)
(PR #1021) · **Branch:** `claude/admin-panel-e2e-audit-9b80i5`

## Context

The SUPER_ADMIN admin panel was audited end-to-end across the frontend ↔ backend ↔ database
triangle: **374 verified findings** (13 CRITICAL, 116 HIGH, 169 MEDIUM, 76 LOW), each with a
root-cause and an architectural fix design. The plumbing is sound — all 35 controllers sit behind
the SUPER_ADMIN global guard, 60/60 admin-schema tables have entity↔migration parity, and no
cross-tenant leak was found — but the product surface is hollow: of 50 pages only **2 are fully
WORKING**, 12 BROKEN, 32 PARTIAL, 2 MOCK_ONLY, 2 NOT_WIRED.

Crucially, the findings are not 374 unrelated bugs. They are instances of **12 systemic root-cause
classes**. Fixing a class once (pattern fix) + applying it mechanically + installing a regression
gate resolves many findings at a fraction of the one-by-one cost and stops the class from recurring.
This roadmap sequences all 374 into **5 dependency-ordered phases** built around those classes.

This document is a planning artifact. No source is changed by adding it. Actual remediation lands in
later per-phase agent workflows, each its own PR, run only on request.

## How to use this roadmap

- **[by-phase.md](./by-phase.md)** — every `APA-xxx` finding → phase → root-cause class → section →
  complexity, as a lookup table. Pick a slice from there.
- Per-finding root cause, fix design, files-to-change, proof test and effort live in the audit's
  [`findings/*.md`](../../reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/) files. This
  roadmap references those anchors; it does not duplicate them.
- Every remediation commit cites its finding:
  `Closes: docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/<section>.md#APA-xxx`.

## The 12 systemic root-cause classes (the backbone)

| Class     | Name                                             | What breaks                                                                                                                          | Pattern fix (highest tier)                                                                                                                                    |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RC-1**  | Envelope/pagination contract break               | `{items,total}` vs interceptor's `{data,total}` lift vs FE `PaginatedResult{data}` → lists empty or crash                            | One canonical paginated DTO used by BE + interceptor + FE; contract test over every list endpoint                                                             |
| **RC-2**  | Interface-DTOs bypass ValidationPipe             | `@Body`/`@Query` typed as TS interfaces → global whitelist skipped                                                                   | Class-validator DTOs; architecture spec asserting every `@Body`/`@Query` metatype is a decorated class                                                        |
| **RC-3**  | Mixed named-`@Query` + bare `@Query()` DTO       | `forbidNonWhitelisted` 400s every filtered list                                                                                      | One query-DTO per handler extending `PaginationQueryDto`; `ROUTE_ARGS_METADATA` spec banning the mixed shape                                                  |
| **RC-4**  | FE payload not whitelisted by DTO                | mutations 400 (invite user, maintenance create, backup `encrypt`…)                                                                   | Same contract-at-source discipline + FE↔DTO parity tests using exact FE payload keys                                                                         |
| **RC-5**  | Hand-written FE types, no codegen                | vocabulary/field drift (severity, roles, `senderType`, stats shapes)                                                                 | Shared vocabularies in `@aquaculture/shared-contracts` + compile-time enum equality asserts; schedule OpenAPI→TS client gen                                   |
| **RC-6**  | Phantom endpoints & dead UI                      | FE calls to nonexistent routes; buttons with no handler; unreachable pages                                                           | Contract-parity test FE api layer ↔ Nest route table; nav SSoT diff vs `Module.tsx`                                                                          |
| **RC-7**  | Control-plane theater                            | persisted config nothing reads/enforces (toggles, maintenance, IP rules, email templates, plan catalog, discounts, usage)            | Per feature: wire the named enforcement point or remove the surface; invariant: every admin-writable config table has a registered consumer                   |
| **RC-8**  | Telemetry with no producers / fabricated metrics | ledgers nothing writes; silent-zero; hardcoded "healthy"                                                                             | Nullable measured-metric contract (`number\|null`→"—"); single `PrometheusQueryService` bridge; wire producers via service-identity paths; delete silent-zero |
| **RC-9**  | Dead async wiring                                | no NATS transport in admin-api; declared event consumers with no live listener (tenant creation)                                     | Bootstrap fail-fast for dead `@EventPattern`; registry-derived event-consumer-liveness invariant                                                              |
| **RC-10** | Half-finished config-service migration           | legacy stores dropped, admin routes 410, replacement never built; reads fabricate defaults                                           | Finish or reverse the migration at the SSoT; delete fabricated-defaults; no live UI over tombstoned routes                                                    |
| **RC-11** | Split-brain persistence silos                    | admin support/announcement tables disconnected from what tenants read                                                                | Single ownership per silo; admin writes go through the tenant-visible store                                                                                   |
| **RC-12** | Security hardening gaps                          | CSRF double-submit inert; token blacklist not consulted; impersonation token unconsumable + append-only trigger on operational table | Server-side CSRF (or drop the header, commit to SameSite); blacklist check in guard; impersonation wired scoped/revocable/audited                             |

## Execution model — agent-driven

Agents execute this roadmap, the same way the audit and the 374 fix designs were produced (fan-out
`Workflow` runs). It is **not** sized in dev-days; it is sized in agent workflow slices.

- Each phase = one or more **fan-out agent workflows**. A workflow slices its findings by root-cause
  class (Phases 1–3) or by section (Phases 0, 4) and runs an **implement → adversarial-verify**
  pipeline per slice — mirroring the audit's design→verify pipeline.
- **Slice granularity comes from the S/M/L complexity tag** (complexity, not hours): every **L**
  finding gets a dedicated implementer agent in an isolated git worktree (agents mutate files in
  parallel); **S/M** findings of the same root-cause class batch into one agent. The _pattern fix +
  regression gate_ for a systemic class is its own agent, run **before** the mechanical-application
  agents that depend on it.
- Each implementer agent lands a **small PR** (or a stacked commit) with its `Closes:` line; a
  verify agent adversarially checks the diff (tests green, the new invariant fails-red on HEAD then
  passes, no banned patterns) before the slice is marked done.
- Phases 0 and 1 run as **parallel workflows** (Phase 0 flows are largely independent of the
  contract layer). Phases 2–4 gate on Phase 1's contracts landing first.

## Phases

Counts below are exact (see [by-phase.md](./by-phase.md)); the S/M/L tags there are relative
complexity driving slice granularity, never calendar time.

### Phase 0 — Restore the flagship flows · 17 findings (13 CRITICAL + 4 HIGH)

Goal: make the visibly-broken, highest-privilege flows actually work. Largely independent of the
contract layer → starts immediately, in parallel with Phase 1.

- **Tenant creation — RC-9** (APA-022, APA-030): admin-api sets no NATS microservice transport, so
  every `@EventPattern` consumer is dead code and the provisioning saga ends FAILED-but-ACTIVE on
  every run. Wire `natsTransport`; scope HTTP-only enhancers (guard/interceptor/filter) to
  `context.getType()==='http'`; generalize the existing db-migrate wait/requeue into a generic saga
  wait primitive; reorder the saga so the onboarding-ack barrier precedes
  `create_subscription`/`activate_tenant`. Add the registry-derived event-consumer-liveness
  invariant + bootstrap fail-fast for dead handlers.
- **Support — RC-11** (APA-185, APA-186, APA-201, APA-213): ticket create/assign 500 on hardcoded
  non-UUID actor IDs; announcements are stored but never delivered (tenants read a different table
  in a different service); split-brain silos. Decide single ownership per silo; route admin writes
  through the tenant-visible store.
- **Impersonation — RC-12** (APA-288, APA-289): an append-only trigger on the operational
  `impersonation_sessions` table blocks every lifecycle mutation; the issued token is discarded and
  nothing consumes it. Separate operational vs audit immutability; wire the impersonation token
  end-to-end (scoped, time-limited, revocable, audited).
- **Messaging legal-hold** (APA-163): dual-approver release fields are dropped through the whole
  chain → legal-hold release impossible from the panel.
- **Security false-assurance — RC-8** (APA-240): threat dashboard always reports 100/healthy because
  its detection supply chain is dead. Wire producers or render "unmeasured".
- **Routing topology — RC-6** (APA-252, APA-253, APA-251): prod/dev compose stacks route `/api` to
  gateway-api which has no admin proxy (whole panel 404s off the droplet stack); dev has no route at
  all; the feature-toggle switch calls a nonexistent route.

Verification: e2e tenant creation reaches ACTIVE with a recorded ack; support ticket create/assign
persists and is visible to the tenant; impersonation lifecycle round-trips; saga integration test on
a real (test) transport.

### Phase 1 — Contract layer · 121 findings (32 HIGH, 71 MEDIUM, 18 LOW)

Goal: one canonical contract at each FE↔BE seam, enforced by build/test gates so the drift classes
cannot recur. Foundational — most Phase 2–4 surfaces are also RC-1..RC-6 instances. Lands **RC-1,
RC-2, RC-3, RC-4, RC-5, RC-6** (and any residual RC-9 handler wiring):

- **RC-1** unify on one paginated-list DTO (extend the platform `IStandardPaginatedResult`); make
  the `ResponseInterceptor` lift it; make the FE `PaginatedResult` the same shape; delete the ad-hoc
  `items` normalization already patched into FeatureTogglesPage. Contract test over every list
  endpoint.
- **RC-2 / RC-4** convert interface-`@Body`/`@Query` to class-validator DTOs; architecture spec
  asserting every `@Body`/`@Query` metatype is a decorated class; FE↔DTO parity tests with the
  exact FE payload key sets.
- **RC-3** one query-DTO per handler extending `PaginationQueryDto`; `ROUTE_ARGS_METADATA` spec
  banning the mixed named/bare `@Query` shape repo-wide.
- **RC-5** shared vocabularies (audit severity, role enums) in `@aquaculture/shared-contracts` with
  compile-time equality assertions on the backend enums; wire the lib into admin-panel (tsconfig
  paths + vite alias, mirroring aquamobil); retire the `KNOWN_DRIFT` allowlist; schedule OpenAPI→TS
  client generation as the durable fix.
- **RC-6** contract-parity test FE api layer ↔ Nest route table; nav SSoT diff vs `Module.tsx`.

Verification: each new invariant spec fails on current `HEAD` (proving detection) and passes after;
`npm run type-check` becomes the RC-5 gate.

### Phase 2 — Truth in telemetry & security · 108 findings (61 HIGH, 31 MEDIUM, 16 LOW)

Goal: every metric/security surface shows a real measurement or renders "unmeasured" — never a
fabricated constant. Depends on Phase 1 for surfaces that also render lists. Lands **RC-8** and the
**RC-12** remainder (plus HIGH behavior-correctness findings without a distinct class — e.g.
inverted filters, wrong aggregates, misrendered statuses):

- RC-8: nullable measured-metric contract (`number|null`→"—"); single `PrometheusQueryService`
  bridge for traffic/latency KPIs; wire producers via service-identity paths (not SUPER_ADMIN
  user-JWT); delete silent-zero catch blocks — dashboard KPIs, analytics/financial reports,
  performance & error-tracking, activity/audit/security ledgers.
- RC-12 remainder: server-side CSRF double-submit (or remove the FE header and commit to the
  SameSite token model — decide, don't fake); token-blacklist check in `PlatformAdminGuard`;
  `logStrict` audit-durability on security-critical writes.

### Phase 3 — Control-plane wire-or-remove · 24 findings (19 HIGH, 3 MEDIUM, 2 LOW)

Goal: per feature, wire the named enforcement point or remove the surface. **Requires product
input** — several of these are decisions, not just code. Lands **RC-7, RC-10** and the **RC-11**
remainder:

- RC-7: feature toggles, maintenance mode, IP access rules, email templates (incl. re-pointing the
  email send-path at the operator-managed config — the "email settings" concern), plan catalog,
  discount codes, usage metering. Each finding names its enforcement point; product decides enforce
  vs remove. New invariant: every admin-writable config table must have a registered consumer.
- RC-10: finish or reverse the config-service migration (tenant-config, system settings, email SMTP
  source); delete fabricated-defaults read paths; stop shipping live UI over 410-tombstoned routes.

### Phase 4 — UX polish · 104 findings (64 MEDIUM, 40 LOW)

Goal: the long tail with no cross-cutting dependency — silent failures surfaced with real error UX,
pagination controls over already-paginated endpoints, debounced search, dead links, optimistic UI
rollback, label/enum cosmetics. Batched per section; runs last, or opportunistically alongside a
section's higher-phase work.

## Cross-cutting execution rules (every agent slice)

- Root-cause only (repo `CLAUDE.md`); pattern-level fix + regression gate per systemic class — no
  allowlisting drift.
- Systemic-class agents run before the mechanical-application agents that depend on them; parallel
  implementer agents use isolated git worktrees.
- Migrations blue-green (nullable → backfill → NOT NULL); admin `@Entity` declares
  `schema: 'admin'`; never add tables to `public`.
- Every fix commit carries its `Closes: …/findings/<section>.md#APA-xxx` line.
- `nx affected --target=test && --target=lint` green before each commit; each new invariant spec
  fails-red on current HEAD then passes after; an adversarial verify agent confirms per slice.
- Small PRs sliced by root-cause class or by section — never one mega-PR.

## Notes on the phase mapping

Phase and root-cause-class assignment in [by-phase.md](./by-phase.md) is a planning aid derived from
each finding's title and verified severity. Where a finding spans classes, it is placed by its
dominant remediation; the authoritative per-finding root cause and fix design always live in the
audit `findings/*.md` file linked from its row. 141 findings are standalone (`-`) — mostly Phase 4
polish and a set of HIGH behavior-correctness fixes routed to Phase 2. Adjust placement freely when
scoping a workflow; the phase counts are a starting sequence, not a contract.
