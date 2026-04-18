# prompt-writer — CATCHER — 2026-04-18-agent-system-audit

## Scope

End-to-end audit of the multi-agent system on the `agentic` branch. Surfaces:
`.claude/agents/**` (36 Lane-A + 22 Lane-B agent files), `.claude/shared/**` (7
shared fragments), `.claude/knowledge/**` (9 SSoT shards), `.claude/settings.json`,
`tests/invariants/**` (10 invariant specs), `docs/reviews/_registry/findings.jsonl`
(33 entries), `docs/runbooks/**` (target directory for relocations),
`.claude/worktrees/`, `.claude/agents.legacy/`.

**Audit trigger:** user request 2026-04-18 for a ruthless end-to-end quality
review of the agent system, explicitly excluding model/effort uniformity from
the review (`opus + xhigh` is intentional platform policy).

**Method:** Direct file reads, frontmatter extraction, routing-table
cross-reference, invariant-spec source-code inspection, orphan-agent grep,
hash-chain registry tail inspection.

## Summary

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 3 | CLAUDE-CRITICAL-004, 005, 006 |
| HIGH | 8 | CLAUDE-HIGH-005 through 012 |
| MEDIUM | 6 | CLAUDE-MEDIUM-006 through 011 |
| LOW | 5 | CLAUDE-LOW-004 through 008 |
| **Total** | **22** | |

**Deployment decision:** PASS WITH CONDITIONS. No CRITICAL blocks merge, but three
CRITICAL findings must land in the next review cycle (see
`/root/.claude/plans/mutable-frolicking-yao.md` Phases 1-2).

---

## CRITICAL

### CLAUDE-CRITICAL-004 — Duplicate primary on `apps/*/src/gdpr/**`

**Severity:** CRITICAL
**Layer:** 3 (ADR — routing convention)
**State:** OPEN

**Evidence**
- `.claude/shared/orchestrator-routing-table.md:97` — `apps/*/src/gdpr/** (handler implementations) | gdpr-erasure-executor | ...`
- `.claude/shared/orchestrator-routing-table.md:111` — `apps/*/src/gdpr/** | compliance-expert | *respective domain expert*`

**Rule violated**
`tests/invariants/agent-ownership-uniqueness.spec.ts` — Primary ownership uniqueness. CLAUDE.md "Every glob = exactly one primary owner" discipline. Invariant does not cover routing-table rows today (scope gap, see CLAUDE-HIGH-007).

**Proposed fix direction**
- Remove row 111; keep row 97 with `compliance-expert` as also-notify.
- Extend `agent-ownership-uniqueness.spec.ts` to scan the routing table (CLAUDE-HIGH-007).

**Affected surface (ripple set)**
- `.claude/shared/orchestrator-routing-table.md`
- `tests/invariants/agent-ownership-uniqueness.spec.ts`

**Expected closer**
Phase 1 of `/root/.claude/plans/mutable-frolicking-yao.md`.

---

### CLAUDE-CRITICAL-005 — 5 orphan Lane-B agents with no dispatch glob

**Severity:** CRITICAL
**Layer:** 2 (dispatch pattern)
**State:** OPEN

**Evidence**
- `.claude/agents/product-audit/accessibility-auditor.md:1` — agent exists but no glob routes to it.
- `.claude/agents/product-audit/edge-industrial-auditor.md:1` — ditto.
- `.claude/agents/product-audit/billing-reconciliation-auditor.md:1` — ditto.
- `.claude/agents/product-audit/webhook-ingress-auditor.md:1` — ditto.
- `.claude/agents/product-audit/job-queue-auditor.md:1` — ditto.
- Confirmed via `grep` across `.claude/shared/orchestrator-routing-table.md` + `.claude/agents/product-audit/orchestrator.md` Phase 1 table (0 matches).

**Rule violated**
Lane-B orchestrator dispatch contract: every specialist in the runtime roster must be reachable from an auto-dispatch glob. Currently there is NO invariant enforcing this (CLAUDE-HIGH-008 reverse-check gap).

