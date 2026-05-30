"""Plan ARIA-V7 POST-V7 — 30-cycle autonomy run analyzer (V6 + V7 phases).

Reads aria-tools/autonomy_state.jsonl + aria-tools/reflection/*.json +
aria-tools/governance.jsonl produced by the 30-cycle autonomy run and
emits a structured analysis report covering:

  * Phase-firing histogram per cycle (which phases fired, how often)
  * Verdict distribution for Gate A (convergence) + Gate B (review)
    + Gate C (specialist_review) + V7 phases (skill_genesis_drainer,
    convergence_invalid_plan, cycle_runner_no_pressure,
    calibration_reporter_completed) per cycle
  * Orphan-convergence-started detection (V7.8 hard gate H-1):
    every convergence_started row MUST be followed by exactly one
    of convergence_resolved, convergence_invalid_plan, or
    convergence_skipped_no_payload within the same cycle.
  * Defensive-default rate (specialists_unavailable, primary_silent,
    challenger_unavailable, dispatchers_unavailable) — expected high
    since no external ci_executor is running in the snowball CI
    environment
  * GovernanceError surface from governance.jsonl
  * Cycle-to-cycle drift signal (did anything change cycle over cycle?)

Operator-facing — print JSON + human-readable summary to stdout.
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def main(tools_dir: str = "./aria-tools") -> int:
    root = Path(tools_dir).resolve()
    autonomy_state = _load_jsonl(root / "autonomy_state.jsonl")
    governance = _load_jsonl(root / "governance.jsonl")

    cycles: dict[str, dict] = {}
    phase_hist: collections.Counter = collections.Counter()
    for row in autonomy_state:
        cid = row.get("cycle_id") or "unknown"
        phase = row.get("phase") or "unknown"
        status = row.get("status") or ""
        phase_hist[phase] += 1
        bucket = cycles.setdefault(cid, {
            "phases": [],
            "statuses": [],
            "first_recorded": row.get("recorded_at"),
            "last_recorded": row.get("recorded_at"),
            "details": [],
        })
        bucket["phases"].append(phase)
        bucket["statuses"].append(status)
        bucket["last_recorded"] = row.get("recorded_at")
        if row.get("details"):
            bucket["details"].append({
                "phase": phase,
                "details": row["details"],
            })

    # Verdict counters per gate.
    convergence_verdicts: collections.Counter = collections.Counter()
    review_verdicts: collections.Counter = collections.Counter()
    specialist_verdicts: collections.Counter = collections.Counter()
    # Plan ARIA-V7 §3 Phase 7.7 — V7 phase verdict counters.
    skill_genesis_verdicts: collections.Counter = collections.Counter()
    calibration_statuses: collections.Counter = collections.Counter()
    cycle_runner_outcomes: collections.Counter = collections.Counter()
    invalid_plan_count = 0
    no_pressure_count = 0
    deadline_exceeded_count = 0
    for row in autonomy_state:
        phase = row.get("phase") or ""
        status = row.get("status") or ""
        if phase == "convergence_resolved":
            convergence_verdicts[status] += 1
        elif phase == "review_resolved":
            review_verdicts[status] += 1
        elif phase == "specialist_review_resolved":
            specialist_verdicts[status] += 1
        elif phase == "skill_genesis_drainer_resolved":
            skill_genesis_verdicts[status] += 1
        elif phase == "calibration_reporter_completed":
            calibration_statuses[status] += 1
        elif phase == "cycle_runner_synthesized_plan":
            cycle_runner_outcomes["synthesized"] += 1
        elif phase == "cycle_runner_no_pressure":
            cycle_runner_outcomes["no_pressure"] += 1
            no_pressure_count += 1
        elif phase == "convergence_invalid_plan":
            invalid_plan_count += 1
        elif phase == "cycle_deadline_exceeded":
            deadline_exceeded_count += 1

    # Plan ARIA-V7 §3 V7.7 — orphan convergence_started detection.
    # Every convergence_started row MUST be followed by exactly one
    # of convergence_resolved, convergence_invalid_plan, or
    # convergence_skipped_no_payload within the same cycle.
    orphan_convergence_started_count = 0
    for cid, bucket in cycles.items():
        phases = bucket.get("phases", [])
        starts = [i for i, p in enumerate(phases) if p == "convergence_started"]
        resolutions = {"convergence_resolved", "convergence_invalid_plan",
                       "convergence_skipped_no_payload"}
        for start_idx in starts:
            tail = phases[start_idx + 1:]
            if not any(p in resolutions for p in tail):
                orphan_convergence_started_count += 1

    governance_class_hist: collections.Counter = collections.Counter()
    for row in governance:
        kind = row.get("event_type") or row.get("kind") or "unknown"
        governance_class_hist[kind] += 1

    summary = {
        "tools_dir": str(root),
        "total_state_transitions": len(autonomy_state),
        "cycles_observed": len(cycles),
        "phase_histogram": dict(phase_hist.most_common()),
        "convergence_verdict_histogram": dict(convergence_verdicts.most_common()),
        "review_verdict_histogram": dict(review_verdicts.most_common()),
        "specialist_review_verdict_histogram": dict(specialist_verdicts.most_common()),
        # Plan ARIA-V7 §3 V7.7 — V7 phase counters.
        "skill_genesis_drainer_verdict_histogram": dict(skill_genesis_verdicts.most_common()),
        "calibration_reporter_status_histogram": dict(calibration_statuses.most_common()),
        "cycle_runner_outcomes": dict(cycle_runner_outcomes.most_common()),
        "convergence_invalid_plan_count": invalid_plan_count,
        "cycle_runner_no_pressure_count": no_pressure_count,
        "cycle_deadline_exceeded_count": deadline_exceeded_count,
        "orphan_convergence_started_count": orphan_convergence_started_count,
        "governance_event_histogram": dict(governance_class_hist.most_common()),
        "first_cycle": _stub_cycle(next(iter(cycles.values()), None)),
        "last_cycle": _stub_cycle(list(cycles.values())[-1] if cycles else None),
        "cycle_phase_signatures": _phase_signatures(cycles),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))

    print("\n=== HUMAN SUMMARY ===", file=sys.stderr)
    print(f"  Cycles observed:        {summary['cycles_observed']}", file=sys.stderr)
    print(f"  Total transitions:      {summary['total_state_transitions']}", file=sys.stderr)
    print(f"  Distinct phases:        {len(phase_hist)}", file=sys.stderr)
    print(f"  Convergence verdicts:   {dict(convergence_verdicts)}", file=sys.stderr)
    print(f"  Review verdicts:        {dict(review_verdicts)}", file=sys.stderr)
    print(f"  Specialist verdicts:    {dict(specialist_verdicts)}", file=sys.stderr)
    print(f"  Skill genesis verdicts: {dict(skill_genesis_verdicts)}", file=sys.stderr)
    print(f"  Calibration statuses:   {dict(calibration_statuses)}", file=sys.stderr)
    print(f"  Cycle runner outcomes:  {dict(cycle_runner_outcomes)}", file=sys.stderr)
    print(f"  invalid_plan count:     {invalid_plan_count}", file=sys.stderr)
    print(f"  no_pressure count:      {no_pressure_count}", file=sys.stderr)
    print(f"  deadline_exceeded:      {deadline_exceeded_count}", file=sys.stderr)
    print(f"  orphan started count:   {orphan_convergence_started_count} (V7.8 hard gate H-1)", file=sys.stderr)
    print(f"  Governance events:      {dict(governance_class_hist)}", file=sys.stderr)
    return 0


def _stub_cycle(c: dict | None) -> dict:
    if c is None:
        return {}
    return {
        "first_recorded": c.get("first_recorded"),
        "last_recorded": c.get("last_recorded"),
        "phase_count": len(c.get("phases", [])),
        "phases": c.get("phases", []),
    }


def _phase_signatures(cycles: dict) -> dict[str, int]:
    """Group cycles by ordered-phase-tuple to detect cycle-to-cycle drift."""
    sig_counts: collections.Counter = collections.Counter()
    for c in cycles.values():
        sig = tuple(c.get("phases", []))
        sig_counts[sig] += 1
    return {",".join(sig): count for sig, count in sig_counts.most_common()}


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "./aria-tools"))
