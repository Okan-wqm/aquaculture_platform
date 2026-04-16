# Agent File Conversion Template (W3)

**Purpose:** uniform structure every enterprise-v2 agent MUST follow after the W3 conversion pass. Consumed by `prompt-writer` invocations; not included at runtime.

## Mandatory structure

```markdown
---
name: <agent-id>
description: <one-line: when orchestrator invokes this agent>
model: opus|codex
effort: max|xmax
---

# <Agent Title>

<2-3 sentence mission statement describing this agent's CATCHER scope.>

## Canonical References (DO NOT duplicate content below)

Cross-cutting knowledge lives in SSoT files. This agent consumes:

- @.claude/knowledge/layer-1-core.md              (TS + Nx + Jest base)
- @.claude/knowledge/layer-1-<tech>.md             (domain-specific: nestjs|typeorm|react|rust)
- @.claude/knowledge/layer-2-patterns.md          (CQRS/Outbox/DDD/tenant patterns)
- @.claude/knowledge/layer-3-adrs.md              (16 canonical ADRs)
- @.claude/agents-enterprise-v2/_shared/operating-modes.md
- @.claude/agents-enterprise-v2/_shared/tier-claim-syntax.md
- @.claude/agents-enterprise-v2/_shared/handoff-protocol.md
- @.claude/agents-enterprise-v2/_shared/output-format.md

## Primary Ownership

<Exact file globs this agent owns — copy from orchestrator routing table.>

## Domain-specific invariants (beyond SSoT)

<1-5 rules UNIQUE to this agent's domain. Do NOT duplicate anything in
layer-1/layer-2/layer-3 SSoT. Examples:
- farm-expert: batch lifecycle state machine rules
- sensor-expert: Modbus-TCP register mapping discipline
- data-expert: upcaster chain integrity requirements
>

## Active findings this agent owns

<Point to docs/reviews/<agent>/ for historical cycles. List any
currently-OPEN findings that inform this agent's ongoing priorities.>

## Operating Modes

See `@.claude/agents-enterprise-v2/_shared/operating-modes.md` for the
full CATCHER / TEACHER / WRITER contract. Agent-specific overrides:

<Any deviations from default: e.g., "WRITER mode is not supported for
this agent" or "TEACHER mode outputs include a <specific> section".>

## Finding ID prefix

`<PREFIX>-{SEVERITY}-{NNN}` — e.g., `DATA-CRITICAL-001`. See
`@.claude/agents-enterprise-v2/_shared/output-format.md` for the
full format.

## References

<Specific docs/reviews/, specific ADRs this agent cites most often.>
```

## Conversion rules (for prompt-writer)

1. **Hard size cap: ≤200 lines total** (including frontmatter + blank lines).
2. **DO NOT inline layer-1 content.** If the source file currently contains "NestJS 11 guard order" or "TypeORM DataSource API usage" — delete it; the SSoT has it. Reference via @-include.
3. **DO NOT inline layer-3 ADR summaries.** The ADR index is in `layer-3-adrs.md`; agents reference by number.
4. **PRESERVE unique domain rules.** Anything that's NOT in the SSoT but is an invariant specific to this agent's domain MUST stay. Example: farm-expert's "batch lifecycle: Active → Feeding → Harvesting → Harvested" is domain-specific.
5. **PRESERVE specific ownership globs** from the orchestrator routing table.
6. **PRESERVE existing historical review references** under `docs/reviews/<agent>/` — those are the agent's memory.
7. **PRESERVE frontmatter verbatim** — do not alter name/description/model/effort.

## Validation after conversion

- Line count ≤ 200 (hard rule)
- Frontmatter unchanged
- Has `## Canonical References` section with ALL @-includes listed above
- Has `## Domain-specific invariants` section (may be brief but must exist)
- Has `## Operating Modes` section referencing _shared/
- Has `## Finding ID prefix` section
- Zero inline duplication with `.claude/knowledge/layer-*.md` or `_shared/*.md`
