# Enterprise-Grade Agent+Skill+Gate System — Implementation Plan

## Context

Okan (platform owner) wants a system that **structurally enforces enterprise-grade code quality** across /var/aqua-saas/ with three non-negotiable properties:

1. **No patches, no workarounds, no deferral.** Every fix must be architectural root-cause (CLAUDE.md 4-tier hierarchy: impossible → automatic → detectable → documented). Banned phrases (`"for now"`, `"interim"`, `"deferred"`, `"out of scope"`) are truly banned.
2. **Cascade all the way.** When one thing changes, every affected file must also change in the same PR. "Half-done" is a failure state.
3. **Three-layer best-pattern awareness × three agent roles.** Agents must know (a) tech-version-specific patterns (NestJS 11, TypeORM 0.3, React 18, Tokio 1.43), (b) architectural patterns (CQRS, DDD, Event Sourcing, Outbox, Saga, tenant isolation), (c) repo conventions (16 ADRs + CLAUDE.md). Agents must **act** in three roles: catcher (review/block), teacher (advise before code), writer (generate best-pattern code).

Current state: `.claude/agents/` (20 legacy) + `.claude/agents-enterprise-v2/` (22, inert by default) + `.claude/test-agents/` (27 product E2E). ESLint bans `any`/`getRepository`/`JWT_SECRET` at error level. 9 invariant tests under `e2e/tests/integration/`. `.claude/skills/` does NOT exist. No commit-msg hook, no ripple-tracer, no root-cause gate, no finding state registry, no override protocol. Okan stated he doesn't know what's currently missing vs. used — so **discovery is part of the plan**, not a prerequisite.

Outcome: a layered system where (1) agents carry deep tech+pattern knowledge and can teach/catch/write, (2) skills encode cascade-enforced recipes, (3) gates structurally block tier-4 patches and ripple-incomplete commits, (4) false-positive inflation is prevented by boundary allowlists + tracked overrides + progressive rollout.

---

## Review Consensus & Amendments (2026-04-16)

Three independent reviewers (prompt-writer, architect-review, code-reviewer) reached `APPROVE_WITH_CONCERNS` with overlapping blocker findings. All amendments below are **pre-kickoff mandatory** unless marked deferred.

### BLOCKER-1 — Knowledge SSoT missing (all 3 agents agree)
22 agents × duplicated Layer 1 (tech version) + Layer 3 (ADR summaries) = 22-file fanout on NestJS/React version bump. Violates the plan's own 4-tier hierarchy (tier-4 duplication).
**Amendment:** Create SSoT files **BEFORE** Part B kickoff:
- `.claude/knowledge/layer-1-tech.md` — tech-version anchors (NestJS 11, TypeORM 0.3, React 18, Tokio 1.43) — single source.
- `.claude/knowledge/layer-3-adrs.md` — one-line ADR summaries indexed 001-016.
- `.claude/knowledge/layer-2-patterns.md` — shared architectural patterns (CQRS, Outbox, DDD).
- Agent files reference via `@.claude/knowledge/*` includes; carry only domain-specific Layer 2 + mode overrides.
- New invariant `tests/invariants/knowledge-ssot.spec.ts` — fails if any agent file inlines content hashable-duplicate of SSoT.

### BLOCKER-2 — Agent file bloat (prompt-writer flagged)
Current `farm-expert.md` ~163 lines; adding 3-layer + 3-mode pushes past 250, violating prompt-writer's 200-line cap.
**Amendment:** Extract shared sections into `.claude/agents-enterprise-v2/_shared/` (operating-modes, tier-claim-syntax, output-format, handoff-protocol). Agent files include by reference, stay ≤200 lines each.

### BLOCKER-3 — Default mode must be `review:` (prompt-writer)
Current v2 is strict REVIEW-ONLY (`orchestrator.md:13-19`). If new mode routing defaults to anything else, REGRESSION.
**Amendment:** Hardcode `review:` as default. WRITER mode requires explicit `implement:` token from human or implementation-planner. TEACHER→WRITER handoff forbidden within same agent (pair-review invariant): if an agent operated in TEACHER mode on a cycle, the WRITER for the same surface must be a different agent instance (orchestrator enforces).

### BLOCKER-4 — Pre-commit `tsc --noEmit` unrealistic (code-reviewer)
Warm cache 20-60s, cold >2min — violates Tier-1 <10s budget. Existing CI `type-check` job has 35min timeout.
**Amendment:** Drop `tsc --noEmit` from Tier 1 entirely. Keep in Tier 2 (CI `type-check` already exists). Tier 1 = banned-phrase + tier-claim + commit-msg + ESLint `--cache` on staged only. Budget <5s.

### BLOCKER-5 — Ground-truth dependency gaps (code-reviewer)
- `ts-morph` is NOT a direct devDep (only transitive).
- `package.json:217` declares `engines.node >=20.11.0`; `--experimental-strip-types` requires Node 22.6+.
- `husky@^8` installed; plan described v9-style hooks.

**Amendment:** Part D step 0 (prerequisite, Week 4):
- `npm install -D ts-morph@^23`.
- Bump `engines.node` to `>=22.6.0` in `package.json`. Document in release notes.
- Stay on husky v8 (minimize churn); hooks written in v8 style (`#!/bin/sh; . "$(dirname "$0")/_/husky.sh"; ...`).
- Fallback path: if Node 22 adoption blocked, use `tsx` runner instead of `--experimental-strip-types`.

### BLOCKER-6 — `adoption-invariants` must have service allowlist (code-reviewer)
`gateway-api`, `observability-service`, `notification-service`, `config-service`, `event-store-service`, `ai-service` don't have their own schema (or use cross-cutting `shared`). Blanket mandate fails them.
**Amendment:** ~~`tests/invariants/adoption-invariants.spec.ts` allowlists the 9 schema-owning services explicitly: `farm-service, sensor-service, hr-service, messaging-service, hydroponics-service, alert-engine, auth-service, billing-service, admin-api-service`. Non-schema services exempt.~~ **SUPERSEDED by BLOCKER-8 (Round 3):** correct count is **13** services. See Round 3 Meta-Review Consensus below.

### BLOCKER-7 — `ripple-coverage` must be semantic-gated (code-reviewer)
Typo/comment/README-only diffs have no ripple. Plain `ripple ⊇ diff` check false-positives on legitimate trivial changes.
**Amendment:** Pre-filter diff with AST pass: if no added/removed exports + no signature changes + no new/changed decorators + no schema.ts touch → skip ripple-coverage. Only semantic changes trigger the check.

### AMENDMENT-A — Rollout 10 weeks → 12 weeks (code-reviewer sizing)
Week 3 (18 agents at once) unrealistic; ripple-tracer `ts-morph` engineering (W7) is code not prose.
**Amendment:** Split W3 → W3+W4 (9 agents each). Insert W7.5 for ripple-tracer engineering. New timeline: 12 weeks total (see updated Part F).

### AMENDMENT-B — Seed boundary allowlist during Part A (architect-review)
CODEOWNERS @okan gate on empty allowlist = paper-cut PR starvation in activation weeks.
**Amendment:** Part A discovery identifies ≥10 known-legitimate boundaries (MQTT deserializer, proto codegen, zod parsers, Stripe webhook, event-store payload, external OAuth callback, CSV importers, WS binary frames, Rust FFI, timestamptz conversion). Pre-populate `.claude/allowlists/boundary-files.yaml`. PRs arrive with allowlist, not empty.

### AMENDMENT-C — Legacy `.claude/agents/` lifecycle (architect-review)
Three coexisting agent sets (20 legacy + 22 v2 + 27 test-agents) risks routing confusion.
**Amendment:** Week 2 add `.claude/agents/README.md` with `STATUS: FROZEN — new work → enterprise-v2/`. Week 8 archive to `.claude/agents.legacy/` (not left in-place). Test-agents untouched — orthogonal concern.

### Non-blocker concerns (address during rollout)
- CI runtime growth (Tier 2 +5 jobs) — mitigate via ripple cache in `.nx/cache` starting W8.
- `Closes:` validator vs squash-merge — client hook accepts either trailer; server-side PR-check validates squashed message using `pull_request` event.
- `auditor-override` CODEOWNERS bottleneck — relax to `architectural-arbiter` autonomous at W13 if calibration data supports.

**Consensus verdict:** APPROVE_WITH_CONCERNS → becomes APPROVE after BLOCKER-1 through BLOCKER-7 land as pre-kickoff amendments.

---

## Round 3 Meta-Review Consensus (2026-04-16, v3 revision)

After Round 1 amendments were folded in, three domain specialists (architectural-arbiter, security-reviewer, data-expert) rejected the plan with 35+ new findings. A third-round meta-review (context-manager synthesis, implementation-planner executability, infra-expert ground-truth) classified those findings and produced the v3 blocker list below. Key insight from infra-expert's ground-truth pass: some Round-2 concerns were OVER-STRICT because the repo's existing baseline already addresses them.

