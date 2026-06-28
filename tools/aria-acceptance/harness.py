#!/usr/bin/env python3
"""Plan 030 — ARIA Acceptance & Gap-Closure deterministic harness.

This harness lives OUTSIDE the ARIA kernel by design: the thing that audits ARIA
cannot be part of ARIA (independence). It is the *truth layer* of the acceptance
lane — its pass/fail verdict is a deterministic assertion against repo evidence,
never an LLM opinion. The agent lane (`.claude/agents/aria-acceptance-*`) sits ON
TOP of this and only adds judgment; its verdicts are leads, not truth.

Three checks, all deterministic:

* ``validate_drift_output`` — runs the LLM-free mechanical drift scan
  (``tools/aria-poc/poc.py``), then RE-VERIFIES every drift's evidence refs
  against the repo at HEAD via ``evidence_trust.classify_evidence_ref`` and
  classifies each as true-positive / false-positive / unverifiable. This audits
  the only ARIA output that runs today.
* ``run_cycle_acceptance`` — drives a full ARIA kernel cycle in an isolated temp
  workspace + bound tools-dir (CURRENT_STATE's "clean trial") and asserts a
  battery of behavioural invariants on the cycle output.
* ``assert_reacts_*`` — seeds a synthetic stimulus and asserts ARIA reacts as
  specified (belief decays, consensus escalates, runtime signal becomes pressure).

Run directly: ``python3 tools/aria-acceptance/harness.py`` (exit 0 = accept).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
# The kernel is imported for the evidence-verification + cycle primitives. The
# harness adds aria-kernel to the path itself so it runs without external setup.
_KERNEL_PATH = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_PATH) not in sys.path:
    sys.path.insert(0, str(_KERNEL_PATH))

from aria_kernel.evidence_trust import classify_evidence_ref  # noqa: E402

_RESOLVABLE_GRADES = ("repo_verified", "worktree_candidate")


# ── A1: validate ARIA's mechanical drift output ──────────────────────────────
def _run_poc(repo_root: Path, out_dir: Path) -> dict[str, Any]:
    poc = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
    # Exit code is NOT a failure signal: poc returns 1 (via --fail-on-drifts) when
    # it finds drifts, which is the normal case. The artifact is the contract.
    proc = subprocess.run(
        [sys.executable, str(poc), "--workspace-root", str(repo_root),
         "--out-dir", str(out_dir), "--skip-nx-graph"],
        capture_output=True, text=True, timeout=600,
    )
    artifact = out_dir / "MECHANICAL_DRIFTS.json"
    if not artifact.exists():
        raise RuntimeError(f"poc.py produced no MECHANICAL_DRIFTS.json (rc={proc.returncode}): {proc.stderr[-500:]}")
    return json.loads(artifact.read_text(encoding="utf-8"))


def _ref_resolvable(ref: str | None, repo_root: Path) -> tuple[bool, str]:
    if not ref or not isinstance(ref, str):
        return False, "no_ref"
    grade = classify_evidence_ref(ref, workspace_root=repo_root, target_sha="HEAD").trust_grade
    return grade in _RESOLVABLE_GRADES, grade


def _classify_drift(d: dict[str, Any], repo_root: Path) -> tuple[str, str]:
    """Deterministic verdict for one above-threshold drift ARIA emitted."""
    ts_ok, ts_grade = _ref_resolvable((d.get("ts") or {}).get("ref"), repo_root)
    sql_ok, sql_grade = _ref_resolvable((d.get("sql") or {}).get("ref"), repo_root)
    if not (ts_ok and sql_ok):
        return "unverifiable", f"evidence not resolvable (ts={ts_grade}, sql={sql_grade})"
    if not (d.get("missing_in_ts") or d.get("missing_in_sql")):
        return "false_positive", "value sets do not actually differ (likely name collision)"
    if d.get("existing_gate_refs"):
        return "false_positive", "already protected by an existing gate/test"
    return "true_positive", "refs verified, values differ, unprotected"


def validate_drift_output(*, repo_root: Path | None = None) -> dict[str, Any]:
    """Re-verify every above-threshold drift ARIA emitted against repo evidence.

    A drift is a TRUE positive only when both of its cited refs resolve in the
    repo AND the two value sets genuinely differ AND no existing gate already
    guards it. Anything whose evidence does not resolve is flagged — ARIA must
    not cite stale/fabricated evidence.
    """
    repo_root = (repo_root or _REPO_ROOT).resolve()
    # poc.py makes artifact paths relative to the workspace root, so its out-dir
    # must live INSIDE the repo. Use a dedicated temp subdir and remove it after.
    out_dir = repo_root / ".aria-acceptance-poc-tmp"
    shutil.rmtree(out_dir, ignore_errors=True)
    try:
        drifts = _run_poc(repo_root, out_dir)
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    above = list(drifts.get("drifts_above_threshold") or [])
    details: list[dict[str, Any]] = []
    tp = fp = unverifiable = 0
    for d in above:
        verdict, reason = _classify_drift(d, repo_root)
        if verdict == "true_positive":
            tp += 1
        elif verdict == "false_positive":
            fp += 1
        else:
            unverifiable += 1
        details.append({
            "concept": d.get("concept"),
            "ts_ref": (d.get("ts") or {}).get("ref"), "sql_ref": (d.get("sql") or {}).get("ref"),
            "jaccard": d.get("value_jaccard_similarity"), "cross_service": d.get("cross_service"),
            "verdict": verdict, "reason": reason,
        })

    checked = len(above)
    fp_rate = round((fp + unverifiable) / checked, 3) if checked else 0.0
    return {
        "check": "drift_output_validation",
        "checked": checked, "true_positive": tp, "false_positive": fp,
        "unverifiable": unverifiable, "fp_rate": fp_rate,
        # Pass unless ARIA cited evidence that doesn't resolve (unverifiable),
        # which is the one outcome that breaks the "evidence is truth" contract.
        "passed": unverifiable == 0,
        "details": details,
    }


# ── A2: drive an isolated ARIA cycle and assert behavioural invariants ────────
_EXPECTED_PHASE_KEYS = (
    "discovery", "memory", "belief_decay", "pressure",
    "consensus_escalation", "judge_calibration", "proactive_priorities", "reflection",
)


def run_cycle_acceptance() -> dict[str, Any]:
    """Run a full cycle in an isolated temp workspace + bound tools-dir and assert
    ARIA's behaviour. Writes only to the temp dir — never the real repo."""
    from aria_kernel.cycle import run_enterprise_cycle
    from aria_kernel.ledger import load_jsonl_verified
    from aria_kernel.tool_registry import ensure_tools_dir

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td) / "workspace"
        (ws / "src").mkdir(parents=True)
        (ws / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        (ws / "package.json").write_text('{"name":"acceptance-fixture"}\n', encoding="utf-8")
        (ws / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")
        tools = ensure_tools_dir(Path(td) / "aria-tools")

        result = run_enterprise_cycle(workspace_root=ws, cycle_id="accept-1", base_dir=tools)

        # (1) cycle reached a terminal status
        if result.get("status") not in ("completed", "failed"):
            failures.append(f"cycle did not reach terminal status: {result.get('status')}")
        # (2) every expected phase produced a state key
        for key in _EXPECTED_PHASE_KEYS:
            if key not in result:
                failures.append(f"missing phase key in cycle state: {key}")
        # (3) the cycles ledger is hash-chain valid and carries a terminal row
        try:
            rows = load_jsonl_verified(tools / "cycles.jsonl")
            terminal = [r for r in rows if r.get("cycle_id") == "accept-1"
                        and r.get("event") in ("completed", "failed", "aborted", "stopped")]
            if not terminal:
                failures.append("no terminal cycle row in cycles.jsonl")
        except Exception as exc:  # ledger integrity error = a hard fail
            failures.append(f"cycles.jsonl failed strict verification: {exc}")
        # (4) isolation held: the real repo's tools dir was never touched
        if (_REPO_ROOT / "aria-tools" / "cycles.jsonl").stat().st_size > 0 if (
            _REPO_ROOT / "aria-tools" / "cycles.jsonl").exists() else False:
            failures.append("real-repo aria-tools/cycles.jsonl is non-empty — isolation breach")

        status = result.get("status")

    return {
        "check": "cycle_acceptance",
        "cycle_status": status,
        "passed": not failures,
        "failures": failures,
    }


# ── A3: scenario injection — assert ARIA reacts as specified ──────────────────
def assert_reacts_to_scenarios() -> dict[str, Any]:
    """Seed synthetic stimuli and assert ARIA's documented reactions."""
    from datetime import datetime, timedelta, timezone
    from aria_kernel.tool_registry import ensure_tools_dir
    from aria_kernel.memory import append_jsonl as mem_append, decay_stale_beliefs_by_age, latest_beliefs, load_jsonl
    from aria_kernel.feedback_store import _consensus_uncertainty
    from aria_kernel.human_required import sweep_consensus_uncertainties_for_human_required
    from aria_kernel.runtime_signal_bridge import ingest_runtime_signal
    from aria_kernel.pressure import run_pressure

    checks: list[dict[str, Any]] = []
    now = datetime(2026, 6, 27, tzinfo=timezone.utc)

    with tempfile.TemporaryDirectory() as td:
        tools = ensure_tools_dir(Path(td) / "aria-tools")

        # Scenario 1 — a stale belief about unchanged code must decay.
        old = (now - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
        mem_append(tools / "memory" / "beliefs.jsonl", {
            "schema_version": 2, "belief_id": "b-old", "claim": "x holds", "confidence": 0.9,
            "status": "supported", "evidence_refs": ["src/a.ts:1"], "needs_revalidation_cycles": 0,
            "verified_at": old, "recorded_at": old, "updated_at": old,
            "first_seen_cycle": "c0", "support_count": 1,
        })
        decay_stale_beliefs_by_age(cycle_id="c1", base_dir=tools, now=now)
        decayed = next((b for b in latest_beliefs(load_jsonl(tools / "memory" / "beliefs.jsonl"))
                        if b.get("belief_id") == "b-old"), {})
        checks.append({"scenario": "stale_belief_decays",
                       "passed": decayed.get("status") == "needs_revalidation"})

        # Scenario 2 — a consensus disagreement must escalate to HUMAN_REQUIRED.
        unc = _consensus_uncertainty("tool-x", "r1", "F1", "g1", "judge_disagreement")
        with (tools / "feedback-consensus-uncertainties.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"schema_version": 1, "recorded_at": old, "tool_id": "tool-x",
                                 "cycle_id": "c1", "uncertainties": [unc]}, sort_keys=True) + "\n")
        esc = sweep_consensus_uncertainties_for_human_required(base_dir=tools)
        checks.append({"scenario": "consensus_disagreement_escalates",
                       "passed": len(esc.get("created", [])) == 1})

        # Scenario 3 — a runtime signal must surface as UNVERIFIED pressure.
        ingest_runtime_signal(source="sentry", service="farm-service", summary="prod NPE",
                              code_refs=["apps/farm-service/src/x.ts:1"], base_dir=tools)
        pressure = run_pressure(cycle_id="c1", base_dir=tools)
        rt = [p for p in pressure["pressures"] if p["source"] == "runtime_signal"]
        checks.append({"scenario": "runtime_signal_becomes_pressure",
                       "passed": len(rt) == 1 and "UNVERIFIED" in rt[0]["recommended_action"]})

    return {"check": "scenario_reactions", "passed": all(c["passed"] for c in checks),
            "scenarios": checks}


# ── orchestration ────────────────────────────────────────────────────────────
def run_all(*, repo_root: Path | None = None) -> dict[str, Any]:
    results = [
        validate_drift_output(repo_root=repo_root),
        run_cycle_acceptance(),
        assert_reacts_to_scenarios(),
    ]
    return {"passed": all(r["passed"] for r in results), "checks": results}


def _print_report(report: dict[str, Any]) -> None:
    print("=== ARIA Acceptance Harness ===")
    for r in report["checks"]:
        mark = "PASS" if r["passed"] else "FAIL"
        line = f"[{mark}] {r['check']}"
        if r["check"] == "drift_output_validation":
            line += (f" — checked={r['checked']} TP={r['true_positive']} "
                     f"FP={r['false_positive']} unverifiable={r['unverifiable']}")
        elif r["check"] == "cycle_acceptance":
            line += f" — status={r['cycle_status']}" + (f" failures={r['failures']}" if r["failures"] else "")
        elif r["check"] == "scenario_reactions":
            line += " — " + ", ".join(f"{c['scenario']}={'ok' if c['passed'] else 'FAIL'}" for c in r["scenarios"])
        print(line)
    print(f"=== OVERALL: {'ACCEPT' if report['passed'] else 'REJECT'} ===")


def main() -> int:
    report = run_all()
    _print_report(report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
