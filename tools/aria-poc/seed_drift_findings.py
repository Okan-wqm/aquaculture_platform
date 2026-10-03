#!/usr/bin/env python3
"""Seed ARIA findings from a FRESH PoC mechanical drift scan (Plan S3,
ORPHAN-MEDIUM-297).

Why fresh-scan instead of re-verifying a stored MECHANICAL_DRIFTS.json:
the May 2026 artifact carried 126 above-threshold drifts of which 112
referenced stale `.worktrees/` checkouts — re-verification of a stale
file is patching the symptom. Re-running the scanner at HEAD makes
staleness structurally impossible (tier-1: the wrong input cannot
exist). The 2026-07-02 fresh scan yields 0 TS<->SQL drifts and 1
promoted frontend dropdown drift — the seed pool is whatever is REAL at
HEAD, never a fixed batch size.

Output: every drift goes through the kernel's ONE mint path
(``aria_kernel.finding.emit_finding``), which appends the finding event,
writes the frozen ``F-NNN.json`` and refreshes the index cycle_guard reads.
The seeder writes no finding file of its own (ARIA-MEDIUM-330): the writer
it used to carry put F-101/F-102 beside the ledger, where no event named
them.

Determinism: candidates are minted in a stable order (cross_service desc,
gate-free first, similarity desc, concept asc).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any



def run_fresh_scan(repo_root: Path) -> dict[str, Any]:
    """Run the PoC mechanical scanner at HEAD and return its drift doc."""
    with tempfile.TemporaryDirectory(dir=repo_root) as tmp:
        out_rel = Path(tmp).name
        cmd = [
            sys.executable,
            str(repo_root / "tools" / "aria-poc" / "poc.py"),
            "--workspace-root", str(repo_root),
            "--out-dir", out_rel,
            "--skip-nx-graph",
            # The seeder is a producer, not a gate — CI-fail semantics
            # belong to the poc's own invocation surface.
            "--fail-on-drifts", "999999999",
        ]
        subprocess.run(cmd, check=True, cwd=repo_root, capture_output=True, text=True)
        return json.loads((repo_root / out_rel / "MECHANICAL_DRIFTS.json").read_text(encoding="utf-8"))


def _sort_key(drift: dict[str, Any]) -> tuple[Any, ...]:
    return (
        not bool(drift.get("cross_service")),
        bool(drift.get("existing_gate_refs")),
        -float(drift.get("value_jaccard_similarity") or 0.0),
        str(drift.get("concept") or ""),
    )


def select_candidates(drifts_doc: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    """Stable-ordered seed candidates: TS<->SQL drifts first, then
    promoted frontend dropdown drifts (already confidence-gated by the
    scanner)."""
    sql_drifts = [
        {"drift_class": "enum_drift", **d}
        for d in (drifts_doc.get("drifts_above_threshold") or [])
    ]
    ui_drifts = [
        {"drift_class": "ui_option_drift", **d}
        for d in (drifts_doc.get("frontend_dropdown_drifts") or [])
    ]
    ranked = sorted(sql_drifts, key=_sort_key) + sorted(ui_drifts, key=_sort_key)
    return ranked[:limit]


def _evidence_ref(side: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(side, dict):
        return None
    ref = side.get("ref")
    if not ref:
        return None
    return {
        "source_type": "code",
        "reference": str(ref),
        "trust_level": "mechanical_scan",
        "declared_name": side.get("name"),
        "declared_values": side.get("values"),
    }


def _declared_symbol(side: dict[str, Any], concept: str) -> str:
    """The name a drift side declares, else the drift's concept: line-free either way."""
    name = side.get("declared_name")
    return name.strip() if isinstance(name, str) and name.strip() else concept


