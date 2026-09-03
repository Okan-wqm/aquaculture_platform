# ADR-036: ARIA Per-Job CI-Workflow Governance

## Status

**Proposed** — pending operator/kernel-owner sign-off on the six load-bearing decisions in §Decision Points. Implementation (registry + verifiers + preflight + 6 workflow YAMLs + docs_ssot + tests) follows in a single PR once this ADR is accepted; per CLAUDE.md a security-governance kernel surface admits **no partial landing**.

## Context

The cross-checked ARIA→main convergence audit (`docs/plans/2026-06-13-aria-to-main-controlled-merge/`, ~36 primary+challenger agents) found one genuinely-unique, security-relevant capability that the `aria/*` branches carry and `main` **lacks by content** — verified firsthand by multiple independent challengers:

| Capability | main today | ARIA branches (e.g. `13b94c505`) |
|---|---|---|
| Per-job GHA **permission** verification | **none** (`git grep _verify_permissions main` = empty) | `_verify_permissions` flags uncontracted-write / permission-mismatch per job |
| Audited-exclusion **expiry/owner** | `AUDITED_WORKFLOW_EXCLUSIONS: dict[str,str] = {}` (empty placeholder, membership-only) | `AuditedWorkflowExclusion(workflow_id, reason, owner, expires_at)` + `_verify_audited_exclusions` |
| Per-job upload-artifact **SHA-pin** verifier | upload-step existence only | `_verify_upload_artifact_step` (name-pattern + SHA-pin) |
| Static **merge-poison** CI guard | runtime-only (`auto_merge.py` raises) | AST scanner test asserts no direct `gh merge` / `adapter.merge_pr` outside `merge_authority` |
| Contract granularity | **flat** `WorkflowContract` (workflow-level) | **nested** `WorkflowContract → tuple[WorkflowJobContract]` |

This capability is the **only** thing justifying the continued existence of the foundation `aria/*` branches; integrating it onto `main` is the final step that makes them fully superseded and retireable (single-branch convergence goal).

**Critical constraints established by the design phase (architect + adversarial challenger):**
- The ARIA branches' contract **values** target a *different YAML generation*; **only the structure/verifiers** are portable. The contract values must be re-derived from `main`'s **live** workflow YAMLs.
- `main` already governs **all 9** ARIA workflows as full (flat) contracts with a `_verify_preflight_artifact` that checks network/token/hash — `main` is **not** a thin model. The integration must **add** the per-job layer **without regressing** main's existing verifiers.
- The registry + verifiers + preflight + tests are **one coupled unit**.

## Decision

Adopt the **nested per-job `WorkflowJobContract` model** as an **additive** layer on `main`'s current `workflow_contracts.py`, re-sourcing contract *structure* from the validated commit `13b94c505` and the static guard from `f557fc777`, with all contract *values* derived from `main`'s live YAMLs. Preserve every existing main verifier and invariant. Land as one PR with tests; `BREAKING CHANGE` footer for the `verify_workflow_preflight(job_id=...)` API.

### Implementation surface (file-by-file, from the cross-reviewed spec)

1. **new** `aria-kernel/aria_kernel/workflow_contract_registry.py` — `WorkflowJobContract`, nested `WorkflowContract`, `AuditedWorkflowExclusion(workflow_id, reason, owner, expires_at)`, `workflow_contract_registry()`, `workflow_job_contract()`, `workflow_hash()`, `workflow_contract_hash()`, `workflow_job_contract_hash()`. **Keep** the 3 `aria-kernel*` workflows as full single-job contracts (do **not** demote to audited-exclusions — see D1).
2. **rework** `aria-kernel/aria_kernel/workflow_contracts.py` — re-source `WORKFLOW_CONTRACTS` from the registry; **add** `verify_workflow_registry`/`WorkflowRegistryVerdict`, `_verify_job_contract`, `_verify_permissions`, `_verify_upload_artifact_step`, `_verify_audited_exclusions`, `_verify_preflight_call_shape`, `UPLOAD_ARTIFACT_ACTION` (= main's live `v7.0.1` SHA, **not** the canonical's stale pin — see D4); **preserve** main's existing flat verifiers (`_verify_preflight_artifact`, ordering, network/token).
3. **rework** `aria-kernel/aria_kernel/preflight.py` — add required `job_id` kwarg + per-job binding (`_normalise_runtime_path`, `_matches_contract_path`); **preserve** main's `allowed_token_provenance` github-app token-value allowlist in the no-contract path; update `preflight.__all__` (see D3).
4. **rewire** `aria-kernel/aria_kernel/docs_ssot.py` — iterate `contract.job_contracts` (the flat attrs it reads today vanish under nesting); `npm run aria:docs:ssot` must stay green.
5. **edit all 6** mutating workflow YAMLs (`aria-operational-proof`, `aria-agent-executor`, `aria-agent-eval`, `aria-daily-report`, `finding-state-sweep`, `rule-health-report`) — add `job_id=` to each `verify_workflow_preflight(...)` call; conform step names / retention / SHA-pinned upload-artifact to the contracts (see D2).
6. **port tests** `test_workflow_enterprise_preflight.py` (replace main's 9-test file, preserving its 3 security assertions) + **new** `test_readiness_merge_eval_static_invariants.py` (re-target whitelists to main's actual `merge_authority` API).