**Proposed fix direction**
- Add Phase 1 table rows in `product-audit/orchestrator.md` for each of the 5 agents (globs specified in plan Phase 1 step 2).
- Extend `orchestrator-routing-coverage.spec.ts` with reverse roster coverage check.

**Affected surface (ripple set)**
- `.claude/agents/product-audit/orchestrator.md`
- `tests/invariants/orchestrator-routing-coverage.spec.ts`

**Expected closer**
Phase 1 of `/root/.claude/plans/mutable-frolicking-yao.md`.

---

### CLAUDE-CRITICAL-006 — Zero `tools:` frontmatter on any agent file

**Severity:** CRITICAL
**Layer:** 1 (Claude Code sub-agent loader frontmatter)
**State:** OPEN

**Evidence**
- `grep -r '^tools:' .claude/agents/` → 0 matches across 58 agent files.
- `.claude/agents/gdpr-erasure-executor.md:3` — description states "WRITER-primary execution agent" yet no tool restriction applied.
- `.claude/agents/security-reviewer.md` — reviewer with identical unrestricted tool access as writer agents.

**Rule violated**
Tier-3 "make-it-detectable" — Claude Code sub-agents support a `tools:` frontmatter; leaving it blank grants every agent (reviewer and writer alike) full Edit/Write/Bash/Agent access. WRITER-vs-READER boundary is prose-only today.

**Proposed fix direction**
- Reviewer agents: `tools: Read, Grep, Glob`.
- Meta-reviewer agents (orchestrator class): `tools: Read, Grep, Glob, Agent`.
- WRITER agents (gdpr-erasure-executor, implementation-planner): `tools: Read, Grep, Glob, Edit, Write, Bash`.
- Maintenance (prompt-writer): `tools: Read, Grep, Glob, Edit, Write`.
- New `agent-frontmatter-schema.spec.ts` — enforces required tools field + token whitelist.

**Affected surface (ripple set)**
- All 58 agent files under `.claude/agents/**`.
- `tests/invariants/agent-frontmatter-schema.spec.ts` (new).

**Expected closer**
Phase 2 of `/root/.claude/plans/mutable-frolicking-yao.md`.

---

## HIGH

### CLAUDE-HIGH-005 — `product-audit/orchestrator.md` 261 lines exceeds ≤200 template

**Evidence**
- `.claude/agents/product-audit/orchestrator.md:1-261` — file length 261 lines.
- `.claude/shared/_conversion-template.md:8` — "Hard size cap: ≤200 lines total".
- `tests/invariants/agent-size-limit.spec.ts:16-21` — Lane-B out of current scope (deferred to "Phase 5 expansion").

**Rule violated**
Canonical agent template ≤200 line cap. Same pattern Lane-A orchestrator already respects via split-into-shared-fragments approach.

**Proposed fix direction**
- Split into main file + `.claude/shared/product-audit-orchestrator-{phases,routing}.md`.

**Expected closer** Phase 3.

---

### CLAUDE-HIGH-006 — `messaging-expert` description overreaches to `apps/ai-service/`

**Evidence**
- `.claude/agents/messaging-expert.md:3` — description claims ownership of `apps/ai-service/`.
- `.claude/shared/orchestrator-routing-table.md:23` — routing table assigns `apps/ai-service/**` primary to `ai-safety-auditor`, messaging-expert as also-notify.

**Rule violated**
Agent-file description must match routing-table primary. Overreach creates false dispatch expectations.

**Proposed fix direction**
- Remove `apps/ai-service/` from messaging-expert description; keep only `apps/messaging-service/`.

**Expected closer** Phase 1.

---

### CLAUDE-HIGH-007 — `agent-ownership-uniqueness.spec.ts` does not scan routing table

**Evidence**
- `tests/invariants/agent-ownership-uniqueness.spec.ts:100-179` — only scans agent files' `## Primary Ownership` sections; no routing-table row scan.
- CLAUDE-CRITICAL-004 was CI-silent as a direct result.

