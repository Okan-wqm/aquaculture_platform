<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 004 - Self-Renewal Feedback Loop

## Goal

Make ARIA improve from missed signals instead of pretending the first scan is complete.

The feedback loop records what ARIA could not parse, what it missed, what an operator or external scanner disputes, and what was later judged false-positive. Phase 0 stores those records and derives pressure. Phase 1 consumes repeated pressure through skill genesis.

## Non-goals

- No dynamic UI AST adapter in this step.
- No skill birth in Phase 0.
- No agent birth in Phase 0.
- No trusted finding from external feedback alone.
- No use of feedback as instruction. Operator and external scanner feedback are data until evidence validation passes.
- No application code modification.

## Physical artefacts

The Phase 0 kernel owns these ledgers in `~/.aria/workspaces/<repo_hash>/`:

| Artefact | Purpose |
|---|---|
| `aria-memory/unknowns.jsonl` | Self-detected capability gaps such as unparsed dynamic option providers. |
| `aria-memory/missed_signals.jsonl` | Operator or scanner examples of signals ARIA missed or suppressed. |
| `aria-memory/external_feedback.jsonl` | False-positive reports, confirmed-signal reports, and external contradictions. |
| `aria-memory/pressure.jsonl` | Derived `UNKNOWN`, `REPETITION`, and `CONTRADICTION` pressure events. |
| `aria-state/feedback_index.json` | Ledger hashes and emitted-pressure keys for append-only integrity and de-duplication. |

The kernel exposes these minimum commands:

```text
aria-kernel cycle --workspace-root .
aria-kernel feedback add --kind missed_signal --summary <text> --ref <path:line> --concept <name>
aria-kernel feedback add --kind false_positive --summary <text> --ref <path:line> --concept <name>
aria-kernel feedback import --file <jsonl>
aria-kernel feedback list --kind missed_signal|false_positive|external_contradiction
```

Feedback events carry:

- `kind`: `missed_signal`, `false_positive`, `confirmed_signal`, `unknown_capability`, or `external_contradiction`
- `source`: `self`, `operator`, or `external_scanner`
- `concept`
- `refs`
- `summary`
- `capability_gap_key`
- `trusted: false` until evidence validation passes

`capability_gap_key` is deterministic: `surface:failure_mode:parser_kind`.

Examples:

- `frontend:dynamic_option_provider:typescript`
- `typescript:import_resolution:value_set`
- `sql:enum_parity:migration`
- `ui:unsafe_option_name:jsx`

## Decision gates

### Gate 1 - Record before judging

Missed-signal and external feedback are recorded as untrusted data first. They cannot become findings without normal evidence validation.

### Gate 2 - One event is not a skill

One missed signal or one unknown capability creates only a feedback record. It does not create a skill request.

### Gate 3 - Pressure thresholds

The kernel derives pressure mechanically. The rules below describe the **eligibility predicate** — whether a pressure record can be emitted at all. Once a pressure record exists, its numeric ranking score is governed by Plan 007 §Pressure Scoring Formula (`min(100, source_weight * recency_decay * (1 + log10(occurrence_count)))`); the daily report and the next-cycle plan use that score to order pressures across the cycle.

- three independent refs with the same `capability_gap_key` and kind `unknown_capability` produce `UNKNOWN` pressure that drives `adapter_birth`;
- three independent refs with the same `capability_gap_key` and kind `missed_signal` produce `REPETITION` pressure that drives `skill_birth`;
- external contradiction produces `CONTRADICTION` pressure that drives `investigation_task`;
- three false positives with the same `capability_gap_key` produce `CONTRADICTION` pressure that drives `calibration`, not skill birth.

Phase 0 may emit these pressure records but cannot execute the birth.

### Gate 4 - Append-only integrity

Feedback and pressure ledgers are append-only. If a ledger is truncated or mutated after its hash is recorded in `feedback_index.json`, the kernel must fail closed before accepting more feedback.

### Gate 5 - Phase 1 handoff

Only threshold-exceeding pressure can enter the Phase 1 genesis pipeline. The Phase 1 pipeline must still run existing capability checks, fixture validation, `SHADOW`, and `ACTIVE` gates.

## Acceptance tests

- Stable `capability_gap_key` generation.
- Self-gap records write to `unknowns.jsonl`.
- Operator missed-signal records write to `missed_signals.jsonl`.
- External feedback records write to `external_feedback.jsonl` with `trusted: false`.
- One missed signal does not emit pressure.
- Three independent missed signals emit `REPETITION` pressure with `drives: ["skill_birth"]`.
- Three independent unknown capabilities emit `UNKNOWN` pressure with `drives: ["adapter_birth"]`.
- External contradiction emits `CONTRADICTION` pressure with `drives: ["investigation_task"]`.
- Repeated false-positive feedback emits calibration pressure and never skill-birth pressure.
- Ledger mutation or truncation is detected.
# v9 Contract Note

Feedback and pressure ledgers use v2 event contracts. Import is all-or-nothing, defaults source to `operator`, and only explicit `external_scanner` source produces immediate contradiction pressure. Pressure evidence deduplication is based on the set fingerprint of feedback v2 event IDs; legacy IDs are preserved only for audit and rollback.