### Ground-truth reality (infra-expert verified)
- **S13 GHA action SHA pinning: ALREADY DONE.** Every `uses:` across 20 workflows is full 40-char SHA with version comment. Pattern is established; new jobs just follow it.
- **S7 ts-morph RCE risk: OVER-STRICT.** ts-morph wraps the TS compiler API — does NOT execute code. `--ignore-scripts` is already universal across `npm ci` calls in `ci-affected.yml`. Sandbox container is overkill; `permissions: { contents: read }` + artifact-based ripple-set suffices.
- **D12 backup exists: partially addressed.** `backup-production.yml` runs nightly pg_dump via `tools/scripts/database/backup-databases.sh` to DO Spaces with retention. Runbook at `docs/runbooks/database-restore-drill.md`. Plan's `run-migration-prod` skill calls the existing script, not a new one.
- **Husky v8 clean slate confirmed.** `.husky/_/husky.sh` exists; no active hooks.

### V3 Real Blockers (9 — replaces Round-2's 35+ with consolidated actionable set)

**BLOCKER-8 — Schema-owning services = 13, not 9 (A1+D8). UPDATED by W1 audit: `@Entity()` violation count = 157, not 2.**
BLOCKER-6 allowlist (9 services) is factually wrong. Correct set = 13: `farm-service, sensor-service, hr-service, messaging-service, hydroponics-service, alert-engine, auth-service, billing-service, admin-api-service, event-store-service, ai-service, config-service, notification-service`. Only `gateway-api` and `observability-service` are schema-less (exempt).
**W1 audit scope expansion:** Round-3 consensus assumed "2 entities missing `schema:`" (event-store + config). W1 anti-pattern scan reconciled the real count at **157 violations** across 10 services (data-expert slice reported 180, platform-services 21 — both partial views; anti-pattern scan is authoritative). Only `notification-service` is fully compliant.
**Fix:** Single `SCHEMA_OWNING_SERVICES` constant in `tests/invariants/_constants.ts` (LANDED in W0 commit ad7ec82d). Every reference imports it. Fix 157 `@Entity()` decorators in W2 via mechanical migration, blocking before `adoption-invariants.spec.ts` promotes to error. Parallel work: stand up `tools/eslint-rules/require-entity-schema.ts` AST rule to prevent regression.
**Cost:** W0 constant DONE. W2: ~2-3 days for mechanical `@Entity` migration across 157 sites + 1 day for AST rule. W8: adoption-invariants consumer.

**BLOCKER-9 — Control-plane CODEOWNERS gates (S3)**
`.claude/skills/**`, `.claude/agents-enterprise-v2/**`, `.claude/knowledge/**`, `.claude/allowlists/**`, `.claude/gates/**`, `tools/gates/**`, `.github/workflows/**`, `docs/reviews/_registry/**` all lack CODEOWNERS routing. Without this, a single PR modifying `_shared/operating-modes.md` poisons 22 agents (policy RCE equivalent).
**Fix:** `.github/CODEOWNERS` entries route all control-plane paths to `@okan`. GitHub branch protection requires signed commits on `main`.
**Cost:** <1 day (one-line CODEOWNERS edits + branch protection settings). **Land in W0 before Part B writes.**

**BLOCKER-10 — Override trust chain (S1+S2+S4+S5)**
Inline `// auditor-override: AUDIT-042` is currently unauthenticated string; finding registry is tamperable plaintext. Must be cryptographically bound.
**Fix:**
- Hash-chain `findings.jsonl` — each line carries `prev_hash` (SHA256 of previous row); CI invariant `findings-chain-invariants.spec.ts` walks the chain and fails on any break.
- `commit-msg-validator.ts` verifies override ID exists in registry AND the registry entry is in `BLOCKED` state AND the registering commit was signed by `auditor-override-approvers` team.
- Rate-limit counter moved from in-memory to `proper-lockfile`'d shared store keyed by registry-entry-creator (not commit author — defeats squash/rebase bypass).
**Cost:** ~3-5 days. **Land in W10 (registry implementation week).**

**BLOCKER-11 — Ripple-tracer correctness + determinism (D1+A4)**
Grep-based consumer enumeration misses NATS wildcard subjects (`AQUACULTURE_EVENTS.Sensor.>`); ts-morph traversal is non-deterministic across OSes (path ordering, glob stability).
**Fix:**
- Ripple-tracer runtime-contract pass MUST parse `infrastructure/nats/services.yaml` as SSoT for consumer enumeration (per ADR-015), resolve wildcard patterns against declared consumer subjects.
- Canonical output: sorted paths, NFC-normalized, pinned ts-morph version.
- Ripple-set hash emitted to commit trailer `Ripple-Hash: sha256:...`; CI re-runs tracer and asserts hash match. Determinism test: 10× identical-input runs must produce identical output.
**Cost:** ~2-3 days. **Land in W7.5 ripple-tracer engineering.**

**BLOCKER-12 — Phase 4.5 auditor role split (A2)**
Auditor cannot verify same-cycle Phase 4 arbiter rulings (chicken-and-egg). Must split: tier-claim verification is within-cycle; architectural-dispute ruling verification is next-cycle.
**Fix:** Edit `orchestrator.md` Phase 4.5 description to: *"verifies tier-claim correctness for current-cycle diff AND verifies prior-cycle arbiter rulings are implemented in current-cycle diff."*
**Cost:** 10 minutes (prose edit). **Land in W4.**

**BLOCKER-13 — Migration safety enforcement (D5+D6+D13)**
TypeORM generator output can produce unsafe SQL (ACCESS EXCLUSIVE locks, non-concurrent indexes, missing `SET LOCAL lock_timeout/statement_timeout/search_path`, volatile-default rewrites). Blue-green 3-step dance (nullable→backfill→NOT NULL) unenforced.
**Fix:** New `tools/gates/migration-sql-lint.ts` (~200 lines) appended to `add-migration` skill's `done_definition`. Rules:
- Reject `ALTER TABLE ... SET NOT NULL` without prior same-file nullable+backfill
- Require `SET LOCAL lock_timeout`, `SET LOCAL statement_timeout`, `SET LOCAL search_path` in every DDL tx
- Require `CREATE INDEX CONCURRENTLY` on tables >10k rows
- Reject `ADD COLUMN ... DEFAULT <volatile>` (full table rewrite)
- Verify `down()` exists and is non-empty
**Cost:** 3-4 days. **Land in W5 (add-migration skill authoring).**

**BLOCKER-14 — provision-tenant saga + rollback (D9)**
Mid-provision failure leaves orphan schemas + "active" tenant row. Must be transactional.
**Fix:** `provision-tenant` skill mandates: (a) pre-flight schema-existence check, (b) `pg_advisory_xact_lock(hash(tenant_id))` per service, (c) compensating `DROP SCHEMA` on any per-service failure, (d) tenant row flipped to `ACTIVE` only after ALL services complete, (e) `CrossTenantProbe` canary in `done_definition` (write in A, attempt read from B).
**Cost:** ~3 days. **Land in W5 (tenant skills week).**

**BLOCKER-15 — add-shared-table ADR gate (D7)**
Currently a normal skill; silently adds 5th+ shared table, bypassing ADR-011 governance.
**Fix:** `add-shared-table` skill frontmatter gains `requires_adr: true`. `commit-msg-validator` verifies the commit touches `docs/adr/` with a new file OR references an existing ADR. Without ADR evidence → reject.
**Cost:** 0.5 day. **Land in W5.**

**BLOCKER-16 — Three-store cycle manifest (A8)**
`cycle-state-log`, `ripple-set.json`, `findings.jsonl` are three independent append-only stores with no transactional linkage. Crash mid-cycle leaves drift.
**Fix:** At every cycle close, orchestrator writes `.claude/state/cycle-{id}.manifest.json` = `{cycle_state_hash, ripple_set_hash, findings_delta_hash}`. Next cycle open verifies prior manifest matches disk state. Invariant test `three-store-invariants.spec.ts`.
**Cost:** 2-3 days. **Land in W11 (new week added to timeline).**

### V3 Pushbacks (over-strict — NOT in v3)

