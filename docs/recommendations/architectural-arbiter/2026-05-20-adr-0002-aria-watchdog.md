# ADR-0002 — ARIA-Watchdog Daemon Governance

**Status:** accepted
**Date:** 2026-05-20
**Branch:** snowball
**Resolves:** ARCH-HIGH-001 (claim_type semantic collapse), ARCH-HIGH-004 (3-daemon ARIA_STOP coordination), AISAFETY-CRIT-002 (sanitizer at emit_finding), AISAFETY-HIGH-008 (originating_skill allowlist)
**Plan reference:** `/root/.claude/plans/immutable-sparking-waterfall.md` §B

## Context

V10.5 Phase 1 introduces ARIA-Watchdog: a read-only daemon that polls `governance.jsonl` + `autonomy_state.jsonl` every 60s, emits findings via existing `finding.emit_finding`. The architectural-arbiter + ai-safety-auditor + code-reviewer audits identified several decisions that must be locked down BEFORE the daemon ships:

1. **Claim type semantic collapse risk** — using `convention_inconsistency` for runtime-state-machine anomalies confuses the taxonomy
2. **Multi-daemon ARIA_STOP coordination** — watchdog becomes the 4th writer (alongside planner-dispatch + worker-dispatch + ci_executor) to `governance.jsonl`
3. **Finding emit sanitizer gap** — `emit_finding` natural-language fields bypass `text_safety.sanitize_untrusted_text`
4. **Originating_skill spoofability** — free-text field permits external callers to forge `aria-watchdog:*` prefix
5. **Finding ID race** — concurrent `_allocate_finding_id` calls produce same ID (TOCTOU)
6. **Performance: full-file governance read** — O(N²) over endurance lifetime

## Decision

### 1. New `claim_type`: `operational_anomaly`

Add to `aria-kernel/aria_kernel/finding.py` `CLAIM_TYPES` table:

```python
CLAIM_TYPES["operational_anomaly"] = {
    "min_severity": "LOW",
    "min_evidence": 3,
    "label": "Runtime state-machine anomaly observed by ARIA-Watchdog",
}
```

Rationale: `convention_inconsistency` semantically means "naming/spelling/format inconsistency across a code surface" (per V8 belief graph). Reusing it for runtime anomalies (stall, repeated bridge_warning) is a polysemic collapse. The new `operational_anomaly` claim_type carries the same severity floor (LOW) + min_evidence (3 — matches dedup-threshold semantics) but preserves the taxonomy distinction.

### 2. Watchdog daemon ARIA_STOP semantics

Watchdog launches as a 4th background daemon via `python -m aria_kernel scheduler watchdog run`. ARIA_STOP coordination follows the existing pattern at `autonomous_planner_dispatcher.py:121`:

- Each iteration's first action is `aria_stop_path.exists()` check
- If present: detector run completes (detectors are pure functions, safe to finish) but emission for the current iteration is SKIPPED
- Daemon exits clean with `exit_reason=aria_stop` governance event

Mid-iteration finding-emission SKIP is the architectural choice: detectors are fast (<1s); emissions involve fcntl lock + atomic write + governance event (50-200ms) which is the operator-visible side effect that should be controllable. Skipping the emission while completing detection ensures clean stop without partial finding writes.

Invariant test #12 in `test_phase_v10_5_aria_watchdog.py` validates this: spawn watchdog, write ARIA_STOP mid-iteration, assert zero new findings on disk + clean `aria_watchdog_daemon_exit` governance event.

### 3. Sanitizer at emit_finding (Tier-1)

Every string field passed to `finding.emit_finding` runs through `text_safety.sanitize_untrusted_text(value, max_len=...)` BEFORE write. Fields covered:
- `claim_summary` (max_len=512)
- `facts[]` entries (max_len=1024 each)
- `interpretations[].text` (max_len=2048)
- `recommendation` and nested fields (max_len=512)
- `scope.files[]` entries (max_len=256, must additionally match repo-relative path regex)
- `originating_skill` (max_len=128, additionally must match ORIGINATING_SKILL_ALLOWLIST)

Per AISAFETY-CRIT-002: banned-phrase grep ≠ injection sanitizer. Both gates apply; sanitizer first (rejects U+200B-F + U+202A-E + control chars + structural HTML chars), banned-phrase second (rejects deferral excuse vocabulary).

### 4. ORIGINATING_SKILL_ALLOWLIST (Tier-1)

`finding.py` adds:

