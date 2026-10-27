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
  classifies each as true-positive / false-positive / unverifiable — or, when
  the host's git could not answer the probe, as verification-unavailable,
  which is the harness's gap and is reported apart from ARIA's score. This
  audits the only ARIA output that runs today.
* ``run_cycle_acceptance`` — drives a full ARIA kernel cycle in an isolated temp
  workspace + bound tools-dir (CURRENT_STATE's "clean trial") and asserts a
  battery of behavioural invariants on the cycle output.
* ``assert_reacts_*`` — seeds a synthetic stimulus and asserts ARIA reacts as
  specified (belief decays, consensus escalates, runtime signal becomes pressure).

A fourth entry, ``baseline-exam`` (F1.3), is not a check of ARIA's output: it
re-derives the section test's tally from a kept store, offline and with no
model, and stamps every number with (ARIA SHA, corpus hash, provider/model).

Run directly: ``python3 tools/aria-acceptance/harness.py`` (exit 0 = accept).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, NoReturn

_REPO_ROOT = Path(__file__).resolve().parents[2]
# The kernel is imported for the evidence-verification + cycle primitives. The
# harness adds aria-kernel to the path itself so it runs without external setup.
_KERNEL_PATH = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_PATH) not in sys.path:
    sys.path.insert(0, str(_KERNEL_PATH))

from aria_kernel.evidence_probe import GitProbeSession  # noqa: E402
from aria_kernel.evidence_trust import classify_evidence_ref  # noqa: E402

# The Board runner's CANDIDATE entries (PLAN-v2 B1, R2): the functions that
# run ARIA's own code under exam — a whole cycle, and its documented
# reactions to seeded stimuli — and observe what it does. Everything else
# here is the scorer. The derived authority set is closed under what the
# scorer executes (`aria_kernel.authority_closure`); the bodies of these
# functions are the one place it does not walk, because the code they call
# is what the Board judges, not part of the judge. A new function that runs
# the candidate is named here; this file is itself an authority member.
BOARD_CANDIDATE_ENTRIES = ("run_cycle_acceptance", "assert_reacts_to_scenarios", "review_change")

_RESOLVABLE_GRADES = ("repo_verified", "worktree_candidate")
# The grade that says the HARNESS could not ask, not that ARIA cited badly:
# git did not answer the probe inside its bounds, the run's probe clock ran
# out, or HEAD is unreachable from this checkout. A ref under this grade is
# neither resolved nor fabricated — nothing about it was compared — so it
# must never be billed to ARIA (fp_rate, `clean`) and must never pass.
_UNAVAILABLE_GRADE = "verification_unavailable"

# The three things one ref can come back as, closed so the two consumers
# below (the per-drift verdict and the sub-threshold sweep) cannot read the
# grades differently.
REF_RESOLVED = "resolved"
REF_UNRESOLVED = "unresolved"
REF_UNAVAILABLE = "unavailable"


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


def _ref_resolution(
    ref: str | None, repo_root: Path, session: GitProbeSession,
) -> tuple[str, str]:
    """(REF_* state, kernel trust grade) for one cited ref.

    ``session`` is the probe clock and baseline cache of the WHOLE run: every
    ref of every drift is graded through the same one, so HEAD is resolved
    once and a git that has stopped answering costs the run one liveness
    clock instead of refs x attempts x bound (`evidence_probe`).
    """
    if not ref or not isinstance(ref, str):
        return REF_UNRESOLVED, "no_ref"
    grade = classify_evidence_ref(
        ref, workspace_root=repo_root, target_sha="HEAD", probe_session=session,
    ).trust_grade
    if grade in _RESOLVABLE_GRADES:
        return REF_RESOLVED, grade
    if grade == _UNAVAILABLE_GRADE:
        return REF_UNAVAILABLE, grade
    return REF_UNRESOLVED, grade


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


def _classify_drift(
    d: dict[str, Any], repo_root: Path, session: GitProbeSession,
) -> tuple[str, str]:
    """Deterministic verdict for one above-threshold drift ARIA emitted.

    Four verdicts, and only three of them are about ARIA. A ref the host
    could not probe (`verification_unavailable`) makes the drift
    ``verification_unavailable`` — the harness's gap, reported apart from
    TP/FP and never in the fp_rate — UNLESS the drift's other ref positively
    failed to resolve, because a fabricated ref is a fabricated ref no matter
    what its neighbour did.
    """
    ts_state, ts_grade = _ref_resolution((d.get("ts") or {}).get("ref"), repo_root, session)
    sql_state, sql_grade = _ref_resolution((d.get("sql") or {}).get("ref"), repo_root, session)
    states = (ts_state, sql_state)
    if REF_UNRESOLVED in states:
        return "unverifiable", f"evidence not resolvable (ts={ts_grade}, sql={sql_grade})"
    if REF_UNAVAILABLE in states:
        return (
            "verification_unavailable",
            f"harness could not verify the evidence (ts={ts_grade}, sql={sql_grade})",
        )
    if not (d.get("missing_in_ts") or d.get("missing_in_sql")):
        return "false_positive", "value sets do not actually differ (likely name collision)"
    if d.get("existing_gate_refs"):
        return "false_positive", "already protected by an existing gate/test"
    return "true_positive", "refs verified, values differ, unprotected"


