# Context-Manager Audit: Enterprise-v2 Agent System

**Date:** 2026-04-18
**Cycle ID:** 2026-04-18-enterprise-v2-audit
**Scope:** `.claude/` agent orchestration system — `agents-enterprise-v2/`, `test-agents/`, `agents.legacy/`, `knowledge/`, `skills/`, `allowlists/`, shared templates in `_shared/`
**Agent:** context-manager (meta-review of the agent system itself)
**Finding prefix:** `CLAUDE-*`

## Scope

Live audit of the enterprise-v2 multi-agent review architecture. Inputs:

- `.claude/agents-enterprise-v2/*.md` — 34 agent definitions + 1 deprecated stub + 7 shared fragments + 2 runner wrappers
- `.claude/test-agents/*.md` — 28 Lane-B product auditors + README + INVOCATION-PACK
- `.claude/agents.legacy/*.md` — 20 archived agents
- `.claude/knowledge/layer-{1,2,3}-*.md` — 9 SSoT files
- `.claude/skills/*.md` — 7 procedural cascades
- `.claude/allowlists/boundary-files.yaml`
- `tests/invariants/*.spec.ts` — ran locally, 7 failures observed
- `tools/scripts/orchestrator-runner.ts`, `tools/gates/finding-registry.ts`, `tools/gates/*.ts`

Ground-truth verification via Claude Code official docs (sub-agents priority / discovery rules) + `tools/scripts/orchestrator-runner.ts:261` confirmed name-resolution delegation to `claude-agent` CLI.

## Executive summary

The enterprise-v2 architecture is mature in design (7-phase orchestrator, two-lane dispatch, tier hierarchy, finding-registry, hash-chained append-only state store) but has three classes of gaps between documentation and mechanical enforcement:

1. **Dispatch correctness** — 3 `name:` collisions (`orchestrator`, `context-manager`, `architectural-arbiter` duplicated in Lane-A + Lane-B) produce undefined resolution; `platform-services.md` is marked DEPRECATED but still loadable via its valid `name:` frontmatter.
2. **Invariant health** — 7 CI invariants red on the active branch: 4 in `adoption-invariants` (alert-engine + event-store-service missing SchemaDriftModule registration), 1 in `finding-registry-integrity` (FE-CRITICAL-001 evidence format), 2 in `three-store-invariants` (commit trailer + review-file anchor).
3. **Convention gap between architecture and mechanism** — `@.claude/knowledge/...` references in agent bodies are inert (not auto-imported); skill `handoff:` frontmatter is documented but never declared; Lane-B agents do not follow the shared `_conversion-template.md`; several documented CI gates (200-line cap, skills-catalog, runner smoke) are not landed.

Deployment decision: **PASS WITH CONDITIONS** — the three CRITICAL dispatch-correctness findings are real but contained (the system has been usable because no one has invoked the ambiguous names in production; the runner path masks the issue). All 15 findings tracked in `docs/reviews/_registry/findings.jsonl` with prefix `CLAUDE-*`; reconciliation plan at `/root/.claude/plans/synthetic-dazzling-hippo.md`.

## Deployment decision

**PASS WITH CONDITIONS** — 3 CRITICAL, 4 HIGH, 5 MEDIUM, 3 LOW.

Conditions (must land before the next full review cycle):
- `CLAUDE-CRITICAL-001` — Lane-B agent rename.
- `CLAUDE-CRITICAL-002` — platform-services archival.
- `CLAUDE-CRITICAL-003` — SSoT include convention clarification.
- `CLAUDE-HIGH-002` — 7 red invariant tests green.

No `security-reviewer` BLOCK. No `architectural-arbiter` dispatch required — findings are systemic-mechanical, not cross-agent contradictions.

---

## Critical Findings

### CLAUDE-CRITICAL-001 — Lane-A ↔ Lane-B `name:` collisions produce undefined dispatch

