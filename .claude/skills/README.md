# Skills Catalog — Procedural How-To Cascades

> **Status: REFERENCE-ONLY (2026-04-18).** These skills are architectural
> playbooks — canonical recipes for cross-cutting tasks — not automatically-
> invoked pipelines. A human reviewer (or a Claude Code `Agent()` dispatch)
> consults a skill when executing the cascade; there is no
> `implementation-planner` auto-dispatch. Every skill carries
> `status: reference-only` in its frontmatter. When a mechanical pipeline
> lands later, individual skills flip to `status: active`.

**Audience:** `implementation-planner` consults these files when generating package cascades for cross-cutting architectural tasks. Domain agents reference skill IDs in their Domain-specific invariants when recommending a multi-step fix.

**Phase 3 of** `docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-3`. Landed end-of-day 2026-04-17.

## What a skill IS

A skill is the canonical, reproducible, end-to-end cascade for a cross-cutting architectural task that touches ≥3 files across ≥2 bounded contexts. When a reviewer finds a gap ("add priority field to Batch") the review does not spell out every file — it cites the skill and the skill enumerates the cascade.

Skills are READ by `implementation-planner` + `WRITER`-mode agents; they are WRITTEN only by `prompt-writer` + `architectural-arbiter` (the latter for BLOCKER-class skills with ADR gates).

## What a skill IS NOT

- NOT an agent (no `model:` / `effort:` frontmatter; no operating-mode section).
- NOT a runbook (operational / on-call procedures go to `docs/runbooks/`).
- NOT a research file (`docs/research/{agent}/`).
- NOT a review report (`docs/reviews/{agent}/`).
- NOT a domain-unique invariant (those live in the respective agent's "Domain-specific invariants" section).

A "how-to" that does NOT touch ≥3 files across ≥2 contexts does not warrant a skill — inline it in the relevant agent's rules instead.

## Canonical file shape

```markdown
---
name: <kebab-case-skill-id>
description: <one-sentence — when to invoke this cascade>
type: skill
version: 1
blocker: <optional BLOCKER-NN reference if gated by an open architectural decision>
owners: <comma-separated primary agents that consult this skill>
---

# {Skill Title}

## When to invoke
{1-2 paragraph trigger conditions — what review finding / scenario / user request maps to this skill.}

## Prerequisites
{Inputs the caller must supply. Flag missing prereqs as a skill-level contract violation.}

## Cascade (numbered, ordered, atomic per step)

### Step N — {short imperative title}
**Affected files:** {absolute paths, globs permitted}
**Mechanism:** {exact code / migration / config shape — what to write}
**Why:** {one-line rationale tying to an ADR / invariant / finding-ID}
**Verification:** {the exact command or invariant test that proves the step landed}
**Cross-domain notifications:** {which agents must be flagged as Also-Notify per the handoff protocol}

(Repeat per step; steps are topologically ordered — step N+1 may depend on step N's verification being PASS.)

## Validation checklist
- [ ] Every Affected File received its change.
- [ ] Every Verification command returns PASS.
- [ ] Every Cross-domain notification landed as a dispatch target in the orchestrator cycle.
- [ ] No step was skipped or reordered (the ordering is load-bearing).

## Examples
{Real commits from repo history that exemplify the cascade. Absolute path + short SHA.}

## Cross-references
- ADRs: {list applicable docs/adr/*.md}
- Agent invariants: {list .claude/agents/*.md sections}
- Research files: {docs/research/*/*.md}
```

## Handoff contract

When `implementation-planner` builds a package that uses a skill, the package file MUST include:

- `Skill: {skill-id}` field in the Metadata section.
- The Atomic Commit Plan reflects the skill's cascade ordering — no re-interpretation.
- If the package can only implement a PARTIAL cascade (e.g. blocked mid-sequence), split into sub-packages `Na` + `Nb` with explicit prerequisite edges per the implementation-planner grouping priority. Never land a partial cascade in one commit.

## Blocker skills

Some skills document a gated architectural decision — they cannot execute without an ADR + arbitration approval:

- `add-shared-table.md` — **BLOCKER-15**. Adding a 5th shared-schema table requires ADR + architectural-arbiter approval + `SHARED_SCHEMA_TABLES` invariant update per ADR-011.
- `provision-tenant.md` — **BLOCKER-14**. Tenant provisioning saga must honour the 8-step sequence + compensation handlers; a new step order = new blocker finding.

Blocker skills start with an `ADR Gate` section naming the decision record + approver. A WRITER-mode agent invoking a blocker skill without an open approved ADR is a PROCESS CRITICAL finding per root-cause-auditor.

## Skill lifecycle

- **v1** — first landed version, baseline.
- **v2+** — version bump ONLY when the cascade ordering / file set / verification contract changes. Increment via `version:` frontmatter + changelog entry at the bottom of the skill file. Review files that cite the skill pin the version they tested against.
- **Deprecation** — skills are not deleted; mark `status: deprecated` in frontmatter and add `superseded_by: <new-skill-id>` pointer. `context-manager` surfaces deprecated-skill citations as SYSTEMIC process findings.

## Current catalog (Phase 3)

| Skill | BLOCKER | Purpose |
|---|---|---|
| `add-entity-field.md` | — | New `@Column` on an existing TypeORM entity with event-contract propagation |
| `change-event-contract.md` | — | Additive vs breaking event change with upcaster chain + ripple-tracer |
| `add-shared-table.md` | BLOCKER-15 | 5th shared-schema table — ADR + arbiter approval required |
| `add-rls-policy.md` | — | New Postgres RLS policy on a tenant table |
| `provision-tenant.md` | BLOCKER-14 | Tenant lifecycle saga discipline |
| `pre-migration-restore-test.md` | — | Never-restored-backup CRITICAL prevention |
| `run-migration-prod.md` | — | Production migration execution + rollback contract |

## Validation

CI invariant `tests/invariants/skills-catalog.spec.ts` (Phase 4 deliverable — to be landed after the 8 skill files are stable) will assert:

1. Every `.claude/skills/*.md` (except this README) has the canonical frontmatter.
2. Every BLOCKER-referenced skill carries an `ADR Gate` section.
3. Every cited ADR / research / agent path exists.
4. Every skill's Validation checklist section is present.
