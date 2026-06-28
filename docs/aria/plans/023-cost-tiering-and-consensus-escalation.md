<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 023 — Cost Tiering and Consensus Escalation

> **Status:** Implemented (model/effort tiering + consensus→HUMAN_REQUIRED consumer). Five larger gaps tracked as deferred work below.
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **HEAD at authoring:** `ce0e22a`

## Summary

A full read of ARIA (kernel + agents + spec) surfaced seven gaps. Plan 023
closes the two most surgical, lowest-risk ones in code and tracks the other
five as deferred work with explicit owners and deadlines. The two closed gaps:

1. **No model/effort tiering.** Mechanical triage is already LLM-free
   (`tools/aria-poc/poc.py`, `aria-kernel/aria_kernel/triage.py`,
   `lane_classifier.py`), but at the LLM layer all 13 ARIA agents ran on the
   single most expensive setting — the Codex executor forced
   `model_reasoning_effort="xhigh"` globally (`codex_runtime.py`) and the
   per-agent `model:`/`effort:` frontmatter was declared yet never consumed.
2. **Consensus disagreement black hole.** When independent judges disagreed
   or were low-confidence, the kernel wrote the outcome to
   `feedback-consensus-uncertainties.jsonl` (`feedback_store.py`) and *nothing
   ever read it* — a split judge vote was silently held forever and never
   reached a human.

## Phase 023a — Model/Effort Tiering

Operator decision baked in: **"scout-and-verify"**. The cheap tier (Sonnet)
are read-only *scorers/scanners* that flag candidates and point the expensive
tier at targets; the expensive tier (Opus) *plans / decides / writes* and does
NOT trust the cheap tier — it re-verifies against repo evidence. This puts the
saving where the cost multiplies (the per-finding N-judge fan-out) while the
single decision/plan/implement stays Opus.

**Architecture (tier-2 "make it automatic"):** the agent frontmatter is the
single source of truth; the runtime now reads it instead of forcing a global.

- New SSoT reader `aria-kernel/aria_kernel/agent_runtime_profile.py` —
  `read_agent_runtime_profile()` / `resolve_codex_reasoning_effort()`. Unknown
  agent or invalid/missing field fails safe to the most expensive tier
  (`opus`/`xhigh`) — a silent downgrade can only come from an explicit,
  reviewable frontmatter edit.
- `tools/aria-poc/codex_runtime.py` — `build_codex_exec_argv` / `run_codex_exec`
  accept a per-call `reasoning_effort` (validated against
  `VALID_REASONING_EFFORTS`); the global `CODEX_REASONING_EFFORT="xhigh"`
  remains the fail-safe default.
- `tools/aria-poc/ci_executor.py` — the dispatch path resolves the effort from
  the dispatched agent's frontmatter (`resolve_codex_reasoning_effort(subagent_type)`).
- 9 of 13 agent frontmatter files retiered (Claude-path `model:` is honoured
  natively by Claude Code; Codex-path `effort:` flows through the reader).

| Tier class | Agents | model / effort |
|---|---|---|
| scout (read-only scorer/scanner) | evidence-judge, adversarial-judge, cross-reviewer, change-intelligence, goldset-curator | **sonnet / medium** |
| planner / drafter | primary-planner, challenger-planner, primary-drafter, challenger-drafter | **opus / high** |
| decider / writer | consensus-arbiter, implementer, _maintenance/drafter, _maintenance/prompt-writer | **opus / xhigh** |

**Drift guard (tier-3 "make it detectable"):**
`aria-kernel/tests/test_agent_runtime_profile.py` fails if any agent frontmatter
carries an invalid model/effort, or if a write-tier agent
(`WRITE_TIER_AGENTS`) is downgraded below opus/xhigh.

## Phase 023b — Consensus Escalation Consumer

Architecture (tier-1 "make it impossible"): a consensus disagreement can no
longer land in a file nothing reads.

- `feedback_store.py::_consensus_uncertainty` now stamps a stable
  `escalation_id` (`consensus-<sha16>` over tool/run/finding/group/reason) so a
  consumer can key idempotently.
