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

Output contract: every drift is minted through the kernel's one mint path,
``aria_kernel.finding.emit_finding`` (see ``mint_candidates``), which writes
the ``F-<NNN>.json`` record and refreshes ``_index.json`` under
``aria_kernel.finding.findings_dir`` — the ``aria-findings/`` surface of the
repo-state root (``aria_kernel.workspace.repo_state_root``: the durable
``aria/state`` store when a lane binds it, else the repository root).
``aria_kernel.cycle_guard._open_finding_count`` reads that index. The seeder
writes no finding file of its own, so the producer and the consumer cannot
point at different directories.

The third class, ``graphql_operation_drift`` (DET crossfile-5, Z38), is not scanned here: its owner
is ``scripts/ci/validate-graphql-operations.mjs`` (``graphql.validate`` of every FE operation against
the composed supergraph, CI's zero-new-drift ratchet). ``run_graphql_operations`` runs that script
with ``--json`` and the class is what it prints; a run that did not reach a verdict is a NAMED
observation (``wire_unverifiable``), never an empty list.

Determinism: ``select_candidates`` orders drifts stably (severity desc,
cross_service first, gate-free first, similarity desc, concept asc).
Identity and dedupe are ``emit_finding``'s: a drift's subject key, or its
evidence chain when no subject derives (``mint_candidates``), so the same
drift seen on a later night is counted as already recorded, not re-minted.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

CANDIDATE_TOOL_SQL = "typeorm-entity-schema-adapter"
CANDIDATE_TOOL_UI = "event-contracts-adapter"
CANDIDATE_TOOL_GRAPHQL = "fe-dto-parity-adapter"
# The scanner classifies every drift it emits and names its severity
# (ui_value_not_on_wire / ts_value_not_in_db HIGH, own-service subsets LOW).
# The seeder mints that severity; it does not re-derive one from blast radius.
MINTABLE_SEVERITIES = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}

GRAPHQL_DRIFT_CLASS = "graphql_operation_drift"
GRAPHQL_OPERATIONS_OWNER = "scripts/ci/validate-graphql-operations.mjs"
# The scan document's section for the owner's run: {status, reason, drifts}.
GRAPHQL_SECTION = "graphql_operations"
# Every category the owner names is an operation the gateway's own graphql.validate rejects (an HTTP
# 400 at request time), so the class has one severity; the category is the classification.
GRAPHQL_DRIFT_SEVERITY = "HIGH"
# The one fatal the owner has: the supergraph file is absent (exit 0 and 1 are verdicts).
OWNER_EXIT_SCHEMA_ABSENT = 2
GRAPHQL_OWNER_TIMEOUT_SECONDS = 120
# The contract side of the class's two evidence sides: the supergraph is a CI artifact outside the
# repository, so the only repo-verifiable place the drift is seen is the operation's own file.
GRAPHQL_CONTRACT_SIDE = "supergraph"


# ARIA-HIGH-363 (review M1) — the scanner is the one that ships with THIS
# seeder, never the copy inside the tree being scanned. A recheck scans a merge
# commit's tree; that tree's own poc.py may write a different document shape,
# and this module's judge would read a renamed or missing section as "no
# drift". One scanner, one judge, one revision of both.
SCANNER = Path(__file__).resolve().parent / "poc.py"


def _graphql_section(status: str, reason: str = "", drifts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"status": status, "reason": reason, "drifts": drifts or []}


def _owner_drifts(stdout: str) -> list[dict[str, Any]] | None:
    """The owner's ``--json`` array when it is the shape this seeder reads, else None."""
    try:
        parsed = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(parsed, list):
        return None
    for entry in parsed:
        if not isinstance(entry, dict) or not isinstance(entry.get("messages"), list):
            return None
        if not all(isinstance(entry.get(key), str) for key in ("key", "file", "op", "category")):
            return None
    return parsed


