<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 029 — Runtime-signal bridge (D5)

> **Status:** Implemented (runtime signals enter as unverified leads → pressure). Source-connector ingestion + CLI tracked as ARIA-029-D1.
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-023-D5 (no runtime-signal bridge; runtime-only bugs structurally invisible).

## Summary

ARIA's evidence allowlist is closed to repo-resident sources, and that is
load-bearing — the hallucination-resistance comes from "trust evidence, not
assertions". The cost: a bug visible only at runtime (a Sentry error, a prod
incident, a telemetry anomaly) was structurally invisible, because it cannot be
repo-verified and so had no way in. On an IoT/SCADA platform the most expensive
failures surface in the field.

## Implementation (tier-2 "make it automatic", with the trust boundary intact)

New `aria_kernel/runtime_signal_bridge.py` lets runtime signals in **without
corrupting the trust foundation**:

- `ingest_runtime_signal(*, source, service, summary, code_refs, severity)` —
  records a signal (source ∈ sentry / incident / prod_log / telemetry / operator
  / external_scanner) as a distinct, explicitly **UNVERIFIED** lead
  (`trust_grade = "runtime_unverified"`), one per-signal file under
  `runtime-signals/`, idempotent by content hash. It is **not** evidence and is
  never repo-graded.
- `run_pressure` reads each open signal and emits a `runtime_signal` pressure
  (UNKNOWN, weight 85 — below `tool_quarantine`, above `evidence_gone`) whose
  recommended action makes the unverified status explicit: *investigate the
  referenced area with repo evidence; confirm against the repo before treating
  it as a finding*. So the signal decides **where to look**; the repo evidence
  still decides **what is true**. A finding born from a runtime lead passes the
  same evidence gate as any other (Plan 024 §C).
- `resolve_runtime_signal` closes a signal once investigated, so it stops driving
  pressure.

No cycle-phase change is needed — `run_pressure` already runs every cycle and
reflection already surfaces pressures, so runtime signals flow through the
existing pressure → investigation → reflection path.

## Acceptance

- An ingested signal is marked `runtime_unverified`/`open`; ingestion is
  idempotent; bad source / empty code_refs are rejected.
- An open signal becomes a `runtime_signal` pressure carrying the code_refs and
  an UNVERIFIED recommended action; a resolved signal stops producing pressure.
- Test: `tests/test_runtime_signal_bridge.py`.

## Assumptions & deferred — ARIA-029-D1 (owner: aria-core, due 2026-10-25)

- The bridge is the **ingestion contract**; the actual source connectors (a
  Sentry webhook, an incident-postmortem importer, a log-anomaly tap) and the
  operator CLI `aria-kernel runtime-signal ingest|resolve` are deferred (the CLI
  held back to avoid destabilising `cli.py`'s invariant surface, as with the
  Plan 025 goldset CLI). The kernel functions are complete and callable.
- This also lands the event-feed half that Plan 028 §D4 (ARIA-028-D1) needs: a
  CVE / external-contract event is the same shape — an unverified external lead
  that should drive `needs_revalidation` of the touched beliefs. Wiring runtime
  signals to belief revalidation (not just tool pressure) is the natural next
  step.
