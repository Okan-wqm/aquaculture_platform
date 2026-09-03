<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# 005 Adapter Skill Health Governance

## Status

Implemented enterprise local kernel surface with executable guardrails, fixture gate, evidence validation, feedback ledger, and strict promotion commands.

## Problem

ARIA can run adapters and skills that inspect repository state and emit observations or findings. If one of those tools drifts, reads generated ARIA output as if it were application code, cites weak evidence, or produces repeated false positives, ARIA needs a deterministic stop mechanism. Reporting the failure is not enough because an unhealthy tool can keep producing operator-facing noise.

## Decision

Govern adapters and skills together through a registry, run ledger, health evaluator, health-hold decision point, and calibration recovery path.

The v1 implementation is intentionally local and file-backed:

- `aria-tools/registry.json` stores tool definitions.
- `aria-tools/runs.jsonl` stores run envelopes.
- `aria-tools/health.jsonl` stores health decisions.
- `aria-tools/quarantine.jsonl` stores quarantine events.
- `aria-tools/calibration.jsonl` stores calibration events.
- `aria-tools/fixtures/<tool_id>/` stores fixture inputs and expected outputs.
- `aria-tools/fixture-runs.jsonl` stores fixture suite results.
- `aria-tools/findings.jsonl` stores emitted operator-facing findings.
- `aria-tools/operator-feedback.jsonl` stores true/false-positive judgements.

## Kernel Surface

The governance kernel lives in `aria-kernel/aria_kernel`:

- `tool_registry.py` validates and stores adapter, skill, and LLM-amplified skill definitions.
- `tool_health.py` records run envelopes, computes health metrics, and applies automatic quarantine or calibration.
- `tool_runner.py` executes registered subprocess tools, hashes inputs and outputs, validates stdout JSON, snapshots repository state, and records runs through the health evaluator.
- `fixture_runner.py` executes deterministic fixture cases before promotion.
- `evidence_validator.py` verifies finding evidence paths and line references before a run can stay healthy.
- `feedback_store.py` tracks emitted findings and operator feedback.
- `promotion.py` enforces strict lifecycle gates.
- `quarantine.py` centralizes quarantine events.
- `cli.py` exposes the local command surface.

CLI commands:

```bash
aria-kernel tool register --file <json>
aria-kernel tool record-run --file <json>
aria-kernel tool run --tool-id <id> --input <json> --cycle-id <id>
aria-kernel fixture run --tool-id <id> --workspace-root <path> --cycle-id <id>
aria-kernel tool promote --tool-id <id> --to SHADOW|ACTIVE --reason <text>
aria-kernel finding list --tool-id <id>
aria-kernel feedback record --tool-id <id> --run-id <id> --finding-id <id> --verdict true_positive|false_positive --severity medium --note <text>
aria-kernel db snapshot --service farm --output <json>
aria-kernel tool health --tool-id <id>
aria-kernel tool quarantine --tool-id <id> --reason <reason>
aria-kernel tool list --status ACTIVE
```