**Rule violated**
Invariant scope gap — ownership-uniqueness must also cover the canonical dispatch surface (the routing table).

**Proposed fix direction**
- Add `describeRoutingTableGlobUniqueness()` block parsing the markdown table and failing on duplicate glob → different primary without handoff tag.

**Expected closer** Phase 2.

---

### CLAUDE-HIGH-008 — `orchestrator-routing-coverage.spec.ts` missing reverse roster check

**Evidence**
- `tests/invariants/orchestrator-routing-coverage.spec.ts:267-290` — forward check only (routed-to agents exist).
- CLAUDE-CRITICAL-005 was CI-silent: 5 roster agents have zero glob coverage.

**Rule violated**
Invariant scope gap — every roster agent must be reachable.

**Proposed fix direction**
- Add `describeReverseRosterCoverage()` block combining Lane-A + Lane-B rosters, subtracting `dispatch: cross-cutting`/`ad-hoc`-tagged agents, asserting every remaining name appears in ≥1 glob cell.

**Expected closer** Phase 2.

---

### CLAUDE-HIGH-009 — `agent-size-limit.spec.ts` excludes Lane-B files

**Evidence**
- `tests/invariants/agent-size-limit.spec.ts:16-21` — spec header marks Lane-B as "Phase 5 expansion: adds once every file has been ported".
- `.claude/agents/product-audit/orchestrator.md:1-261` — violates cap today but CI stays green.

**Rule violated**
Documented Phase-5-expansion promised; still deferred.

**Proposed fix direction**
- Expand glob from `.claude/agents/*.md` to `.claude/agents/{*,product-audit/*}.md`, matching template intent. `_maintenance/` excluded by design.

**Expected closer** Phase 2 + Phase 3 (split lands first, then invariant activates).

---

### CLAUDE-HIGH-010 — Lane-B rename half-done: output paths still `docs/test-audits/`

**Evidence**
- `git log --oneline -1 078daa5d` — commit message "retire test-agents terminology → Lane-B product-audit (Faz 3)".
- `.claude/agents/product-audit/orchestrator.md:34` — writes to `docs/test-audits/orchestrator/...`.
- 19+ other Lane-B agent files reference `docs/test-audits/`.
- `docs/test-audits/contract-parity-auditor/` — subdirectory of a retired agent still on disk.

**Rule violated**
Terminology consistency with agent-directory rename. Tier-1 "make-impossible" would be a filesystem rename.

**Proposed fix direction**
- `git mv docs/test-audits/ docs/product-audits/` + update every literal path reference across 22 Lane-B agents.
- Delete `docs/product-audits/contract-parity-auditor/` subdirectory (retired agent).

**Expected closer** Phase 3.

---

### CLAUDE-HIGH-011 — `INVOCATION-PACK.md` in auto-discovery dispatch surface

**Evidence**
- `.claude/agents/product-audit/INVOCATION-PACK.md` — 345 lines, no frontmatter, lives in agents dispatch directory.
- Claude Code auto-discovers `.claude/agents/**/*.md`; without frontmatter it's silently skipped by the loader but remains a reader-confusion surface.

**Rule violated**
Loader hygiene — agents directory should contain agents only. Runbooks belong under `docs/runbooks/`.

**Proposed fix direction**
- `git mv .claude/agents/product-audit/INVOCATION-PACK.md docs/runbooks/product-audit-invocation.md` + update all `@`-references.

**Expected closer** Phase 3.

---

### CLAUDE-HIGH-012 — Maintenance agents colocated with runtime dispatch

**Evidence**
- `.claude/agents/prompt-writer.md:10` — "Maintenance tooling, NOT a runtime reviewer".
- `.claude/agents/implementation-planner.md:3` — "Invoke only when a human explicitly requests remediation planning after the review is complete; not part of strict runtime review cycles".
- Both files live at `.claude/agents/` root alongside runtime dispatch agents; any orchestrator could dispatch them.

**Rule violated**
Tier-1 "make-impossible" — prose discipline is insufficient. Filesystem separation denies silent dispatch.

