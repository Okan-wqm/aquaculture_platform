# Output Format — Finding Report Skeleton

**Audience:** every enterprise-v2 agent emitting CATCHER findings. Consumed by `context-manager` during Phase 3.5 compaction, by `architectural-arbiter` during Phase 4 conflict resolution, and by `finding-registry.ts` CLI (W10).

## Finding ID format

`{AGENT-PREFIX}-{SEVERITY}-{NNN}` where:
- `AGENT-PREFIX` — short namespace per agent domain, set on the agent file itself:
  - `DATA-*` — data-expert (event contracts, migrations, TypeORM, outbox)
  - `SEC-*` — auth-security-expert
  - `GSEC-*` — security-reviewer global security gate
  - `TEST-*` — test-runner
  - `ARCH-*` — architectural-arbiter
  - `PRODUCT-{AGENT-PREFIX}-*` — Lane-B product-audit agents
  - `DB-{AREA}-*` — Lane-D db-audit agents; AREA ∈ FARMPROD | FARMOPS | FARMPLAT | SENSOR | ADMIN | IDENT | PEOPLE | INFRA (one per partition auditor under `.claude/agents/db-audit/`)
  - `PLAT-*` — platform-kernel-expert only; retired platform service aliases are invalid
  - `BILLING-*` — billing-expert
  - `ALERT-*` — alert-engine-expert
  - `OBS-*` — observability-expert
  - `MSG-*` — messaging-expert
  - `FE-*` — frontend-expert
  - `EDGE-*` — edge-expert
  - `MT-*` — multi-tenant-saas-expert
  - `FARM-*`, `SENSOR-*`, `HR-*`, `ADMIN-*` — respective domain experts
  - `ANTI-*` — anti-pattern scan (general-purpose repo-wide cycles)
  - `ADR-*` — ADR drift matrix entries
  - `AUDIT-*` — root-cause-auditor (active 2026-04-16, Phase 5 of abstract-brewing-mochi plan). Sub-kinds: `OVER_CLAIMED`, `RULING_PARTIAL_APPLICATION`, `RULING_MISSED_DEADLINE`, `OVERRIDE_UNSUPPORTED`, `BOUNDARY_EXPIRED`, `BANNED_PHRASE_IN_CLAIM`.
  - `CTX-*` — context-manager meta-findings (over-claimed tiers, systemic patterns)
- `SEVERITY` — CRITICAL / HIGH / MEDIUM / LOW per CLAUDE.md.
- `NNN` — zero-padded sequential within the agent's cycle output (001, 002, …).

Example: `DATA-CRITICAL-001`, `SEC-HIGH-004`, `EDGE-CRITICAL-001`.

## Per-finding structure

Each finding carries all of:

```markdown
### {FINDING-ID} — {one-line title}

**Severity:** CRITICAL | HIGH | MEDIUM | LOW
**Layer:** 1 (tech) | 2 (pattern) | 3 (ADR) — which layer's rule was violated
**State:** OPEN (newly raised) | IN-PROGRESS (in an implementation-planner package) | RESOLVED (closed by commit)

**Evidence**
- `<path>:<line>` — short excerpt or description
- `<path>:<line>` — additional citation if relevant

**Rule violated**
<Name the rule: ESLint rule ID, ADR number + title, CLAUDE.md section, layer-1/2/3 knowledge entry.>

**Proposed fix direction**
<1-3 bullets. Architectural approach — do not write code in a CATCHER report.
Prefer highest tier reachable: prefer Tier-1 make-impossible over Tier-3 make-detectable.>

**Affected surface (ripple set)**
- <file paths that must change together>

**Expected closer**
<Which skill or which agent's WRITER mode should close this. E.g., "add-entity-field skill"
or "data-expert WRITER mode if no skill matches".>
```

## Per-cycle report structure

```markdown
# {Agent name} — {mode} — {cycle-id or date}

## Scope
<One paragraph: what files were reviewed, what change triggered the invocation.>

## Executive summary
<= 200 words. Top 3 findings, overall verdict.>

## Pattern usage table (if CATCHER against a discovery audit or onboarding task)
<Only for audit-style invocations. Normal CATCHER reviews skip this.>

## Findings (by severity)

### CRITICAL
- <per-finding blocks>

### HIGH
- <per-finding blocks>

### MEDIUM
- <per-finding blocks>

### LOW
- <per-finding blocks>

## Cross-domain dependencies flagged
<Findings or concerns that require another agent's review. Format:
"Finding <ID>: recommend also invoking <agent-name> because <reason>".>

## Verdict
PASS | CONDITIONAL (with listed conditions) | BLOCK

## References
- Layer-1/2/3 knowledge cites
- ADR cites
- Prior cycle findings this one supersedes (if any)
```

## Conciseness discipline

- Executive summary ≤ 200 words.
- Each finding's "Proposed fix direction" ≤ 3 bullets.
- Evidence citations use file:line format; never paste > 10 lines of code.
- Tables preferred over prose for pattern-usage and reconciliation.
- Cross-references to shared knowledge (layer-*.md, ADR) by reference, not by re-quoting.

## When to escalate severity vs new finding

- Same issue worsens between cycles → escalate severity (+1), keep same ID.
- Different issue on same surface → new ID.
- Rule interpretation disagreement with another agent → mark CONDITIONAL + flag for `architectural-arbiter` (Phase 4).

## Compaction-safe properties

`context-manager` compacts reports in Phase 3.5 when 3+ agents dispatched OR > ~50K tokens total. To survive compaction:

- Finding IDs are preserved verbatim.
- Severity is preserved verbatim.
- Evidence citations (file:line) are preserved.
- Executive summary may be compacted.
- Cross-domain dependencies are preserved (they drive Phase 4 routing).

The cycle-state log (`append-only, exempt from compaction` per plan v3 A3) carries the invocation metadata; do not embed it in finding text.

## References

- CLAUDE.md — commit format + finding ID references (`Closes:` trailer)
- `.claude/shared/operating-modes.md` — mode semantics
- `.claude/shared/tier-claim-syntax.md` — tier vocabulary
- `/root/.claude/plans/declarative-riding-shamir.md` D.6 (finding registry schema)
- `docs/reviews/_registry/findings.jsonl` (W10) — persistent state store