def validate_drift_output(
    *,
    repo_root: Path | None = None,
    probe_session: GitProbeSession | None = None,
) -> dict[str, Any]:
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

    A third state sits beside those two and belongs to neither: the HOST
    could not answer. Every ref is verified with a git probe, and a git that
    does not answer inside its bounds grades `verification_unavailable`.
    Until this change that grade was folded into `unverifiable`, counted into
    ARIA's fp_rate and flipped `clean` — the CI lane billed a stalled runner
    as ARIA citing unresolvable evidence. Such a drift is now its own verdict
    (``verification_unavailable``), such a sub-threshold ref its own list
    (``unavailable_refs``); neither enters fp_rate or `clean`, and a run in
    which NOTHING could be verified is inconclusive, not a pass — the same
    rule the empty sample follows, for the same reason (no measurement).

    ``probe_session`` is the one git-probe session of this run (clock and
    baseline cache); the default is the production session, a test with a
    scripted git passes a shorter one.
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
    # The session's liveness clock starts when it is constructed, so the
    # run's own session is minted AFTER the minute-long drift scan: the clock
    # is for the probes, not for poc.py.
    session = probe_session if probe_session is not None else GitProbeSession()

    above = list(drifts.get("drifts_above_threshold") or [])
    details: list[dict[str, Any]] = []
    tp = fp = unverifiable = verification_unavailable = 0
    for d in above:
        verdict, reason = _classify_drift(d, repo_root, session)
        if verdict == "true_positive":
            tp += 1
        elif verdict == "false_positive":
            fp += 1
        elif verdict == "verification_unavailable":
            verification_unavailable += 1
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
    unavailable_refs: list[dict[str, Any]] = []
    sub_signals_unavailable = 0
    for bucket, sig in other_signals:
        signal_unavailable = False
        for side, ref in _signal_refs(sig):
            state, grade = _ref_resolution(ref, repo_root, session)
            if state == REF_RESOLVED:
                continue
            entry = {
                "bucket": bucket, "concept": sig.get("concept"),
                "side": side, "ref": ref, "trust_grade": grade,
            }
            if state == REF_UNAVAILABLE:
                unavailable_refs.append(entry)
                signal_unavailable = True
            else:
                unresolved_refs.append(entry)
        if signal_unavailable:
            sub_signals_unavailable += 1

    checked = len(above)
    emitted = checked + len(other_signals)
    # The precision rate is over the drifts that WERE measured; a drift the
    # host could not probe is neither a hit nor a miss and leaves the sample.
    measured_checked = checked - verification_unavailable
    fp_rate = round((fp + unverifiable) / measured_checked, 3) if measured_checked else None
    measured = measured_checked + (len(other_signals) - sub_signals_unavailable)
    # A sample of zero is not a clean bill of health — it is no measurement;
    # and a sample the host could not probe is the same absence of
    # measurement wearing a different reason.
    inconclusive_reason = (
        "no_sample" if emitted == 0
        else ("verification_unavailable" if measured == 0 else None)
    )
    inconclusive = inconclusive_reason is not None
    clean = unverifiable == 0 and not unresolved_refs
    verdict = "inconclusive" if inconclusive else ("pass" if clean else "fail")
    return {
        "check": "drift_output_validation",
        "checked": checked, "emitted": emitted, "measured": measured,
        "true_positive": tp, "false_positive": fp, "unverifiable": unverifiable,
        "verification_unavailable": verification_unavailable, "fp_rate": fp_rate,
        "unexamined_signals": len(other_signals),
        "unresolved_refs": unresolved_refs,
        "unavailable_refs": unavailable_refs,
        "verdict": verdict,
        "inconclusive_reason": inconclusive_reason,
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
    from aria_kernel.memory import (
        append_jsonl as mem_append,
        decay_beliefs_by_runtime_signals,
        decay_stale_beliefs_by_age,
        latest_beliefs,
        load_jsonl,
    )
    from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
    from aria_kernel.human_required import sweep_consensus_uncertainties_for_human_required
    from aria_kernel.judge_fanout import dispatch_arbiter_for_split_verdicts
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

        # Scenario 2 (F0.7) — a consensus disagreement must reach the arbiter,
        # never HUMAN_REQUIRED.
        for judge, verdict in (("aria-evidence-judge", "true_positive"), ("aria-adversarial-judge", "false_positive")):
            record_operator_feedback(tool_id="tool-x", run_id="r1", finding_id="F1", verdict=verdict,
                                     severity="high", note=judge, source_type="ai_judge", judge_id=judge,
                                     confidence=0.9, judgment_group_id="g1", base_dir=tools)
        generate_ai_consensus(tool_id="tool-x", base_dir=tools)
        esc = sweep_consensus_uncertainties_for_human_required(base_dir=tools)
        arbiter = dispatch_arbiter_for_split_verdicts(tool_id="tool-x", base_dir=tools)
        checks.append({"scenario": "consensus_disagreement_reaches_the_arbiter",
                       "passed": esc["created"] == [] and arbiter["minted_count"] == 1})

        # Scenario 3 — a runtime signal must surface as UNVERIFIED pressure.
        ingest_runtime_signal(source="sentry", service="farm-service", summary="prod NPE",
                              code_refs=["apps/farm-service/src/x.ts:1"], base_dir=tools)
        pressure = run_pressure(cycle_id="c1", base_dir=tools)
        rt = [p for p in pressure["pressures"] if p["source"] == "runtime_signal"]
        checks.append({"scenario": "runtime_signal_becomes_pressure",
                       "passed": len(rt) == 1 and "UNVERIFIED" in rt[0]["recommended_action"]})

        # Scenario 4 (ARIA-MEDIUM-393) — an open runtime signal referencing a
        # supported belief's evidence must re-open the belief: the world moved
        # with no local diff.
        mem_append(tools / "memory" / "beliefs.jsonl", {
            "schema_version": 2, "belief_id": "b-signal", "claim": "y holds", "confidence": 0.9,
            "status": "supported", "evidence_refs": ["src/a.ts:1"], "needs_revalidation_cycles": 0,
            "verified_at": old, "recorded_at": old, "updated_at": old,
            "first_seen_cycle": "c0", "support_count": 1,
        })
        ingest_runtime_signal(source="incident", service="farm-service", summary="feed stall",
                              code_refs=["src/a.ts"], base_dir=tools)
        event_decay = decay_beliefs_by_runtime_signals(cycle_id="c1", base_dir=tools)
        reopened = next((b for b in latest_beliefs(load_jsonl(tools / "memory" / "beliefs.jsonl"))
                         if b.get("belief_id") == "b-signal"), {})
        checks.append({"scenario": "runtime_signal_reopens_belief",
                       "passed": (event_decay["decayed_count"] == 1
                                  and reopened.get("status") == "needs_revalidation")})

    return {"check": "scenario_reactions", "passed": all(c["passed"] for c in checks),
            "scenarios": checks}


# ── WP-D1: review one change in a room ──────────────────────────────────────
def review_change(
    *, change_base: str, change_head: str, store: Path, workspace_root: Path, rounds: int,
) -> dict[str, Any]:
    """Run the production loop for ONE change against an EXPLICIT store.

    ``cycle run --mode change_review`` → ``ci_executor.py --drain`` → cycle
    again, until the cycle reports nothing open for the subject or ``rounds``
    drains have run. A cycle on a subject already asked about mints nothing
    (the kernel's per-subject idempotency), so every later cycle only settles.
    The cycle and the drain are the kernel's own entries, run as the tree's
    own programs: nothing here imports a private kernel function (the
    decision-test script's Stage J did, and re-implemented the judgment
    pipeline beside the kernel).

    The store binding is HARNESS §2.1: the four store roots from the kernel's
    one definition, the session store, and HOME/XDG inside the store, so no
    default can resolve to real ARIA state.
    """
    import time
    from datetime import datetime, timezone

    from aria_kernel.state_store import store_root_environment

    store = store.resolve()
    tree = workspace_root.resolve()
    home = store / "home"
    env = {
        **os.environ,
        **store_root_environment(store),
        "ARIA_SESSION_STORE_DIR": str(store / "sessions"),
        "ARIA_WORKSPACE_ROOT": str(tree),
        "PYTHONPATH": str(tree / "aria-kernel"),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / "xdg" / "config"),
        "XDG_CACHE_HOME": str(home / "xdg" / "cache"),
        "XDG_DATA_HOME": str(home / "xdg" / "data"),
        "XDG_STATE_HOME": str(home / "xdg" / "state"),
    }
    for directory in ("sessions", "logs", "home/xdg/config", "home/xdg/cache", "home/xdg/data", "home/xdg/state"):
        (store / directory).mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report: dict[str, Any] = {
        "check": "review_change", "change_base": change_base, "change_head": change_head,
        "store": str(store), "workspace_root": str(tree), "rounds": [],
    }
    started = time.monotonic()
    for drain_round in range(rounds + 1):
        cycle_id = f"review-change-{stamp}-c{drain_round + 1}"
        cycle = subprocess.run(
            [sys.executable, "-m", "aria_kernel", "cycle", "run", "--cycle-id", cycle_id,
             "--workspace-root", str(tree), "--mode", "change_review",
             "--change-base", change_base, "--change-head", change_head],
            cwd=tree, env=env, capture_output=True, text=True, check=False,
        )
        (store / "logs" / f"{cycle_id}.stderr.log").write_text(cycle.stderr, encoding="utf-8")
        if cycle.returncode != 0:
            report["rounds"].append({"cycle_id": cycle_id, "exit_code": cycle.returncode,
                                     "error": cycle.stderr.strip()[-500:]})
            break
        state = json.loads(cycle.stdout)
        change = state.get("change_intelligence") or {}
        open_requests = list(change.get("subject_open_requests") or [])
        report["subject_ref"] = change.get("subject_ref")
        # WP-D4 — the kernel's own cost attribution (cost_budget), copied: the
        # LAST block a round reported, since it is cumulative over this room's
        # store. A round that failed reports none, and must not erase the
        # spend the rounds before it did.
        if change.get("cost_budget") is not None:
            report["cost_budget"] = change["cost_budget"]
        report["rounds"].append({
            "cycle_id": cycle_id, "exit_code": 0, "status": state.get("status"),
            "minted": change.get("change_intelligence_requests_minted"), "open_requests": open_requests,
        })
        if state.get("status") != "completed" or not open_requests or drain_round == rounds:
            break
        drain = subprocess.run(
            [sys.executable, str(tree / "tools" / "aria-poc" / "ci_executor.py"), "--drain"],
            cwd=tree, env=env, capture_output=True, text=True, check=False,
        )
        (store / "logs" / f"{cycle_id}.drain.log").write_text(drain.stdout + drain.stderr, encoding="utf-8")
        report["rounds"][-1]["drain_exit_code"] = drain.returncode
    last = report["rounds"][-1]
    if "cost_budget" not in report:
        # No round reported a block: the report names why instead of staying
        # silent, and carries no spend, because an attribution that could not
        # be read must not look like a spend of zero.
        outcome = f"exited {last['exit_code']}" if last["exit_code"] else f"reported status {last.get('status')!r}"
        report["cost_budget"] = {"unavailable": f"no round reported a cost_budget block; the last cycle {outcome}"}
    report["settled"] = last.get("status") == "completed" and not last.get("open_requests")
    report["passed"] = report["settled"]
    report["wall_seconds"] = round(time.monotonic() - started, 3)
    return report


