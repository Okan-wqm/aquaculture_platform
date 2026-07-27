# ARIA Current State

Date: 2026-06-21
Target ref: `origin/main`
Last verified ARIA authority hash: `ff3de61b0c8e4c3f14d691d775b76237410389fbf20cf4ecb6beb11f163bf6e2`
Status: post-snowball mainline hardening in progress

## Authority Chain

ARIA authority is ordered and fail-closed:

1. Executable code and machine-checked contracts are normative.
2. This file is the live human-readable state index.
3. Accepted ADRs are normative only when they do not contradict executable contracts or this file.
4. `SPEC.md`, `CONTRACTS.md`, `IDENTITY.md`, `ROADMAP.md`, and `docs/aria/plans/**` are live only in sections that are not marked historical, superseded, or compatibility reference.
5. Historical snowball/Claude-era docs are evidence of design history, not runtime authority.

When two sources disagree, the lower-priority source must be updated, generated from code, or explicitly marked historical. Runtime behavior must not be inferred from stale prose.

## Current Normative Anchors

- Runtime CLI and public surface: `aria-kernel/aria_kernel/cli.py`
- Runtime profile and write authorization: `aria-kernel/aria_kernel/runtime_profile.py`
- State surface inventory: `aria-kernel/aria_kernel/state_manifest.py`
- Tools root identity and binding: `aria-kernel/aria_kernel/tool_registry.py`
- Runtime artifact graph and v2 approval: `aria-kernel/aria_kernel/runtime_artifacts.py`
- Run envelope/status owner: `aria-kernel/aria_kernel/tool_health.py`
- Strict run-ledger reader/upcaster: `aria-kernel/aria_kernel/runs_reader.py`
- Agent role/lifecycle SSoT: `aria-kernel/aria_kernel/agent_surface.py`
- Agent request/response contract: `aria-kernel/aria_kernel/agent_contract.py`
- Transactional append/index primitive: `aria-kernel/aria_kernel/ledger.py`
- Merge authority: `aria-kernel/aria_kernel/merge_authority.py::merge_pr_if_ready`
- Enterprise risk policy owner: `aria-kernel/aria_kernel/risk_policy.py`
- Enterprise autonomy unlock owner: `aria-kernel/aria_kernel/autonomy_unlock.py`
- L3 policy approval owner: `aria-kernel/aria_kernel/policy_approval.py`
- Rollback bundle owner: `aria-kernel/aria_kernel/rollback_bundle.py`
- Incident ledger owner: `aria-kernel/aria_kernel/incident_ledger.py`
- Runner attestation owner: `aria-kernel/aria_kernel/runner_attestation.py`
- Capability resolution owner: `aria-kernel/aria_kernel/capability_resolver.py`
- Required PR merge check: `.github/workflows/aria-merge-authority.yml`
- Executor implementation: `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, `tools/aria-poc/claude_runtime.py`
- Runtime artifact safety boundary: `aria-kernel/aria_kernel/artifact_safety.py`
- Enterprise autonomy burn-in: `aria-kernel/aria_kernel/burn_in.py`
- Observe burn-in report schema: `docs/aria/schemas/autonomy-burn-in-report.schema.json`

## Runtime

ARIA live autonomous execution is Claude Code CLI based and must use a managed Claude Code login session on a trusted/private runner. Direct API-key / proxy-billing runtime mode is not the default authority for this repository.

Legacy Codex executor language in older docs is historical or compatibility reference unless an executable contract explicitly calls it. Any live doc section that treats `codex exec`, ChatGPT-managed Codex auth, or `codex_runtime.py` as the current ARIA runtime authority is a documentation defect.

## State And Lifecycle

`state_manifest.py` is the inventory for write-driving ledgers, runtime state, indexes, locks, and artifacts. Runtime writes that can drive future behavior must be declared there before they are trusted by autonomy.

`runtime_profile.py` is the single write-authorization boundary for profile-aware surfaces. The live profile taxonomy is `observe`, `standard`, `strict`, `frozen`, and `autonomous`.

`runtime_artifacts.py` owns artifact graph verification. Promotion evidence must be artifact-bearing, hash-bound, path-contained, indexed, and connected to the relevant cycle/run ledgers. Lifecycle-only cycles do not authorize promotion.

`ARIA Operational Proof` is the GitHub Actions proof lane for isolated temp-tools runtime verification and strict/mock autonomy smoke. It must not write repo-local ARIA runtime state.

`agent_surface.py` owns request roles, invocation roles, dispatchable roles, bridge-required roles, target-agent whitelist, role-target pairing, and derived request lifecycle labels. Callers must consume that SSoT rather than maintaining local role sets.

`autonomy burn-in observe` is the first enterprise autonomy acceptance slice. It runs discovery, memory, pressure, and triage for exactly 30 observe attempts with at least 20 valid cycles, and fails if agent claims, tool runs, PR lifecycle, runtime promotions, or agent/skill materializations are observed. It is not a full autonomous merge proof.

## Clean Trial Rule

A clean ARIA trial must run from an isolated worktree at the declared target commit. Existing detached or dirty operator worktrees are not validation surfaces. Every runtime command in a trial must receive an explicit bound `--tools-dir` and `--workspace-root`; repo-local shadow roots such as `aria-kernel/aria-tools/` are invalid.

## Documentation State

The ARIA docs set contains historical material. Sections still saying only the PoC exists, the kernel does not exist, live runtime is Claude/Anthropic, or auto-merge is categorically impossible are superseded unless explicitly restated by this file and the executable contracts above.

For the bilingual architecture explainer with diagrams, see `docs/aria/ARCHITECTURE.md`. That document is explanatory only: it must defer to this file, executable contracts, and machine-checked invariants whenever there is a conflict.

For the enterprise autonomy SSoT and burn-in acceptance matrix, see `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`.

On 2026-06-20, `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md` records the accepted
production-autonomy target decisions: full production autonomy, whole-repo
risk-gating, L3 two-stage human policy approval before ARIA merge execution,
rollback bundle plus incident ledger, L2 unlock after 30 supervised successes,
hybrid GitHub Actions plus private-runner runtime, hybrid GitHub App plus
`GITHUB_TOKEN` token model, kernel plus required-check plus CODEOWNERS merge
authority, and hybrid ledger/state authority. This record is not live merge
permission; live authority still requires the machine-readable policy files,
schemas, executable owners, required GitHub check, CODEOWNERS ownership,
state-manifest declarations, and invariants listed in that SSoT.