- **D10 Pact / consumer-driven contract testing — DEFERRED to POST-V1.** Existing ripple-coverage + invariant tests + event-store replay stack covers ≥80% of semantic breaks. Pact is 2-week initiative for marginal tail coverage. Open tracked finding `AUDIT-PACT-001`; revisit W15+ based on calibration data showing (or not showing) escapes. This deferral WITH tracking + calibration plan is architectural, not a banned "for now" shortcut.
- **S7 ts-morph sandboxed container — REDUCED to read-only job permissions.** ts-morph doesn't execute code; `--ignore-scripts` already universal. No container isolation needed; job-level `permissions: { contents: read }` + `persist-credentials: false` + artifact-based `ripple-set.json` delivery suffices.
- **S13 GHA SHA pinning — ALREADY DONE.** Existing workflows 100% compliant; new jobs follow established pattern; add regex CI check `(^|\s)uses:\s+[^@]+@(?!v?\d|[0-9a-f]{40})` to prevent regression.
- **D15 Finding-ID namespace prefixing (AUDIT-* vs DATA-*) — COSMETIC.** `{severity}-{NNN}` per CLAUDE.md is adequate; prefix convention is nice-to-have, not blocker.

### V3 New Infra Findings (discovered by ground-truth pass — add to plan)

- **INFRA-1 HIGH**: `backup-production.yml:62` uses `git checkout -f origin/main` — arbitrary code execution on droplet via main commit. **Fix:** pin to release tag or SHA-256 manifest verify. **W2.**
- **INFRA-2 MEDIUM**: `docs-check` and `security-audit` CI jobs use `|| true` masking failures. **Fix:** remove masks; fail on high/critical. **W7.**
- **INFRA-3 MEDIUM**: No Dependabot `github-actions` ecosystem config — 20 pinned SHA workflows silently rot. **Fix:** add `.github/dependabot.yml` entry. **W0.**
- **INFRA-4 LOW**: New `finding-state-sweep.yml` / `rule-health-report.yml` need `concurrency:` groups to prevent overlapping daily runs corrupting `findings.jsonl`. **Fix:** add to workflow YAML. **W10.**

### V3 Phase-1 mandatory items (fold into plan weeks, not blockers)
A3 compaction-exempt cycle-state log (W4); A5 Layer-1 per-domain shard split (W2); A6 skill precedence matrix (W5); A7 `expires: never` requires ADR (W7); D2 dual-publish window spec (W5); D3+D4 event-store replay + upcaster chain harness (W6); D11 ban raw `natsClient.publish` outside outbox (W7); S6+S10 Unicode/concat scanner evasion (W7); S8 sweep workflow least-privilege (W8); S9 `expires: never` scheduled re-review (W7); D12 pre-migration restore-test sanity (W6); D14 auth/billing tenant row placement ADR clarification (W2); INFRA-1/2 (W2/W7).

### V3 Timeline: 12 → 14 weeks + W0

W0 (3-5 days pre-kickoff) added for 4 hard blockers. W11 added (three-store reconciliation). W13 added (calibration). W14 activation cutover.

**V3 Consensus verdict:** APPROVE after BLOCKER-8 through BLOCKER-16 land per week schedule + 4 infra findings addressed. D10 Pact remains tracked-deferred.

---

## W1 Audit Findings & v4 Revision (2026-04-16 end-of-W1)

W1 Part A audit (6 domain slices + anti-pattern scan + ADR drift matrix + unified synthesis) surfaced 18 CRITICAL + 38 HIGH + 26 MEDIUM + 14 LOW findings. Full inventory at `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-unified-audit.md`. Five systemic patterns (SYS-1 to SYS-5) + seven plan-revision recommendations feeding v4.

### V4 Blocker additions (W1.5 insert before W2)

Synthesis surfaced gaps the Round-3 consensus missed. Do NOT start W2 before these land.

**BLOCKER-17 — Rust edge gateway does not compile on HEAD (EDGE-CRITICAL-001)**
`apps/sens-api-gateway/src/commands.rs:3334,3398` references `state.failover_manager.as_ref()` but the field is not declared on `AppState` in `main.rs:240-282`. A prior cycle patched `commands.rs` for HIGH-003 without wiring the manager. Deploy from HEAD is blocked. This is exactly the CLAUDE.md-forbidden "partial migration shipped as complete" pattern (SYS-4).
**Fix:** architectural — either (a) complete the FailoverManager wiring with proper lifecycle (new + register + startup/shutdown) or (b) remove the stale references + the unused trait surface. Decision requires reading the original HIGH-003 intent. W1.5 Day 1 investigation → W1.5 Day 1-2 implementation.
**Cost:** 4-8 hours. Stop-the-line for droplet deploy.

**BLOCKER-18 — Five canonical ADR files are 0 bytes (ADR-001/002/003/004/005)**
CLAUDE.md cites `docs/adr/001-monorepo-vs-polyrepo.md` through `005-opensearch-logging.md` as canonical architectural authorities. All five are empty files. ADR-004 (Temporal) and ADR-005 (OpenSearch) declare "Accepted" status but have zero implementation (no deps, no code references) — phantom ADRs. ADR-001/002/003 have actual implementations to retrodocument.
**Fix:** ADR-001/002/003 → reverse-engineered content reflecting current reality (monorepo Nx structure, gateway-api pattern, sensor-service separation). ADR-004 → SUPERSEDED marker citing current workflow orchestration reality (saga handlers + Nx orchestrator). ADR-005 → SUPERSEDED marker citing current logging stack (StructuredLoggerService + optional OpenSearch deferred).
**Cost:** ~4-6 hours (3 real ADRs + 2 supersede markers). W1.5.

**BLOCKER-19 — SSoT chain broken (CTX-HIGH-001)**
W0 landed `tests/invariants/_constants.ts` referencing `tests/invariants/adoption-invariants.spec.ts`, but the consumer spec does not exist. The SSoT points at a ghost enforcer.
**Fix:** Either land a minimal `adoption-invariants.spec.ts` in W2 that actually imports and enforces `SCHEMA_OWNING_SERVICES`, OR update `_constants.ts` to remove the forward reference until W8. Former preferred — minimal invariant is ~6h work; creates tier-3 enforcement immediately rather than waiting 7 weeks.
**Cost:** ~6h. Promote from W8 into W2 deliverable.

**BLOCKER-20 — `tools/eslint-rules/` workspace must exist before Part B agent knowledge writing (anti-pattern top-5 recommendation)**
Anti-pattern scan identified 5 ESLint rules that structurally prevent top tier-1-achievable violations: `require-entity-schema`, `no-inline-event-literal`, `no-direct-event-publish`, `no-raw-redis-on-tenant-data`, `no-bare-tenant-query-key`. Without the workspace bootstrapped, Part B agent files cite rules that do not exist — tier-4 documentation instead of tier-3 detection.
**Fix:** Scaffold `tools/eslint-rules/package.json` + `index.ts` + one worked-example rule in W2. Remaining 4 rules tracked across W5-W7 alongside the skills they enforce.
**Cost:** ~4h scaffold + 2h for first rule. W2 prerequisite.

### V4 revisions (accepted from W1 synthesis)

1. **BLOCKER-8 scope language updated in-place above** — 157 `@Entity` violations (not 13 services / not 2 entities). The BLOCKER-8 section is authoritative now; anti-pattern scan reconciles.
2. **Tech anchor table corrected in-place above** — Vite ^5.0.0 (not 7.3.1), React mixed, @originjs federation, hooks plugin mixed.
3. **MT-HIGH-001 rescinded** — multi-tenant slice agent flagged `tests/invariants/_constants.ts` as missing; FALSE positive, the file exists on agentic at commit `ad7ec82d`. Slice ran during a branch-switch window and saw `main` working tree. Documented in unified-audit.md; no code action needed.
4. **W1.5 inserted between W1 and W2** — contains BLOCKER-17 through BLOCKER-20 fixes. Estimated 2-3 days. Timeline bumps from 14w + W0 → 14w + W0 + W1.5.
5. **OPA dead-code decision deferred to architectural-arbiter in W4** — SEC-HIGH-004 surfaced full OPA stack with zero adoption. Requires ADR: land or delete. Not a W1.5 item.

### V4 Timeline: W0 + W1 + **W1.5** + 14 weeks

W1.5 = 2-3 days, stop-the-line before any W2 Knowledge SSoT work. W2 inherits BLOCKER-19/20 deliverables in addition to original Knowledge SSoT scope.

**V4 Consensus verdict:** APPROVE pending BLOCKER-17 through BLOCKER-20 landed in W1.5 + 7 v4 revisions reflected. W1 audit findings (96+ total) feed the Part C skills catalog as the work surface for W5-W7.

---

## Tech stack anchors (authoritative — from package.json + Cargo.toml on 2026-04-16)