```python
ORIGINATING_SKILL_ALLOWLIST: frozenset[str] = frozenset({
    "manual:operator",
    "aria-watchdog:stall",
    "aria-watchdog:bridge_warning_repeat",
    "report_ingestion:external_pr",
    # Future watchdog detectors register here; rejection_repeat +
    # phase_asymmetry are V10.6 scope (F-AUTO-V10.6-EXTRA-DETECTORS).
})
```

`emit_finding` raises `GovernanceError("originating_skill {value!r} not in ORIGINATING_SKILL_ALLOWLIST")` on unknown value. The watchdog daemon emits with its declared skill; an external (report_ingestion) caller cannot forge an `aria-watchdog:*` prefix.

### 5. Finding ID race fix: fcntl lock on `_allocate_finding_id`

Per ARCH-CRIT-002, `_allocate_finding_id` is not concurrency-safe. The fix wraps allocation + write in `with_exclusive_lock(findings_dir / ".alloc.lock", timeout_seconds=5.0)`:

```python
def emit_finding(...) -> dict:
    with with_exclusive_lock(_findings_dir(repo_root) / ".alloc.lock", timeout_seconds=5.0):
        finding_id = _allocate_finding_id(repo_root)
        output_path = _findings_dir(repo_root) / f"{finding_id}.json"
        _atomic_write_json(output_path, record)
        _refresh_index(repo_root, just_written=record)  # incremental
        return record
```

Invariant test #9 spawns 10 concurrent `emit_finding` calls, asserts 10 distinct sequential IDs land + no overwrites.

### 6. Performance: incremental governance read

The watchdog daemon stores `last_seen_event_id` per detector across iterations. `read_governance_rows(since_event_id=...)` returns only NEW rows since the last poll. The full-file scan happens once at daemon startup (cold start); subsequent ticks are O(delta) per poll.

`aria-kernel/aria_kernel/governance_reader.py` extends with `since_ts` / `since_event_id` parameter (one of) for incremental reads.

### 7. Two-detector MVP scope

V10.5 ships 2 detectors only:
- `detect_stall` (plan_id has no state-machine event ≥600s)
- `detect_repeated_bridge_warning` (same `details.error_class` ≥3× in 600s window — uses categorical error_class field, NOT freeform error string)

`rejection_repeat` + `phase_asymmetry` deferred to V10.6 (F-AUTO-V10.6-EXTRA-DETECTORS). Rationale: the 4-detector v1 spec was un-calibrated against FP-rate measurement. The 2-detector MVP runs a 48h soak; FP-rate measurement via `tools/aria-poc/measure_watchdog_fp_rate.py` calibrates the dedup thresholds before adding the more-error-prone variants.

## Consequences

### Positive
- 4-daemon process budget bounded; ARIA_STOP coordinates clean exit across all 4
- Sanitizer-first emit_finding prevents prompt-injection vector through finding bodies
- Allowlist forces every emitter to declare itself; cannot forge ARIA identity
- fcntl-locked allocation closes the ID race; existing `test_concurrent_submit_race_5_subprocesses` invariant extends to 10
- Incremental governance read scales O(delta) per poll; 48h soak feasible without quadratic growth
- 2-detector MVP de-risks the FP-rate measurement before adding noisy detectors

### Negative
- 4-process governance.jsonl contention requires LOCK_SH shared-lock primitive in `file_lock.py` (extension); existing only has LOCK_EX. New invariant: 6-process race produces zero corrupted JSONL rows.
- Additional fcntl lock overhead per emit (~5-10ms); acceptable because emit is rare (≤10/24h per pattern × small N patterns).

### Neutral
- `convention_inconsistency` callers unchanged; new `operational_anomaly` is additive.

## Compliance

ADR-0002 is Tier-1 (state-machine + emit-path enforcement) + Tier-3 (invariant tests). Banned-phrase compliant (no deferral language; all V10.6 deferrals carry owner + deadline + finding-ID in §B of the plan).

## Implementation owners

- Plan reference: `/root/.claude/plans/immutable-sparking-waterfall.md` §B (V10.5 Phase 1)
- Implementer: operator (Okan) via V10.5 sprint
- Reviewers: architectural-arbiter (claim_type taxonomy), ai-safety-auditor (sanitizer + allowlist), code-reviewer (concurrent allocation), performance-expert (incremental read)
- Validation: 18 invariants in test_phase_v10_5_aria_watchdog.py + 48h soak via measure_watchdog_fp_rate.py
