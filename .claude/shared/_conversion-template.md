# Agent File Conversion Template (W3)

**Purpose:** uniform structure every enterprise-v2 agent MUST follow after the W3 conversion pass. Consumed by `prompt-writer` invocations; not included at runtime.

## Mandatory structure

```markdown
---
name: <agent-id>
description: <one-line: when orchestrator invokes this agent>
model: opus
effort: xhigh
---

# <Agent Title>

<2-3 sentence mission statement describing this agent's CATCHER scope.>

## Canonical References (READ via the Read tool before starting)

Cross-cutting knowledge lives in SSoT files. The `@` prefix on each line below is
a READER BOOKMARK — Claude Code does NOT auto-import agent body content (only
`CLAUDE.md` honors `@`-includes). At the start of every invocation, use the Read
tool to load each file listed here. See `.claude/README.md` § Runtime invocation
paths for the full dispatch model.

- @.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)
- @.claude/knowledge/layer-1-<tech>.md             (domain-specific: nestjs|typeorm|react|rust)
- @.claude/knowledge/layer-2-patterns.md          (CQRS/Outbox/DDD/tenant patterns)
- @.claude/knowledge/layer-3-adrs.md              (16 canonical ADRs)
- @.claude/shared/operating-modes.md
- @.claude/shared/tier-claim-syntax.md
- @.claude/shared/handoff-protocol.md
- @.claude/shared/output-format.md

## Primary Ownership

<Exact file globs this agent owns — copy from orchestrator routing table.>

## Domain-specific invariants (beyond SSoT)

<1-5 rules UNIQUE to this agent's domain. Do NOT duplicate anything in
layer-1/layer-2/layer-3 SSoT. Write each important rule in this teaching shape:
Rule / Why this exists / Protected invariant / Consequence if ignored.
Examples:
- farm-expert: batch lifecycle state machine rules
- sensor-expert: Modbus-TCP register mapping discipline
- data-expert: upcaster chain integrity requirements
>

## Active findings this agent owns

<Point to docs/reviews/<agent>/ for historical cycles. List any
currently-OPEN findings that inform this agent's ongoing priorities.>

## Operating Modes

See `@.claude/shared/operating-modes.md` for the
full CATCHER / TEACHER / WRITER contract. Agent-specific overrides:

<Any deviations from default: e.g., "WRITER mode is not supported for
this agent" or "TEACHER mode outputs include a <specific> section".>

## Finding ID prefix

`<PREFIX>-{SEVERITY}-{NNN}` — e.g., `DATA-CRITICAL-001`. See
`@.claude/shared/output-format.md` for the
full format.

## References

<Specific docs/reviews/, specific ADRs this agent cites most often.>
```

## Conversion rules (for prompt-writer)

1. **Hard size cap: ≤200 lines total** (including frontmatter + blank lines). Why: prompt size is the forcing function for SSoT discipline. Protected invariant: agents reference shared knowledge instead of copying it. Consequence if ignored: prompts drift independently and future agents apply stale rules.
2. **DO NOT inline layer-1 content.** If the source file currently contains "NestJS 11 guard order" or "TypeORM DataSource API usage" — delete it; the SSoT has it. Reference via @-include. Why: framework facts change in one place. Protected invariant: layer-1 files are the technology authority. Consequence if ignored: two prompts can disagree about the same framework behavior.
3. **DO NOT inline layer-3 ADR summaries.** The ADR index is in `layer-3-adrs.md`; agents reference by number. Why: ADR status and scope can change. Protected invariant: filenames/status in the ADR layer are authoritative. Consequence if ignored: an agent can enforce a superseded architectural decision.
4. **PRESERVE unique domain rules.** Anything that's NOT in the SSoT but is an invariant specific to this agent's domain MUST stay. Example: farm-expert's "batch lifecycle: Active → Feeding → Harvesting → Harvested" is domain-specific. Why: conversion must compress, not erase expertise. Protected invariant: domain-specific failure modes remain visible. Consequence if ignored: the prompt becomes generic and misses the exact bugs the specialist exists to catch.
5. **PRESERVE specific ownership globs** from the orchestrator routing table. Why: routing and prompt ownership must agree. Protected invariant: every file has one primary owner. Consequence if ignored: two agents can claim the same surface or no agent catches it.
6. **PRESERVE existing historical review references** under `docs/reviews/<agent>/` — those are the agent's memory. Why: repeat findings escalate and precedent matters. Protected invariant: prior-cycle learning survives prompt rewrites. Consequence if ignored: the same defect reappears as "new" and systemic patterns are lost.
7. **PRESERVE frontmatter verbatim** — do not alter name/description/model/effort unless the requested change explicitly targets routing metadata. Why: frontmatter is loader configuration, not prose. Protected invariant: Agent() dispatch remains deterministic. Consequence if ignored: a prompt rewrite can silently rename, de-scope, or de-power an agent.
8. **Explain required/prohibited actions causally.** Important "MUST", "MUST NOT", "FORBIDDEN", and "Do not" rules should include the invariant being protected and what breaks if ignored. Why: agents follow causal constraints more reliably than bare commands. Protected invariant: prompt rules remain reviewable and teachable. Consequence if ignored: agents rationalize around unexplained commands and recreate the failure mode the rule was meant to prevent.

## Validation after conversion

- Line count ≤ 200 (hard rule)
- Frontmatter unchanged
- Has `## Canonical References` section with ALL @-includes listed above
- Has `## Domain-specific invariants` section (may be brief but must exist)
- Has `## Operating Modes` section referencing .claude/shared/
- Has `## Finding ID prefix` section
- Zero inline duplication with `.claude/knowledge/layer-*.md` or `.claude/shared/*.md`
- No bare do/don't bullets for behavior-critical rules without rationale, protected invariant, and failure consequence