| Layer | Version | Notes |
|---|---|---|
| NestJS | 11.1.17 | `@nestjs/cqrs` 11.0.3, `@nestjs/typeorm` 11.0.0 |
| TypeORM | 0.3.27 | DataSource API era, not Connection |
| TypeScript | 5.3.3 | satisfies operator, const type params available |
| Nx | 22.3.3 | affected, project graph |
| Jest | 30 | projects array, describe.each |
| React | **shell 18.3.1, modules ^18.2.0** (not 19) | Suspense, transitions, NOT Server Actions. Mixed pin is a drift source — Part B L1 must acknowledge both |
| Vite | **^5.0.0** (every shell + module) | Not 7.3.1 — root package.json declares 7 but per-project overrides pin to 5. Corrected by W1 frontend audit |
| Module Federation | `@originjs/vite-plugin-federation` | NOT `@nx/module-federation` (also corrected by W1 audit) |
| eslint-plugin-react-hooks | **shared-ui ^4.6.0, elsewhere ^5.0.0** | Mixed pin |
| GraphQL | 16 + Apollo Federation | graphql-depth-limit, query-complexity wired |
| NATS client | 2.29.3 | mTLS cert-CN identity (ADR-014/015) |
| class-validator | 0.14.3 | |
| Rust | Tokio 1.43, axum 0.8, rustls-native-certs 0.8, thiserror 2.0 | Edge gateway |
| Postgres | pg 8.16 + TimescaleDB | |

Canonical ADRs: 001-016 under `docs/adr/` (16 total). 4 misfiled under `docs/architecture/ADR-01{0-3}-*.md` (tracked drift — do not renumber here).

---

## Part A — Discovery Phase (Week 1)

Goal: produce a **Tech+Pattern Audit Report** that maps what's in use, what's outdated, and what best-pattern knowledge agents must carry. User explicitly stated "ne eksik ne kullanılıyor ben bilmiyorum" — this phase answers that.

### A.1 Pattern usage audit (per tech)

Deliverable: `docs/reviews/_audit/2026-04-{W}-tech-pattern-audit.md`

For each tech, produce a table of `pattern → usage count → version correctness → example file → modernization opportunity`:

| Tech | Patterns to audit |
|---|---|
| NestJS 11 | Guards (v11 `CanActivate`), Interceptors, Pipes (ValidationPipe config), Filters, `@nestjs/cqrs` command/query/event bus usage, microservices transport, module forRoot/forRootAsync, lifecycle hooks (`OnModuleInit`, `OnApplicationBootstrap`) |
| TypeORM 0.3 | `DataSource` usage (not `Connection`), `@Entity({ schema })` compliance (ADR-011), migrations owner, `getScopedRepository` adoption, raw SQL usage, jsonb/array column patterns |
| TypeScript 5.3 | `satisfies` operator adoption, branded types (already in EventId), `as const`, discriminated unions, `noUncheckedIndexedAccess` opportunities |
| React 18 | Suspense boundaries, `useTransition`, `useDeferredValue`, Error Boundaries coverage, React Query vs local state split, Module Federation remote loading patterns |
| GraphQL | Federation directives correctness, `@Resolver` patterns, N+1 via DataLoader, depth/complexity limits |
| NATS | `@platform/event-bus` factory adoption, outbox pattern (platform/libs/outbox), subject naming (`AQUACULTURE_EVENTS.*`), cert CN flows |
| Rust edge | Tokio runtime config, `?` error propagation, `thiserror` vs `anyhow` discipline, TLS (rustls), protocol isolation |
| CQRS (`@nestjs/cqrs` 11) | CommandBus/QueryBus discipline, handler single responsibility, saga usage, event publisher vs event bus separation |
| Multi-tenant | schema-per-tenant adoption (farm/sensor/hr/messaging/hydroponics/alert/ai), RLS coverage, tenant ID sourcing (JWT vs header per CLAUDE.md) |

### A.2 Anti-pattern scan

Grep-level scan for known anti-patterns; output to `docs/reviews/_audit/anti-patterns.md`:
- `as any` / `as unknown as` call sites (count per service)
- `getRepository()` (should be zero per ESLint, verify)
- Defensive `?.` chains (likely legitimate vs. paranoid — needs agent review)
- Inline event object literals (should compile-error via branded `EventId`, verify)
- `@Entity()` without `schema:` (should be zero, verify)
- `console.*` (should be zero outside tests)
- JSON.stringify with indent in log calls
- TODO/FIXME without `Closes:` or `no-finding:` reference

### A.3 ADR ↔ code drift scan

For each of 16 canonical ADRs, locate enforcement mechanism (lint rule / invariant test / agent guard) and produce a coverage matrix. Gaps become HIGH findings feeding the skills catalog.

### A.4 How to execute

Run the audit as a **single orchestrated multi-agent cycle** against the current `main` HEAD using the existing enterprise-v2 roster:
- Each domain agent (farm, sensor, hr, messaging, admin, auth-security, edge, platform-kernel) audits its slice.
- `context-manager` compacts into the unified report.
- Output lands in `docs/reviews/_audit/` (new subfolder).

This is the only deliverable of Phase A — **no code changes yet**. The report drives Parts B, C, D.

---

## Part B — Agent Knowledge Layer Redesign (Week 2-3)

Goal: every enterprise-v2 agent carries explicit tech+pattern+ADR knowledge and can operate in three roles.

### B.0 Knowledge SSoT (pre-Part-B prerequisite — BLOCKER-1)

Before editing any agent file, create three SSoT knowledge files under `.claude/knowledge/`:
- `layer-1-tech.md` — tech-version anchors (single source for NestJS 11, TypeORM 0.3.27, React 18.2, TS 5.3, Tokio 1.43 patterns)
- `layer-2-patterns.md` — architectural patterns (CQRS discipline, Outbox, DDD aggregate, tenant isolation modes)
- `layer-3-adrs.md` — one-line ADR summaries indexed 001-016

Plus shared agent-template fragments under `.claude/agents-enterprise-v2/_shared/`:
- `operating-modes.md` — CATCHER/TEACHER/WRITER spec (included by every agent)
- `tier-claim-syntax.md` — inline `// tier-N:` + `// auditor-override:` grammar
- `handoff-protocol.md` — skill ↔ agent handoff contract
- `output-format.md` — finding report skeleton

Agent files reference via `@.claude/knowledge/layer-1-tech.md` + `@_shared/operating-modes.md` include syntax; inline only domain-specific Layer 2 + per-agent mode overrides. This keeps every agent ≤200 lines (BLOCKER-2).

Invariant enforcement: `tests/invariants/knowledge-ssot.spec.ts` hashes SSoT blocks and fails if any agent file inlines a hashable duplicate — detects drift automatically.

### B.1 Three-layer knowledge matrix

```markdown
## Best-Pattern Knowledge

### Layer 1 — Tech-Version-Specific (what "modern" looks like today)
- NestJS 11.1: Use `@Injectable({ scope: Scope.DEFAULT })` by default; Request-scoped only when tenant context demands.
- TypeORM 0.3.27: `DataSource` not `Connection`; `getScopedRepository<T>(ctx)` not `getRepository<T>()`; migrations via service-owned `data-source.ts`.
- TypeScript 5.3: Prefer `satisfies` over type assertion; branded types for domain IDs; `const` type parameters for generic inference.
- {tech specific to this agent's domain}

### Layer 2 — Architectural Patterns
- CQRS discipline: Controller → Service → CommandBus/QueryBus → Handler → Repository. No layer skipping.
- Outbox for cross-service writes: persist + publish atomically via `@platform/outbox`.
- Event flat pattern (ADR-006): `BaseEvent` + domain fields, no nested payload wrappers.
- DDD aggregate root owns its invariants; commands mutate via aggregate, not via repository directly.
- Tenant isolation: schema-per-tenant for farm/sensor/hr/messaging/hydroponics/alert/ai; shared schema for cross-tenant; JWT claims as trust anchor (CLAUDE.md).

### Layer 3 — Repo Conventions (ADR-bound)
- ADR-011: every @Entity() declares schema:; never public for new tables.
- ADR-014/015: NATS identity is cert CN only; services.yaml is SSoT; generated block sentinels in nats.conf.
- ADR-006: flat events, createBaseEvent() factory, no inline EventId.
- ADR-012: SchemaDriftValidator at cold start; SCHEMA_DRIFT_FATAL=true for prod.
- {ADRs specific to this agent's domain}
```

### B.2 Three-role operating modes

Each agent file gains `## Operating Modes` section declaring how it behaves in each role:

```markdown
## Operating Modes

### Mode 1 — CATCHER (review/block)
Invoked: PR review, post-commit audit, orchestrator Phase 2.
Output: findings with severity {CRITICAL|HIGH|MEDIUM|LOW}, finding ID, cite Layer 1/2/3 rule violated.
Decision rule: any CRITICAL/HIGH unresolved → BLOCK merge.

### Mode 2 — TEACHER (advise before code)
Invoked: user query "how do I add X to domain Y?" or before skill execution.
Output: 
  - Cite the Layer 1/2/3 pattern that applies.
  - Enumerate the cascade (ripple set) — files that must change.
  - Warn of anti-patterns specific to this change.
  - Point to the skill that encodes the recipe (if exists).
Do NOT write code; hand off to skill or Writer mode.

### Mode 3 — WRITER (generate code)
Invoked: explicit "write the X" request or skill execution delegates here.
Output: production-ready code conforming to all three knowledge layers.
Constraints:
  - No tier-4 patterns (banned-phrase list).
  - Must produce the full ripple set in the same session.
  - Must write tests alongside implementation (TDD).
  - Must reference Closes: finding if fixing a known issue.
```