def mint_candidates(
    repo_root: Path, candidates: list[dict[str, Any]],
    *, base_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
    """ORPHAN-702 — every drift goes through the ONE mint path.

    ARIA-HIGH-331 — each side declares the ``symbol`` it points at (its
    declared name, else the drift's concept), so the kernel can refuse a
    drift whose subject is already open, wherever its lines have moved
    (``subject_already_open``). That refusal replaces the seeder's own
    dedupe on a hash of ``path:line`` refs, which minted a new finding for
    every moved line. claim_type=spine_drift by definition; severity from
    blast radius; a drift the kernel refuses for any other reason is
    DISCLOSED as unmintable, never hand-written around the gate.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
    from aria_kernel.finding import SubjectAlreadyOpen, emit_finding
    from aria_kernel.tool_registry import GovernanceError

    minted: list[dict[str, Any]] = []
    already: list[str] = []
    unmintable: list[dict[str, str]] = []
    for drift in candidates:
        sides = [
            _evidence_ref(drift.get(key)) for key in ("ts", "sql", "ui", "source")
        ]
        concept = str(drift.get("concept") or "unknown")
        evidences = [
            {
                "ref": side["reference"],
                "symbol": _declared_symbol(side, concept),
                "summary": f"{side.get('declared_name') or 'side'} values: {str(side.get('declared_values'))[:80]}",
            }
            for side in sides if side is not None
        ]
        if len(evidences) < 2:
            unmintable.append({"concept": concept, "reason": "fewer_than_two_evidence_sides"})
            continue
        summary = (
            f"{drift['drift_class']}: '{concept}' value sets diverge across "
            f"{len(evidences)} surfaces (cross_service={bool(drift.get('cross_service'))})"
        )
        facts = [
            f"missing in ts/ui: {sorted(drift.get('missing_in_ts') or drift.get('missing_in_ui') or [])[:8]}",
            f"missing in sql: {sorted(drift.get('missing_in_sql') or [])[:8]}",
        ]
        try:
            record = emit_finding(
                repo_root=repo_root,
                base_dir=base_dir,
                claim_type="spine_drift",
                claim_summary=summary,
                severity="HIGH" if drift.get("cross_service") else "MEDIUM",
                evidences=evidences,
                facts=facts,
                scope_files=sorted({e["ref"].split(":")[0] for e in evidences}),
                originating_skill="seed:drift-scan",
            )
        except SubjectAlreadyOpen:
            already.append(concept)
            continue
        except GovernanceError as exc:
            unmintable.append({"concept": concept, "reason": str(exc)[:160]})
            continue
        minted.append(record)
    return minted, already, unmintable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=".", help="Repository root (default: cwd)")
    parser.add_argument("--limit", type=int, default=20, help="Max findings to seed")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    head_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, cwd=repo_root,
        capture_output=True, text=True,
    ).stdout.strip()

    print(f"[seed] fresh mechanical scan at {head_sha[:12]} ...", flush=True)
    drifts_doc = run_fresh_scan(repo_root)
    total_sql = len(drifts_doc.get("drifts_above_threshold") or [])
    total_ui = len(drifts_doc.get("frontend_dropdown_drifts") or [])
    candidates = select_candidates(drifts_doc, limit=args.limit)

    # ORPHAN-702 — the seeder graduates to the ONE mint path. It used to
    # write its own F-NNN.json files OVER the same ids every night: no
    # events, no lifecycle, invisible to replay — the second finding
    # format İ1 forbids. Now every drift goes through emit_finding:
    # the kernel's subject refusal keeps one open record per drift across
    # nights and line moves (ARIA-HIGH-331),
    # claim_type=spine_drift (a DB/TS/UI backbone divergence is that type
    # by definition), severity from blast radius, and the kernel's own
    # index refresh keeps cycle_guard's OPEN count working unchanged.
    minted, already, unmintable = mint_candidates(repo_root, candidates)

    print(f"[seed] scan: {total_sql} sql-drifts + {total_ui} ui-drifts above threshold")
    print(f"[seed] minted {len(minted)} findings via emit_finding; {len(already)} already recorded; {len(unmintable)} unmintable (limit {args.limit})")
    for record in minted:
        print(f"[seed]   {record['finding_id']}: {record['claim_summary'][:100]}")
    for row in unmintable:
        print(f"[seed]   UNMINTABLE {row['concept']}: {row['reason']}")
    if not minted and not already:
        print("[seed] pool is empty at HEAD — honest zero")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