For direct source-tree execution without installing the package:

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel tool health --tool-id <id>
```

## Lifecycle

Tool states:

```text
DRAFT -> SANDBOX -> SHADOW -> ACTIVE -> CALIBRATE -> QUARANTINED -> ARCHIVED
```

Rules:

- Only `ACTIVE` tools may emit operator-facing observations or findings.
- `SHADOW` tools may run comparisons but cannot emit operator-facing output.
- `CALIBRATE` tools may run fixtures and shadow comparisons only.
- `QUARANTINED` tools cannot emit observations or findings; they may only run fixture or calibration jobs.
- `ARCHIVED` tools are retained for historical traceability.

## Tool Registry Schema

Required fields:

- `tool_id`
- `kind`: `adapter`, `skill`, or `llm_amplified_skill`
- `version`
- `status`
- `declared_scope`
- `output_schema`
- `fixture_set`
- `health_thresholds`
- `allowed_read_globs`
- `forbidden_read_globs`
- `claim_types`
- `owner`
- `schema_version`
- `runner`: required for `SANDBOX`, `SHADOW`, `ACTIVE`, and `CALIBRATE`

Runner fields:

- `type`: currently only `subprocess`
- `argv`: command list passed directly to `subprocess.run` without a shell
- `cwd`: workspace-root-relative working directory
- `timeout_ms`: positive integer hard timeout
- `stdin_json`: when true, the runner input payload is sent as JSON on stdin

`DRAFT`, `QUARANTINED`, and `ARCHIVED` definitions may exist without a runner. Normal `tool run` refuses `QUARANTINED` tools. Fixture execution is handled by `fixture run` and records only fixture results, not operator-facing findings.

Default v1 thresholds:

- precision minimum: `0.85`
- critical false positives: `0`
- non-critical false positives: `3 in 30 days`
- crash rate: `20% over last 10 runs`

## Run Ledger Schema

Required fields:

- `run_id`
- `tool_id`
- `cycle_id`
- `status`: `ok`, `schema_error`, `scope_violation`, `evidence_error`, `crash`, or `budget_exceeded`
- `input_hash`
- `output_hash`
- `read_paths`
- `emitted_observations`
- `emitted_findings`
- `evidence_validation`: includes evidence sources, validation errors, checked sources, self-output evidence flag, and repository mutation flag
- `operator_feedback_refs`
- `duration_ms`
- `cost_units`
- `schema_version`

`tool run` produces these envelopes automatically. Tool stdout must be a JSON object with:

- `observations`: array
- `findings`: array
- `read_paths`: array
- `evidence_sources`: array

Optional stdout fields are `cost_units` and `metadata`. Fields listed in `output_schema.required` must also be present. Invalid JSON or missing required fields records a `schema_error` run.

## Immediate Auto-Quarantine

A tool moves to `QUARANTINED` immediately when a recorded run shows any of these conditions:

- reads outside `allowed_read_globs`;
- reads generated or unsafe paths such as `agent-workspace/`, `.aria-poc/`, `aria-tools/`, `secrets/`, or `.env*`;
- emits evidence sourced from ARIA's previous output;
- cites missing evidence, a missing path, or a line outside the cited file;
- emits invalid output schema;
- attempts repository mutation;
- produces one operator-confirmed critical false positive;
- crashes in a way that corrupts ledger state.

The v1 sandbox is detect-and-quarantine rather than an OS-level write block. The runner snapshots workspace state before and after the subprocess. In a git workspace it compares `git status --porcelain -z`; outside git it falls back to a directory content snapshot. ARIA ledger writes happen after the second snapshot, so the runner's own `aria-tools/*.jsonl` writes are not counted as repository mutation. If the tool changes the workspace during execution, the run records `evidence_validation.repository_mutation_attempt=true` and the health evaluator quarantines the tool.

Only `ACTIVE` tools can emit operator-facing observations and findings. `SANDBOX`, `SHADOW`, and `CALIBRATE` tools may execute, but the runner stores empty `emitted_observations` and `emitted_findings` arrays while preserving raw-output traceability through `output_hash`.

## Auto-Calibration

A tool moves to `CALIBRATE`, not `QUARANTINED`, when it shows degraded but recoverable behavior:

- precision below `0.85` after at least `10` judged samples;
- three non-critical false positives in 30 days;
- repeated contradiction with another `ACTIVE` tool;
- crash rate above `20%` over the last 10 runs;
- budget use above declared cap twice in 7 days.

## Recovery

Recovery is staged and explicit:

- `QUARANTINED -> CALIBRATE` requires a root-cause note and fixture update reference.
- `CALIBRATE -> SHADOW` requires the latest fixture suite to pass.
- `SHADOW -> ACTIVE` requires the latest fixture suite to pass, five consecutive clean shadow runs, precision at or above threshold, zero critical false positives, valid evidence chains, and operator approval.
- Findings previously emitted by a quarantined tool must be revalidated. Unsupported findings are withdrawn or downgraded to observations.

## Verification

```bash
PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'
python3 -m unittest discover tools/aria-poc -p '*test*.py'
rg "QUARANTINED|CALIBRATE|tool_id|scope_violation|self-output evidence" docs/aria aria-kernel
rg "tool run|runner|repository_mutation_attempt|scope_violation|QUARANTINED|CALIBRATE" aria-kernel docs/aria
```

## Non-Goals

- This does not build real AST adapters or detector skills.
- This does not allow ARIA to mutate application code.
- This does not promote quarantined findings automatically.
- This does not replace operator approval for `ACTIVE` promotion.
