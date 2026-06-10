<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 016: Convergent Planning, Bound Agents, and Async Execution

## Summary

Plan 016 promotes ARIA from read-mostly observation to bound-agent execution while preserving every law from SPEC v7.2 and the apply/PR discipline established in Plans 008, 009, 011, and 012. ARIA does not directly invoke external Claude or Codex agents. Instead, the kernel writes pending request envelopes to an append-only async queue, validates submitted outputs against a satisfaction matrix, and rejects every result that fails scope, evidence, lease, or separation-of-duties checks. Planning is a two-agent convergence loop (primary planner + independent challenger) capped at five rounds; failure to converge becomes `HUMAN_REQUIRED`, never silent drift. All implementation work lands on the `snowball` branch; the dirty `main` worktree is never touched.

Plan 013, 014, and 015 were skipped to avoid numbering ambiguity with Plan 012's "Phase 012D-015" wording. Plan 016 is the canonical source of truth for the convergent gate; Plan 012's wording will be clarified during the Faz B sweep so the rollout DAG remains unambiguous.

## Key Changes

### Async agent protocol

- Stable CLI surface (v3 hierarchical naming): `aria-kernel agent next-pending`, `agent claim`, `agent heartbeat`, `agent submit-result`, `agent release`, `agent reap-stale`. The existing `agent-invocations ...` sub-command is preserved unchanged; only the new hierarchical name is advertised.
- Ten-state request lifecycle: `PENDING`, `CLAIMED`, `RUNNING`, `SUBMITTED`, `ACCEPTED`, `REJECTED`, `STALE`, `REQUEUED`, `HUMAN_REQUIRED`, `CANCELLED`.
- Lease defaults: 30 minute lease, 30 minute heartbeat extension, 4 hour request SLA, 2 maximum requeues before `HUMAN_REQUIRED`. Raw lease tokens are never logged; only `lease_token_hash` lands in `aria-tools/agent-invocations/claims.jsonl`.
- Append-only ledgers under `aria-tools/agent-invocations/`: `requests.jsonl`, `claims.jsonl`, `results.jsonl`. Every state transition emits a hash-chained governance event (`agent_claim_created`, `agent_claim_expired`, `agent_result_rejected`, `agent_satisfaction_failed`, `self_approval_rejected`, etc.).

### Agent contract module

- `aria_kernel/agent_contract.py` defines `aria/agent-request/v1`: `request_id`, `cycle_id`, `role`, `target_agent`, `pressure_event_id`, `plan_id`, `converged_plan_hash`, `evidence_refs`, `impact_graph_refs`, `allowed_scope`, `forbidden_scope`, `must_satisfy`, `validation_commands`, `expected_output_path`, `separation_of_duties`.
- `aria/agent-response/v1`: `request_id`, `claim_id`, `agent_id`, `role`, `status`, `satisfaction_matrix`, `unmet_items`, `evidence_refs`, `risk_ids`, `output_hash`, `changed_plan_hash`.
- Reject rules (kernel-side, fail-closed): no valid active lease; agent_id or role mismatch; output_path mismatch; missing satisfaction entry for any `must_satisfy` item; missing or invalid evidence refs; output touches `forbidden_scope`; response cites only prior ARIA output as evidence; `target_agent` not in the maintenance-agent + judge-agent whitelist; `implementer_agent_id == reviewer_agent_id`.

### Convergent planning

- Three new maintenance agents under `.claude/agents/_maintenance/`: `aria-prompt-writer.md`, `aria-primary-planner.md`, `aria-challenger-planner.md`. All marked non-dispatchable for runtime domain reviewers; only the kernel pending-request queue invokes them.
- Both planners run on `opus xhigh`. Independence comes from the prompt: primary is an architecture-first synthesizer that traces recursive impact to the most extreme affected node; challenger is an independent code-scan validator that scans the codebase fresh and writes its own plan from the same evidence before ever seeing the primary plan.
- Cross-review is bidirectional. Each review emits concrete risks with `risk_id`, `severity`, `affected_files`, `evidence_refs`, and `required_plan_changes`. Primary revises and must address every material `risk_id`. Loop caps at five rounds; unresolved material gaps become `HUMAN_REQUIRED`.
- `feedback_store.generate_ai_consensus` and `plan_convergence` are preserved; the envelope/contract/claim lifecycle wraps them without rewriting their judgment logic.

### Convergence requirements

A plan is `CONVERGED` only when every condition below holds:
- zero blocking or material risks remain;
- every ARIA request `must_satisfy` item is `satisfied` in the response matrix;
- recursive impact graph status is `known` or `explicitly_blocked` (with `operator_approval_ref` for the latter);
- `base_branch == "snowball"` and the recorded `base_sha` is no older than the freshness window;
- validation scope is complete (every required validation command has a recorded result);
- no suppression, disabled tests, ignored failures, or local masking patterns appear in the proposed change.

### Recursive impact and freshness gates

