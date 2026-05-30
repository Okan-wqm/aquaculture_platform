# ARIA Current State

Date: 2026-05-26
Branch: `snowball`

## Normative Sources

Executable code and machine-checked contracts are normative for ARIA. Historical docs, older plans, and Claude-era runbooks are non-normative when they conflict with code.

Current normative anchors:

- Codex runtime contract: `tools/aria-poc/ci_executor_contract_proven.md`
- Executor implementation: `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, `tools/aria-poc/codex_runtime.py`
- Merge authority: `aria-kernel/aria_kernel/auto_merge.py::merge_if_green`
- State surface inventory: `aria-kernel/aria_kernel/state_manifest.py`
- Autonomous lease authority: `aria-kernel/aria_kernel/autonomous_host_lease.py::acquire_remote_cas_lease`
- Artifact safety boundary: `aria-kernel/aria_kernel/artifact_safety.py`
- Agent instruction style: `docs/aria/AGENT_INSTRUCTION_STYLE.md`
- Agent role/lifecycle SSoT: `aria-kernel/aria_kernel/agent_surface.py`
- Transactional ledger primitive: `aria-kernel/aria_kernel/ledger.py::state_transaction`

## Runtime

ARIA is being migrated to Codex CLI. Live autonomous agent execution must use ChatGPT-managed Codex CLI auth on a trusted/private runner. API-key mode is not allowed by default because the project relies on an existing ChatGPT/Codex account and must not open an extra API-billing path.

Legacy Claude/Anthropic executor docs and variables are superseded for ARIA runtime. They may remain only as historical records or compatibility references and must not be treated as live authority.

## State And Lifecycle

`state_manifest.py` declares write-driving ledgers, queue surfaces, lock files, and artifacts. New queue/ack lifecycle writes use `state_transaction()` for ordered locks plus strict reads before append. Ack consumption is append-only: new consumes append `aria/ack-consumption/v1` rows; old rows with populated `consumed_at` remain readable as legacy consumed tokens.

`agent_surface.py` owns request roles, invocation roles, dispatchable roles, bridge-required roles, target-agent whitelist, role-target pairing, and derived request lifecycle labels. `agent_contract.py`, `agent_invocations.py`, `dispatcher_factory.py`, bridge modules, and the Codex executor consume that SSoT instead of maintaining independent role sets.

## Merge

`merge_if_green` is the only real merge executor. Legacy V9 implementation merge APIs are demoted and must fail closed instead of invoking direct `gh pr merge` flows.

## Documentation

The ARIA docs set contains historical material. Any document that still says the kernel/orchestrator/contracts do not exist, or that references Claude as the live executor, must be updated, generated from code, or marked historical/superseded.