# ── F1.3 slice a: the stamped, offline baseline exam ─────────────────────────
# The section test of 2026-10-20 reported "0/13 located; 29 of 643 named noise,
# 614 not" from driver scripts that are not in the tree, at a system nobody
# pinned, on a corpus nobody hashed. `baseline_exam` re-derives what the kept
# store can still prove, offline and with no model, and stamps every number
# with the triple that makes two numbers comparable. It only SCORES: it is not
# a BOARD_CANDIDATE_ENTRIES member (that exempts a body from the derived
# authority set, and a scorer's imports must join it). It computes no recall:
# the producer is `role_fitness` (ARIA-HIGH-758), not wired, and the status says so.
BASELINE_CORPUS_SCHEMA = "aria/baseline-corpus/v1"
BASELINE_EXAM_SCHEMA = "aria/baseline-exam/v1"
COMMITTED_CORPUS = Path(__file__).resolve().parent / "corpora" / "bolum-v1.json"
STAMP_FIELDS = ("aria_sha", "corpus_hash", "provider", "model")
NO_MODEL = "none"  # the (provider, model) of a number no model produced
PRACTICE_LABEL = "practice_score_contaminated"
# No offline read can prove which kernel executed the stored runs: the stamp's
# aria_sha is the tree the store says it scanned, declared in-tree. Slice c closes
# this by running the pinned tree itself.
ARIA_SHA_BASIS = "in_tree_run_declared"
_CORPUS_GIT_TIMEOUT_SECONDS = 60