### B.3 Role-routing rule (added to orchestrator)

Orchestrator's Phase 1 routing gains a mode selector. The invoker declares intent:
- `review:` → agent runs in CATCHER mode. **HARDCODED DEFAULT when no mode token present** (BLOCKER-3).
- `plan:` → agent runs in TEACHER mode (before writing).
- `implement:` → agent runs in WRITER mode. Requires **explicit token** from human or implementation-planner; orchestrator never synthesizes this token autonomously.

Agents refuse cross-mode contamination:
- TEACHER never writes code (outputs advice + skill pointer only).
- WRITER never rubber-stamps own output — CATCHER on review MUST be a different agent instance (pair-review invariant).
- **Same-agent TEACHER→WRITER self-promotion is FORBIDDEN.** If agent-X ran TEACHER on cycle-N, WRITER for the same surface must be routed to a different agent by orchestrator (e.g., TEACHER=farm-expert → WRITER=implementation-planner-driven via skill; CATCHER=farm-expert in next cycle).
- Orchestrator enforces via a cycle-state log: `{cycle_id, agent, mode, surface_hash}` — rejects routing that violates pair-review.

### B.4 Files modified

- `.claude/agents-enterprise-v2/{every-agent}.md` — add Best-Pattern Knowledge + Operating Modes sections
- `.claude/agents-enterprise-v2/orchestrator.md` — add mode-routing to Phase 1
- `.claude/agents-enterprise-v2/implementation-planner.md` — compose plans as mode-directed skill DAGs

### B.5 Files created

- `.claude/agents-enterprise-v2/README.md` — update with "three-layer × three-role" model

---

## Part C — Skills Catalog (Week 3-4)

Goal: every recurring procedure becomes a deterministic skill with machine-checked cascade enforcement. Agents delegate to skills instead of re-deriving procedures per session.

### C.1 Skill file format

Location: `.claude/skills/<name>.md`

```yaml
---
name: add-entity-field
description: |
  Triggered when adding a new column to a TypeORM entity. Keywords:
  entity, column, field, @Column, database schema.
category: domain-mutation
adr_refs: [006, 011, 012]
tech_refs:
  - "TypeORM 0.3.27"
  - "NestJS 11 TypeOrmModule"
layer_knowledge:
  - layer-1: "Use DataSource.createQueryBuilder, not getRepository"
  - layer-2: "Entity change = migration + DTO + event upcaster (if persisted event)"
  - layer-3: "ADR-011 schema: required; ADR-012 drift validator boots clean"
ripple:
  required:
    - "apps/<svc>/src/**/entities/<entity>.entity.ts"
    - "apps/<svc>/src/database/migrations/<timestamp>-Add<Field>To<Entity>.ts"
    - "apps/<svc>/src/**/dto/{create,update,read}-<entity>.dto.ts"
    - "apps/<svc>/src/**/__tests__/*.spec.ts"
  conditional:
    - pattern: "field is in published event contract"
      then: "libs/event-contracts/src/<aggregate>/*.ts + upcaster"
    - pattern: "field is exposed via GraphQL"
      then: "apps/<svc>/src/**/*.resolver.ts + codegen rerun"
    - pattern: "field drives tenant access decision"
      then: "invoke multi-tenant-saas-expert + auth-security-expert review"
anti_patterns:
  - "jsonb dumping ground to avoid typed column"
  - "optional (?) in DTO to hide nullability"
  - "as any in mapper"
  - "missing schema: option in @Entity()"
done_definition:
  - cmd: "nx affected --target=test --target=lint"
  - cmd: "npx jest e2e/tests/integration/schema-invariants.spec.ts"
  - verify: "service boots with SCHEMA_DRIFT_FATAL=true (integration smoke)"
handoff:
  on_complete_invoke: [data-expert, database-reviewer]
  on_security_touch: security-reviewer
  on_event_impact: {agents_consuming_event}
override_protocol: audit-override-request
---

# Procedure (TEACHER mode narration)

1. Read the entity file; identify aggregate boundary. If field affects a published event, STOP and invoke `change-event-contract` skill first.
2. Add @Column with explicit type (no jsonb unless justified by boundary). Set nullable per invariant.
3. Generate migration: `nx run <svc>:migration:generate --name=Add<Field>To<Entity>`. Verify up/down reversibility.
4. Update DTOs: create/update/read variants. Preserve null-safety (no optional-to-hide-nullability).
5. Update repository query paths if indexes/projections affected.
6. Update fixtures in `@platform/testing`.
7. Write/update unit test covering new field persistence + read.
8. Run done_definition checks. If any fails, the cascade is incomplete — DO NOT declare done.
9. Hand off to `data-expert` + `database-reviewer` for CATCHER review.
```

**Load-bearing fields**: `ripple.required` (must match `git diff --name-only`), `ripple.conditional` (context-sensitive), `done_definition` (executable verification), `handoff` (closed-loop review).

### C.2 Initial skills catalog (16 skills)

**Category A — Domain Mutation**
- `add-entity-field` — new column + migration + DTO + test + event upcaster
- `rename-column` — migration + all QueryBuilders + DTOs + events + fixtures
- `retire-feature` — controller → command → handler → entity (deprecate/drop) → event tombstone → frontend federation removal → NATS subject removal → dashboards → ADR
- `split-service` — scaffold new app + carve schema + relocate migrations + NATS SSoT update + orchestrator routing

**Category B — Contract**
- `add-event` — interface in event-contracts + schema + createBaseEvent usage + outbox + consumers enumerated + test-agent contract-parity check
- `change-event-contract` — upcaster (never mutate version) + version bump + consumers updated concurrently + event-store replay test
- `break-event-contract-safely` — dual-publish → migrate consumers → tombstone + deletion after canary

**Category C — Infrastructure**
- `add-nats-service` — services.yaml + cert CN + generate-nats-conf.py + health probe (ADR-014/015)
- `add-new-service` — Nx generator + data-source.ts + migration runner + SchemaDriftModule + gateway routing + orchestrator routing table + docker-compose + observability scrape
- `add-shared-table` — entity in `shared` schema + SHARED_SCHEMA_TABLES update + read-only consumer repositories
- `add-migration` — generated via service-local data-source + reversible down + drift-validator retest + pool-recycle runbook link if long-running

**Category D — Tenant / Security**
- `provision-tenant` — auth tenant row + per-tenant schemas for every schema-per-tenant service + RLS + default roles + NATS ACL + billing sub + audit event
- `offboard-tenant` — GDPR export + per-schema hard delete + shared-schema anonymization + NATS ACL removal + billing cancel + audit preserved
- `rotate-secret` — dual-read window + consumer flip + old revoke + runbook update
- `enable-mfa-for-role` — auth policy + gateway guard + OPA regen + frontend branch + breakglass doc

**Category E — Deploy / Ops**
- `deploy-droplet` — nx affected build → docker bake → migration dry-run → compose apply → health wait-loop → pool recycle → smoke
- `run-migration-prod` — backup snapshot → maintenance check → runner with `DATABASE_MIGRATIONS_RUN=false` enforced → drift validator → pool recycle

**Category F — Review / Audit**
- `open-finding` — canonical header + stable ID + severity + owner; if CRITICAL/HIGH not fixed same-session, commit must say so
- `close-finding` — Closes: trailer + reviewer re-verify + multi-domain re-invocation if needed
- `audit-override-request` — override note in `docs/reviews/overrides/` + architectural-arbiter approval + inline `eslint-disable-next-line ... -- OVERRIDE:<id>` with expiry

### C.3 Skill ↔ Agent integration

- Orchestrator phases unchanged (1, 2, 3, 3.5, 4, 5, 6).
- **New Phase 1.5 for WRITER/TEACHER invocations**: implementation-planner composes a DAG of skill invocations (not prose steps) — skill is the unit of work.
- `done_definition` runs before the skill returns; failure = skill did not complete. No "partial skill" state.
- `handoff` triggers auto-review by named agents in CATCHER mode after skill completion.

### C.4 Files created

- `.claude/skills/` (new directory)
- `.claude/skills/README.md` — format spec, catalog, override protocol
- 16 skill files per C.2

---

## Part D — Gate Infrastructure (Week 4-5)

Goal: structurally prevent tier-4 patches and incomplete cascades from entering the repo.

### D.0 Prerequisites (Week 4 setup — BLOCKER-5)