**Severity:** CRITICAL
**Layer:** 3 (ADR — cross-cutting agent-dispatch invariant)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/orchestrator.md:2` — `name: orchestrator` (model: opus)
- `.claude/test-agents/orchestrator.md:2` — `name: orchestrator` (model: codex)
- `.claude/agents-enterprise-v2/context-manager.md:2` — `name: context-manager`
- `.claude/test-agents/context-manager.md:2` — `name: context-manager`
- `.claude/agents-enterprise-v2/architectural-arbiter.md:2` — `name: architectural-arbiter`
- `.claude/test-agents/architectural-arbiter.md:2` — `name: architectural-arbiter`
- `tools/scripts/orchestrator-runner.ts:261` — runner calls `claude-agent run --agent <name>`; name resolution delegated to CLI with no disambiguation.
- `.claude/agents.legacy/README.md:3` — historical incident: "`name:` frontmatter collision with `.claude/agents-enterprise-v2/` caused undefined dispatch behavior" (the same class of bug the legacy archive was created to fix, now re-introduced between Lane-A and Lane-B).

**Rule violated**
`_shared/handoff-protocol.md` Ownership grammar: every agent name globally unique. Sub-agents official docs: "When multiple subagents share the same name, the higher-priority location wins" — unspecified for two paths at the same scope level. `tools/scripts/orchestrator-runner.ts` has no safeguard.

**Proposed fix direction**
- Rename Lane-B duplicates to `product-audit-orchestrator`, `product-audit-context-manager`, `product-audit-arbiter`.
- Update internal refs in `INVOCATION-PACK.md`, `soc2-readiness-auditor.md`, `README.md`.
- Add `tests/invariants/agent-name-uniqueness.spec.ts` to assert globally-unique `name:` across all `.claude/**/*.md`.

**Affected surface (ripple set)**
- `.claude/test-agents/{orchestrator,context-manager,architectural-arbiter}.md`
- `.claude/test-agents/INVOCATION-PACK.md` (7 context-manager refs + 1 orchestrator + 2 arbiter)
- `.claude/test-agents/soc2-readiness-auditor.md:252-253`
- `.claude/test-agents/README.md:74-91`
- `tests/invariants/agent-name-uniqueness.spec.ts` (new)

**Expected closer**
prompt-writer WRITER mode for the rename + Phase 1d of `/root/.claude/plans/synthetic-dazzling-hippo.md` for the invariant.

---

### CLAUDE-CRITICAL-002 — Deprecated `platform-services.md` still has valid `name:` frontmatter, loadable by CLI

**Severity:** CRITICAL
**Layer:** 3 (ADR — agent deprecation enforcement)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/platform-services.md:2` — `name: platform-services` (frontmatter still valid; CLI will load this file on `--agent platform-services`).
- `.claude/agents-enterprise-v2/orchestrator.md:79` — row is strikethrough'd (`~~platform-services~~`) but markdown styling does not prevent the loader from resolving the name.
- `.claude/agents-enterprise-v2/platform-services.md:28` — self-referential warning "Invoking `Agent(platform-services, ...)` is a PROCESS HIGH finding" — documented but not mechanically enforced.

**Rule violated**
CLAUDE.md Architectural Approach — Tier 1 (make impossible) > Tier 4 (doc). Current state is Tier-4 (markdown strikethrough + prose warning); Tier-1 alternative is to make the file unloadable.

**Proposed fix direction**
- Move file to `.claude/agents.legacy/platform-services.md` (loader does not scan legacy).
- Prepend tombstone header with archival date + 30-day deletion window.
- Remove row from `orchestrator.md` runtime roster.
- Translate remaining Turkish paragraph to English in the same commit (see CLAUDE-LOW-003).

**Affected surface (ripple set)**
- `.claude/agents-enterprise-v2/platform-services.md` (delete)
- `.claude/agents.legacy/platform-services.md` (new)
- `.claude/agents-enterprise-v2/orchestrator.md:79` (remove row)

**Expected closer**
prompt-writer WRITER mode for the move + tombstone header.

---

### CLAUDE-CRITICAL-003 — `@.claude/...` references in agent bodies are inert; SSoT include mechanism does not exist

**Severity:** CRITICAL
**Layer:** 3 (ADR — SSoT-include contract between agents and knowledge layer)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/data-expert.md:14-24` — `- @.claude/knowledge/layer-1-core.md` bullet list documented as "Canonical References (DO NOT duplicate content below)".
- Claude Code official docs (sub-agents) make no mention of `@path` auto-import in agent body text. Confirmed via `claude-code-guide` subagent audit.
- `tools/scripts/orchestrator-runner.ts` — no code expands `@.claude/...` lines before dispatch (grep of runner source: no `readFile` call on knowledge paths).
- `.claude/knowledge/README.md:11-15` — documents the include convention but does not mention the runtime mechanism.

**Rule violated**
Documentation claims a runtime behavior that does not exist. Agents relying on SSoT content receive none of it unless they explicitly Read the files during execution.

**Proposed fix direction**
- Documentation-only convention per user directive: rewrite the "Canonical References" section header in every agent file + `_conversion-template.md` to read `## Canonical References (READ via the Read tool before starting)`, making the reader intent explicit.
- Add `.claude/README.md` documenting the dual-path runtime architecture (runner path vs built-in `Agent()` path) so future authors don't re-make the implicit-include assumption.
- Append CLAUDE.md section clarifying that `.claude/agents-enterprise-v2/` is runner-dispatched only.

