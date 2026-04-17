# Handoff Protocol — Skill ↔ Agent Contract

**Audience:** every enterprise-v2 agent. Also consumed by the (W5) skills catalog authors and `implementation-planner` composing skill-DAG work packages.

## Why handoff matters

Agents carry judgment; skills carry procedure (see `.claude/skills/README.md`, W5). They interact through a defined contract so that:

- A skill's cascade completes before control returns (no half-done state).
- The appropriate reviewer agent runs CATCHER after each skill, closing the loop.
- Cross-domain changes engage every relevant agent, not just the primary owner.

## Skill frontmatter `handoff:` field

Every skill file under `.claude/skills/*.md` declares:

```yaml
handoff:
  on_complete_invoke: [<agent-name>, ...]     # CATCHER review
  on_security_touch: <agent-name>             # extra reviewer if security surface
  on_event_impact: dynamic                    # ripple-tracer enumerates consumers
  on_multi_tenant_touch: multi-tenant-saas-expert
```

The skill is **not done** until every `on_complete_invoke` agent returns a clean CATCHER report. Partial skill completion is a failure state.

## Agent-side handoff contract

### Receiving a handoff (CATCHER invocation after skill)

Agents are invoked via the orchestrator with:

```
Mode: review
Scope: <files changed by the skill>
Upstream: <skill name> completed in cycle <N>
Ripple set: <path to ripple-set.json from Phase 0 tracer>
```

Agent's job:
1. Read the diff (skill-produced) + ripple-set.
2. Run through layer-1 / layer-2 / layer-3 knowledge for the changed surface.
3. Emit findings per `output-format.md`.
4. Return PASS / CONDITIONAL / BLOCK.

### Emitting a handoff (TEACHER recommending a skill)

When an agent in TEACHER mode recognises the change matches a catalogued skill:

```
Recommendation: invoke skill `add-entity-field`
  Rationale: the requested change (add `priority` column to `batch.entity.ts`) matches
             the skill's trigger keywords AND the ripple set (entity + migration +
             DTO + fixtures + test + event upcaster if persisted) aligns with its
             declared cascade.
  Required pre-conditions: none
  Expected on-complete handoff: data-expert + database-reviewer (CATCHER)
```

The orchestrator routes to `implementation-planner`, which composes the skill DAG.

### Pair-review invariant

If agent-X ran TEACHER in cycle N, the WRITER for the same surface in cycle N (or the skill invocation for the same surface) MUST NOT be routed back to agent-X. Orchestrator enforces via cycle-state log (`{cycle_id, agent, mode, surface_hash}`).

Rationale: an agent cannot rubber-stamp its own recommendation. TEACHER → skill/implementation-planner → (different agent) CATCHER is the correct chain.

## Ownership grammar — primary / secondary / delegated

Every path has exactly ONE primary owner (enforced by `tests/invariants/agent-ownership-uniqueness.spec.ts`, Phase 4). Other agents may claim the path under two reduced-scope roles:

- **primary** — CATCHER dispatched here first; this agent's verdict is load-bearing; other owners are consulted only if flagged.
- **secondary reviewer** — invoked in parallel with primary when the path touches a narrow concern this agent catches better (e.g., `messaging-expert` on `platform/libs/outbox/**` for consumer-side regressions; primary remains data-expert for kernel).
- **delegated** — this agent reviews ONLY a named slice (e.g., multi-tenant-saas-expert on `libs/backend-common/src/database/tenant-*` reviews the tenant-contract slice; all other database concerns route back to data-expert).

Agent files MUST tag non-primary entries in their Primary Ownership section using the words `secondary reviewer` or `delegated from <agent>`. Untagged overlapping claims are a PROCESS HIGH ownership conflict.

## Cross-domain handoff rules

Certain surfaces trigger multiple agents:

| Surface touched | Primary owner | Also notify |
|------------------|----------------|--------------|
| `libs/event-contracts/**` | data-expert | ALL agents whose services consume the changed events (via ripple-tracer services.yaml parse) |
| `apps/*/src/**/entities/*.entity.ts` | respective domain expert | database-reviewer |
| Any path matching tenant middleware / guards / scoped-repo | multi-tenant-saas-expert | primary domain expert + auth-security-expert |
| Any security-sensitive file (auth, JWT, guards, rate limit) | auth-security-expert | security-reviewer |
| `libs/backend-common/src/auth/**` / `security/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/database/**` | data-expert | multi-tenant-saas-expert (tenant slice only) |
| `libs/backend-common/src/redis/**` | auth-security-expert | multi-tenant-saas-expert (tenant slice only) |
| `platform/libs/outbox/**` | data-expert | messaging-expert (consumer-side) |
| `platform/libs/**` (cqrs, event-bus) | platform-kernel-expert | depends on sub-module |
| `sens-api-gateway/**` | edge-expert | security-reviewer |
| 3+ distinct domains in one PR | orchestrator invokes security-reviewer as cross-cutting gate | ALL implicated domain experts |

## Invocation format (orchestrator → agent)

```
Agent(<name>, mode=review|plan|implement): {
  scope: [<file-paths>],
  context: <brief: what changed, ripple-set pointer, any arbiter ruling from prior cycle>,
  upstream: <cycle N−1 findings still open that this change must close>,
  pair_review_exclude: [<agent-names to not route WRITER here — pair-review invariant>]
}
```

## Skill invocation from the agent side

Agents in TEACHER mode never invoke skills directly — they recommend. The orchestrator (via `implementation-planner`) composes the skill DAG. This preserves the single entry-point discipline:

- Human → orchestrator → implementation-planner → skill → (agent CATCHER) → orchestrator → human.

Inversion (agent → skill) would break the cycle-state log and the pair-review invariant.

## Exceptions for non-review agents

- `context-manager` — invoked by orchestrator in Phase 3.5 for report compaction. Does not receive `handoff.on_complete_invoke` invocations.
- `architectural-arbiter` — invoked when agents conflict. Rulings feed back through the orchestrator; no skill handoffs.
- `prompt-writer` — maintenance agent for `.claude/agents-enterprise-v2/` and `.claude/skills/` content. Not in the runtime review roster (per `orchestrator.md:13-19` strict review-only policy).
- `implementation-planner` — composes skill-DAGs; does not run CATCHER. Handoffs FROM planner TO skill, not the other direction.

## References

- `.claude/skills/README.md` (W5) — skill file format + handoff field spec
- `.claude/agents-enterprise-v2/orchestrator.md` — routing table + phase flow
- `.claude/agents-enterprise-v2/_shared/operating-modes.md` — mode-switching rules including pair-review invariant
- `/root/.claude/plans/declarative-riding-shamir.md` C.3 (skill-agent integration)
