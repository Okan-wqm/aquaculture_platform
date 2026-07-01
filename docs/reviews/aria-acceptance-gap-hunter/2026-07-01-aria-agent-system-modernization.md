# ARIA Agent System Modernization — Audit Findings (2026-07-01)

Operator-commissioned end-to-end audit of the ARIA agentic system (17 agent
files + kernel dispatch layer + the 71 non-ARIA agents) against current repo
reality and the Claude Fable 5 runtime. Three exploration passes + two
verified design passes; every finding below carries file evidence. The
remediation lands as the sliced initiative B1–B3 / K1–K6 / W-A–W-C
(plan of record: operator-approved 2026-07-01).

Verified baseline: Claude Code CLI 2.1.197 supports `--model fable` and
`--effort {low,medium,high,xhigh,max}`; kernel model set and executors predate
both. Model policy decision (operator, 2026-07-01): decision nodes → fable,
judge/validator layer → opus, non-ARIA roster stays opus pending W-C.

---

### ORPHAN-MEDIUM-279 — ARIA writer agents carry no repo coding standards; contract prose drifted from kernel truth

**Evidence:** `.claude/agents/aria-implementer.md`,
`.claude/agents/_shared/aria-implementer-safety-contract.md`,
`.claude/agents/aria-acceptance-gap-fixer.md`,
`.claude/agents/_maintenance/aria-drafter.md`

The three code-writing agents (implementer, acceptance-gap-fixer, drafter)
reference no per-diff repository standards (root-cause tiers, type discipline,
`getScopedRepository`, ADR-011 schema placement, migration immutability,
`createBaseEvent`, `Closes:` trailer format). Drifted prose: safety contract
documents `satisfied: true|false` while `agent_contract.SATISFACTION_VERDICTS`
enforces the 3-value enum; body says "15 hard-fail safety checks" while
`implementation_safety.HARD_FAIL_CHECKS` has 16 entries; `details.usage`
described as "Codex CLI usage block" (runtime is Claude Code per ADR-040);
per-cycle cap hardcoded as a dollar literal instead of citing
`budget.DEFAULT_MAX_BUDGET_USD_PER_CYCLE`. **Remediation: slice B1** — shared
`_shared/aria-code-writing-standards.md` contract + writer wiring + prose
corrections.

### ORPHAN-MEDIUM-280 — challenger-planner claims cross_review/implementation_review roles the kernel never routes to it

**Evidence:** `.claude/agents/aria-challenger-planner.md`,
`aria-kernel/aria_kernel/cross_review_bridge.py:48`,
`aria-kernel/aria_kernel/plan_round_controller.py:22`

`cross_review_bridge.CROSS_REVIEW_ROLE = ("aria-cross-reviewer", "cross_review")`
is the single mint point; no kernel code mints `cross_review` or
`implementation_review` targeting the challenger-planner. The agent body still
documents both run modes (pre-V8 single-direction design) — dead prompt weight
and a dual-ownership audit hazard. Body also carries Tier-3-density narratives
at 2750/2800 of the Tier-2 token budget. **Remediation: slice B2** — delete the
dead modes, trim to hybrid density, declare aria-cross-reviewer the single
bidirectional owner.

### ORPHAN-LOW-281 — banned-phrase discipline and refusal sections missing from judge/acceptance bodies

**Evidence:** `.claude/agents/aria-evidence-judge.md`,
`.claude/agents/aria-adversarial-judge.md`,
`.claude/agents/aria-acceptance-lead.md`,
`.claude/agents/aria-acceptance-output-validator.md`,
`.claude/agents/aria-acceptance-gap-hunter.md`

Both judges constrain banned phrases only for refusal text, not for
`rationale`/`satisfaction_matrix[].note` (which
`agent_contract._check_banned_phrases` also scans). The four acceptance-lane
agents document no refusal/stop conditions at all. **Remediation: slice B2.**

### ORPHAN-MEDIUM-282 — no end-to-end pipeline SSoT; prompt-writer mandate stale

**Evidence:** `.claude/agents/_maintenance/aria-prompt-writer.md:20`,
`docs/aria/CONTRACTS.md`

No document maps which agent runs when across the convergent plan gate,
authoring loop, implementation lane, acceptance lane, and autonomy ladder —
the flow is reconstructable only from kernel source. The prompt-writer (the
agent that authors ARIA agent prompts) carries a stale roster paragraph
("five judges + three maintenance agents" — planners were promoted to runtime
in V8.1), a hardcoded `model: opus, effort: xhigh` render rule that bypasses
the tier registry, and a hardcoded clause count. It also lacks clauses for
(a) code-writing standards in writer-class prompts and (b) prompt-shape
economy for the Fable runtime. **Remediation: slice B3** —
`docs/aria/PIPELINES.md` + mandate clauses 12/13 + agent/skill authoring rules.

### ORPHAN-HIGH-283 — kernel model set frozen pre-Fable; frontmatter effort never delivered to the CLI

**Evidence:** `aria-kernel/aria_kernel/agent_runtime_profile.py:31`,
`tools/aria-poc/claude_runtime.py:40`,
`tools/aria-poc/worker_executor.py:233`,
`.github/workflows/aria-agent-executor.yml:77`