**Proposed fix direction**
- Create `.claude/agents/_maintenance/` subdirectory.
- Move `prompt-writer.md`, `implementation-planner.md`, `gdpr-erasure-executor.md` (WRITER-only).
- New `maintenance-isolation.spec.ts` asserts `_maintenance/` names never appear in runtime roster tables or routing-table primary cells.

**Expected closer** Phase 4.

---

## MEDIUM

### CLAUDE-MEDIUM-006 — `.claude/settings.json` lacks PreToolUse Agent gate

**Evidence**
- `.claude/settings.json:1-7` — only `.env` deny rule; no `hooks.PreToolUse` entry.

**Rule violated**
Enterprise dispatch audit contract — every Agent() dispatch should validate against live roster, enforce per-cycle fan-out cap, log to audit trail.

**Proposed fix direction**
- New `tools/gates/agent-dispatch-gate.ts` (TypeScript, Node 22 strip-types).
- Wire via `hooks.PreToolUse[matcher=Agent]`.
- Append rows to `.claude/agents/.dispatch-log.jsonl`.

**Expected closer** Phase 5.

---

### CLAUDE-MEDIUM-007 — `.claude/worktrees/` uncommitted churn

**Evidence**
- `.claude/worktrees/` — 7 orphan agent worktrees (agent-a10d7c5c, …).
- Not in `.gitignore`; visible in `git status --short` with surrounding noise.

**Rule violated**
Repo hygiene — ephemeral session state should not pollute commit surface.

**Proposed fix direction**
- Add `.claude/worktrees/` + `.claude/agents/.dispatch-log.jsonl` to `.gitignore`.
- Physical removal deferred to user decision.

**Expected closer** Phase 4.

---

### CLAUDE-MEDIUM-008 — `agents.legacy/README.md` missing loud warning

**Evidence**
- `.claude/agents.legacy/README.md` — no top-of-file DO-NOT-READ block.
- 20 Lane-A + 4 Lane-B legacy files inside still readable as architectural reference by any agent.

**Rule violated**
Archive discipline — retired content must be visually distinct so future readers do not follow stale rules.

**Proposed fix direction**
- Prepend prominent blockquote header: "**DO NOT READ.** Archive only. Loader does not scan this directory."

**Expected closer** Phase 4.

---

### CLAUDE-MEDIUM-009 — Phase 4.5 root-cause-auditor not mechanically triggered

**Evidence**
- `.claude/shared/orchestrator-phases.md:120-131` — prose states "runs after Phase 4 … on every cycle" but no mechanical trigger.
- No invariant asserts the orchestrator dispatched `root-cause-auditor` when conditions met.

**Rule violated**
Tier-1 invariant coverage — prose-only orchestration silently degrades.

**Proposed fix direction**
- Update orchestrator-phases.md with `MUST dispatch root-cause-auditor when` clause.
- Extend `orchestrator-routing-coverage.spec.ts` with invariant-anchored regex catching prose removal.

**Expected closer** Phase 6.

---

### CLAUDE-MEDIUM-010 — No build-validator agent

**Evidence**
- `.claude/agents/test-runner.md` — covers test files only.
- No agent owns `nx affected --target=build` or `npm run type-check`.
- CLAUDE.md "CRITICAL — Read BEFORE and AFTER every change" mandates these but dispatch is unowned.

**Rule violated**
Cross-cutting quality-gate ownership; dispatch surface gap.

**Proposed fix direction**
- New `.claude/agents/build-validator.md` (Lane-A, cross-cutting, `dispatch: cross-cutting`, `tools: Read, Grep, Glob, Bash`).
- Orchestrator always includes on any commit touching `apps/**`, `libs/**`, `platform/**`, `web/**`.

**Expected closer** Phase 6.

---

### CLAUDE-MEDIUM-011 — `.full-review/` stale state accumulation

**Evidence**
- `.full-review/state.json` + 4 phase-* files on disk; no cycle-reset discipline.
- `context-manager.md:143-150` refers to this file as "authoritative handoff substrate" without stale-detection.

