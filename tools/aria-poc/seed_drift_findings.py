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
# The scanner classifies every drift it emits and names its severity
# (ui_value_not_on_wire / ts_value_not_in_db HIGH, own-service subsets LOW).
# The seeder mints that severity; it does not re-derive one from blast radius.
MINTABLE_SEVERITIES = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}


# ARIA-HIGH-363 (review M1) — the scanner is the one that ships with THIS
# seeder, never the copy inside the tree being scanned. A recheck scans a merge
# commit's tree; that tree's own poc.py may write a different document shape,
# and this module's judge would read a renamed or missing section as "no
# drift". One scanner, one judge, one revision of both.
SCANNER = Path(__file__).resolve().parent / "poc.py"


def run_fresh_scan(repo_root: Path, supergraph: str | None = None) -> dict[str, Any]:
    """Run this seeder's PoC mechanical scanner over ``repo_root`` and return its drift doc."""
    with tempfile.TemporaryDirectory(dir=repo_root) as tmp:
        out_rel = Path(tmp).name
        cmd = [
            sys.executable,
            str(SCANNER),
            "--workspace-root", str(repo_root),
            "--out-dir", out_rel,
            "--skip-nx-graph",
            # The seeder is a producer, not a gate — CI-fail semantics
            # belong to the poc's own invocation surface.
            "--fail-on-drifts", "999999999",
            *(["--supergraph", supergraph] if supergraph else []),
        ]
        subprocess.run(cmd, check=True, cwd=repo_root, capture_output=True, text=True)
        return json.loads((repo_root / out_rel / "MECHANICAL_DRIFTS.json").read_text(encoding="utf-8"))


def _sort_key(drift: dict[str, Any]) -> tuple[Any, ...]:
    return (
        -MINTABLE_SEVERITIES.get(str(drift.get("severity")), 0),
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
        "classification": drift.get("classification"),
        "severity": drift.get("severity"),
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


def _kernel_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))


def drift_evidences(drift: dict[str, Any]) -> list[dict[str, str]]:
    """The evidence list a drift is minted with — one entry per side.

    The summary opens with the side's declared name; the kernel's subject key
    (``aria_kernel.finding_subject``) reads that name back, so this is the one
    place the shape is written.
    """
    sides = [_evidence_ref(drift.get(key)) for key in ("ts", "sql", "ui", "source")]
    return [
        {"ref": side["reference"], "summary": f"{side.get('declared_name') or 'side'} values: {str(side.get('declared_values'))[:80]}"}
        for side in sides if side is not None
    ]


def unmintable_reason(drift: dict[str, Any], evidences: list[dict[str, str]]) -> str | None:
    """Why the seeder would not mint this drift, or None when it would."""
    if len(evidences) < 2:
        return "fewer_than_two_evidence_sides"
    if str(drift.get("severity")) not in MINTABLE_SEVERITIES or not drift.get("classification"):
        return "unclassified_drift"
    return None


def drift_subject_key(drift: dict[str, Any], evidences: list[dict[str, str]]) -> str | None:
    """ARIA-HIGH-363 — the drift's line-independent identity, from the kernel's one definition."""
    _kernel_on_path()
    from aria_kernel.finding_subject import subject_key_from_evidences

    return subject_key_from_evidences(drift_class=str(drift.get("drift_class") or ""), evidences=evidences)