def _refuse(name: str, detail: str) -> NoReturn:
    """Raise the kernel's governance refusal ``name: detail``; the name is what a caller matches."""
    from aria_kernel.tool_registry import GovernanceError

    raise GovernanceError(f"{name}: {detail}")


def _require_commit_sha(what: str, value: str) -> str:
    """``value`` iff it is one full lowercase 40-hex commit id, else ``baseline_exam_sha_malformed``.

    The one test every SHA of the stamp and the corpus passes, BEFORE it reaches git:
    the corpus's ids are SHA-1 constants, and a branch name or an option-shaped string
    must never become a git argument.
    """
    from aria_kernel.git_object_id import SHA1_OBJECT_FORMAT, is_object_id

    if not is_object_id(value, formats=SHA1_OBJECT_FORMAT):
        _refuse("baseline_exam_sha_malformed", f"{what} is not a full lowercase 40-hex commit id: {value!r}")
    return value


def measurement_stamp(*, aria_sha: str, corpus_hash: str, provider: str, model: str) -> dict[str, str]:
    """The triple a number must carry to be compared with another: system, corpus, provider/model.

    ``(none, none)`` says no model produced the number; otherwise the fleet must list the
    model under that provider, so a stamp cannot name a model its provider does not run.
    """
    from aria_kernel.digest import is_sha256_digest
    from aria_kernel.model_fleet import provider_for_model

    _require_commit_sha("aria_sha", aria_sha)
    if not is_sha256_digest(corpus_hash):
        _refuse("baseline_exam_corpus_hash_malformed", f"corpus_hash is not a sha256 digest: {corpus_hash!r}")
    if (provider, model) != (NO_MODEL, NO_MODEL) and provider_for_model(model) != provider:
        _refuse("baseline_exam_provider_model_mismatch", f"the fleet does not list model {model!r} under provider {provider!r}")
    return {"aria_sha": aria_sha, "corpus_hash": corpus_hash, "provider": provider, "model": model}