## Decision Points (require operator/kernel-owner sign-off)

| # | Decision | Recommended enterprise-default | Consequence |
|---|---|---|---|
| **D1** | Keep vs demote the 3 `aria-kernel*` test workflows' governance | **KEEP** as full contracts (more governance, not less) | Rejects the canonical's `AuditedWorkflowExclusion(expires_at=2026-07-05)` time-bomb |
| **D2** | 3 workflows (`aria-agent-eval`, `finding-state-sweep`, `rule-health-report`) have **no upload-artifact step** | **Add** a contract-conformant upload step | New CI artifacts + 7/365-day retention cost |
| **D3** | `preflight.__all__` is pinned by `test_phase_v9_0_c_preflight` to a 7-symbol set | **Amend** the pinned set in the same PR (with rationale) | Touches a deliberately-pinned public-API invariant |
| **D4** | `main` pins `actions/upload-artifact` at **two** SHAs | **Unify** on the verified `v7.0.1` SHA (`gh api`-confirmed) | Silently corrects a latent inconsistency |
| **D5** | `verify_workflow_preflight` gains a **required `job_id`** | Accept the **BREAKING CHANGE** (6 in-tree callsites updated; no out-of-tree consumers) | `BREAKING CHANGE:` footer required |
| **D6** | CLAUDE.md: "ARIA lives on snowball, no merge to main without explicit operator decision" | Operator has directed convergence to `main` — this ADR records that decision for a security surface | Policy gate satisfied by this ADR + PR review |

## Consequences

- **Closes a real security-governance gap**: per-job GHA permission verification, audited-exclusion expiry/ownership, upload-artifact SHA-pin enforcement, and a static merge-poison CI guard — none of which `main` has today.
- **Completes convergence**: with this integrated, the `aria/*` foundation branches hold zero unmerged unique value → archive + retire → `main` becomes the lone ARIA SSoT.
- **BREAKING CHANGE** to `verify_workflow_preflight` (kernel-internal; 6 callsites).
- **Largest mechanical surface** is YAML conformance (the canonical tests assert contract == live YAML); this is the main source of breakage and is gated by the ported tests.
- **Verification gate** before merge: full `aria-kernel` pytest green; `test_phase_v9_0_c_preflight` green; `verify_workflow_registry(repo)` dry-run returns `valid=True` with zero `failed_contracts`/`uncovered_workflows`; `aria:docs:ssot` green; sibling lint/CI gates unaffected. No partial landing.

## Alternatives Considered

- **Cherry-pick the canonical files verbatim** — REJECTED: targets a divergent YAML generation, carries a stale upload-artifact SHA, drops main's token allowlist, and demotes the 3 kernel-workflow contracts (governance regression). The challenger proved this turns main's pytest red.
- **Branch-merge an `aria/*` carrier** — FORBIDDEN: each carrier is 70+ commits behind main on platform + lacks main's plan-026R modules; a merge reverts main and re-pins `auto_merge.py` to the `snowball` base.
- **Leave main's flat governance as-is** — viable but leaves the per-job permission/expiry/SHA-pin gaps open and leaves the `aria/*` branches non-retireable (blocks single-branch convergence).

## References

- Convergence plan + forensic ledger: `docs/plans/2026-06-13-aria-to-main-controlled-merge/`
- Cross-checked unique-value sweep: workflow runs `wf_a61fe3da` + `wf_30624b9d`; design phase `wf_2d7738e2`
- Canonical source structure: `13b94c505` (registry/verifiers), `f557fc777` (static merge-poison guard)
- Sibling SSoT precedent (Item B): `implementation_rejections.py` (PR #455)
