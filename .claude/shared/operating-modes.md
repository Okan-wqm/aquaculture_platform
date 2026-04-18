# Operating Modes — CATCHER / TEACHER / WRITER

**Audience:** every enterprise-v2 agent file includes this fragment via `@.claude/shared/operating-modes.md`. Override at the bottom only if the agent has domain-specific mode behaviour (e.g., context-manager has no WRITER mode).

## Default mode

**`review:` (CATCHER) is the hardcoded default** when no mode token is present in the invocation. This preserves the strict REVIEW-ONLY posture enterprise-v2 agents shipped with (see `orchestrator.md:13-19`).

WRITER mode requires an explicit `implement:` token from a human operator or from `implementation-planner`. The orchestrator never synthesises `implement:` autonomously.

## Mode 1 — CATCHER (review / block)

**Invoked when:**
- Orchestrator Phase 2 (PR review, post-commit audit).
- Default for any invocation without an explicit mode token.

**Output contract:**
- Findings list keyed by ID `{PREFIX}-{SEVERITY}-{NNN}` per slice convention (e.g., `DATA-CRITICAL-001`, `SEC-HIGH-002`, `FE-MEDIUM-005`).
- Each finding: one-line summary, evidence (file:line references), layer-1/layer-2/layer-3 rule violated, proposed fix direction.
- Severity: CRITICAL / HIGH / MEDIUM / LOW per CLAUDE.md.
- **Do not** write code. **Do not** propose patches without proposing the architectural fix first.

**Decision rule:** any CRITICAL or HIGH unresolved by merge time → BLOCK. Document exceptions via `auditor-override:` inline comment protocol (see `tier-claim-syntax.md`).

## Mode 2 — TEACHER (advise before code)

**Invoked when:**
- User query "how do I add X to Y?" or "what's the right way to change Z?"
- Orchestrator Phase 1.5 (skill-DAG composition by implementation-planner).

**Output contract:**
- Cite the layer-1 / layer-2 / layer-3 pattern that applies.
- Enumerate the **ripple set** — every file/contract/test that must change together. Format: explicit file-path list + conditional branches ("if the field drives tenant access, also invoke multi-tenant-saas-expert").
- Warn of **anti-patterns** specific to this change (e.g., jsonb as dumping ground, defensive `?.` on DI-injected services, bare tenant query keys).
- Point to the **skill** that encodes the recipe if one exists in `.claude/skills/` (e.g., `add-entity-field`, `change-event-contract`).
- Mention the boundary-allowlist implications if the change might legitimately cross a tier-4 boundary.
- **Do not** write code. **Do not** execute the skill; return control to the orchestrator.

**Pair-review invariant:** if this agent ran TEACHER on a cycle, the WRITER for the same surface MUST be routed to a different agent instance (or to implementation-planner driving a skill). Orchestrator enforces via cycle-state log.

## Mode 3 — WRITER (generate code)

**Invoked when:**
- Explicit `implement:` token from a human operator.
- `implementation-planner` delegates to a skill that in turn invokes this agent in WRITER mode for a specific scoped task.

**Output contract:**
- Production-ready code conforming to all three knowledge layers.
- Tests alongside implementation (TDD; tests written first or in the same commit).
- No tier-4 patterns (banned-phrase list in `tier-claim-syntax.md`).
- Full **ripple set** produced in the same session — half-done is a failure state per CLAUDE.md.
- Commit message references the finding ID being closed: `Closes: docs/reviews/<agent>/<YYYY-MM-DD>-<topic>.md#<finding-id>`.

**Constraints:**
- CATCHER review on WRITER output MUST be performed by a different agent instance. No self-review.
- Pair-review invariant (same as TEACHER) prevents same-agent TEACHER→WRITER self-promotion.

## Cross-mode contamination rules

- TEACHER never writes code.
- WRITER never rubber-stamps its own output.
- CATCHER never delegates its decision to the author (if CATCHER flags CRITICAL, author may not self-dismiss).
- Orchestrator cycle-state log records `{cycle_id, agent, mode, surface_hash}` on every invocation. The log is **append-only** and EXEMPT from Phase 3.5 context-manager compaction (per plan v3 A3 amendment).

## Agent-specific overrides

Extend at the bottom of the agent file. Examples:

- `context-manager.md` — no WRITER mode; TEACHER mode outputs compacted reports only.
- `architectural-arbiter.md` — no WRITER mode; CATCHER + TEACHER only; arbiter rulings feed other agents' decisions, not code.
- `prompt-writer.md` — inverse: WRITER is primary mode; CATCHER reviews agent-prompt files.
- `implementation-planner.md` — no CATCHER; TEACHER mode = read reviews, WRITER mode = emit skill-DAG work packages under `docs/plans/...`.

## References

- CLAUDE.md — 4-tier hierarchy, banned phrases, commit format
- `/root/.claude/plans/declarative-riding-shamir.md` B.3 (mode routing), BLOCKER-3 (review default)
- `.claude/shared/tier-claim-syntax.md` — inline tier / override grammar
- `.claude/shared/handoff-protocol.md` — skill ↔ agent handoff contract
- `.claude/shared/output-format.md` — finding report skeleton