def stamps_match(left: dict[str, str], right: dict[str, str]) -> list[str]:
    """The names of the stamp fields that differ, [] when the two numbers are comparable.

    Whole-value equality: a prefix of a SHA is a different SHA, and a field missing on
    either side differs.
    """
    return [
        field for field in STAMP_FIELDS
        if field not in left or field not in right or left[field] != right[field]
    ]


def load_baseline_corpus(path: Path) -> dict[str, Any]:
    """The corpus manifest at ``path``, with its schema, kind and every commit id checked (no git is run)."""
    corpus = json.loads(Path(path).read_text(encoding="utf-8"))
    if corpus.get("$schema") != BASELINE_CORPUS_SCHEMA or corpus.get("kind") != "practice":
        _refuse("baseline_exam_corpus_malformed", f"{path} is not a {BASELINE_CORPUS_SCHEMA} manifest of kind practice")
    _require_commit_sha("the corpus head", corpus["head"])
    for case in corpus["cases"]:
        _require_commit_sha("a corpus case's revert_sha", case["revert_sha"])
    return corpus


def _corpus_git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """One git call against ``repo`` under the scrubbed environment: no GIT_* the caller's shell
    exports can point it at another repository (ARIA-MEDIUM-824's evidence)."""
    from aria_kernel.main_anchor import scrubbed_git_env

    return subprocess.run(
        ["git", "-C", str(repo), *args], env=scrubbed_git_env(), capture_output=True, text=True,
        check=False, timeout=_CORPUS_GIT_TIMEOUT_SECONDS,
    )


def _head_tree_of_verified_corpus(repo: Path, corpus: dict[str, Any]) -> str:
    """The tree id of the corpus head, once the head and every case are commits of ``repo`` and
    every revert is an ancestor of the head: a corpus the repo does not hold is not the corpus."""
    head = corpus["head"]
    reverts = [case["revert_sha"] for case in corpus["cases"]]
    for sha in (head, *reverts):
        if _corpus_git(repo, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}").returncode != 0:
            _refuse("baseline_exam_corpus_commit_missing", f"{sha} is not a commit of {repo}")
    for sha in reverts:
        if _corpus_git(repo, "merge-base", "--is-ancestor", sha, head).returncode != 0:
            _refuse("baseline_exam_corpus_commit_missing", f"{sha} is not an ancestor of the corpus head {head}")
    return _corpus_git(repo, "rev-parse", f"{head}^{{tree}}").stdout.strip()


def _read_cycle(
    store: Path, cycle_id: str,
) -> tuple[dict[str, dict[str, Any]], list[tuple[str, dict[str, Any]]], set[str]]:
    """(per-tool status and finding count, every (tool_id, finding), the trees the runs scanned).

    The store is read the way a frozen profile reads one: ``ensure_tools_dir_readonly`` and
    the plain ledger path. ``tool_health.runs_path`` and ``ensure_tools_dir`` rewrite
    ``integrity_index.json`` and bootstrap a directory that is not a store. Findings come
    through ``run_raw_findings`` only: the row's sample is truncated and its count is a
    claim, so a row with no artifact-backed list is refused, never counted as zero.
    """
    from aria_kernel.runs_reader import read_runs_rows
    from aria_kernel.runtime_artifacts import run_raw_findings
    from aria_kernel.tool_registry import ensure_tools_dir_readonly

    root = ensure_tools_dir_readonly(store)
    if root is None:
        _refuse("baseline_exam_not_a_store", f"{store} holds no repo_identity.json: not a bound ARIA store")
    rows = [row for row in read_runs_rows(root / "runs.jsonl", base_dir=root) if row.get("cycle_id") == cycle_id]
    if not rows:
        _refuse("baseline_exam_no_runs_for_cycle", f"{root} holds no run of cycle {cycle_id!r}")
    tools: dict[str, dict[str, Any]] = {}
    findings: list[tuple[str, dict[str, Any]]] = []
    for row in rows:
        tool_id = row["tool_id"]
        # What makes the stamp's `provider: none` checkable from the store.
        if row["runner"].get("type") != "subprocess":
            _refuse("baseline_exam_non_deterministic_run", f"{tool_id} ran as {row['runner'].get('type')!r}, not a subprocess")
        if tool_id in tools:
            _refuse("baseline_exam_ambiguous_runs", f"{tool_id} has more than one run in cycle {cycle_id!r}")
        raw = run_raw_findings(row, base_dir=root)
        if raw is None:
            _refuse("baseline_exam_findings_unavailable", f"no artifact holds the full findings of run {row['run_id']} ({tool_id})")
        tools[tool_id] = {"status": row["status"], "raw_findings": len(raw)}
        findings.extend((tool_id, finding) for finding in raw)
    # A row whose evidence_validation spilled over the inline cap keeps no envelopes
    # (EVIDENCE_VALIDATION_STRUCTURAL_KEYS): the tree comes from the rows that kept theirs.
    scanned = {
        envelope["target_sha"] for row in rows
        for envelope in row["evidence_validation"].get("evidence_envelopes", [])
    }
    return tools, findings, scanned


