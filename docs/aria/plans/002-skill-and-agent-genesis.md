<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 002 - Skill and Agent Genesis

## Goal

Define how ARIA earns new capabilities after the Phase 0 kernel exists.

ARIA must not ship with a fixed domain skill catalog. Skills and agents are born from repository pressure: Unknown, Repetition, and Contradiction. Missed-signal feedback is one source of that pressure, but only after Phase 0 records it and thresholds are exceeded. This keeps ARIA shaped by this repository rather than by a preloaded taxonomy.

## Non-goals

- No skill genesis in Phase 0.
- No new agent creation in Phase 0.
- No one-off skill for a single drift.
- No domain list hardcoded as destiny.
- No ACTIVE skill without fixture validation and shadow comparison.
- No skill promotion based only on LLM judgment.
- No agent that can modify application code without the existing repository guardrails.

## Physical artefacts

Skill and agent genesis begins only after Phase 0 is accepted. The allowed artefacts are:

| Artefact | Location | Purpose |
|---|---|---|
| Pressure log | `~/.aria/workspaces/<repo_hash>/aria-memory/pressure.jsonl` | Append-only Unknown, Repetition, and Contradiction records. |
| Feedback ledgers | `~/.aria/workspaces/<repo_hash>/aria-memory/{unknowns,missed_signals,external_feedback}.jsonl` | Inputs that can produce pressure but are not findings or instructions. |
| Skill birth requests | `~/.aria/workspaces/<repo_hash>/aria-skills/requests/*.json` | Precise capability gap and evidence for why a skill is needed. |
| Skill drafts | `~/.aria/workspaces/<repo_hash>/aria-skills/drafts/<skill_id>/` | Draft detector, scope declaration, fixtures, and expected outputs. |
| Skill registry | `~/.aria/workspaces/<repo_hash>/aria-skills/registry.json` | Lifecycle state: see Plan 005 §Lifecycle for the canonical state list (`DRAFT -> SANDBOX -> SHADOW -> ACTIVE -> CALIBRATE -> QUARANTINED -> ARCHIVED`). The shorter `DRAFT/SHADOW/ACTIVE/ARCHIVED` summary previously published in this row is superseded by Plan 005. |
| Fixture set | `~/.aria/workspaces/<repo_hash>/aria-skills/fixtures/<skill_id>/` | Minimal positive, negative, and false-positive fixtures. |
| Shadow reports | `~/.aria/workspaces/<repo_hash>/aria-skills/shadow/<skill_id>/*.json` | Comparison between draft skill output and accepted human/operator judgment. |
| Agent mapping draft | `~/.aria/workspaces/<repo_hash>/aria-agents/mapping.json` | Mapping from observed repo domain pressure to existing `.claude/agents/` files. |
| Public summary | `docs/aria/reports/skill-genesis-*.md` | Optional sanitized summary of proposed capability birth; not an executable skill. |

No `.claude/agents/aria-*.md` file is written until a later implementation plan explicitly permits agent materialization. The authorized PR pathway is defined by Plan 016 §Snowball and PR ownership: ARIA prepares the diff with `aria-kernel pr create --base snowball`; the diff modifies `.claude/agents/aria-*.md` only through that gated lane after operator-issued `approved_for_agent_pr` per Plan 010.

## Decision gates

### Gate 1 - Pressure eligibility

A skill birth request can be opened only when at least one pressure primitive is present:

- **Unknown:** ARIA cannot parse, classify, verify, or connect a repeated repo surface.
- **Repetition:** the same structural problem appears in at least three independent locations or cycles.
- **Contradiction:** two evidence chains disagree and the disagreement recurs or blocks validation.

Single occurrence drift is recorded as an observation. It does not create a skill.

Missed-signal feedback follows the same rule: one operator or external scanner example is data, not a birth request.

### Gate 2 - Existing capability check

Before `DRAFT`, the genesis pipeline must prove that the pressure is not already covered by:

- existing tests or invariant gates;
- existing `.claude/agents/` expertise;
- existing `tools/gates/` checks;
- the Phase 0 deterministic scanners;
- simple operator documentation.

If an existing gate can be invoked or wrapped, ARIA must wrap it instead of birthing a new skill.

### Gate 3 - DRAFT

A `DRAFT` skill must declare:

- exact scope: file globs, symbol types, and excluded paths;
- claim type: observation, candidate finding, or validation helper;
- required evidence shape;
- false-positive risks;
- fixture list;
- budget estimate;
- deactivation condition.

Draft output is never operator-facing as an authoritative finding.

### Gate 4 - Fixture validation

A draft can enter `SHADOW` only after fixtures include:

- at least three positive examples;
- at least three negative examples;
- at least two false-positive traps;
- at least one generated-output or excluded-path trap;
- expected evidence chain shape for each positive example.

Fixture tests must fail if the skill treats `agent-workspace/`, `.aria-poc/`, secrets, or generated output as application code.

### Gate 5 - SHADOW

In `SHADOW`, the skill runs beside the normal cycle but cannot create confirmed findings. Shadow reports measure:

- precision;
- recall where a fixture or known finding exists;
- false-positive count;
- cycle cost;
- evidence validity;
- overlap with existing gates.

The default shadow duration is 14 days or three complete cycles, whichever is longer.

### Gate 6 - ACTIVE

A skill can become `ACTIVE` only when:

- fixture suite passes;
- shadow precision is at least 0.85;
- there are zero critical false positives;
- evidence chains pass Phase 0 validation;
- budget use stays under its declared cap;
- the operator approves promotion.

ACTIVE does not mean autonomous code modification. It means the skill may produce candidate findings within its declared scope.

### Gate 7 - Archive

A skill moves to `ARCHIVED` when:

- its false-positive rate crosses the configured threshold;
- its target repo surface disappears;
- existing repo gates supersede it;
- its evidence format is invalid after a repo evolution;
- the operator retires it.

Archived skills preserve lessons in the external workspace; they are not deleted to hide history.

### Gate 8 - Agent genesis

Agent genesis is not skill genesis. Agent planning begins only after Phase 1 shows repeated domain pressure for at least three cycles.

At the end of Phase 1, ARIA may map pressure domains to existing `.claude/agents/` files. A new agent can be proposed only when:

- at least three cycles show the same domain pressure;
- no existing agent has adequate scope;
- at least one ACTIVE or repeatedly useful SHADOW skill exists in that domain;
- the proposed agent has a narrow ownership surface;
- the operator approves a separate implementation plan.

## Acceptance tests

Skill and agent genesis is accepted only when these tests pass:

- A one-time enum/UI drift creates an observation but no skill birth request.
- One missed-signal feedback record creates no skill birth request.
- Three independent Unknown records for the same parse surface create one skill birth request, not three.
- Three independent missed-signal records can create pressure, but the existing capability check still runs before `DRAFT`.
- A repeated contradiction produces a birth request only after the existing capability check fails.
- A false-positive fixture blocks `DRAFT` to `SHADOW` promotion.
- A `SHADOW` skill cannot write confirmed findings.
- A skill with precision below 0.85 cannot become `ACTIVE`.
- A critical false positive blocks `ACTIVE` even when precision is high.
- A superseded skill moves to `ARCHIVED` while preserving calibration history.
- Phase 0 creates no skill or agent artefacts.
- Agent mapping at Phase 1 uses existing `.claude/agents/` before proposing any new agent.