`VALID_MODELS = {opus, sonnet, haiku}` — a `model: fable` frontmatter parses as
`default_invalid` today. `claude_runtime.py` documents "no separate
reasoning-effort flag" while CLI 2.1.197 ships `--effort {low..max}`; resolved
`effort:` values are computed and then dropped (never on argv).
`REQUIRED_CLAUDE_VERSION="2.1.0"` predates the fable alias.
**Remediation: slice K1.**

### ORPHAN-HIGH-284 — no refusal detection on the CLI executor path

**Evidence:** `tools/aria-poc/claude_runtime.py:322-388`,
`tools/aria-poc/api_backoff.py`

`parse_claude_jsonl`/`extract_final_message` never inspect `stop_reason`.
Fable's safety classifiers can return `stop_reason: "refusal"`
(cyber/bio categories); on the current path a refusal surfaces as a generic
failure with no policy: no audited fallback, no HUMAN_REQUIRED escalation, no
ledger row distinguishing it from an outage. **Remediation: slice K2** —
detection + one audited opus retry + HUMAN_REQUIRED on double refusal.

### ORPHAN-HIGH-285 — kernel dispatches two agents that have no agent files; WRITE_TIER sets diverge

**Evidence:** `aria-kernel/aria_kernel/agent_surface.py:95-96`,
`aria-kernel/aria_kernel/autonomy_orchestrator.py:221`,
`aria-kernel/aria_kernel/promotion_controller.py:79`,
`tests/invariants/agent-frontmatter-schema.spec.ts:141`,
`aria-kernel/aria_kernel/agent_runtime_profile.py:41`

`aria-autonomy-planner` and `aria-worker` are whitelisted, envelope-minted
targets with no `.md` files — model resolution silently falls back
(`default_missing_file`) with no invariant coverage. The jest
`ARIA_WRITE_TIER` set contains `aria-acceptance-gap-fixer`; the python
`WRITE_TIER_AGENTS` set does not — the two enforcement surfaces disagree.
**Remediation: slice K3.**

### ORPHAN-MEDIUM-286 — budget caps and estimates are opus-calibrated, not model-aware

**Evidence:** `tools/aria-poc/ci_executor.py:717`,
`aria-kernel/aria_kernel/budget.py:165`

`_estimate_envelope_cost_usd` hardcodes opus-priced estimates; the $1.50
per-cycle cap assumes opus decision nodes. Fable prices at 2× opus — under the
approved tiering the reservation math undercounts and the cap fires mid-cycle.
**Remediation: slice K4** — model-aware estimates + cap re-baseline.

### ORPHAN-MEDIUM-287 — acceptance lane sits outside the canonical envelope profile; drafter refusals bypass the refusal ledger

**Evidence:** `.claude/knowledge/layer-2-aria-canonical-envelope.md`,
`.claude/agents/_maintenance/aria-drafter.md:69`

The four `dispatch: ad-hoc` acceptance agents emit results in no documented
envelope profile (response shape, verdict enum, refusal schema), so their
outputs cannot be validated by `agent_contract.validate_response`.
`DRAFTER_REFUSAL:<code>` sentinels are consumed by draft_validator but never
rendered as `aria/agent-refusal/v1` ledger rows — refusals are invisible to
the queryable refusal surface. **Remediation: slice K6.**

### ORPHAN-MEDIUM-288 — ARIA tier assignments predate the operator capability policy

**Evidence:** `.claude/agents/aria-primary-planner.md:5` (and 16 sibling
frontmatters), `aria-kernel/aria_kernel/dispatcher_factory.py:98-100`

Operator policy (2026-07-01): decision nodes run fable, judge/validator layer
runs opus. Current frontmatter: 12 opus + 6 sonnet (one agent per the older
scout-and-verify calibration); `dispatcher_factory` default `claude_model:
"opus"` and `subprocess_timeout_seconds: 600` (too tight for fable turn
lengths). **Remediation: slice K5** (tier flip, single-revert unit).

### ORPHAN-LOW-289 — build-validator body cites a repo-external memory file

**Evidence:** `.claude/agents/build-validator.md:66`

The webpack/NestJS-DI warning cites `feedback_webpack_nestjs.md` — an
operator-session memory file that does not exist in the repository. The claim
itself is correct (webpack breaks NestJS DI metadata; the deploy-crash root
cause) but must anchor to in-repo evidence. **Remediation: wave W-A.**

---

## Disposition

| Finding | Slice | State at registration |
|---|---|---|
| ORPHAN-MEDIUM-279 | B1 | fix authored with this doc |
| ORPHAN-MEDIUM-280, ORPHAN-LOW-281 | B2 | OPEN |
| ORPHAN-MEDIUM-282 | B3 | OPEN |
| ORPHAN-HIGH-283 | K1 | OPEN |
| ORPHAN-HIGH-284 | K2 | OPEN |
| ORPHAN-HIGH-285 | K3 | OPEN |
| ORPHAN-MEDIUM-286 | K4 | OPEN |
| ORPHAN-MEDIUM-288 | K5 | OPEN |
| ORPHAN-MEDIUM-287 | K6 | OPEN |
| ORPHAN-LOW-289 | W-A | OPEN |

Non-ARIA wave verification (W-A/W-B) registers additional findings as real
defects surface; each wave PR closes its own entries.
