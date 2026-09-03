<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 001 - Phase 0 Kernel Skeleton

## Goal

Define the smallest physical ARIA kernel that can run against this repository without modifying application code.

Phase 0 converts the PoC decision into a durable runtime skeleton:

- a small `aria-kernel/` Python package;
- an external workspace at `~/.aria/workspaces/<repo_hash>/`;
- append-only observation storage;
- a repeatable discovery cycle;
- an evidence chain validator;
- a budget gate;
- an unconditional kill switch.
- self-renewal feedback intake that records missed signals and derives pressure without birthing skills.

The kernel is infrastructure only. It observes, records, validates evidence, and stops safely.

## Non-goals

- No application code modification.
- No pull request creation.
- No skill genesis.
- No agent creation.
- No auto-fix loop.
- No production access.
- No direct Anthropic or other LLM SDK integration; Claude Code remains the execution host described in `docs/aria/CONTRACTS.md`.
- No in-repo durable private state beyond sanitized public reports, if explicitly requested by the operator.

## Physical artefacts

Phase 0 implementation is allowed to create only these new physical surfaces:

| Artefact | Location | Purpose |
|---|---|---|
| Kernel package | `aria-kernel/` | Small Python package for cycle orchestration, discovery, evidence validation, ledger writes, budget gate, and kill switch checks. |
| CLI entrypoint | `aria-kernel/aria_kernel/cli.py` | Local command invoked by Claude Code slash command or shell. |
| External workspace root | `~/.aria/workspaces/<repo_hash>/` | Durable ARIA state outside the repository working tree. |
| Workspace config | `~/.aria/workspaces/<repo_hash>/aria-config/*.json` | Human-controlled runtime config: budgets, include/exclude policy, kill switch path. |
| Observation ledger | `~/.aria/workspaces/<repo_hash>/aria-memory/observations.jsonl` | Append-only single-observation records. |
| Evidence ledger | `~/.aria/workspaces/<repo_hash>/aria-evidence/evidence_chains.jsonl` | Append-only evidence chain records with validator status. |
| Feedback ledgers | `~/.aria/workspaces/<repo_hash>/aria-memory/{unknowns,missed_signals,external_feedback,pressure}.jsonl` | Append-only self-renewal records and derived pressure. |
| Feedback index | `~/.aria/workspaces/<repo_hash>/aria-state/feedback_index.json` | Ledger hashes and emitted-pressure de-duplication. |
| Discovery artefacts | `~/.aria/workspaces/<repo_hash>/aria-coverage/*.json` | Per-cycle file fates, repository fingerprint, skip reasons, reconciliation summary. |
| Cycle state | `~/.aria/workspaces/<repo_hash>/aria-state/cycles/*.json` | Cycle open/close state, checkpoint hashes, stop reason. |
| Public report directory | `docs/aria/reports/` | Optional sanitized summaries only. Phase 0 must not write secrets or private observations here. |

The external workspace path is keyed by a stable repo hash derived from the repository absolute path plus git remote identity when available. Moving a checkout creates a new workspace unless the operator explicitly links it.

### Minimum package shape

```text
aria-kernel/
  pyproject.toml
  aria_kernel/
    __init__.py
    cli.py
    workspace.py
    discovery.py
    ledger.py
    evidence.py
    feedback.py
    budget.py
    kill_switch.py
    redaction.py
```

This package must stay boring. No plugin runtime, no skill loader, no agent registry, and no self-modification.

### Discovery cycle

Each cycle performs these steps:

1. Check kill switch.
2. Open cycle state record.
3. Load budget config and reserve cycle budget.
4. Walk filesystem with the exclusion policy.
5. Reconcile filesystem walk with `git ls-files`.
6. Assign every path one fate: `read_deeply`, `read_skimmed`, or `skipped_with_reason`.
7. Write discovery artefacts to the external workspace.
8. Record observations produced by deterministic scanners only.
9. Ingest feedback records and derive `UNKNOWN`, `REPETITION`, or `CONTRADICTION` pressure.
10. Validate evidence chains for any promoted observation.
11. Close cycle state with hashes for every written artefact.

### Required exclusions

Discovery must not treat these as application code:

- `agent-workspace/`
- `.aria-poc/`
- `node_modules/`
- `.git/`
- generated build output (`dist/`, `build/`, `coverage/`, `.next/`, `.nx/`, `target/`, `.turbo/`, `.cache/`)
- secret-bearing files identified by name or entropy scan
- generated output that is explicitly marked as generated

Skipped paths are still accounted for in coverage with a reason.

## Decision gates

### Gate 1 - Phase 0 entry

Phase 0 can start only when:

- `tools/aria-poc/poc.py` has run successfully on the target checkout;
- the operator has answered the PoC decision gate in favor of continuing;
- `docs/aria/SPEC.md`, `docs/aria/IDENTITY.md`, `docs/aria/CONTRACTS.md`, and this plan are present;
- no kernel code exists outside `aria-kernel/`;
- the workspace root can be created outside the repository.

### Gate 2 - Workspace safety

The kernel must fail closed if:

- the external workspace cannot be created;
- the workspace path resolves inside the repository;
- the workspace already belongs to a different repo hash;
- a ledger file is not append-only relative to the previous cycle hash.

### Gate 3 - Kill switch

The kill switch is checked:

- before every shell command;
- before every file write;
- before every scanner step that can exceed one second;
- before cycle close;
- after budget gate failure.

If active, the cycle halts within seconds and writes only a minimal stop record if that write is safe.

### Gate 4 - Budget gate

The budget gate is mandatory even before LLM work exists. It tracks:

- wall-clock cycle time;
- file count read deeply;
- bytes read;
- subprocess count;
- optional Claude Code cost telemetry when available.

Soft limit at 80 percent writes a warning observation. Hard limit at 100 percent activates the kill-switch halt path. A cycle must not continue past the hard limit.

### Gate 5 - Evidence chain validator

An observation can be promoted to a candidate finding only when its evidence chain:

- uses current repository paths and line references where applicable;
- carries evidence source type;
- has no self-output as evidence;
- has no repo content interpreted as instruction;
- has at least two independent evidence records for confirmed findings;
- records absence claims as scoped absence, never universal absence.

Phase 0 may validate chains, but it must not publish confirmed findings as authoritative bug reports unless the operator explicitly asks for the experimental report.

### Gate 6 - Self-renewal feedback

Phase 0 records missed signals, unknown capabilities, external contradictions, and false-positive reports as untrusted feedback. It may derive pressure from repeated records, but it must not create skills or agents.

Self-renewal feedback follows `docs/aria/plans/004-self-renewal-feedback-loop.md`.

## Acceptance tests

Phase 0 is accepted only when these tests pass:

- Running the kernel twice on the same repo reuses the same external workspace and remembers prior observations.
- Every `git ls-files` path receives a fate or a reconciliation reason.
- `agent-workspace/`, `.aria-poc/`, generated output, and secret-like files are excluded from application-code scanning.
- The observation ledger is append-only and detects truncation or mutation between cycles.
- The evidence chain validator rejects evidence that depends on prior ARIA output.
- The kill switch stops a cycle mid-discovery.
- The budget gate stops a cycle mid-discovery when configured with a deliberately tiny hard limit.
- One missed signal is recorded but does not birth a skill.
- Three independent missed signals with the same capability gap emit pressure.
- No application file changes after a Phase 0 cycle.
- No `.claude/agents/aria-*.md` files are created in Phase 0.
- No PR branch, commit, or pull request is created in Phase 0.