**Affected surface (ripple set)**
- `.claude/agents-enterprise-v2/*.md` (33 files — section header rewrite)
- `.claude/agents-enterprise-v2/_shared/_conversion-template.md`
- `.claude/README.md` (new)
- `CLAUDE.md` (append section)

**Expected closer**
prompt-writer WRITER mode batch header-edit + new README + CLAUDE.md append.

---

## High Findings

### CLAUDE-HIGH-001 — Skill `handoff:` frontmatter never declared on any skill

**Severity:** HIGH
**Layer:** 3 (ADR — skill ↔ agent handoff contract)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/_shared/handoff-protocol.md:16-23` — specifies `handoff: { on_complete_invoke: [...], on_security_touch: ..., on_event_impact: dynamic, on_multi_tenant_touch: ... }` as MANDATORY skill frontmatter.
- `.claude/skills/add-entity-field.md:1-8` — frontmatter has `name`, `description`, `type: skill`, `version`, `owners` but NO `handoff:` field.
- `.claude/skills/change-event-contract.md:1-8` — same omission.
- `.claude/skills/add-rls-policy.md:1-8` — same.
- `.claude/skills/add-shared-table.md:1-8` — same.
- `.claude/skills/provision-tenant.md:1-8` — same.
- `.claude/skills/pre-migration-restore-test.md:1-8` — same.
- `.claude/skills/run-migration-prod.md:1-8` — same.

**Rule violated**
`_shared/handoff-protocol.md` § "Skill frontmatter `handoff:` field" — every skill file MUST declare it.

**Proposed fix direction**
- Add `handoff:` block to all 7 skills per domain: on_complete_invoke receivers, security/event/multi-tenant touch fields.
- Land `tests/invariants/skills-catalog.spec.ts` asserting presence + referenced agent-names existing.

**Expected closer** prompt-writer WRITER mode batch skill edits + invariant spec.

---

### CLAUDE-HIGH-002 — 7 invariant tests currently red on agentic branch

**Severity:** HIGH
**Layer:** 3 (ADR — CI invariant health)
**State:** OPEN

**Evidence**
- `tests/invariants/adoption-invariants.spec.ts` — 4 failures: `alert-engine` serviceName mismatch (`'alert'` instead of `'alert-engine'`), `event-store-service` missing SchemaDriftModule import + forRoot registration.
- `tests/invariants/finding-registry-integrity.spec.ts` — 1 failure: FE-CRITICAL-001 evidence[0] uses `#FE-CRITICAL-001` anchor instead of `file:line` pattern per schema line 47.
- `tests/invariants/three-store-invariants.spec.ts` — 2 failures: commit 955c8caa missing `Closes: #FE-CRITICAL-001` trailer (pre-strict-trailer era); `docs/reviews/infra-expert/2026-04-17-deploy-debug.md` lacks PROC-MEDIUM-005 anchor.
- `apps/alert-engine/src/app.module.ts:157` — `SchemaDriftModule.forRoot({ serviceName: 'alert' })`.
- `apps/event-store-service/src/app.module.ts` — no SchemaDriftModule import.
- `docs/reviews/_registry/findings.jsonl` — PROC-MEDIUM-005 entry: `layer: 4` (schema allows [1,2,3]); evidence uses GitHub Actions run description; `closing_commits: ["pending"]` violates SHA regex.

**Rule violated**
CLAUDE.md "Run `nx affected --target=test` after changes. Never commit with red tests." Currently the invariants are red — the agentic branch fails this rule.

**Proposed fix direction**
- `apps/alert-engine/src/app.module.ts:157` — change `'alert'` → `'alert-engine'`.
- `apps/event-store-service/src/app.module.ts` — add import + `SchemaDriftModule.forRoot({ serviceName: 'event-store' })` registration.
- Registry repair: FE-CRITICAL-001 evidence[0] → `file:line` form; PROC-MEDIUM-005 remove `layer: 4`, fix evidence format, resolve `"pending"` commit or add to allowlist.
- Append `## PROC-MEDIUM-005` anchor section to `docs/reviews/infra-expert/2026-04-17-deploy-debug.md`.
- Add 955c8caa to `PRE_STRICT_TRAILER_SHAS` in `tests/invariants/three-store-invariants.spec.ts`.

