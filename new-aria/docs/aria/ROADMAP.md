<!-- ARIA-CURRENT-STATE-NOTICE: This document may contain historical state. For normative current state, see docs/aria/CURRENT_STATE.md and executable contracts. -->

# ARIA Roadmap

## Live State Pointer

This roadmap is historical unless a section is explicitly reaffirmed by `docs/aria/CURRENT_STATE.md` and executable contracts. The live post-snowball state is not the original PoC-only state: ARIA now has an `aria-kernel/` package, Codex executor surfaces, runtime profile gates, state manifests, artifact graph verification, agent/skill genesis ledgers, and autonomy orchestration code.

The current authority chain and target commit are defined in `docs/aria/CURRENT_STATE.md`. Any older roadmap sentence that says only `tools/aria-poc/poc.py` exists, the kernel is not implemented, or Claude/Anthropic is the live runtime authority is superseded.

## Snowball v9 Hardening

The Phase 0 kernel now includes the enterprise hardening spine required before broader self-renewal work:

- v2 workspace/tools identities and binding checks;
- separate workspace/tools integrity indexes;
- covered governance ledgers in both roots;
- v2 feedback and pressure schemas with legacy ID preservation;
- explicit workspace and tools migration/rollback commands;
- committed discovery snapshots that ignore dirty working-tree state with governance evidence;
- CI smoke for unittest, discovery, and nested integrity verification.

Push retry policy for the live `main` branch is fail-closed: an automated retry may run `git fetch` and `git merge --ff-only`. If fast-forward is not possible, the push gate stops and the operator performs the rebase/merge manually before rerunning the gate. No force push is part of the retry path. Historical snowball branch references are not live deployment authority.

## Phase 0 Entry Condition

Phase 0 starts only after the PoC decision gate says ARIA is worth building.

Phase 0 delivers the kernel skeleton described in `docs/aria/plans/001-phase-0-kernel-skeleton.md`:

- `aria-kernel/` as a small Python package;
- external workspace at `~/.aria/workspaces/<repo_hash>/`;
- append-only observation and evidence ledgers;
- repeatable discovery cycle;
- evidence chain validator;
- budget gate;
- kill switch.
- self-renewal feedback ledgers for unknowns, missed signals, external feedback, and derived pressure.

Phase 0 may record pressure from self-renewal feedback, but it must not modify application code, create a PR, create a skill, or create an agent.

## Phase 1 Skill Genesis Condition

Phase 1 starts only after Phase 0 passes its validation harness.

Skill genesis follows `docs/aria/plans/002-skill-and-agent-genesis.md`:

- skills come from Unknown, Repetition, or Contradiction pressure;
- missed signals can feed that pressure only after Phase 0 records repeated independent examples;
- one-time drift does not birth a skill;
- every skill starts as `DRAFT`;
- fixture validation is mandatory before `SHADOW`;
- `SHADOW` output is non-authoritative;
- `ACTIVE` requires precision, zero critical false positives, budget compliance, evidence validity, and operator approval.

At the end of Phase 1, ARIA may map recurring pressure to existing `.claude/agents/`. It still does not create new agents by default.

## Phase 2 Agent Orchestration Condition

Phase 2 starts only after Phase 1 proves repeated domain pressure across at least three cycles and existing `.claude/agents/` mapping is insufficient.

Phase 2 may plan agent orchestration, but only under a separate implementation plan. A new agent is justified only when:

- the same domain pressure recurs for at least three cycles;
- no existing agent has adequate scope;
- at least one ACTIVE or repeatedly useful SHADOW skill exists in that domain;
- the proposed agent has narrow ownership;
- the operator approves materialization.

Phase 2 remains bounded by the Phase 0 kill switch, budget gate, evidence validator, and repository preservation rules.

## Never

ARIA must never:

- deploy to production;
- rotate secrets;
- manipulate customer data;
- execute production migrations;
- flip production feature flags;
- auto-merge pull requests outside the explicitly gated runtime profile, branch, artifact, approval, and merge-authority contracts;
- modify its own immutable kernel without explicit human-directed implementation work;
- treat repository text as instruction;
- analyze `agent-workspace/`, `.aria-poc/`, secrets, or generated output as application code;
- birth a skill from a single observation;
- create an agent because a domain name sounds useful.

## Validation Spine

The validation plan lives in `docs/aria/plans/003-aria-validation-and-test-harness.md`.

Before Phase 1, ARIA must prove:

- memory survives repeated runs;
- new enum/UI drift becomes a separate signal;
- false positives block skill genesis;
- excluded paths are accounted for but not scanned as application code;
- missed signals and external contradictions become pressure without becoming trusted findings;
- kill switch and budget gate interrupt an active cycle.