Before writing gate scripts:
1. `npm install -D ts-morph@^23` — required by ripple-tracer AST pass; not currently a direct dep.
2. Bump `engines.node` in `/var/aqua-saas/package.json` from `>=20.11.0` to `>=22.6.0`. Document in release notes. Node 22 is required for stable `--experimental-strip-types`.
3. Keep husky at v8 (currently installed) — v8 hook layout: `.husky/<hook>` shell file sourcing `_/husky.sh`. Do NOT upgrade to v9 (would require broader layout changes).
4. Fallback: if Node 22 adoption blocked on any dev machine, swap `node --experimental-strip-types` for `tsx` runner — add `tsx@^4` as devDep; hook command becomes `npx tsx tools/gates/<script>.ts`.

### D.1 Tier 1 — Local pre-commit gate (<5s, noisy-OK)

**IMPORTANT (BLOCKER-4):** `tsc --noEmit` is NOT in Tier 1 — too slow (20-60s warm, >2min cold). Type-check stays in Tier 2 (existing CI `type-check` job).

**Files created (TypeScript, Node 22 type-stripping):**
- `.husky/pre-commit` — v8-style shell: `#!/bin/sh; . "$(dirname "$0")/_/husky.sh"; node --experimental-strip-types tools/gates/pre-commit.ts`
- `.husky/commit-msg` — v8-style shell sourcing husky.sh, then `node --experimental-strip-types tools/gates/commit-msg-validator.ts "$1"`
- `tools/gates/pre-commit.ts` — parallel orchestrator for sub-checks
- `tools/gates/banned-phrase.ts` — AST-aware scanner (staged files + `.git/COMMIT_EDITMSG`); excludes ADRs, CHANGELOG, fixtures; rejects on match with suggested rewrite
- `tools/gates/tier-claim-lint.ts` — validates inline `// tier-{1..4}: <justification>` syntax, rejects tier-4 claims on domain-code paths (allowlist-checked)
- `tools/gates/commit-msg-validator.ts` — Conventional Commits header; `Closes: ...` XOR `no-finding: <justification>`; no banned phrases in body; `auditor-override:` grammar check
- `.claude/gates/rules.yaml` — rule manifest (severity, rollout state, override counts)
- `.claude/gates/mandatory-rules.yaml` — non-negotiable rules, invariant-test-enforced

**ESLint additions** (`.eslintrc.json`):
- Ban `// TODO` / `// FIXME` without `Closes:` or `no-finding:` tail
- Ban `throw new Error('not implemented')` in non-test files
- Ban file-level `/* eslint-disable */` without `auditor-override:` comment above
- Promote `@typescript-eslint/explicit-function-return-type` to error for exported symbols

All new rules ship at `severity: "warn"` for 30 days per progressive-rollout protocol (D.5), promoted to `error` after calibration.

### D.2 Tier 2 — CI PR gate (blocking, precision)

**Files modified** (`.github/workflows/ci-affected.yml`):
- Add job **`invariants`** — `npx jest e2e/tests/integration/*-invariants.spec.ts --ci --detectOpenHandles`. Mandatory, blocking, not scoped by `nx affected`.
- Add job **`adoption-invariants`** — verifies **schema-owning services** import `SchemaDriftModule.forRoot({serviceName})`. **BLOCKER-8 (v3 correction):** allowlist = 13 services via `SCHEMA_OWNING_SERVICES` constant in `tests/invariants/_constants.ts`: `farm-service, sensor-service, hr-service, messaging-service, hydroponics-service, alert-engine, auth-service, billing-service, admin-api-service, event-store-service, ai-service, config-service, notification-service`. Only `gateway-api` and `observability-service` are schema-less (exempt). W2 fixes missing `schema:` on event-store-service + config-service entities before promoting to error.
- Add job **`ripple-coverage`** — runs `tools/gates/ripple-check.ts`. **AST-semantic-gated (BLOCKER-7):** pre-filter diff; if no added/removed exports, no signature changes, no new/changed decorators, no `*.entity.ts` / `*-events.ts` / `*.dto.ts` / `services.yaml` / migration touch → SKIP ripple-coverage. Only semantic changes trigger. Typo/comment/README-only diffs pass without check.
- Add job **`closes-footer`** — walks every commit in PR, validates `Closes:` or `no-finding:` footer.
- Add job **`rule-telemetry`** — parses ESLint JSON report + override counter; emits to `docs/reviews/_telemetry/rule-stats-{YYYY-WW}.json`.

**Files created**:
- `tools/gates/ripple-check.ts` — compares ripple set to diff
- `tests/invariants/adoption-invariants.spec.ts` — SchemaDriftModule adoption
- `tests/invariants/eslint-coverage-invariants.spec.ts` — mandatory-rules.yaml ↔ .eslintrc.json lockstep

### D.3 Tier 3 — Agent-level gate (context-aware)

**Two new agents under `.claude/agents-enterprise-v2/`:**

#### `ripple-tracer.md`
Given `git diff`, enumerate downstream impact via three passes:
1. **AST pass** — `ts-morph` walks imports; transitively resolves consumers of changed symbols.
2. **Runtime-contract pass** — for each changed file, detect if it defines event contract / NATS subject / DTO / entity / migration; enumerate consumers by symbol/subject grep.
3. **Test pass** — enumerate every `*.spec.ts` referencing (1)+(2).

Output: `ripple-set.json` → `{ primary, downstream, tests, contracts, migrations }`.

Invoked: **Phase 0** (new), before Phase 1. Phase 1 routing uses ripple set as superset of raw diff. This is the lever that ensures domain experts see "you changed X, Y was also supposed to change."

#### `root-cause-auditor.md`
Given diff + ripple set + all Phase 2 expert reports, classify each change against 4-tier hierarchy:
1. Read author's `// tier-N:` claim; otherwise infer.
2. Re-classify independently; flag `OVER_CLAIMED` if auditor tier < claimed.
3. For tier-4 without accepted override, emit **rewrite suggestion** (concrete — "extract into branded type at `libs/shared/src/types/`, replace assertion with parse()").
4. Compose with `architectural-arbiter`: defer to arbiter rulings, verify they were implemented (not merely promised).

Output: `auditor-verdict.json` → `{ verdict: PASS|CONDITIONAL|BLOCK, tier4_unresolved, over_claimed, rewrite_suggestions }`.

Invoked: **Phase 4.5** (new), between Phase 4 (architectural-arbiter) and Phase 5 (unified report). Decision rule amendment: `BLOCK if verdict == BLOCK or any tier4_unresolved has no accepted override`.

### D.4 Anti-false-positive design

**Boundary allowlist** (`.claude/allowlists/boundary-files.yaml`):
```yaml
version: 1
entries:
  - path: libs/backend-common/src/bootstrap/zod-validator.ts
    reason: "Boundary — parses raw HTTP input; `as unknown` required before zod.parse"
    owner: "@okan"
    expires: 2026-10-01
  - path: apps/sens-api-gateway/src/proto/**
    reason: "Generated protobuf artifacts — tier-4 patterns are codegen outputs, not source"
    owner: "@okan"
    expires: never
```
- Additions require PR touching this file.
- CODEOWNERS routes `.claude/allowlists/**` and `.claude/gates/**` to `@okan`.
- Auto-expires within 12 months unless `expires: never` (requires ADR).

**Author tier claim syntax**:
```ts
// tier-1: branded TenantId type enforced at every repository boundary
const t: TenantId = parseTenantId(raw);

// tier-2-begin: migration runner auto-syncs this schema change
@Column('uuid', { nullable: false }) tenantId: TenantId;
// tier-2-end
```
- tier-claim-lint validates syntax at commit-time.
- root-cause-auditor validates correctness; downgrades over-claimed with `OVER_CLAIMED` finding.

**Override protocol**:
```ts
// auditor-override: AUDIT-042 | owner:@okan | deadline:2026-05-01 | tracked:docs/reviews/root-cause-auditor/2026-04-16-mqtt-boundary.md
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OVERRIDE:AUDIT-042
const parsed = rawMqttPayload as any;
```
- commit-msg-validator parses override → generates synthetic finding ID if absent → emits `Creates-Finding: AUDIT-042` line.
- CI `closes-footer` job inserts finding into state registry in `BLOCKED` state with deadline.
- Scheduled workflow `finding-state-sweep.yml` runs daily: past-deadline → `STALE` → +1 severity on next review cycle.
- Rate limit: max 3 active overrides per author per week; excess blocks commit.

**Override authority (RECOMMENDED default — revisable):** CODEOWNERS gate on `.claude/allowlists/**` routes all new overrides to `@okan` for approval. This matches user's "architectural fix all the way" mandate. Can be relaxed to `architectural-arbiter` autonomous approval after 90 days of calibration data.

