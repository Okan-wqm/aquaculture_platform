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

Output contract (consumed by aria_kernel.cycle_guard._open_finding_count):
  <repo-state-root>/aria-findings/F-<NNN>.json  — one per drift, status OPEN
  <repo-state-root>/aria-findings/_index.json   — {"findings": [...]}

The repo-state root is resolved by ``aria_kernel.workspace.repo_state_root``,
IMPORTED rather than reimplemented (PLAN Wave 1 PR 2.6b). It used to be the
repository root, unconditionally. After the lane cutover the kernel reads
findings from the durable ``aria/state`` store, so a seeder with its own idea
of where findings live would have written a full pool every night into a
directory nothing reads — the producer still green, the consumer still empty.
One resolver, two callers.


Determinism: ids are assigned from a stable sort (cross_service desc,
gate-free first, similarity desc, concept asc); content carries the scan
HEAD sha passed by the caller — no wall-clock reads, so re-running at
the same commit is byte-identical (idempotent).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

FINDING_ID_BASE = 101
CANDIDATE_TOOL_SQL = "typeorm-entity-schema-adapter"
CANDIDATE_TOOL_UI = "event-contracts-adapter"


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
        {"drift_class": "enum_drift", "candidate_tool": CANDIDATE_TOOL_SQL, **d}
        for d in (drifts_doc.get("drifts_above_threshold") or [])
    ]
    ui_drifts = [
        {"drift_class": "ui_option_drift", "candidate_tool": CANDIDATE_TOOL_UI, **d}
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


def render_finding(drift: dict[str, Any], *, finding_id: str, head_sha: str) -> dict[str, Any]:
    sides = [
        _evidence_ref(drift.get(key))
        for key in ("ts", "sql", "ui", "source")
    ]
    evidence_chain = [side for side in sides if side is not None]
    concept = str(drift.get("concept") or "unknown")
    return {
        "id": finding_id,
        "status": "OPEN",
        "drift_class": drift["drift_class"],
        "title": (
            f"{drift['drift_class']}: '{concept}' value sets diverge "
            f"(jaccard {float(drift.get('value_jaccard_similarity') or 0.0):.2f}, "
            f"cross_service={bool(drift.get('cross_service'))})"
        ),
        "concept": concept,
        "missing_in_ts": drift.get("missing_in_ts") or drift.get("missing_in_ui") or [],
        "missing_in_sql": drift.get("missing_in_sql") or [],
        "cross_service": bool(drift.get("cross_service")),
        "existing_gate_refs": drift.get("existing_gate_refs") or [],
        "candidate_tools": [drift["candidate_tool"]],
        "evidence_chain": evidence_chain,
        "source": "seed_drift_findings",
        "seeded_from_commit": head_sha,
    }


def render_index(findings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "source": "seed_drift_findings",
        "findings": [
            {
                "id": f["id"],
                "status": f["status"],
                "drift_class": f["drift_class"],
                "title": f["title"],
                "file": f"{f['id']}.json",
            }
            for f in findings
        ],
    }


def write_findings(out_dir: Path, findings: list[dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for finding in findings:
        path = out_dir / f"{finding['id']}.json"
        path.write_text(json.dumps(finding, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    index = out_dir / "_index.json"
    index.write_text(json.dumps(render_index(findings), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def findings_out_dir(repo_root: Path, out_dir: str | None) -> Path:
    """Where the seeds go, resolved through the kernel's own seam.

    ``repo_state_root`` is the ONE definition of where the ``repo``-root
    surfaces live; it answers the repository root until a lane binds
    ``ARIA_REPO_STATE_ROOT`` at the durable store, and the store after.
    Imported here rather than re-deriving it from the environment, because
    two readers of one convention is how the seeder and the consumer end up
    pointing at different directories while both report success.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
    from aria_kernel.workspace import repo_state_root

    base = repo_state_root(repo_root)
    return base / (out_dir or "aria-findings")


def mint_candidates(
    repo_root: Path, candidates: list[dict[str, Any]],
    *, base_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
    """ORPHAN-702 — every drift goes through the ONE mint path.

    Chain-id dedupe keeps one durable record per drift across nights;
    claim_type=spine_drift by definition; severity from blast radius;
    a drift the kernel refuses is DISCLOSED as unmintable, never
    hand-written around the gate.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
    from aria_kernel.finding import (
        _evidence_chain_id,
        emit_finding,
        find_by_evidence_chain_id,
    )
    from aria_kernel.tool_registry import GovernanceError

    minted: list[dict[str, Any]] = []
    already: list[str] = []
    unmintable: list[dict[str, str]] = []
    for drift in candidates:
        sides = [
            _evidence_ref(drift.get(key)) for key in ("ts", "sql", "ui", "source")
        ]
        evidences = [
            {"ref": side["reference"], "summary": f"{side.get('declared_name') or 'side'} values: {str(side.get('declared_values'))[:80]}"}
            for side in sides if side is not None
        ]
        concept = str(drift.get("concept") or "unknown")
        if len(evidences) < 2:
            unmintable.append({"concept": concept, "reason": "fewer_than_two_evidence_sides"})
            continue
        chain_id = _evidence_chain_id([
            {"ref": e["ref"], "summary": e.get("summary", "")} for e in evidences
        ])
        if find_by_evidence_chain_id(repo_root, chain_id) is not None:
            already.append(concept)
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
        except GovernanceError as exc:
            unmintable.append({"concept": concept, "reason": str(exc)[:160]})
            continue
        minted.append(record)
    return minted, already, unmintable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=".", help="Repository root (default: cwd)")
    parser.add_argument(
        "--out-dir",
        default=None,
        help=(
            "Findings dir. Relative paths resolve against the repo-state root "
            "(the aria/state store when bound, else the repository root). "
            "Defaults to aria-findings under that root."
        ),
    )
    parser.add_argument("--limit", type=int, default=20, help="Max findings to seed")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    out_dir = findings_out_dir(repo_root, args.out_dir)
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
    # chain-id dedupe keeps one durable record per drift across nights,
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