def mint_candidates(
    repo_root: Path, candidates: list[dict[str, Any]],
    *, base_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
    """ORPHAN-702 — every drift goes through the ONE mint path.

    ARIA-HIGH-363 — dedupe is by SUBJECT (drift class + the file and declared
    name of each side), not by evidence chain. The chain id hashes the cited
    line and the value lists, so the same option group seen at a new line
    minted a new finding (F-003/F-005/F-007/F-008/F-015 are one LeavesPage
    filter at lines 346/358/355/353/389). A subject held by a finding in any
    state but RESOLVED is already recorded; a RESOLVED one was closed because
    its detector stopped reproducing it at the merge, so the subject seen
    again is a regression and gets a finding of its own.

    claim_type=spine_drift by definition; severity is the scanner's
    classification (a drift without one is unmintable — fail closed, never
    a guessed HIGH); a drift the kernel refuses is DISCLOSED as unmintable,
    never hand-written around the gate.
    """
    _kernel_on_path()
    from aria_kernel.cycle_guard import OpenerAdmission, admit_finding_opener, backlog_census
    from aria_kernel.finding import _evidence_chain_id, emit_finding, fold_findings
    from aria_kernel.finding_subject import finding_subject_key
    from aria_kernel.tool_registry import GovernanceError

    recorded = fold_findings(repo_root) or {}
    held = {
        key for key in (
            finding_subject_key(record)
            for record in recorded.values()
            if record.get("status") != "RESOLVED"
        ) if key is not None
    }
    # Review M2 — a drift with no derivable subject (e.g. both sides one file
    # and one name) still has the identity it always had: its evidence chain.
    # Held by any recorded finding, as before ARIA-HIGH-363.
    held_chains = {str(record.get("evidence_chain_id")) for record in recorded.values()}
    minted: list[dict[str, Any]] = []
    already: list[str] = []
    unmintable: list[dict[str, str]] = []
    admission: OpenerAdmission | None = None
    for drift in candidates:
        evidences = drift_evidences(drift)
        concept = str(drift.get("concept") or "unknown")
        reason = unmintable_reason(drift, evidences)
        if reason is not None:
            unmintable.append({"concept": concept, "reason": reason})
            continue
        severity = str(drift.get("severity"))
        subject = drift_subject_key(drift, evidences)
        chain = _evidence_chain_id([{"ref": e["ref"], "summary": e.get("summary", "")} for e in evidences])
        if (subject in held) if subject is not None else (chain in held_chains):
            already.append(concept)
            continue
        # Wall #7 — the seeder opens findings, so under backlog pressure it
        # runs at the openers' rate: asked once, at the first NEW drift. A
        # held run mints nothing; the scan finds the same drift next run.
        if admission is None:
            admission = admit_finding_opener(base_dir, "seed_drift_findings", backlog_census(repo_root))
        if not admission.admitted:
            unmintable.append({"concept": concept, "reason": "opener_throttled:" + ",".join(admission.reasons)})
            continue
        summary = (
            f"{drift['drift_class']}: '{concept}' {drift['classification']} across "
            f"{len(evidences)} surfaces (cross_service={bool(drift.get('cross_service'))})"
        )
        facts = [
            f"classification: {drift['classification']} over {drift.get('transport') or 'db'}",
            f"missing in ts/ui: {sorted(drift.get('missing_in_ts') or drift.get('missing_in_ui') or [])[:8]}",
            f"missing in sql/source: {sorted(drift.get('missing_in_sql') or drift.get('missing_in_source') or [])[:8]}",
        ]
        try:
            record = emit_finding(
                repo_root=repo_root,
                base_dir=base_dir,
                claim_type="spine_drift",
                claim_summary=summary,
                severity=severity,
                evidences=evidences,
                facts=facts,
                scope_files=sorted({e["ref"].split(":")[0] for e in evidences}),
                originating_skill="seed:drift-scan",
            )
        except GovernanceError as exc:
            unmintable.append({"concept": concept, "reason": str(exc)[:160]})
            continue
        if subject is not None:
            held.add(subject)
        held_chains.add(chain)
        minted.append(record)
    return minted, already, unmintable


# ARIA-HIGH-363 — the recheck verdicts the kernel's finding closure reads.
VERDICT_REPRODUCES = "reproduces"
VERDICT_ABSENT = "absent"
VERDICT_UNVERIFIABLE = "unverifiable"
# The drift class whose verdict depends on the GraphQL wire: without a
# loaded wire the scanner judges no UI pair, so "not found" means "not
# judged", never "fixed".
WIRE_JUDGED_DRIFT_CLASSES = frozenset({"ui_option_drift"})


# The document sections the judge reads, and the side keys a drift carries.
SCAN_SECTIONS = ("drifts_above_threshold", "frontend_dropdown_drifts")
SIDE_KEYS = ("ts", "sql", "ui", "source")


def scan_shape_fault(drifts_doc: Any) -> str | None:
    """Why this scan document cannot be judged, or None (review M1).

    A missing section, a non-list section, a drift that is not an object or a
    drift whose sides are not ``{ref, name}`` objects means the scanner wrote a
    shape this judge does not read. "No match" in such a document is not
    evidence of absence.
    """
    if not isinstance(drifts_doc, dict):
        return "scan_doc_not_an_object"
    for section in SCAN_SECTIONS:
        if not isinstance(drifts_doc.get(section), list):
            return f"scan_section_missing:{section}"
        for drift in drifts_doc[section]:
            if not isinstance(drift, dict):
                return f"scan_drift_not_an_object:{section}"
            sides = [drift.get(key) for key in SIDE_KEYS if key in drift]
            if len(sides) < 2 or not all(
                isinstance(side, dict) and isinstance(side.get("ref"), str) and isinstance(side.get("name"), str)
                for side in sides
            ):
                return f"scan_side_shape:{section}"
    return None


def judge_subject(drifts_doc: dict[str, Any], *, subject_key: str, drift_class: str) -> dict[str, Any]:
    """Does this scan reproduce the subject? The seeder's own selection, unlimited.

    A drift reproduces the subject when the seeder would mint it (or count it
    already recorded) at this revision: mintable, and the same subject key. A
    document whose shape this judge does not read is unverifiable for every
    drift class, never absent.
    """
    fault = scan_shape_fault(drifts_doc)
    if fault is not None:
        return {"verdict": VERDICT_UNVERIFIABLE, "reason": fault, "matches": [], "wire": None}
    ranked = select_candidates(drifts_doc, limit=len(drifts_doc.get("drifts_above_threshold") or [])
                               + len(drifts_doc.get("frontend_dropdown_drifts") or []))
    matches: list[str] = []
    for drift in ranked:
        evidences = drift_evidences(drift)
        if unmintable_reason(drift, evidences) is None and drift_subject_key(drift, evidences) == subject_key:
            matches.extend(evidence["ref"] for evidence in evidences)
    wire = drifts_doc.get("wire") or {}
    if matches:
        return {"verdict": VERDICT_REPRODUCES, "reason": "subject_in_scan", "matches": matches,
                "wire": wire.get("status")}
    if drift_class in WIRE_JUDGED_DRIFT_CLASSES and wire.get("status") != "ok":
        return {"verdict": VERDICT_UNVERIFIABLE,
                "reason": f"wire_unavailable:{wire.get('reason') or 'no_wire_section'}",
                "matches": [], "wire": wire.get("status")}
    return {"verdict": VERDICT_ABSENT, "reason": "subject_not_in_scan", "matches": [],
            "wire": wire.get("status")}


def _schema_commit(repo: Path) -> str | None:
    """The newest commit on HEAD's first-parent line that changed the supergraph's inputs."""
    import fetch_supergraph

    workflow = repo / fetch_supergraph.WORKFLOW
    if not workflow.is_file():
        return None
    return fetch_supergraph.schema_commit(repo, fetch_supergraph.push_paths(workflow.read_text(encoding="utf-8")))


def recheck_subject(
    repo_root: Path, *, subject_key: str, drift_class: str, at_sha: str, supergraph: str | None,
) -> dict[str, Any]:
    """Re-run the seeder's drift scan at ``at_sha`` and judge one subject.

    The scan runs in a detached worktree of ``at_sha``, so the verdict is
    about the merged revision and not about whatever HEAD has become. The
    supergraph the lane fetched is exact for HEAD; it is handed to the scan
    only when no schema-affecting commit separates HEAD from ``at_sha``
    (the same first-parent test ``fetch_supergraph`` accepts an artifact by),
    otherwise the UI pairs are honestly unverifiable.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    base = {"subject_key": subject_key, "drift_class": drift_class, "at": at_sha}
    with tempfile.TemporaryDirectory(prefix="aria-recheck-") as tmp:
        tree = Path(tmp) / "tree"
        added = subprocess.run(
            ["git", "-C", str(repo_root), "worktree", "add", "--detach", "--quiet", str(tree), at_sha],
            capture_output=True, text=True,
        )
        if added.returncode != 0:
            return {**base, "verdict": VERDICT_UNVERIFIABLE, "reason": "revision_unavailable",
                    "matches": [], "wire": None}
        try:
            # No schema commit on either side means no evidence the artifact
            # matches this tree, not a match.
            merged_schema = _schema_commit(tree)
            exact = supergraph is not None and merged_schema is not None and merged_schema == _schema_commit(repo_root)
            doc = run_fresh_scan(tree, supergraph if exact else None)
        finally:
            subprocess.run(["git", "-C", str(repo_root), "worktree", "remove", "--force", str(tree)],
                           capture_output=True, text=True)
    return {**base, **judge_subject(doc, subject_key=subject_key, drift_class=drift_class)}


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
    parser.add_argument(
        "--supergraph", default=None,
        help="Composed supergraph SDL passed to poc.py (default: its dist/graphql path).",
    )
    parser.add_argument(
        "--recheck-subject", default=None,
        help=("ARIA-HIGH-363: judge ONE subject key at --at instead of seeding; prints one "
              "JSON verdict line (reproduces / absent / unverifiable)."),
    )
    parser.add_argument("--drift-class", default=None, help="The rechecked subject's drift class.")
    parser.add_argument("--at", default=None, help="The revision the recheck scans (a merge commit).")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    if args.recheck_subject is not None:
        if not args.drift_class or not args.at:
            parser.error("--recheck-subject requires --drift-class and --at")
        verdict = recheck_subject(
            repo_root, subject_key=args.recheck_subject, drift_class=args.drift_class,
            at_sha=args.at, supergraph=args.supergraph,
        )
        print(json.dumps(verdict, sort_keys=True))
        return 0
    out_dir = findings_out_dir(repo_root, args.out_dir)
    head_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, cwd=repo_root,
        capture_output=True, text=True,
    ).stdout.strip()

    print(f"[seed] fresh mechanical scan at {head_sha[:12]} ...", flush=True)
    drifts_doc = run_fresh_scan(repo_root, args.supergraph)
    wire = drifts_doc.get("wire") or {}
    if wire.get("status") != "ok":
        # UI drifts need the wire; without it they are unverifiable, not absent.
        print(f"[seed] WIRE UNAVAILABLE: {wire.get('reason') or 'no_wire_section'} "
              f"({wire.get('supergraph')}) — UI option drifts were not judged")
    total_sql = len(drifts_doc.get("drifts_above_threshold") or [])
    total_ui = len(drifts_doc.get("frontend_dropdown_drifts") or [])
    candidates = select_candidates(drifts_doc, limit=args.limit)

    # ORPHAN-702 — the seeder graduates to the ONE mint path. It used to
    # write its own F-NNN.json files OVER the same ids every night: no
    # events, no lifecycle, invisible to replay — the second finding
    # format İ1 forbids. Now every drift goes through emit_finding:
    # subject dedupe (ARIA-HIGH-363) keeps one durable record per drift across nights,
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