### D.5 Progressive rollout

**Rule manifest** (`.claude/gates/rules.yaml`):
```yaml
rules:
  - id: no-tier4-in-domain-code
    severity: warn   # warn | error
    since: 2026-04-16
    promote_after: 2026-05-16
    override_rate_current: 0
    promote_when: "override_rate < 0.05 for 30 days"
```
- `tools/gates/rule-severity.ts` reads manifest, patches ESLint config at lint-time.
- New rule = `warn` for ≥30 days; calibration data from `rule-telemetry` CI job.
- Promotion to `error` only if override rate <5% sustained.
- Override rate >50% over 2 weeks → auto-demote to `warn` + flag for refinement/retirement.

### D.6 Finding state registry

**Format (RECOMMENDED):** JSONL over SQLite. Git-native diffable, no binary in repo, atomic writes via `proper-lockfile`. User preference for TypeScript-first tooling also fits.

Location: `docs/reviews/_registry/findings.jsonl`
Schema per line:
```json
{"id":"AUDIT-042","created":"2026-04-16T10:00:00Z","severity":"HIGH","state":"BLOCKED","agent":"root-cause-auditor","path":"apps/sensor-service/src/mqtt/mqtt.deserializer.ts","owner":"@okan","deadline":"2026-05-01","override_for":"no-explicit-any"}
```

**Tooling (`tools/gates/finding-registry.ts`):**
- `findings list --state=OPEN --severity=CRITICAL`
- `findings state AUDIT-042 --set=RESOLVED --commit=<sha>`
- `findings sweep` (CI-invoked daily via `finding-state-sweep.yml`)
- `findings report --week=2026-W16` → generates markdown

**State machine (CLAUDE.md-documented, now automated):**
- `OPEN` → raised, no commit
- `IN-PROGRESS` → in implementation-planner package
- `RESOLVED` → commit with matching Closes: merged
- `STALE` → 30 days OPEN or past deadline (+1 severity next cycle)
- `BLOCKED` → override active; expiry enforced

### D.7 Files created (Part D total)

- `.husky/pre-commit`, `.husky/commit-msg`
- `tools/gates/*.ts` (8 files: pre-commit, banned-phrase, tier-claim-lint, commit-msg-validator, ripple-check, rule-severity, rule-health, finding-registry, registry-to-md)
- `.claude/gates/rules.yaml`, `.claude/gates/mandatory-rules.yaml`
- `.claude/allowlists/boundary-files.yaml`
- `.claude/agents-enterprise-v2/ripple-tracer.md`, `.claude/agents-enterprise-v2/root-cause-auditor.md`
- `tests/invariants/adoption-invariants.spec.ts`, `tests/invariants/eslint-coverage-invariants.spec.ts`
- `.github/workflows/finding-state-sweep.yml`, `.github/workflows/rule-health-report.yml`
- `docs/reviews/_registry/.gitkeep`, `docs/reviews/_telemetry/.gitkeep`, `docs/reviews/overrides/README.md`

### D.8 Files modified (Part D)

- `.eslintrc.json` — 5 new rules + explicit-function-return-type to error
- `.github/workflows/ci-affected.yml` — 5 new jobs
- `jest.config.js` — add `invariants` project
- `package.json` — scripts: `gate:pre-commit`, `gate:ripple`, `findings`, `rule-health`
- `.github/CODEOWNERS` — `.claude/allowlists/**` and `.claude/gates/**` → `@okan`

---

## Part E — CLAUDE.md Restructure (Week 5)

Goal: CLAUDE.md becomes the authoritative index, pointing to the layered system instead of duplicating rules.

### E.1 New sections

Add after existing "Architectural Approach" section:

```markdown
## Agent+Skill+Gate System

Three-layer knowledge + three-role execution. Canonical source of truth:

- **Agents** (judgment): `.claude/agents-enterprise-v2/`
  - Every agent carries Layer 1 (tech-version), Layer 2 (architectural pattern), Layer 3 (ADR) knowledge.
  - Every agent operates in CATCHER / TEACHER / WRITER modes per invocation.
- **Skills** (procedure): `.claude/skills/`
  - 16 skills encoding ripple-enforced recipes. Skill completion ≠ skill done until `done_definition` passes.
  - Skills are invoked by agents in TEACHER/WRITER mode.
- **Gates** (enforcement):
  - Tier 1 (pre-commit): `.husky/` + `tools/gates/` — banned-phrase, tier-claim, commit-msg
  - Tier 2 (CI): `.github/workflows/ci-affected.yml` jobs `invariants`, `ripple-coverage`, `closes-footer`
  - Tier 3 (agent): `ripple-tracer` (Phase 0), `root-cause-auditor` (Phase 4.5)
- **Finding state registry**: `docs/reviews/_registry/findings.jsonl` — query via `npm run findings`
- **Override protocol**: `.claude/allowlists/boundary-files.yaml` + inline `// auditor-override:` + CODEOWNERS gate

## Tier Claim Syntax

Inline claim above a change: `// tier-{1..4}: <justification>`
- tier-1: make impossible (branded type, DB constraint, exhaustive switch)
- tier-2: make automatic (runtime guard, generated code, invariant test)
- tier-3: make detectable (ESLint rule, CI check, alert)
- tier-4: documented (comment / runbook) — REQUIRES auditor-override

## Progressive Rollout

