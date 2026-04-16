# ADR Drift Matrix — 2026-04-W16

**Audit window:** W1 Part A.3
**Scope:** 16 canonical ADRs under `/var/aqua-saas/docs/adr/` (001–016)
**Mode:** READ-ONLY. No source code modified.
**Output consumers:** Part D gate infrastructure (promote Tier-4 to Tier-3, harden shallow Tier-3).

## Summary

| Tier distribution | Count | ADRs |
|-------------------|-------|------|
| Tier 1 (impossible) — structural | 2 | 006 (partial), 014 |
| Tier 2 (automatic) — framework default | 1 | 015 (generator + runtime mode selection) |
| Tier 3 (detectable) — CI / runtime validator | 5 | 008 (guard), 011, 012, 013, 015 |
| Tier 4 (documented only) — no code enforcement | 8 | 001, 002, 003, 004, 005, 007, 009, 010 |
| Unreadable (file empty) | 5 | 001, 002, 003, 004, 005 — TITLE-ONLY in CLAUDE.md, body file is zero-byte |

> **16th ADR status:** ADR-016 is present at `docs/adr/016-deploy-resilience-architecture.md`. Phase A1 landed (Tier-3 via CI pre-flight scripts); Phases B-F are roadmap. Tier classification: **mixed Tier-3 / Tier-4** — Phase A enforced, Phases C-F still "documented only."

## Enforcement matrix