def _single_scanned_sha(scanned: set[str], *, head: str, aria_sha: str) -> str:
    """The one tree the cycle scanned, which must be the corpus head and the stamped ARIA SHA."""
    if not scanned:
        _refuse("baseline_exam_scanned_sha_unknown", "no run of the cycle recorded the tree it scanned")
    if len(scanned) > 1:
        _refuse("baseline_exam_scanned_sha_ambiguous", f"the cycle's runs scanned {len(scanned)} trees: {sorted(scanned)}")
    (scanned_sha,) = scanned
    if scanned_sha != head:
        _refuse("baseline_exam_store_not_scanned_at_corpus_head", f"the store scanned {scanned_sha}, the corpus head is {head}")
    if scanned_sha != aria_sha:
        _refuse("baseline_exam_aria_sha_not_the_scanned_tree", f"--aria-sha {aria_sha} is not the scanned tree {scanned_sha}")
    return scanned_sha


def _tally(findings: list[tuple[str, dict[str, Any]]], named_noise: list[dict[str, Any]]) -> dict[str, Any]:
    """Raw findings split by the manifest's named noise classes and nothing else judged.

    A finding is named noise iff its tool_id and rule equal an entry's and, when the entry
    has a ``path``, its path equals it; the first entry that matches takes it, so the
    classes partition the named noise. Whether the rest is true needs a model or a person:
    ``verified_true`` stays null.
    """
    classes = [{**entry, "count": 0} for entry in named_noise]
    by_rule: Counter[str] = Counter()
    named = 0
    for tool_id, finding in findings:
        by_rule[f"{tool_id}/{finding['rule']}"] += 1
        for entry in classes:
            if (entry["tool_id"] == tool_id and entry["rule"] == finding["rule"]
                    and ("path" not in entry or entry["path"] == finding.get("path"))):
                entry["count"] += 1
                named += 1
                break
    return {
        "raw_findings": len(findings), "named_noise": named, "not_named_noise": len(findings) - named,
        "verified_true": None, "verification": "not_measured_here",
        "by_class": classes, "by_rule": dict(sorted(by_rule.items())),
    }


def _legacy_claim(legacy: dict[str, Any], tally: dict[str, Any], stamp: dict[str, str]) -> dict[str, Any]:
    """The earlier section test's numbers, carried as a claim about a different measurement.

    It has no stamp and is never comparable to a stamped number. Its recall is never
    printed without the label and its exact interval, which the one interval owner computes.
    The tally is checked against the store only for the same system: another system's
    counts are neither reproduced nor refuted (M11).
    """
    from aria_kernel import judge_calibration

    hits, trials = legacy["recall"]["hits"], legacy["recall"]["n"]
    low, high = judge_calibration.exact_binomial_interval(hits, trials, confidence=0.95)
    reproduced = None
    if legacy["system_sha"] == stamp["aria_sha"]:
        reproduced = (legacy["tally"]["named_noise"] == tally["named_noise"]
                      and legacy["tally"]["not_named_noise"] == tally["not_named_noise"])
    return {
        "source": legacy["source"], "system_sha": legacy["system_sha"],
        "stamp": None, "comparable_to_stamped": False,
        "recall": {"hits": hits, "n": trials, "label": PRACTICE_LABEL, "interval_exact_95": [low, high]},
        "tally": legacy["tally"], "reproduced_from_store": {"tally": reproduced},
    }