New rules ship at warn for ≥30 days. Calibration via `rule-telemetry` CI job. Override rate >50% over 2 weeks → auto-demote + refinement flag.
```

### E.2 Remove (de-duplicate)

- "Banned phrases" section moves to `.claude/gates/rules.yaml` (single source); CLAUDE.md references it.
- "Finding state machine" moves to `tools/gates/finding-registry.ts` docstring + `docs/reviews/_registry/README.md`.

### E.3 Keep (load-bearing for session-start context)

- 4-tier hierarchy (the philosophy)
- Commands table, architecture map, schema ownership rules, NATS identity rules
- Commit format, git rules

---

## Part F — Rollout Roadmap

Phased delivery because the full system is ~8-10 person-weeks. User's "cascade all the way" mandate is respected by making each phase *itself* complete — no partial deliverables.

**V3 timeline: W0 + 14 weeks** (Round 3 revision). W0 added for 4 pre-kickoff hard blockers (~3-5 days). W11 added for three-store reconciliation. W13 added for calibration before cutover.

| Week | Deliverable | Exit criterion |
|---|---|---|
| **W0** | **Pre-kickoff blockers**: BLOCKER-8 `SCHEMA_OWNING_SERVICES=13` constant; BLOCKER-9 CODEOWNERS on control-plane paths + signed-commit branch protection; BLOCKER-11a ripple-tracer `services.yaml` SSoT parser spec; BLOCKER-12 Phase 4.5 one-line orchestrator clarify; INFRA-3 Dependabot github-actions ecosystem | 4 blockers merged; control plane authenticated; allowlist constant single-source |
| W1 | **Part A: Audit report** + boundary allowlist seed (AMENDMENT-B) | `docs/reviews/_audit/*.md` merged; ≥10 entries in `.claude/allowlists/boundary-files.yaml` |
| W2 | **BLOCKER-1 + BLOCKER-2 + A5**: `.claude/knowledge/` SSoT with **per-domain layer-1 shards** (layer-1-nestjs.md, layer-1-typeorm.md, layer-1-react.md, layer-1-rust.md, layer-1-core.md) + `_shared/` fragments; legacy FROZEN marker (AMENDMENT-C); **fix missing `schema:` on event-store + config entities (BLOCKER-8 cascade)**; **INFRA-1: pin backup-production.yml `git checkout` to release tag**; D14 auth/billing tenant row ADR clarification | 5 layer-1 shards + 4 shared fragments merged; 2 entities fixed; backup workflow hardened |
| W3 | **Part B step 1**: 9 highest-leverage agents updated | 9 agents ≤200 lines each; reference SSoT + _shared includes |
| W4 | **Part B step 2**: remaining 13 v2 agents + orchestrator mode routing (BLOCKER-3) + **A3 cycle-state log compaction-exempt marker** | All 22 v2 agents updated; `review:` hardcoded default; cycle-state log active + exempt flag |
| W5 | **Part C step 1**: 6 highest-ripple skills + **BLOCKER-13 migration-sql-lint tool (D5+D6+D13)** + **BLOCKER-14 provision-tenant saga rollback (D9)** + **BLOCKER-15 add-shared-table ADR gate (D7)** + **A6 skill precedence matrix** + **D2 dual-publish window spec** | 6 skills merged; dogfood session proves cascade + handoff; saga proven via kill-in-middle test |
| W6 | **Part C step 2**: remaining 10 skills + **D3+D4 event-store replay test harness + upcaster chain invariant** + **D12 pre-migration restore-test sanity check** | Catalog complete; replay harness green; restore-test gating prod migrations |
| W7 | **Part D step 0 + 1**: prerequisites (ts-morph, engines.node, husky v8) + Tier 1 pre-commit + **S6+S10 Unicode/concat banned-phrase hardening** + **D11 outbox structural enforcement ESLint rule (ban raw `natsClient.publish`)** + **A7 `expires: never` requires ADR** + **S9 `expires: never` scheduled re-review** + **INFRA-2 remove `|| true` masks on docs-check + security-audit** | Hooks active <5s budget; outbox-only rule green; `|| true` removed |
| W7.5 | **BLOCKER-11 Ripple-tracer engineering** (ts-morph AST passes, **services.yaml SSoT runtime-contract pass (D1)**, test pass, **canonical sort + ripple-set hash in commit trailer + 10×-determinism test (A4)**, **S7 job-level `permissions: contents:read` + `persist-credentials:false` + artifact delivery**) | ripple-check.ts returns deterministic ripple-set.json across 10 runs; NATS wildcards resolved; hash trailer emitted |
| W8 | **Part D step 2**: Tier 2 CI jobs (adoption-invariants with **13-service allowlist**; ripple-coverage semantic-gated; closes-footer) + **S8 sweep workflow least-privilege permissions** | Jobs green on main; PRs blocking semantic changes; sweep workflow contents:read + pull-requests:write only |
| W9 | **Part D step 3**: Tier 3 agents (ripple-tracer.md, root-cause-auditor.md); orchestrator Phase 0 + 4.5 (with BLOCKER-12 role-split wording) | Full review cycle with new phases passes dogfood PR |
| W10 | **Part D step 4**: finding state registry (JSONL) + **BLOCKER-10 hash-chained rows + commit-msg-validator registry verify + signed-commit requirement + shared-store rate limiter (S4+S5)** + sweep workflow + rule-health report + **INFRA-4 concurrency groups on new workflows** | Registry populated; chain integrity green; rate limiter stateful |
| W11 | **BLOCKER-16 three-store cycle manifest**: `.claude/state/cycle-{id}.manifest.json` + `three-store-invariants.spec.ts` | Cross-store drift detected in <1 cycle lag |
| W12 | **Part E**: CLAUDE.md restructure | CLAUDE.md references new structure; duplication removed |
| W13 | **Calibration**: telemetry review; first rule promotions warn→error based on <5% override rate over 30 days | `.claude/gates/rules.yaml` updated with promotion decisions |
| W14 | **Activation cutover**: flip enterprise-v2 to default routing; archive legacy `.claude/agents/` → `.claude/agents.legacy/` (AMENDMENT-C) | Zero tier-4 unresolved on main for 14d; cutover complete |

**Activation cutover:** keep enterprise-v2 opt-in through W13. Flip to default in W14 after Phase 0 + 4.5 prove stable for 2 cycles. Legacy archived, not deleted — 30d grace before `rm -rf`.

**Deferred to POST-V1 (tracked):** D10 consumer-driven contract testing (Pact) — open `AUDIT-PACT-001` HIGH finding; revisit W15+ if calibration data shows semantic escapes. Not in v3 scope.

---

## Part G — Open Decisions (require Okan input during rollout)

1. **Activation cutover week**: flip enterprise-v2 to default routing at Week 8 as planned, or wait until registry shows zero tier-4 unresolved for 14 days?
2. **Override authority final model**: keep `@okan` CODEOWNERS gate indefinitely, or relax to `architectural-arbiter` after 90 days of calibration?
3. **Ripple-tracer cost budget**: if AST pass on large diffs exceeds 90s in CI, accept the cost (recommended) or cache per-commit in `.nx/cache` with staleness detection?
4. **SchemaDriftModule mandatory-adoption enforcement**: big-bang (one PR enforces all 16 apps) or shrinking allowlist (each PR removes one entry)?
5. **Banned-phrase scope in docs**: allowlist `docs/adr/**` entirely, or require `// historical-context:` marker to permit banned phrases in rejected-alternative discussions?
6. **Legacy `.claude/agents/` lifecycle**: retire at Week 12, freeze at Week 12, or keep indefinitely as fallback?

These are not blockers for Part A; they surface during Parts D-F execution.

---

## Critical Files (modify)

- `/var/aqua-saas/CLAUDE.md` — Part E restructure
- `/var/aqua-saas/.claude/agents-enterprise-v2/*.md` (22 files) — Part B knowledge + modes
- `/var/aqua-saas/.claude/agents-enterprise-v2/orchestrator.md` — Phase 0 + 4.5 + mode routing
- `/var/aqua-saas/.claude/agents-enterprise-v2/implementation-planner.md` — skill-DAG planning
- `/var/aqua-saas/.eslintrc.json` — new rules (progressive rollout)
- `/var/aqua-saas/.github/workflows/ci-affected.yml` — 5 new jobs
- `/var/aqua-saas/jest.config.js` — invariants project
- `/var/aqua-saas/package.json` — gate scripts
- `/var/aqua-saas/.github/CODEOWNERS` — allowlist ownership

## Critical Files (create)

- `/var/aqua-saas/.claude/skills/` (directory) + 16 skill files + README
- `/var/aqua-saas/.claude/agents-enterprise-v2/ripple-tracer.md`
- `/var/aqua-saas/.claude/agents-enterprise-v2/root-cause-auditor.md`
- `/var/aqua-saas/.claude/gates/rules.yaml`, `mandatory-rules.yaml`
- `/var/aqua-saas/.claude/allowlists/boundary-files.yaml`
- `/var/aqua-saas/.husky/pre-commit`, `.husky/commit-msg`
- `/var/aqua-saas/tools/gates/*.ts` (8 TS files using Node 22 type-stripping)
- `/var/aqua-saas/tests/invariants/adoption-invariants.spec.ts`, `eslint-coverage-invariants.spec.ts`
- `/var/aqua-saas/.github/workflows/finding-state-sweep.yml`, `rule-health-report.yml`
- `/var/aqua-saas/docs/reviews/_audit/`, `_registry/`, `_telemetry/`, `overrides/`

## Reused (do NOT recreate)

- Existing invariant tests: `/var/aqua-saas/e2e/tests/integration/{schema,nats,mutation,event-publishing,data-isolation,schema-provisioning,tenant-suspension,token-lifecycle,permission-propagation}-*.spec.ts` — these are wired into the new `invariants` CI job, not replaced
- Existing SchemaDriftValidator: `/var/aqua-saas/libs/backend-common/src/database/schema-drift-validator.service.ts` — adoption-invariants enforces its use, doesn't replace it
- Existing ESLint custom rules: `.eslintrc.json` no-restricted-syntax block extended, not rewritten
- Existing NATS SSoT: `scripts/nats/generate-nats-conf.py` — referenced by `add-nats-service` skill, not replaced
- Existing test-agents set: `.claude/test-agents/` — unchanged; new gate system is orthogonal to product E2E audits

---

## Verification

**Part A (audit):**
- `docs/reviews/_audit/*.md` exists and enumerates tech+pattern gaps per service
- Coverage matrix for 16 ADRs with enforcement mechanism column

**Part B (agent knowledge):**
- Every `.claude/agents-enterprise-v2/*.md` has "Best-Pattern Knowledge" and "Operating Modes" sections
- Smoke test: invoke `data-expert` in TEACHER mode → returns 3-layer advice + skill pointer, not code
- Smoke test: invoke `data-expert` in WRITER mode → produces code with tier-claim comments

**Part C (skills):**
- `.claude/skills/` has 16 files + README
- Dogfood: run `add-entity-field` skill against a real change → done_definition all green → handoff to data-expert returns CATCHER report clean

**Part D (gates):**
- `npm run gate:pre-commit` on staged diff with banned phrase → exits non-zero with actionable message
- CI: PR with missing ripple file → `ripple-coverage` job fails with list of missed files
- CI: commit without `Closes:` or `no-finding:` → `closes-footer` job fails
- Full orchestrator review cycle including Phase 0 (ripple-tracer) and Phase 4.5 (root-cause-auditor) produces unified report with `## Root-Cause Classification` section
- `npm run findings` CLI: list, transition, sweep commands all functional
- Override lifecycle: add inline override → commit → registry inserts BLOCKED finding with deadline → sweep auto-escalates past deadline

**Part E (CLAUDE.md):**
- `rg "for now|interim|deferred|out of scope"` in CLAUDE.md returns zero matches outside the banned-phrase list itself
- New Agent+Skill+Gate section present; references `.claude/agents-enterprise-v2/`, `.claude/skills/`, `tools/gates/`

**Rollout:**
- Week 10 retrospective: override rate per rule < 5% on mandatory rules; > 50% rules auto-demoted or refined; zero tier-4-unresolved commits on main in last 14 days
