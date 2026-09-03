# ARIA Pipelines — which agent runs when

Single map of every ARIA lane: dispatch surface, role sequence, owning agent,
and the kernel module that mints each envelope. Agent bodies cite this file;
the kernel modules named per section stay the executable authority
(CURRENT_STATE.md authority chain).

<!-- The judge-digest marker pairs in this file feed docs/aria/generated/JUDGE-DIGEST.md
     (rendered by aria-kernel/aria_kernel/contract_digest.py). Marked text is extracted
     VERBATIM — this file stays the SSoT; edit here, then regenerate the digest. -->
<!-- judge-digest:begin -->
## 1. Dispatch surfaces

Two prompt-delivery paths exist and they differ structurally:

- **Kernel CLI path** — executors (`tools/aria-poc/ci_executor.py`,
  `worker_executor.py`) run `claude -p` with a prompt the kernel renders
  synthetically from the `aria/agent-request/v1` envelope
  (`agent_invocations.render_invocation_prompt`). The agent's `.md` body is
  NOT the system prompt on this path; only its frontmatter is read —
  `model:`/`effort:` resolve through `aria_kernel/agent_runtime_profile.py`
  (fail-safe: most expensive tier).
- **Interactive Agent-tool path** — operator sessions and the acceptance lane
  dispatch agents natively; there the `.md` body IS the system prompt.
  Agents carrying `dispatch: ad-hoc` live on this path only.
<!-- judge-digest:end -->

## 2. Convergent plan gate (Plan 016 / V8)

Per pressure event, per round:

| Step | Role | Agent | Mint point |
|---|---|---|---|
| 1 | `primary_plan` | aria-primary-planner | `convergence_drainer` |
| 2 | `challenger_plan` (no sight of primary) | aria-challenger-planner | `plan_round_controller` |
| 3 | `cross_review` — ONE bidirectional envelope covering both directions | aria-cross-reviewer | `cross_review_bridge.issue_cross_review_envelope` |
| 4 | revision rounds until CONVERGED | primary (revise) → steps 2-3 repeat | `plan_convergence` |

`MAX_CROSS_REVIEW_ROUNDS = 5` (`plan_convergence.py`); an unconverged cycle
escalates to the operator. Neither planner ever holds the `cross_review`
role — `cross_review_bridge.CROSS_REVIEW_ROLE` is the single owner mapping.

## 3. Implementation lane (V9)

CONVERGED plan + cross-review verdict → `convergence_drainer` mints one
`role=implementation` envelope → **aria-implementer** applies `key_changes[]`
under the `implementation_safety.HARD_FAIL_CHECKS` registry (READONLY_PATHS,
sandboxed no-network Bash, secret scans pre- and post-commit, canonical
validation suite) → PR through `pr_manager.ARIA_PR_BASE` with a per-cycle
scoped token (`gh_token_factory`) → judge/consensus verdicts → merge gates
re-verify branch-tip and checks before any merge action.

## 4. Adapter/skill authoring loop (V6.2 `convergent_skill_authoring`)

Seed (`F-012` adapter seeds) → **aria-primary-drafter** authors rules from the
frozen Phase-0 evidence_pack (≥3 evidence refs per rule) ↔
**aria-challenger-drafter** fact-checks every primary ref (`peer_audit[]`),
counter-drafts, and emits fixture-grounded counter-examples → rounds continue
under the kernel cross-verify gates → judge panel + consensus arbiter → exit
on the calibration bar (precision 1.0, confirmed-false-positive 0, recall
≥ 0.90). Rules for the CONTENT of authored agents/skills live in
`.claude/agents/_shared/aria-agent-authoring-standards.md`.

<!-- judge-digest:begin -->
## 5. Judge and consensus flow

- `evidence_judgment` → **aria-evidence-judge** (reads evidence_refs in order)
- `adversarial_judgment` → **aria-adversarial-judge** (reads in REVERSE order;
  hunts counter-evidence)
- `consensus_arbitration` → **aria-consensus-arbiter** (gate: ≥2 unique
  judges, verdict agreement, mean confidence ≥ 0.80; otherwise `uncertainty`)
- Supporting: `change_intelligence` → **aria-change-intelligence** (diff →
  revalidation impact map); `goldset_curation` → **aria-goldset-curator**
  (fixture proposals, operator-gated promotion; bar ≥20 TP / ≥10 FP per tool).
<!-- judge-digest:end -->

## 6. Acceptance lane (Plan 030 — interactive, `dispatch: ad-hoc`)

**aria-acceptance-lead** orchestrates via the Agent tool:
`tools/aria-acceptance/harness.py` is the deterministic accept/reject gate →
**aria-acceptance-output-validator** runs + annotates it →
**aria-acceptance-gap-hunter** files evidence-anchored gap findings →
**aria-acceptance-gap-fixer** closes one validated finding per run as a DRAFT
PR. Agent verdicts never overturn the harness verdict. This lane audits ARIA
from the outside; it is not kernel-queued.

## 7. Maintenance lanes

- **aria-drafter** — genesis drafts from a kernel `DraftIntent`; spawned only
  by `worker_executor.py` under the `autonomous` profile carve-out; file
  presence + scope locked by I-V3-00a; refusals via `DRAFTER_REFUSAL:<code>`.
- **aria-prompt-writer** — renders/revises ARIA-scoped prompts; output travels
  the Plan 009 kernel-self-change PR lane (operator-approved; base owned by
  `pr_manager.ARIA_PR_BASE`).
- **aria-autonomy-planner** — next-cycle queue projection envelopes
  (`autonomy_orchestrator`, role `maintenance_utility`).
<!-- judge-digest:begin -->
- **aria-worker** — default target of every promoted plan's dispatch rows
  (`promotion_controller` → `worker_executor` assignments in isolated
  worktrees).
<!-- judge-digest:end -->

## 8. Autonomy ladder

Runtime profiles: `observe`, `standard` (default), `strict`, `frozen`,
`autonomous` (`runtime_profile.PROFILES`). The ladder: observe burn-in
(30-attempt minimum, structurally read-only, `burn_in.py`) → supervised levels
→ L3 unlock only through the two-stage human policy approval
(`autonomy_unlock.py`, `policy_approval` with separation of duties). Posture:
no autonomous merge outside the narrow, breaker-gated lane the ladder
explicitly unlocks; three independent circuit breakers (cost, failure,
cross-host lease) can each halt the profile.