def baseline_exam(
    *, store: Path, cycle_id: str, repo: Path, corpus: Path, aria_sha: str, provider: str, model: str,
) -> dict[str, Any]:
    """The stamped baseline of one cycle of a kept store against a practice corpus (``aria/baseline-exam/v1``).

    Offline and read-only: the store and the repo are only read, no model runs, nothing is
    written. Every refusal is a ``GovernanceError`` named ``baseline_exam_*``. The report
    is plain JSON and holds no clock or random id, so a later run compares equal when the
    store, the corpus and the scorer do.
    """
    from aria_kernel.digest import sha256_digest_file
    from aria_kernel.ledger import sha256_digest_of_canonical_json

    _require_commit_sha("aria_sha", aria_sha)
    manifest = load_baseline_corpus(corpus)
    tools, findings, scanned = _read_cycle(Path(store), cycle_id)
    scanned_sha = _single_scanned_sha(scanned, head=manifest["head"], aria_sha=aria_sha)
    head_tree = _head_tree_of_verified_corpus(Path(repo), manifest)
    stamp = measurement_stamp(
        aria_sha=aria_sha, provider=provider, model=model,
        corpus_hash=sha256_digest_of_canonical_json({
            "manifest": {key: value for key, value in manifest.items() if key != "legacy_claim"},
            "head_tree": head_tree,
        }),
    )
    tally = _tally(findings, manifest["named_noise"])
    detector_reverts = [case["revert_sha"] for case in manifest["cases"] if case["detector"]]
    return {
        "$schema": BASELINE_EXAM_SCHEMA,
        "stamp": stamp, "aria_sha_basis": ARIA_SHA_BASIS,
        "scorer": {
            "path": Path(__file__).resolve().relative_to(_REPO_ROOT).as_posix(),
            "sha256": sha256_digest_file(Path(__file__)),
        },
        "store": {
            "cycle_id": cycle_id, "scanned_sha": scanned_sha, "tools": tools,
            "crashed_tools": sorted(tool for tool, run in tools.items() if run["status"] == "crash"),
        },
        "measurements": {
            "tally": {"stamp": dict(stamp), **tally},
            "recall": {
                "stamp": dict(stamp), "status": "unmeasured:discovery_recall_producer_not_wired",
                "producer": "role_fitness.measure_discovery_recall (D9; ARIA-HIGH-758)", "label": PRACTICE_LABEL,
                "contamination": manifest["contamination"], "n_cases": len(manifest["cases"]),
                "detector_cases": {"n": len(detector_reverts), "revert_shas": detector_reverts},
                "other_cases": {"n": len(manifest["cases"]) - len(detector_reverts)},
            },
        },
        "legacy_claim": _legacy_claim(manifest["legacy_claim"], tally, stamp),
    }


