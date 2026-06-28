# Knowledge SSoT — `.claude/knowledge/`

Single source of truth for the three-layer knowledge model that every enterprise-v2 agent references. Agents carry judgment; this folder carries the *facts* judgment is applied to.

## Why separate

<!-- cardinality:total-active -->70<!-- /cardinality --> agents (Lane-A runtime + Lane-B combined; excludes <!-- cardinality:lane-a-maintenance -->5<!-- /cardinality --> agents under `.claude/agents/_maintenance/`) need to know NestJS 11 patterns, TypeORM 0.3 DataSource usage, ADR constraints, etc. If every agent inlines these facts, a NestJS 11→12 upgrade becomes a ~70-file fanout — the tier-4 "documentation duplicated everywhere" anti-pattern the agent+skill+gate initiative exists to prevent.

Agents reference this SSoT via include convention:

```markdown
@.claude/knowledge/layer-1-nestjs.md
@.claude/knowledge/layer-2-patterns.md
@.claude/knowledge/layer-3-adrs.md
```

Reference-as-include is a contract between agent files and this directory. `tests/invariants/knowledge-ssot.spec.ts` (planned W8) will fail CI if any agent file inlines content hashable-duplicate with an SSoT section.

## Layer structure (plan v4, per A5 split)

### Layer 1 — Tech-version-specific (what "modern" looks like today)

Split across per-domain shards so `edge-expert` does not load NestJS, `frontend-expert` does not load Tokio:

| File | Audience |
|------|----------|
| `layer-1-core.md` | Every agent — cross-cutting type-system discipline, TS 5.3, Nx 22.3 |
| `layer-1-nestjs.md` | Backend-oriented agents — NestJS 11.1.17, @nestjs/cqrs, guards/pipes/interceptors |
| `layer-1-typeorm.md` | data-expert, database-reviewer, domain experts — TypeORM 0.3.27 DataSource API, migrations |
| `layer-1-timescaledb.md` | sensor-expert, data-expert, observability-expert — TimescaleDB 2.17.2-pg16 hypertables + continuous aggregates + retention |
| `layer-1-react.md` | frontend-expert — React 18.2/18.3.1 mixed, Vite ^5, Module Federation |
| `layer-1-rust.md` | edge-expert — Tokio 1.43, axum 0.8, rustls, thiserror |
| `layer-1-ai.md` | ai-expert, ai-safety-expert, cost-attribution reviewers — Claude Agent SDK 0.2.37 prompt caching + tool use + streaming |

### Layer 2 — Architectural patterns + defect classes

- `layer-2-patterns.md` — CQRS discipline, Outbox, DDD aggregate root, tenant isolation modes, event flat pattern, saga compensation. Applies across every agent.
- `layer-2-defect-catalog.md` — generic real-defect classes (security / bugs / typos / duplication / hygiene) every code-review agent must hunt, each tied to its enforcing eslint rule / gate / invariant (no brittle counts). Domain-specific defects stay in each agent's own invariants section.

### Layer 3 — Repo conventions (ADR-bound)

`layer-3-adrs.md` — one-line summary per canonical ADR (001-016). Every agent reads this so nobody writes advice against a phantom ADR (see BLOCKER-18 — five ADRs were 0-byte files until W1.5).

## Maintenance contract

- Each shard carries an explicit version-anchor line (e.g. `// ANCHOR: NestJS 11.1.17, as of 2026-04-16`) — invariant CI checks this matches `package.json`.
- No agent file may inline layer-1 or layer-3 content. Layer-2 has exceptions for domain-specific elaborations (e.g., farm-expert may cite a farm-specific application of CQRS on top of the generic pattern).
- Updates flow: fact changes (version bump, new ADR) → edit SSoT file → no agent-file edits needed.

## References

- `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-1 (Round-3 consensus) + A5 per-domain split (Round-2 architectural-arbiter)
- `.claude/shared/` — companion shared fragments for operating modes, tier claims, handoff, output format
- `docs/reviews/_audit/2026-04-W16-unified-audit.md` — tech-anchor corrections feeding layer-1 shard content