def run_graphql_operations(repo_root: Path, supergraph: str | None = None) -> dict[str, Any]:
    """The owner's verdict on ``repo_root``'s FE GraphQL operations: ``{status, reason, drifts}``.

    ``ok`` only when the owner ran to a verdict (exit 0 or 1) and printed its JSON array. Every other
    outcome says why it did not: "no drift listed" must never be read from a check that did not run
    (a node that crashed on a missing dependency exits 1 with nothing on stdout, and a missing
    supergraph is the owner's own fatal). The owner is the tree's own copy: it finds the FE sources of
    the tree it sits in, so a recheck at a merge commit runs that commit's check.

    Only a supergraph the caller GIVES is judged against. The owner's own default is
    ``dist/graphql/supergraph.graphql``, an artifact of unknown age that any earlier compose left in
    the tree: reading it could mint HIGH findings for a schema the gateway no longer serves, so without
    a given path the owner is not run at all (the same named result as a path that is not a file).
    """
    if not supergraph:
        return _graphql_section("unavailable", "supergraph_not_given")
    owner = repo_root / GRAPHQL_OPERATIONS_OWNER
    if not owner.is_file():
        return _graphql_section("unavailable", "owner_not_found")
    command = ["node", str(owner), "--json", "--schema", supergraph]
    try:
        run = subprocess.run(command, cwd=repo_root, capture_output=True, text=True,
                             timeout=GRAPHQL_OWNER_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return _graphql_section("unavailable", f"owner_unrunnable:{type(exc).__name__}")
    if run.returncode == OWNER_EXIT_SCHEMA_ABSENT:
        return _graphql_section("unavailable", "supergraph_not_found")
    drifts = _owner_drifts(run.stdout) if run.returncode in (0, 1) else None
    if drifts is None:
        return _graphql_section("unavailable", f"owner_exit_{run.returncode}")
    return _graphql_section("ok", drifts=drifts)


def graphql_section(drifts_doc: dict[str, Any]) -> dict[str, Any]:
    """The owner's run as a scan document records it; a document without one was not judged."""
    return drifts_doc.get(GRAPHQL_SECTION) or _graphql_section("unavailable", "no_section")


def graphql_drifts(drifts_doc: dict[str, Any]) -> list[dict[str, Any]]:
    """The owner's drifts of a scan document; none unless the owner reached a verdict."""
    section = graphql_section(drifts_doc)
    return section["drifts"] if section["status"] == "ok" else []


def run_fresh_scan(repo_root: Path, supergraph: str | None = None) -> dict[str, Any]:
    """Run this seeder's PoC mechanical scanner over ``repo_root`` and return its drift doc.

    The doc also carries the owner's run of the FE GraphQL operation check (``GRAPHQL_SECTION``), so a
    recheck, which scans through here, judges that class by the same run that minted it.
    """
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
        doc = json.loads((repo_root / out_rel / "MECHANICAL_DRIFTS.json").read_text(encoding="utf-8"))
    doc[GRAPHQL_SECTION] = run_graphql_operations(repo_root, supergraph)
    return doc


def _sort_key(drift: dict[str, Any]) -> tuple[Any, ...]:
    return (
        -MINTABLE_SEVERITIES.get(str(drift.get("severity")), 0),
        not bool(drift.get("cross_service")),
        bool(drift.get("existing_gate_refs")),
        -float(drift.get("value_jaccard_similarity") or 0.0),
        str(drift.get("concept") or ""),
    )


def _graphql_candidate(entry: dict[str, Any]) -> dict[str, Any]:
    """One owner drift as a seed candidate: the operation (``ui``) against the contract it breaks (``source``)."""
    return {
        "drift_class": GRAPHQL_DRIFT_CLASS, "candidate_tool": CANDIDATE_TOOL_GRAPHQL,
        "concept": entry["op"], "classification": entry["category"], "severity": GRAPHQL_DRIFT_SEVERITY,
        "cross_service": False, "transport": "graphql", "messages": entry["messages"],
        "ui": {"ref": entry["file"], "name": entry["op"], "values": entry["messages"]},
        "source": {"ref": entry["file"], "name": GRAPHQL_CONTRACT_SIDE, "values": [entry["category"]]},
    }


def select_candidates(drifts_doc: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    """Stable-ordered seed candidates: TS<->SQL drifts first, then
    promoted frontend dropdown drifts (already confidence-gated by the
    scanner), then the owner's FE GraphQL operation drifts."""
    sql_drifts = [
        {"drift_class": "enum_drift", "candidate_tool": CANDIDATE_TOOL_SQL, **d}
        for d in (drifts_doc.get("drifts_above_threshold") or [])
    ]
    ui_drifts = [
        {"drift_class": "ui_option_drift", "candidate_tool": CANDIDATE_TOOL_UI, **d}
        for d in (drifts_doc.get("frontend_dropdown_drifts") or [])
    ]
    graphql_candidates = [_graphql_candidate(entry) for entry in graphql_drifts(drifts_doc)]
    ranked = sorted(sql_drifts, key=_sort_key) + sorted(ui_drifts, key=_sort_key) + sorted(graphql_candidates, key=_sort_key)
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


def drift_facts(drift: dict[str, Any]) -> list[str]:
    """The facts a drift is minted with: the classification, then what differs."""
    facts = [f"classification: {drift['classification']} over {drift.get('transport') or 'db'}"]
    if drift["drift_class"] == GRAPHQL_DRIFT_CLASS:
        # The first three messages, as many as the owner's own report prints per operation.
        return facts + [f"owner message: {message}" for message in drift["messages"][:3]]
    return facts + [
        f"missing in ts/ui: {sorted(drift.get('missing_in_ts') or drift.get('missing_in_ui') or [])[:8]}",
        f"missing in sql/source: {sorted(drift.get('missing_in_sql') or drift.get('missing_in_source') or [])[:8]}",
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
    filter seen at five different lines). A subject held by a finding in any
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
        facts = drift_facts(drift)
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
                               + len(drifts_doc.get("frontend_dropdown_drifts") or [])
                               + len(graphql_drifts(drifts_doc)))
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
    graphql = graphql_section(drifts_doc)
    if drift_class == GRAPHQL_DRIFT_CLASS and graphql["status"] != "ok":
        # The owner did not reach a verdict (no supergraph, no dependency, a crash): not found is not judged.
        return {"verdict": VERDICT_UNVERIFIABLE, "reason": f"graphql_operations_unavailable:{graphql['reason']}",
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


def _share_dependencies(repo_root: Path, tree: Path) -> bool:
    """Let the owner's ``import 'graphql'`` resolve in a detached worktree, which has no node_modules.

    The dependency install belongs to the checkout the cycle runs in; the worktree links to it for the
    scan and the caller removes the link. True when this call made the link.
    """
    installed, link = repo_root / "node_modules", tree / "node_modules"
    if not installed.is_dir() or link.exists():
        return False
    link.symlink_to(installed)
    return True


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
        linked = _share_dependencies(repo_root, tree)
        try:
            # No schema commit on either side means no evidence the artifact
            # matches this tree, not a match.
            merged_schema = _schema_commit(tree)
            exact = supergraph is not None and merged_schema is not None and merged_schema == _schema_commit(repo_root)
            doc = run_fresh_scan(tree, supergraph if exact else None)
        finally:
            if linked:
                # Unlink first: removing the worktree must never reach the checkout's own install.
                (tree / "node_modules").unlink()
            subprocess.run(["git", "-C", str(repo_root), "worktree", "remove", "--force", str(tree)],
                           capture_output=True, text=True)
    return {**base, **judge_subject(doc, subject_key=subject_key, drift_class=drift_class)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=".", help="Repository root (default: cwd)")
    parser.add_argument("--limit", type=int, default=20, help="Max findings to seed")
    parser.add_argument(
        "--supergraph", default=None,
        help=("Composed supergraph SDL passed to poc.py (default: its dist/graphql path). The FE GraphQL "
              "operation check runs only with a path given here, never on a default."),
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
    graphql = graphql_section(drifts_doc)
    if graphql["status"] != "ok":
        # The owner reached no verdict, so FE operations are unverifiable, not clean.
        print(f"[seed] {GRAPHQL_DRIFT_CLASS} wire_unverifiable:{graphql['reason']} — FE GraphQL operations were not validated")
    total_sql = len(drifts_doc.get("drifts_above_threshold") or [])
    total_ui = len(drifts_doc.get("frontend_dropdown_drifts") or [])
    total_graphql = len(graphql_drifts(drifts_doc))
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

    print(f"[seed] scan: {total_sql} sql-drifts + {total_ui} ui-drifts above threshold + {total_graphql} graphql-operation drifts")
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
