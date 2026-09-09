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
import os
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


def _signal_refs(d: dict[str, Any]) -> list[tuple[str, str | None]]:
    """Every evidence ref one emitted signal cites, whatever its shape.

    Value-set drifts cite `ts`/`sql`; frontend-dropdown drifts cite `ui`/
    `source`. The evidence-integrity contract ("ARIA must not cite stale or
    fabricated evidence") is threshold- and shape-independent, so ref
    collection must be too — scoping it to one shape is how three of the four
    signals this repo emits went unexamined.
    """
    return [
        (side, (d.get(side) or {}).get("ref"))
        for side in ("ts", "sql", "ui", "source")
        if isinstance(d.get(side), dict)
    ]


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
    """Re-verify the drifts ARIA emitted against repo evidence.

    A drift is a TRUE positive only when both of its cited refs resolve in the
    repo AND the two value sets genuinely differ AND no existing gate already
    guards it. Anything whose evidence does not resolve is flagged — ARIA must
    not cite stale/fabricated evidence.

    Two questions live here and they are NOT the same:

      1. Did ARIA cite evidence that resolves?  (integrity)
      2. Did ARIA emit anything to check at all? (sample size)

    Collapsing them into one `passed` flag is why this check reported
    ``[PASS] checked=0 TP=0 FP=0`` — with nothing examined, ``unverifiable``
    is trivially 0 and the truth layer of the acceptance lane announced
    success having verified nothing. A check that examined no sample is
    INCONCLUSIVE, never a pass: `verdict` carries the three states and
    `passed` stays True only for a real, non-empty, clean sample.

    Integrity (1) runs over EVERY emitted signal — above threshold, filtered
    below it, and frontend-dropdown drifts alike, since a fabricated ref is a
    fabricated ref at any Jaccard score. The TP/FP precision split (2) stays
    scoped to the above-threshold set, because that is the only set ARIA
    actually asserts as a finding.
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

    # Integrity sweep over every emitted signal, not just the asserted ones.
    other_signals = [
        (bucket, sig)
        for bucket in ("drifts_filtered_below_threshold", "frontend_dropdown_drifts")
        for sig in (drifts.get(bucket) or [])
    ]
    unresolved_refs: list[dict[str, Any]] = []
    for bucket, sig in other_signals:
        for side, ref in _signal_refs(sig):
            ok, grade = _ref_resolvable(ref, repo_root)
            if not ok:
                unresolved_refs.append({
                    "bucket": bucket, "concept": sig.get("concept"),
                    "side": side, "ref": ref, "trust_grade": grade,
                })

    checked = len(above)
    emitted = checked + len(other_signals)
    fp_rate = round((fp + unverifiable) / checked, 3) if checked else None
    # A sample of zero is not a clean bill of health — it is no measurement.
    inconclusive = emitted == 0
    clean = unverifiable == 0 and not unresolved_refs
    verdict = "inconclusive" if inconclusive else ("pass" if clean else "fail")
    return {
        "check": "drift_output_validation",
        "checked": checked, "emitted": emitted, "true_positive": tp,
        "false_positive": fp, "unverifiable": unverifiable, "fp_rate": fp_rate,
        "unexamined_signals": len(other_signals),
        "unresolved_refs": unresolved_refs,
        "verdict": verdict,
        # `passed` drives the exit code, so an inconclusive run must not set it:
        # ACCEPT is an affirmative claim that ARIA's output is trustworthy, and
        # an empty sample supports no such claim. Fail-closed, and labelled
        # INCONC in the report so "ARIA said nothing" stays distinguishable
        # from "ARIA said something false".
        "passed": verdict == "pass",
        "details": details,
    }


# ── A2: drive an isolated ARIA cycle and assert behavioural invariants ────────
_EXPECTED_PHASE_KEYS = (
    "discovery", "memory", "belief_decay", "pressure",
    "consensus_escalation", "judge_calibration", "proactive_priorities", "reflection",
)


def _git_init_fixture(ws: Path) -> None:
    """Make the acceptance workspace a real git repository.

    ARIA observes REPOSITORIES: phases anchor their evidence to a HEAD SHA.
    A bare directory is therefore not a smaller version of ARIA's habitat, it
    is a habitat ARIA has no contract to run in — `experiment_night` failed
    with `experiment_night_head_sha_unavailable` and took the whole cycle down
    with it, so `run_cycle_acceptance` could never observe a 'completed' cycle
    and the harness returned REJECT unconditionally, for a reason that said
    nothing about ARIA.

    Fixing the ASSERTION (accepting a failed cycle) would have green-pinned a
    broken oracle; fixing the phase (skip when git is absent) would weaken a
    real contract to suit a fake workspace. The fixture was the wrong one.
    """
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "aria-acceptance", "GIT_AUTHOR_EMAIL": "aria@acceptance.local",
        "GIT_COMMITTER_NAME": "aria-acceptance", "GIT_COMMITTER_EMAIL": "aria@acceptance.local",
    }
    for argv in (
        ["git", "init", "--quiet", "--initial-branch=main"],
        ["git", "add", "-A"],
        ["git", "commit", "--quiet", "-m", "acceptance fixture baseline"],
    ):
        subprocess.run(argv, cwd=ws, env=env, check=True, capture_output=True, timeout=60)


def run_cycle_acceptance() -> dict[str, Any]:
    """Run a full cycle in an isolated temp workspace + bound tools-dir and assert
    ARIA's behaviour. Writes only to the temp dir — never the real repo."""
    from aria_kernel.cycle import run_enterprise_cycle
    from aria_kernel.ledger import load_jsonl_verified
    from aria_kernel.tool_registry import ensure_tools_dir

    failures: list[str] = []
    # Snapshot the production ledger BEFORE the temp cycle so check (4) can
    # assert non-growth rather than emptiness.
    _real_ledger_probe = _REPO_ROOT / "aria-tools" / "cycles.jsonl"
    _real_ledger_size_before = (
        _real_ledger_probe.stat().st_size if _real_ledger_probe.exists() else 0
    )
    with tempfile.TemporaryDirectory() as td:
        ws = Path(td) / "workspace"
        (ws / "src").mkdir(parents=True)
        (ws / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
        (ws / "package.json").write_text('{"name":"acceptance-fixture"}\n', encoding="utf-8")
        (ws / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")
        _git_init_fixture(ws)
        tools = ensure_tools_dir(Path(td) / "aria-tools")

        result = run_enterprise_cycle(workspace_root=ws, cycle_id="accept-1", base_dir=tools)

        # (1) cycle reached a terminal status
        if result.get("status") not in ("completed", "failed"):
            failures.append(f"cycle did not reach terminal status: {result.get('status')}")
        # (1b) ARIA-AUDIT-025: terminal alone is not success. A cycle that
        # FAILED while emitting the expected phase keys and a valid ledger
        # row is a WORKING PIPELINE around a failing cycle — accepting it
        # green-pins the failure as the pass condition.
        if result.get("status") != "completed":
            failures.append(
                f"cycle terminated as {result.get('status')!r}, not 'completed' — "
                "a failed cycle must fail acceptance"
            )
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
        # (4) isolation held: the real repo's ledger did not GROW during this
        # check. The original predicate asserted the production ledger was
        # EMPTY, which conflated "the temp cycle stayed isolated" with "ARIA
        # has never run" — the first legitimate production cycle (2026-08-05)
        # flipped it to a permanent REJECT. A gate that has never had a real
        # input proves nothing about the same gate once it has one; compare
        # before/after instead.
        real_ledger = _REPO_ROOT / "aria-tools" / "cycles.jsonl"
        size_after = real_ledger.stat().st_size if real_ledger.exists() else 0
        if size_after != _real_ledger_size_before:
            failures.append(
                f"real-repo aria-tools/cycles.jsonl changed during the temp cycle "
                f"({_real_ledger_size_before} -> {size_after} bytes) — isolation breach"
            )

        status = result.get("status")
        # WHICH phase broke is the whole diagnosis. Reporting only
        # `status=failed` cost a full manual descent into the kernel to learn
        # that one phase wanted a git SHA — an operator cannot tell an ARIA
        # defect from a harness/environment fault without this.
        failed_phases = list(result.get("failed_phases") or [])

    return {
        "check": "cycle_acceptance",
        "cycle_status": status,
        "failed_phases": failed_phases,
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
def run_all(*, repo_root: Path | None = None, skip_poc: bool = False) -> dict[str, Any]:
    results = []
    if not skip_poc:
        results.append(validate_drift_output(repo_root=repo_root))
    results.append(run_cycle_acceptance())
    results.append(assert_reacts_to_scenarios())
    return {"passed": all(r["passed"] for r in results), "checks": results}


def _print_report(report: dict[str, Any]) -> None:
    print("=== ARIA Acceptance Harness ===")
    for r in report["checks"]:
        # INCONC is its own mark: "ARIA emitted nothing to verify" and "ARIA
        # emitted something false" are different operator situations and must
        # never print the same word.
        verdict = r.get("verdict") or ("pass" if r["passed"] else "fail")
        mark = {"pass": "PASS", "fail": "FAIL", "inconclusive": "INCONC"}[verdict]
        line = f"[{mark}] {r['check']}"
        if r["check"] == "drift_output_validation":
            line += (f" — checked={r['checked']} TP={r['true_positive']} "
                     f"FP={r['false_positive']} unverifiable={r['unverifiable']}"
                     f" (+{r['unexamined_signals']} sub-threshold signals swept for evidence)")
            if verdict == "inconclusive":
                line += " — NO SAMPLE: ARIA emitted no drift, so nothing was verified"
            elif r["checked"] == 0:
                # Integrity WAS measured (sub-threshold refs resolved); precision
                # was not. Printing a bare PASS beside `checked=0 TP=0 FP=0`
                # invites exactly the misreading this check exists to prevent.
                line += " — evidence integrity verified; PRECISION UNMEASURED (no above-threshold drift)"
            if r["unresolved_refs"]:
                line += f" — {len(r['unresolved_refs'])} unresolvable ref(s) in sub-threshold signals"
        elif r["check"] == "cycle_acceptance":
            line += f" — status={r['cycle_status']}" + (f" failures={r['failures']}" if r["failures"] else "")
            if r.get("failed_phases"):
                line += f" failed_phases={r['failed_phases']}"
        elif r["check"] == "scenario_reactions":
            line += " — " + ", ".join(f"{c['scenario']}={'ok' if c['passed'] else 'FAIL'}" for c in r["scenarios"])
        print(line)
    if report["passed"]:
        overall = "ACCEPT"
    elif any(c.get("verdict") == "inconclusive" for c in report["checks"]) and not any(
        c.get("verdict") == "fail" or (c.get("verdict") is None and not c["passed"])
        for c in report["checks"]
    ):
        # Nothing failed; something could not be measured. Still not an ACCEPT
        # — but calling it a plain REJECT would report a measurement gap as
        # misconduct.
        overall = "REJECT (INCONCLUSIVE — nothing failed, but a check had no sample)"
    else:
        overall = "REJECT"
    print(f"=== OVERALL: {overall} ===")


def main() -> int:
    # WHY argparse exists now: before 2026-08-05 main() ignored sys.argv, so
    # `--help` silently ran the full multi-minute suite — the invocation every
    # short timeout then killed mid-flight. The rich per-drift details[] also
    # died with stdout; --json-out persists the training signal.
    import argparse
    import json

    parser = argparse.ArgumentParser(
        prog="harness.py",
        description=(
            "ARIA acceptance harness. Exit 0 = ACCEPT, 1 = REJECT. "
            "The drift check shells tools/aria-poc/poc.py and may take ~1 "
            "minute; --skip-poc runs only the synthetic cycle + scenario "
            "checks (seconds)."
        ),
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "write the full report (incl. per-drift TP/FP details) as JSON. "
            "Default: aria-tools/reports/acceptance/<UTC-date>.json — SI-0 "
            "made persistence the default because an opt-in flag produced "
            "ZERO scorecard artifacts in 8 days of 'continuous' acceptance "
            "measurement; a measurement nobody can read later is a claim, "
            "not a measurement. --no-artifact restores the old stdout-only "
            "behaviour for ad-hoc runs."
        ),
    )
    parser.add_argument(
        "--no-artifact",
        action="store_true",
        help="do not persist a scorecard artifact (stdout only)",
    )
    parser.add_argument(
        "--skip-poc",
        action="store_true",
        help="skip the repo-wide drift scan; run only the fast synthetic checks",
    )
    args = parser.parse_args()

    report = run_all(skip_poc=args.skip_poc)
    _print_report(report)
    json_out = args.json_out
    if json_out is None and not args.no_artifact:
        # The date names the artifact so consecutive runs on one day
        # overwrite (latest wins) while history stays one file per day —
        # the shape the nightly report section reads.
        from datetime import datetime, timezone

        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        json_out = (
            _REPO_ROOT / "aria-tools" / "reports" / "acceptance" / f"{stamp}.json"
        )
    if json_out is not None:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(
            json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8"
        )
        print(f"report written: {json_out}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