| ADR | Title | Invariant (1 line) | Enforcement tier | Mechanism | Gap |
|-----|-------|---------------------|------------------|-----------|-----|
| 001 | Monorepo vs polyrepo | Single Nx repo, shared libs | Tier 4 | **File is 0-byte** — title-only in CLAUDE.md; `nx.json` + Nx graph invariants (`ci-affected.yml:104` ARCH-CI-012) do enforce graph shape | HIGH — ADR body missing; invariant NOT tied to a decision record |
| 002 | Gateway API pattern | Single gateway-api proxies all subgraphs | Tier 4 | **File is 0-byte**; gateway-api service exists; no CI test asserting "no service exposes edge port directly" | HIGH — no structural check that apps other than `gateway-api` refuse external traffic |
| 003 | Sensor service separation | Sensor ingestion isolated from farm CRUD | Tier 4 | **File is 0-byte**; module boundary check via `@nx/enforce-module-boundaries` present in `.eslintrc.json:22` but no sensor-specific tag constraint | MEDIUM — lint rule exists but `depConstraints` is permissive (`sourceTag: '*'`, `onlyDependOnLibsWithTags: ['*']`) |
| 004 | Temporal workflow adoption | Use Temporal for long-running workflows | Tier 4 | **File is 0-byte**; grep shows **zero** `@temporalio` deps in `package.json`, zero production code references — ADR never implemented | CRITICAL — ADR claims accepted, implementation absent. Mark superseded or implement |
| 005 | OpenSearch logging | Structured logs ship to OpenSearch | Tier 4 | **File is 0-byte**; grep shows **zero** `opensearch`/`@elastic` deps in `package.json` — ADR never implemented | CRITICAL — ADR claims accepted, implementation absent. Mark superseded or implement |
| 006 | Event contracts flat pattern | All events extend BaseEvent; no nested `payload` | Tier 1 (partial) → Tier 4 (inverse) | Branded `EventId` in `libs/event-contracts/src/base-event.ts:16` + `createBaseEvent()` factory forces flat shape via type system. **BUT** grep shows 15+ `this.eventBus.publish(...)` sites; no CI rule bans inline literals bypassing the factory; no lint rule against `payload:` nested keys | MEDIUM — Tier 1 only applies when publisher types events as `BaseEvent`; untyped `publish()` call sites side-step the brand |
| 007 | CQRS usage strategy | CQRS optional per service | Tier 4 | Decision explicitly "not mandated"; no enforcement by design | NONE — ADR chooses no enforcement. OK at Tier 4 |
| 008 | Guard strategy defense-in-depth | Global + per-controller `PlatformAdminGuard` | Tier 3 (shallow) | `APP_GUARD` set in admin-api `app.module.ts:214`; 23 controller-level `@UseGuards` grepped. No CI test asserts every `@Controller` carries `@UseGuards(PlatformAdminGuard)` | MEDIUM — ADR says "PR review checklist" enforces Layer 2. No automated test; a new controller without `@UseGuards` passes CI silently (global guard still protects — but ADR's intent of self-documenting code is lost) |
| 009 | Frontend data fetch pattern | `useAsyncData` + decomposed adminApi; no raw `fetch()` | Tier 4 | No ESLint rule banning `fetch(` in `web/apps/admin-panel/`; no CI test; relies on code review | HIGH — easy to regress; rule is a 3-line ESLint `no-restricted-globals` |
| 010 | Frontend styling strategy | Tailwind only; no CSS-in-JS for new code | Tier 4 | No lint rule against inline `style={{}}`; ADR explicitly accepts 13 existing violators as debt | MEDIUM — promoted to Tier 3 via ESLint `react/forbid-dom-props` with `style` disallowed (with allowlist of existing 13 files) |
| 011 | Schema ownership model | `@Entity()` declares `schema:`; public has 0 app tables | Tier 3 → Tier 4 (inverse gap) | `e2e/tests/integration/schema-invariants.spec.ts` asserts table placement in DB; `createSchemaDriftValidator` runs at boot (`libs/backend-common/src/database/schema-drift-validator.service.ts`); ADR **explicitly defers** Layer-1 ESLint rule `require-entity-schema`. **Source-code grep finds 127 `@Entity('<name>')` single-arg calls vs 60 decorated calls**; `tools/eslint-rules/` directory does NOT exist | CRITICAL — ADR-012 Layer 1 scaffold absent. 127 entity declarations rely on runtime validator + DB-shape CI test. `event-store-service` (4 entities) + `config-service` (2 entities) are explicit pre-existing violations per `tests/invariants/_constants.ts:13-15`. `adoption-invariants.spec.ts` referenced in the constants file **does not exist** (glob returned zero) |
| 012 | Schema drift prevention | 3-layer: ESLint → CI → runtime validator | Tier 3 (two layers) | Layer 2 (CI `schema-invariants.spec.ts`) + Layer 3 (`createSchemaDriftValidator` boot check) live. Layer 1 (ESLint `require-entity-schema`) explicitly deferred in ADR §"Enforcement timeline" — target `+1 month from 2026-04-14`, not landed as of 2026-04-16 | HIGH — ESLint layer missing, but CI + runtime are tight enough to hold. Layer-1 promotion is the blocking item |
| 013 | Messaging isolation convergence | Messaging entities decorated `{ schema: 'messaging' }` + RLS | Tier 3 | 17 MESSAGING_TABLES enumerated and asserted in `schema-invariants.spec.ts:85-103`; `SchemaDriftValidator[messaging]` runs at boot; `TenantRlsSyncService` mirrors policies | LOW — P10 audit identified 2 CRITICAL background workers needing `BypassRlsService.withBypass()` wrapper; tracked but not landed. Workers silently return empty under RLS |
| 014 | NATS mTLS-only auth | No shared NATS user account exists anywhere | Tier 1 | Shared `nats_internal` user removed from compose, `nats.conf`, env — physically cannot be reached (verify_and_map + cert CN gating); `nats-invariants.spec.ts:191` asserts **zero** `password:` fields in generated block | NONE — structural |
| 015 | NATS cert-is-identity SSoT | `infrastructure/nats/services.yaml` is SSoT; generator → `nats.conf` | Tier 2 + Tier 3 | `scripts/nats/generate-nats-conf.py` generates between `# BEGIN/END GENERATED` sentinels; `ci-affected.yml:348-357` runs generator + `git diff --quiet` on PR; `nats-invariants.spec.ts` asserts services.yaml ↔ nats.conf ↔ cert CN list 1:1; client factory `authMode: 'mtls-cert'` omits user/pass from CONNECT frame | LOW — cert CN list in `generate-internal-certs.sh` still hand-maintained (BACKLOG-NATS-002 tracks auto-derivation). Current CI 1:1 check catches drift |
| 016 | Deploy resilience architecture | 6-phase deploy resilience program | Tier 3 (Phase A) + Tier 4 (Phases C-F roadmap) | Phase A1 landed in deploy workflow (always-run certs); Phase A2/A4 landed in `ci-affected.yml` as `preflight-validate.ts` + secrets/signals/criticality manifest checks (lines 372-398); Phases B1-B3 inherited from ADRs 011/012/015; Phases C (per-service health), D (staging), E (migration container isolation), F (observability assertion) are ROADMAP | HIGH — Phase D (staging) is self-identified as "THE single-biggest deploy improvement available." Still unimplemented |

## Tier-4 findings (doc-only — urgent promotions)

Format: `ADR-{NNN}-TIER4-{severity}`

### `ADR-001-TIER4-HIGH` / `ADR-002-TIER4-HIGH` / `ADR-003-TIER4-MEDIUM` / `ADR-004-TIER4-CRITICAL` / `ADR-005-TIER4-CRITICAL`

ADRs 001–005 are ZERO-BYTE FILES. Title exists in CLAUDE.md ADR reference block; decision + consequences + enforcement are absent from the committed record. For ADR-004 (Temporal) and ADR-005 (OpenSearch), source-code grep confirms **no implementation** — the ADR claim ("Accepted" status, referenced in CLAUDE.md) is false-positive. Promote to:

- **ADR-001/002/003:** author the missing body; mark enforcement tier in the doc itself.
- **ADR-004/005:** supersede (new ADR documenting current reality: Temporal NOT adopted, OpenSearch NOT adopted). Leaving "Accepted" status on unimplemented ADRs breaks audit discipline — CLAUDE.md references them as canonical.

### `ADR-008-TIER4-MEDIUM` — Guard self-documentation

Layer 2 (`@UseGuards(PlatformAdminGuard)` per controller) is NOT asserted by any test. Global `APP_GUARD` still protects at runtime, so gap is cosmetic — but ADR explicitly argues the explicit decorator is a PR-review checklist item. Promote to Tier 3: TypeScript AST invariant test (similar shape to NATS/schema invariants) asserting every `@Controller` class in `apps/admin-api-service/src/` carries `@UseGuards(PlatformAdminGuard)`. Estimated LOC: ~50.

### `ADR-009-TIER4-HIGH` — Frontend data fetch

Zero enforcement. Raw `fetch()` in admin-panel is easy to introduce. Promote to Tier 3 via:

```json
// web/apps/admin-panel/.eslintrc.json override
"no-restricted-globals": [
  "error",
  { "name": "fetch", "message": "Use useAsyncData + services/api/* (ADR-009)" }
]
```

Plus a lint rule banning hardcoded mock data objects > N fields. Low effort, high regression-prevention value.

### `ADR-010-TIER4-MEDIUM` — Frontend styling

Zero enforcement; ADR acknowledges 13 violators. Promote to Tier 3 via ESLint `react/forbid-dom-props` with `style` banned, exempting exactly the 13 legacy files in an allowlist. Hardcoding the allowlist forces new violators to either fix or extend the list (visible in PR diff).

## Shallow Tier-3 findings — enforcements that exist but don't cover real usage

### `ADR-011-TIER3-CRITICAL` / `ADR-012-TIER3-HIGH` — Layer 1 ESLint rule never landed

`tools/eslint-rules/` directory does not exist. The ADR-012 "Enforcement timeline" targets the rule for `+1 month from 2026-04-14` (i.e., ~2026-05-14). As of 2026-04-16 the scaffold has not been started. Repo contains **127 `@Entity('<table>')` single-arg calls** that land tables in `public` by default — runtime validator + DB-shape CI catch them, but both are downstream of Layer 1. `event-store-service` (4 entities: stored_events, snapshots, event_streams, projection_checkpoints) and `config-service` (configurations, configuration_history) ship with **known pre-existing ADR-011 violations** documented at `tests/invariants/_constants.ts:13-15`. The referenced `tests/invariants/adoption-invariants.spec.ts` **does not exist** (Glob confirmed). Promote immediately — the cost is ~2 days of work (AST rule + fixtures + override allowlist for `migrations`) and removes a structural footgun.

### `ADR-013-TIER3-LOW` — Background worker bypass

Two CRITICAL workers (embedding cron, knowledge-extraction cron) still need `BypassRlsService.withBypass()` wrapping per the ADR's own P10 audit. Tracked as CRITICAL-MSG-002/003. No test asserts the wrapper is present. Add to `schema-propagation.spec.ts` (or new `rls-bypass-coverage.spec.ts`).

## Tier-1 claims that are actually Tier-4 in reality (false-positive enforcement)

### `ADR-006-TIER1-FALSE-POSITIVE`

ADR-006 claims structural (Tier 1) enforcement via branded `EventId` + factory. The brand is genuine (`libs/event-contracts/src/base-event.ts:16`), but enforcement holds only when publishers statically type the event as `BaseEvent` (or a subclass thereof). Grep finds:

- 15+ `this.eventBus.publish(...)` call sites.
- No typing contract on `EventBus.publish()` parameter — factory use is convention.
- No lint rule banning literal `{ eventId: ... }` object construction.
- No CI test scanning for nested `payload:` / `metadata:` keys in event-related files.

**Reality:** Tier 1 for code that reaches the type system; Tier 4 for call sites that pass `any`-ish structure to an untyped publisher. Enforcement is genuinely structural for typed handlers (most call sites) but gapped at the publisher boundary. Fix: add `publish<T extends BaseEvent>(event: T)` generic constraint to `EventBus` interface so untyped literals become compile errors.

## Misfiled ADRs under `docs/architecture/`

Per CLAUDE.md "Known drift" note, 4 files misuse ADR numbering:

| Path | Size | Overlap with canonical? |
|------|------|-------------------------|
| `docs/architecture/ADR-010-AI-SELF-LEARNING.md` | 96 KB | NO — AI self-learning feature plan, not styling strategy. Namespace collision with canonical ADR-010 (frontend styling) |
| `docs/architecture/ADR-011-operations-hub-restructuring.md` | 27 KB | NO — operations hub UX, not schema ownership. Namespace collision |
| `docs/architecture/ADR-012-messaging-service.md` | 141 KB | PARTIAL — contains messaging service design; canonical ADR-012 (schema drift prevention) is different. Canonical ADR-013 does cite the messaging plan correctly. Namespace collision |
| `docs/architecture/ADR-013-nestjs-v11-upgrade.md` | 57 KB | NO — NestJS upgrade tracker, not messaging isolation. Namespace collision |

All four collide with canonical ID namespace. No invariant overlap (content is plans/trackers, not architectural invariants), so no enforcement gap to close — only the ID-collision audit-discipline concern. Track separately from this matrix per instructions.

## Appendix — Verification files consulted

- `/var/aqua-saas/docs/adr/*.md` (16 files; 5 zero-byte)
- `/var/aqua-saas/e2e/tests/integration/schema-invariants.spec.ts`
- `/var/aqua-saas/e2e/tests/integration/nats-invariants.spec.ts`
- `/var/aqua-saas/libs/event-contracts/src/base-event.ts`
- `/var/aqua-saas/libs/backend-common/src/database/schema-drift-validator.service.ts`
- `/var/aqua-saas/libs/backend-common/src/nats/nats-connection.factory.ts`
- `/var/aqua-saas/.eslintrc.json`
- `/var/aqua-saas/.github/workflows/ci-affected.yml` (lines 344–398)
- `/var/aqua-saas/tests/invariants/_constants.ts`
- `/var/aqua-saas/scripts/nats/generate-nats-conf.py` (referenced; not read)
- Entity decoration grep — 127 single-arg vs 60 `{ schema: ... }` across `apps/`