- `human_required.py::sweep_consensus_uncertainties_for_human_required` drains
  `feedback-consensus-uncertainties.jsonl` into idempotent `HUMAN_REQUIRED`
  records: `judge_disagreement` → HIGH, `low_confidence` → MEDIUM.
  `single_judge` is the benign "only one judge sampled" case (re-sampled next
  cycle) and is intentionally NOT escalated, to avoid triage spam.
- `cycle.py::run_enterprise_cycle` invokes the drain between the `pressure` and
  `reflection` phases (skipped under shadow/discovery no-write runs), surfacing
  the result on `state["consensus_escalation"]`.
- Test: `aria-kernel/tests/test_consensus_human_escalation.py` (severity
  mapping, single-judge skip, cross-cycle idempotency).

> **Scope note (honest boundary):** the arbiter prompt's *behavioural*
> re-verification ("Opus treats Sonnet verdicts as untrusted leads") is not yet
> a kernel mechanism — the mechanical consensus gate in `feedback_store.py` is
> unchanged. Deepening that is deferred as ARIA-023-D1 (judge calibration),
> which is the right home for measuring whether the cheap tier's verdicts hold.

## Deferred work (tracked — owner + deadline)

`aria-findings/` is gitignored operator-local runtime state, so these are
tracked here in the committed plan doc (the real tracked surface for a PR)
rather than as runtime findings. Each is an architectural gap, not a partial
fix of the above.

| ID | Gap | Evidence | Owner | Due |
|---|---|---|---|---|
| ARIA-023-D1 | Judge calibration loop absent — `compute_metrics` measures ADAPTER precision, not judge precision; gold-set curation is one-shot | `tool_health.py:402-422`, `goldset.py:15-82` | aria-core (okan) | 2026-07-27 |
| ARIA-023-D2 | Rust/edge (~210k LOC) outside ARIA's audit net; kernel drift detectors are `.ts`-only; root-cause-auditor tier vocab is TS/SQL-only | `poc.py:475+`, `root-cause-auditor.md:18-27` | edge+aria (okan) | 2026-08-26 |
| ARIA-023-D3 | No proactive Impact×Opportunity prioritization — only severity×recurrence pressure; no-pressure → reflect-only | `plans/007:34`, `ARCHITECTURE.md:198` | aria-core (okan) | 2026-08-26 |
| ARIA-023-D4 | Belief decay is evidence/change-coupled only; no CVE / external-contract / ADR-supersession trigger for unchanged code | `ARCHITECTURE.md:189`, `CONTRACTS.md:58` | aria-core (okan) | 2026-09-25 |
| ARIA-023-D5 | No runtime-signal bridge (Sentry/incident) — closed evidence allowlist excludes runtime; runtime-only bugs are structurally invisible | `CONTRACTS.md:520`, `IDENTITY.md:712` | aria-core (okan) | 2026-09-25 |

## Acceptance

- `aria-kernel/tests/test_agent_runtime_profile.py` and
  `test_consensus_human_escalation.py` pass.
- The full kernel suite stays green:
  `PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'`.
- A dispatched scout agent runs at its frontmatter effort (e.g. evidence-judge
  → `medium`), not the global `xhigh`; an unknown agent and every write-tier
  agent still resolve to `xhigh`.
- A synthetic `feedback-consensus-uncertainties.jsonl` with a disagreement +
  low-confidence + single-judge row yields exactly two idempotent
  `HUMAN_REQUIRED` records (HIGH, MEDIUM); re-running creates none.

## Assumptions

- Two runtime backends consume the frontmatter: Claude Code Agent dispatch
  honours `model:` natively; the Codex CLI executor maps `effort:` to
  `model_reasoning_effort`. Both read the same frontmatter SSoT.
- The mechanical consensus gate (quorum ≥2, unanimous verdict, mean confidence
  ≥ 0.80) is unchanged; Plan 023 only adds the missing human-escalation
  consumer downstream of it.
- Scout-tier quality risk is bounded by scout-and-verify: the cheap tier is a
  recall-oriented flagger, never the final authority. Quantifying the effect
  requires ARIA-023-D1.