- Impact entries: `{path, project, relationship, status: known|unknown|explicitly_blocked, block_reason, operator_approval_ref, validation_scope}`.
- Six impact sources: Nx graph JSON, local import graph fallback, event-contract producer/consumer mapping, GraphQL/API consumer mapping, DB entity/migration relationships, frontend query/module usage.
- Dispatch rule: any `unknown` blocks dispatch; `explicitly_blocked` is allowed only when the surface is outside the intended change scope and carries operator approval.
- Converged plans record `base_branch=snowball`, `base_sha`, `origin_sha`, `converged_at`. Freshness window: 24 hours. Before apply or PR creation, ARIA recomputes branch SHA and impact graph; mismatch transitions the plan to `STALE_REVALIDATION_REQUIRED` and re-enters convergence.

### Suppression policy

A deterministic diff scanner blocks any executor packet that contains:
- test skips: `.skip`, `xit`, `it.skip`, `describe.skip`, `@Disabled`;
- CI masking: `continue-on-error`, disabled workflows;
- TS masking: `@ts-ignore`, broad `as any`;
- runtime masking: empty `catch`, `catch {}`, `try/except: pass`, swallowed errors;
- ARIA suppression fields or false-positive marking that would suppress the targeted finding.

The block lifts only when the converged plan explicitly intends a test-only quarantine removal or equivalent cleanup with operator-approved scope.

### Separation of duties

- `implementer_agent_id != reviewer_agent_id` is a hard rejection.
- The implementation reviewer cannot share `claim_id`, `agent_id`, or executor packet author with the implementer.
- `CRITICAL` and `HIGH` packets require at least one independent reviewer; `CRITICAL` requires two.
- Self-approval triggers `self_approval_rejected` governance event, never a warning.

### Snowball worktree and PR ownership

- Faz 0 worktree preflight is the entry gate: `aria-kernel worktree preflight` records branch identity, source-dirty count, and ahead/behind state. Source-dirty (anything outside `aria-tools/**`, `.aria-poc/**`, `aria-findings/**`, `aria-debts/**`, `agent-workspace/**`) blocks subsequent work.
- Dirty or ambiguous worktrees create `.worktrees/snowball-aria-<id>` or require operator action; the dirty `main` worktree is never touched.
- ARIA opens the PR through `aria-kernel pr prepare <plan_id>` and `aria-kernel pr create <plan_id> --base snowball`. The PR body carries `request_ids`, `claim_ids`, `plan_hash`, `impact_graph_refs`, `validation_refs`, and rollback instructions. PR base is hardcoded to `snowball`; force push and main-base PRs are rejected.

### Logs and telemetry

Covered ledgers extend with: `agent_requests`, `agent_claims`, `agent_results`, `agent_satisfaction`, `plan_convergence_events`, `implementation_reviews`, `pr_actions`. New metrics: `aria_agent_request_total`, `aria_agent_claim_active`, `aria_agent_claim_expired_total`, `aria_agent_satisfaction_failed_total`, `aria_plan_rounds_total`, `aria_plan_stale_total`, `aria_impact_unknown_total`, `aria_self_approval_rejected_total`, `aria_pr_created_total`. A dashboard at `aria-tools/reports/dashboard.md` summarizes active plans, rounds, unresolved risks, pending agent requests, failed satisfaction items, and PR readiness.

## Acceptance

- `next-pending` returns only requests in eligible states for the requested role.
- `claim` requires a valid agent identity and creates a lease with stored `lease_token_hash`.
- `submit-result` without a valid active lease is rejected with `agent_result_rejected`.
- Stale claims requeue up to the limit, then transition to `HUMAN_REQUIRED`.
- Self-approval is rejected with `self_approval_rejected`.
- A response missing a satisfaction entry for any `must_satisfy` item is rejected with `agent_satisfaction_failed`.
- Agent-claimed evidence refs are revalidated through `evidence_validator` against the repository at the recorded SHA.
- Any `unknown` impact entry blocks dispatch; `explicitly_blocked` requires `operator_approval_ref`.
- A converged plan older than the freshness window cannot apply or open a PR until revalidated.
- The suppression scanner blocks executor packets that introduce skips, masking, or swallowed failures on changed lines.
- `pr create` is unavailable until validation results, implementation review, and converged-plan freshness all pass.
- Maintenance agents are indexed but not dispatchable from runtime domain review.
- The integration test exercises pressure → impact → primary plan → challenger plan → cross-review → revision → convergence → claim → implementation → independent review → validation → PR dry-run.
- Full kernel regression passes: `PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'`.

## Assumptions

- The kernel does not directly run Claude or Codex agents. It writes pending requests, validates submitted outputs, and records verdicts.
- An external orchestration layer (operator-driven Claude Code subagent loop in v1, programmatic worker pools later) polls the queue through the stable CLI and submits results back.
- Agent identity is operator-managed locally for v1; raw tokens and secrets are never written to ledgers.
- Plan 016 is used to avoid Plan 012's "Phase 012D-015" numbering ambiguity. Plan 012 wording is clarified in the Faz B contract sweep.
- `snowball` is the only integration and PR target branch for this work.
- Enterprise grade means evidence-backed, architecture-first, transitive-impact-aware, fully validated, and fail-closed on every gate.
