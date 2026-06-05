# ARIA Current State

Date: 2026-05-31
Target ref: `origin/main`
Last verified commit: `ffdef128aee928ba09f8fceb847fa56ab6caa334`
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
- Merge authority: `aria-kernel/aria_kernel/auto_merge.py::merge_if_green`
- Executor implementation: `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, `tools/aria-poc/codex_runtime.py`
- Runtime artifact safety boundary: `aria-kernel/aria_kernel/artifact_safety.py`

## Runtime

ARIA live autonomous execution is Codex CLI based and must use ChatGPT-managed Codex CLI authentication on a trusted/private runner. Direct API-key runtime mode is not the default authority for this repository.

Legacy Claude/Anthropic executor language in older docs is historical or compatibility reference unless an executable contract explicitly calls it. Any live doc section that treats Claude Code, Anthropic API keys, or `llm_bridge.py` as the current ARIA runtime authority is a documentation defect.

## State And Lifecycle

`state_manifest.py` is the inventory for write-driving ledgers, runtime state, indexes, locks, and artifacts. Runtime writes that can drive future behavior must be declared there before they are trusted by autonomy.

`runtime_profile.py` is the single write-authorization boundary for profile-aware surfaces. The live profile taxonomy is `observe`, `standard`, `strict`, `frozen`, and `autonomous`.

`runtime_artifacts.py` owns artifact graph verification. Promotion evidence must be artifact-bearing, hash-bound, path-contained, indexed, and connected to the relevant cycle/run ledgers. Lifecycle-only cycles do not authorize promotion.

`agent_surface.py` owns request roles, invocation roles, dispatchable roles, bridge-required roles, target-agent whitelist, role-target pairing, and derived request lifecycle labels. Callers must consume that SSoT rather than maintaining local role sets.

## Readiness / Merge / Eval Proof Closure

This closure is a contract anchor only. It does not make generated documentation the SSoT, burn-in remains open, and full autonomy closure remains governed by the follow-up burn-in/docs SSoT plan.

- Readiness proof: enterprise merge readiness is owned by `aria-kernel/aria_kernel/enterprise_readiness.py::verify_enterprise_readiness` and requires typed, hash-chained CAS, branch-protection, workflow-run, artifact, rollback, retention, DLP, token, and waiver ledger rows bound to the same PR, target ref, head ref, head SHA, repository, and readiness claim id.
- Merge authority: `aria-kernel/aria_kernel/auto_merge.py::merge_if_green` is evaluate-only. The only production merge authority is `aria-kernel/aria_kernel/merge_authority.py::merge_if_authorized`, which re-runs auto-merge evaluation, verifies enterprise readiness, re-evaluates the fresh PR snapshot, enforces the PR/change/validation triple gate, and only then calls `aria-kernel/aria_kernel/merge_authority.py::execute_gh_squash_merge` for `gh pr merge --squash --match-head-commit`.
- Eval provenance: real-mode agent eval rows are authoritative only when `aria-kernel/aria_kernel/agent_eval.py::run_agent_eval` records `provenance_mode`, `invocation_id`, `transcript_hash`, result/context/prompt/transcript ledger hashes, joins a fixture, accepted invocation result, context hash, prompt hash, transcript ledger row, and operator approval ref. Legacy envelope-feed evals do not satisfy real eval proof.
- Evidence trust: promotion, readiness, and merge evidence must be runtime-verified, artifact-bearing, hash-bound, path-contained, source-surface declared, and ledger-connected before it can drive future behavior.
- Fail-closed bypass classes: direct merge bypass, production import from test helpers, unproven real-mode eval envelope feed, missing artifact/evidence hash binding, missing PR-to-change binding, stale head SHA, unreadable branch protection or checks, unresolved review state, and lifecycle-only promotion evidence.

## Clean Trial Rule

A clean ARIA trial must run from an isolated worktree at the declared target commit. Existing detached or dirty operator worktrees are not validation surfaces. Every runtime command in a trial must receive an explicit bound `--tools-dir` and `--workspace-root`; repo-local shadow roots such as `aria-kernel/aria-tools/` are invalid.

## Documentation State

The ARIA docs set contains historical material. Sections still saying only the PoC exists, the kernel does not exist, live runtime is Claude/Anthropic, or auto-merge is categorically impossible are superseded unless explicitly restated by this file and the executable contracts above.