**Expected closer** infra-expert + data-expert WRITER mode for the code + registry fixes.

---

### CLAUDE-HIGH-003 — Phase 4.5 fallback path described alongside live-registry path creates ambiguous state

**Severity:** HIGH
**Layer:** 3 (ADR — orchestrator contract determinism)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/_shared/orchestrator-phases.md:130` — "Fallback behaviour (when gate / registry infrastructure is not yet live in a branch): auditor emits observations as a report ... with `AUDIT-*` finding IDs; orchestrator Phase 5 incorporates the section as any other agent's output."
- `tools/gates/finding-registry.ts` — CLI is landed and functional.
- `docs/reviews/_registry/findings.jsonl` exists with 30+ entries.

**Rule violated**
Two parallel paths for the same phase produce non-deterministic cycle output.

**Proposed fix direction**
Remove fallback paragraph; registry is a hard dependency.

**Expected closer** prompt-writer WRITER mode for `_shared/orchestrator-phases.md` edit.

---

### CLAUDE-HIGH-004 — Lane-B agents do not follow the shared conversion template; zero of 28 carry Canonical References section

**Severity:** HIGH
**Layer:** 3 (ADR — SSoT discipline propagation)
**State:** OPEN

**Evidence**
- `.claude/agents-enterprise-v2/_shared/_conversion-template.md:18-32` — mandatory structure.
- `grep -L "^## Canonical References" .claude/test-agents/*.md` — all 28 Lane-B files lack the section.
- `.claude/knowledge/README.md:7` — "22 agents need to know NestJS 11 patterns, TypeORM 0.3 DataSource usage, ADR constraints, etc. If every agent inlines these facts, a NestJS 11→12 upgrade becomes a 22-file fanout — the tier-4 'documentation duplicated everywhere' anti-pattern the agent+skill+gate initiative exists to prevent."

**Rule violated**
`_conversion-template.md` conversion rules #1 (≤200 lines) and #2-4 (no layer-1/2/3 duplication). Lane-B inlines its own tech/pattern context despite the SSoT existing.

**Proposed fix direction**
- Port 24 active Lane-B files to Canonical References + Primary Ownership + Domain-specific invariants + Operating Modes + Finding ID prefix.
- 4 deprecated files (gdpr-compliance, soc2-readiness, ai-tool-execution, contract-parity) get DEPRECATED header only.
- Hard-cap 200 lines (enforced by CLAUDE-MEDIUM-003's new gate).

**Expected closer** prompt-writer WRITER mode batch port (Phase 5 of plan).

---

## Medium Findings

### CLAUDE-MEDIUM-001 — `npm run audit:gdpr` / `audit:perf` runner smoke test absent

**Severity:** MEDIUM | **Layer:** 3 | **State:** OPEN

**Evidence:** `.claude/agents-enterprise-v2/runners/{gdpr-audit,perf-audit}.ts:53-56` invoke `ts-node tools/scripts/orchestrator-runner.ts`; no CI spec asserts these paths execute without error.

**Fix:** Add `tests/invariants/runner-smoke.spec.ts` + `--dry-run` flag in `tools/scripts/orchestrator-runner.ts`.

### CLAUDE-MEDIUM-002 — Skills deprecation wiring undefined

**Severity:** MEDIUM | **Layer:** 3 | **State:** OPEN

**Evidence:** `.claude/skills/README.md:90-91` specifies `status: deprecated` + `superseded_by:` frontmatter; no skill currently uses this; no invariant asserts the convention.

**Fix:** Land `tests/invariants/skills-catalog.spec.ts` per `.claude/skills/README.md:107-111` validation list.

### CLAUDE-MEDIUM-003 — 200-line conversion-template cap lacks CI gate

**Severity:** MEDIUM | **Layer:** 3 | **State:** OPEN

**Evidence:** `.claude/agents-enterprise-v2/_shared/_conversion-template.md:72` — "Hard size cap: ≤200 lines total". Current max in enterprise-v2 is 197 (`frontend-expert.md`); in Lane-B is 271 (`soc2-readiness-auditor.md`) — already over cap.

**Fix:** Add `tests/invariants/agent-size-limit.spec.ts` for both dirs.

### CLAUDE-MEDIUM-004 — `layer-1-ai.md` SDK version-anchor not verified against `package.json`

**Severity:** MEDIUM | **Layer:** 1 | **State:** OPEN

**Evidence:** `.claude/knowledge/layer-1-ai.md` declares "Claude Agent SDK 0.2.37 anchor"; `knowledge-ssot.spec.ts` tests 4 other anchors but not this one.

**Fix:** Extend `knowledge-ssot.spec.ts` with layer-1-ai describe block.

### CLAUDE-MEDIUM-005 — `.claude/allowlists/boundary-files.yaml` entries with `expires: never` have no ADR-reference invariant

**Severity:** MEDIUM | **Layer:** 3 | **State:** OPEN

**Evidence:** `_shared/tier-claim-syntax.md:99` — "Entries with `expires: never` bypass the override-per-commit requirement. The allowlist is CODEOWNERS-gated (BLOCKER-9) so a PR cannot add an entry without @okan review." Machine gate is CODEOWNERS-only; no invariant asserts an ADR reference in `reason`/`notes`.

**Fix:** Add `tests/invariants/boundary-allowlist-invariants.spec.ts`.

---

## Low Findings

### CLAUDE-LOW-001 — No test asserts `.claude/agents.legacy/` is excluded from loader

**Severity:** LOW | **Layer:** 3 | **State:** OPEN

**Fix:** Covered by CLAUDE-CRITICAL-001's new `agent-name-uniqueness.spec.ts` which walks the whole `.claude/` tree including `agents.legacy/`.

### CLAUDE-LOW-002 — `add-entity-field.md:19` cites non-existent `create-entity` skill

**Severity:** LOW | **Layer:** 4 | **State:** OPEN

**Evidence:** `.claude/skills/add-entity-field.md:19` — "this skill does NOT create new entities (use `create-entity` skill for that)"; no `create-entity.md` exists in `.claude/skills/`.

**Fix:** Remove the reference (this skill assumes the entity exists).

### CLAUDE-LOW-003 — `platform-services.md` contains Turkish prose inside an English corpus

**Severity:** LOW | **Layer:** 4 | **State:** OPEN

**Evidence:** `.claude/agents-enterprise-v2/platform-services.md:12` — Turkish paragraph; rest of corpus English.

**Fix:** Translate during Phase 1c archival.

---

## Cross-Domain Dependencies

| From | To | Issue | Status |
|---|---|---|---|
| CLAUDE-CRITICAL-001 | Phase 5 Lane-B port | Renames must land before port touches the same files | Sequenced: Phase 1 before Phase 5 |
| CLAUDE-CRITICAL-002 | Phase 1d invariant | Invariant's name-uniqueness check must tolerate `agents.legacy/platform-services.md` | Handled: walk excludes the legacy duplicate list from clash rules |
| CLAUDE-HIGH-002 (PROC-MEDIUM-005) | infra-expert | Review file anchor + registry repair | Assigned to infra-expert in Phase 2b |

No contradictory recommendations; no `architectural-arbiter` dispatch required.

## Systemic Issues

- **SYS-1: Documentation promises mechanisms that don't exist.** `@`-includes, `handoff:` frontmatter, Phase 4.5 fallback, 200-line cap, skills-catalog spec — all documented as if enforced; none mechanically gated on the current branch. Reconciliation plan lands the gates for each.
- **SYS-2: Name-uniqueness is treated as a convention, not a mechanical invariant.** The 2026-04-16 legacy-archive incident was caused by the same class of bug that recurs here. Adding the `agent-name-uniqueness.spec.ts` invariant (Phase 1d) is Tier-3 defense-in-depth so the bug class cannot recur.

## References

- Reconciliation plan: `/root/.claude/plans/synthetic-dazzling-hippo.md`
- Claude Code sub-agents docs: https://code.claude.com/docs/en/sub-agents.md (confirmed via `claude-code-guide` subagent: flat `.claude/agents/` only; subdirectory discovery unsupported; `@` imports apply to CLAUDE.md only).
- `.claude/agents-enterprise-v2/_shared/{handoff-protocol,operating-modes,orchestrator-phases,orchestrator-routing-table,output-format,tier-claim-syntax,_conversion-template}.md` — authoritative contracts.
- `.claude/knowledge/README.md` — SSoT layer discipline.
- Existing registry entries: `docs/reviews/_registry/findings.jsonl`.

## Verdict

**PASS WITH CONDITIONS.** All 15 findings tracked in the finding-registry with `CLAUDE-*` prefix + state `OPEN`. Reconciliation executes through 16 atomic commits per the plan; each commit carries the appropriate `Closes:` trailer.