**Rule violated**
State-file hygiene; stale cycle state could misinform next-cycle compaction.

**Proposed fix direction**
- Add `.full-review/` to `.gitignore` (gitcached rm the existing entries individually).
- Document cycle-reset discipline in `.claude/shared/orchestrator-phases.md`.

**Expected closer** Phase 4.

---

## LOW

### CLAUDE-LOW-004 — `tenant-cost-attribution-agent` naming convention drift

**Evidence**
- `.claude/agents/tenant-cost-attribution-agent.md` — only agent file with `-agent` suffix.
- All other agents use `-expert` / `-auditor` / `-reviewer`.

**Proposed fix direction**
- `git mv` → `tenant-cost-attribution-expert.md`; update frontmatter + every reference.

**Expected closer** Phase 7.

---

### CLAUDE-LOW-005 — `mcp-expert` finding-ID prefix example lacks `MCP-`

**Evidence**
- `.claude/agents/mcp-expert.md:81` — example says `CRITICAL-001` bare; other agents use agent-prefix (e.g. `FARM-CRITICAL-001`).

**Proposed fix direction**
- Replace with `MCP-CRITICAL-001`.

**Expected closer** Phase 1.

---

### CLAUDE-LOW-006 — `product-audit/architectural-arbiter.md` filename ≠ frontmatter `name:`

**Evidence**
- File: `.claude/agents/product-audit/architectural-arbiter.md`.
- Frontmatter: `name: product-audit-arbiter`.

**Proposed fix direction**
- `git mv` → `product-audit-arbiter.md`.

**Expected closer** Phase 3.

---

### CLAUDE-LOW-007 — Prose cardinality not marker-wrapped

**Evidence**
- `.claude/shared/orchestrator-phases.md:16` — "19 UI/product specialists" literal.
- `.claude/agents/product-audit/README.md:74` — "22 agents" literal.
- `.claude/README.md` directory map already uses `<!-- cardinality:* -->` marker pattern elsewhere.

**Proposed fix direction**
- Wrap every literal count with cardinality markers; rely on existing `doc-cardinality.spec.ts` for drift protection.

**Expected closer** Phase 4.

---

### CLAUDE-LOW-008 — `three-store-invariants.spec.ts` not cross-referenced

**Evidence**
- `tests/invariants/three-store-invariants.spec.ts` — exists.
- `.claude/README.md:55-65` invariant-gates table — does not list this spec.

**Proposed fix direction**
- Add row to `.claude/README.md` Invariant gates table.

**Expected closer** Phase 7.

---

## Cross-Domain Dependencies

- CLAUDE-CRITICAL-004 ← CLAUDE-HIGH-007 (ownership invariant scope gap is root cause).
- CLAUDE-CRITICAL-005 ← CLAUDE-HIGH-008 (routing-coverage invariant scope gap is root cause).
- CLAUDE-HIGH-005 ← CLAUDE-HIGH-009 (size-limit scope gap is enforcement root cause).
- CLAUDE-HIGH-012 → routing-table + orchestrator.md runtime roster table (file moves require cross-ref update).
- CLAUDE-MEDIUM-009 + CLAUDE-MEDIUM-010 → orchestrator.md Phase 2 dispatch rules (both modify same surface).

## Prior Work Check

No prior `docs/reviews/prompt-writer/` cycles exist (greenfield agent-audit
directory). Three prior `CLAUDE-CRITICAL-*` findings in registry
(`CLAUDE-CRITICAL-001..003`) concern different surfaces (`.claude/agents-enterprise-v2/`
consolidation, pre-2026-04-16 dispatch path). None overlap with this cycle's
findings.

## Finding ID prefix

`CLAUDE-*` per registry schema whitelist
(`docs/reviews/_registry/findings.jsonl.schema.json` prefix pattern). `PROMPT-*`
is documented in `prompt-writer.md:156-158` as prompt-writer's own output prefix
but is absent from the registry regex — a drift between prompt-writer.md and
the schema that is out of scope for this audit cycle (would require either
schema extension or prompt-writer.md correction).