def _baseline_exam_command(args: Any) -> int:
    """The ``baseline-exam`` subcommand: 0 = reported (and reproduced, with --against), 1 = same
    triple but different numbers, 2 = refused. ``--out`` is created exclusively, after every
    refusal that can precede it; the command writes nothing else."""
    from aria_kernel.tool_registry import GovernanceError

    try:
        out, store = Path(args.out), Path(args.store)
        if os.path.lexists(out):
            _refuse("baseline_exam_out_exists", f"{out} exists; a report is never overwritten")
        if out.resolve().is_relative_to(store.resolve()):
            _refuse("baseline_exam_out_inside_store", f"{out} lies inside the store it reads")
        prior = None
        if args.against is not None:
            prior = json.loads(Path(args.against).read_text(encoding="utf-8"))
            if prior.get("$schema") != BASELINE_EXAM_SCHEMA or not {"stamp", "measurements"} <= prior.keys():
                _refuse("baseline_exam_prior_malformed", f"{args.against} is not an {BASELINE_EXAM_SCHEMA} report")
        report = baseline_exam(
            store=store, cycle_id=args.cycle_id, repo=args.repo, corpus=args.corpus,
            aria_sha=args.aria_sha, provider=args.provider, model=args.model,
        )
        if prior is not None:
            differing = stamps_match(prior["stamp"], report["stamp"])
            if differing:
                # Matched triples only: nothing of either side's numbers is compared or printed.
                _refuse("baseline_exam_stamps_differ", str(differing))
    except GovernanceError as refusal:
        print(f"refused: {refusal}", file=sys.stderr)
        return 2
    with out.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"baseline-exam report written: {out}")
    if prior is not None:
        blocks = sorted(prior["measurements"].keys() | report["measurements"].keys())
        differing = [name for name in blocks if prior["measurements"].get(name) != report["measurements"].get(name)]
        print(f"reproduced: {'false' if differing else 'true'}")
        if differing:
            print(f"blocks that differ: {', '.join(differing)}")
        return 1 if differing else 0
    stamp, tally, legacy, scanned = report["stamp"], report["measurements"]["tally"], report["legacy_claim"], report["store"]
    print(f"stamp: {' '.join(f'{field}={stamp[field]}' for field in STAMP_FIELDS)} (aria_sha_basis: {report['aria_sha_basis']})")
    print(f"store: cycle {scanned['cycle_id']} scanned at {scanned['scanned_sha']}; "
          f"{len(scanned['tools'])} tools, crashed: {scanned['crashed_tools']}")
    print(f"tally: raw_findings={tally['raw_findings']} named_noise={tally['named_noise']} "
          f"not_named_noise={tally['not_named_noise']} verified_true=null ({tally['verification']})")
    print(f"recall: {report['measurements']['recall']['status']}")
    recall = legacy["recall"]
    print(f"legacy claim (no stamp, not comparable to the numbers above): recall {recall['hits']}/{recall['n']} "
          f"{recall['label']}, exact 95% interval {recall['interval_exact_95']}; "
          f"tally reproduced from this store: {legacy['reproduced_from_store']['tally']}")
    return 0


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
                     f" host_unavailable={r['verification_unavailable']}"
                     f" (+{r['unexamined_signals']} sub-threshold signals swept for evidence)")
            if r["inconclusive_reason"] == "no_sample":
                line += " — NO SAMPLE: ARIA emitted no drift, so nothing was verified"
            elif r["inconclusive_reason"] == "verification_unavailable":
                # The host, not ARIA: git answered none of the harness's
                # probes. Printing FAIL here would bill a stalled runner as
                # ARIA citing unresolvable evidence.
                line += " — NO MEASUREMENT: git did not answer the harness's probes; nothing was verified"
            elif r["checked"] == 0:
                # Integrity WAS measured (sub-threshold refs resolved); precision
                # was not. Printing a bare PASS beside `checked=0 TP=0 FP=0`
                # invites exactly the misreading this check exists to prevent.
                line += " — evidence integrity verified; PRECISION UNMEASURED (no above-threshold drift)"
            if r["unresolved_refs"]:
                line += f" — {len(r['unresolved_refs'])} unresolvable ref(s) in sub-threshold signals"
            if r["unavailable_refs"]:
                line += (f" — {len(r['unavailable_refs'])} sub-threshold ref(s) the host could not "
                         "probe (not billed to ARIA)")
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
    sub = parser.add_subparsers(dest="command")
    review = sub.add_parser(
        "review-change",
        help="review ONE change in a room: cycle (mode change_review) -> drain -> cycle until settled",
        description=(
            "Run the production loop for one change (base, head) against an explicit store, "
            "without GitHub. Prints the per-round report as JSON; exit 0 = the subject settled."
        ),
    )
    review.add_argument("--change-base", required=True, help="commit the change starts from")
    review.add_argument("--change-head", required=True, help="commit the change ends at")
    review.add_argument("--store", required=True, type=Path,
                        help="the room's store directory; every ARIA store root is bound inside it")
    review.add_argument("--workspace-root", required=True, type=Path,
                        help="the room's tree, holding the kernel and the change's history")
    review.add_argument("--rounds", type=int, default=3,
                        help="the most drains to run before the round cap stops the loop (default 3)")
    exam = sub.add_parser(
        "baseline-exam",
        help="re-derive a kept store's section-test tally offline, every number stamped (F1.3)",
        description=(
            "Read one cycle of a kept ARIA store against a practice corpus: no model, nothing "
            "written but --out. Every number carries (aria_sha, corpus_hash, provider, model); "
            "recall is left unmeasured by name. Exit 0 = reported (reproduced, with --against), "
            "1 = same stamp but different numbers, 2 = refused."
        ),
    )
    exam.add_argument("--store", required=True, type=Path, help="the kept store (its aria-tools directory), read only")
    exam.add_argument("--cycle-id", required=True, help="the cycle of the store to read")
    exam.add_argument("--repo", required=True, type=Path, help="a checkout holding the corpus commits, read only")
    exam.add_argument("--aria-sha", required=True, help="the full SHA of the tree the stored runs scanned")
    exam.add_argument("--out", required=True, type=Path,
                      help="the report to create; it must not exist and must not lie inside --store")
    exam.add_argument("--corpus", type=Path, default=COMMITTED_CORPUS, help="the corpus manifest (default: the committed bolum-v1)")
    exam.add_argument("--provider", default=NO_MODEL, help="the provider of the model that produced a number (default: none)")
    exam.add_argument("--model", default=NO_MODEL, help="the model that produced a number (default: none)")
    exam.add_argument("--against", type=Path, default=None, help="a prior report to reproduce: compared only when the stamps match")
    args = parser.parse_args()
    if args.command == "baseline-exam":
        return _baseline_exam_command(args)
    if args.command == "review-change" and args.rounds < 0:
        review.error("--rounds must be 0 or more")
    if args.command == "review-change":
        result = review_change(
            change_base=args.change_base, change_head=args.change_head,
            store=args.store, workspace_root=args.workspace_root, rounds=args.rounds,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["passed"] else 1

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
