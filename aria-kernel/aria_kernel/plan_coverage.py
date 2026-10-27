"""Deterministic plan-coverage computation (the kernel side of the gate).

WHY this module exists: convergence measures AGREEMENT, not COVERAGE — the
primary and challenger planners can share a blind spot and happily converge
on it. The planner prompts demand recursive impact tracing, but a prompt is
a wish; nothing verified it. This module turns the obligation into machine
truth: it computes the impact closure of a plan's ``affected_surfaces`` through
the kernel's one closure (``impact_graph.impact_closure`` at depth
``PLAN_CLOSURE_DEPTH``, over the code facts of the same tree), hands its node set
to the repo's plan-coverage witness (a deterministic TypeScript gate that adds
the entity->migration coupling and the event subscriptions it cannot resolve,
and diffs the nodes against what the plan claims or waives), and shapes the
result into the ``coverage_computed`` event payload that
``plan_convergence.record_coverage`` validates and persists.

Fail-closed discipline: this function NEVER raises for environmental
problems. A missing node toolchain, a witness crash, a timeout, or garbage
stdout all produce a ``verdict="environment_unable"`` payload — the evaluator
escalates that to HUMAN_REQUIRED. An empty closure can never masquerade as
"covered" because the witness itself distinguishes exit 0/1 (computed) from
exit 2 (environment), and anything unparseable lands on the environment side.

The same discipline runs the code-fact bridge (service-expertise PLAN §2, §3.3, SE-3):
``compute_service_facts`` runs the two ``--facts`` entries on the diff's base tree through the
one runner below (``run_ts_json_entry``), and any environment failure is a named
``environment_unable`` with no partial facts, so the change is held instead of being routed as
if its services produced and consumed nothing.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Callable

from .evidence_validator import coverage_manifest_pointer
from .impact_graph import impact_closure
from .plan_convergence import affected_surface_paths as _affected_surface_paths
from .tool_registry import ensure_tools_dir, utc_now
from .digest import sha256_digest
from .workspace_view import WorkspaceViewRefused, hermetic_git, index_flagged_paths, workspace_head_sha

WITNESS_RELPATH = "tools/gates/plan-coverage-witness.ts"
WITNESS_TSCONFIG = "tools/gates/tsconfig.json"
EVENT_FACTS_RELPATH = "tools/gates/event-consumer-index.ts"
MODULE_FACTS_RELPATH = "tools/aria-adapters/module-schemas-source.ts"
# The workspace's own installed ts-node: no package-manager launcher, so no registry fallback.
TS_NODE_RELPATH = "node_modules/.bin/ts-node"
DEFAULT_TIMEOUT_SECONDS = 180
# The plan-time policy value of the closure's depth (service-expertise PLAN §8 SE-4): the plan
# must address the projects one edge away from what it touches, or waive them.
PLAN_CLOSURE_DEPTH = 1
TREE_STATUS_TIMEOUT_SECONDS = 60
COVERAGE_DIR = "coverage"
# Severity is "material" (not "blocking"): a coverage gap must block
# convergence via the material gate AND remain addressable through the
# normal revision loop (addresses_review_risk_ids), exactly like a
# reviewer-raised material risk.
SYNTHETIC_RISK_SEVERITY = "material"
SYNTHETIC_RISK_CATEGORY = "coverage_gap"

Runner = Callable[[list[str], str, int], "subprocess.CompletedProcess[str]"]


def _default_runner(cmd: list[str], cwd: str, timeout_seconds: int) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(  # noqa: S603 — fixed argv, no shell
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def run_ts_json_entry(
    run: Runner,
    *,
    tool: str,
    args: list[str],
    workspace: Path,
    timeout_seconds: int,
    ok_exit_codes: tuple[int, ...],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Run one TypeScript JSON entry of ``workspace`` and read its one JSON object.

    Returns ``(report, witness)``. ``report`` is None exactly when the run is an environment
    failure, and ``witness["error"]`` then names it: ``toolchain_missing``, ``timeout_after_<n>s``,
    ``witness_environment_exit_<code>`` (an exit outside ``ok_exit_codes``) or
    ``witness_output_unparseable`` (stdout that is not one JSON object). Nothing is written.

    The entry runs on the workspace's own installed ``ts-node`` (``TS_NODE_RELPATH``), never through
    ``npx``: on a tree without ``node_modules`` npx does not fail, it fetches an unpinned ts-node
    from the package registry and runs it with the kernel's environment. The tree's own binary
    either exists or raises FileNotFoundError, which is ``toolchain_missing`` (PLAN Risk 7).
    """
    cmd = [str(workspace / TS_NODE_RELPATH), "--project", WITNESS_TSCONFIG, tool, *args]
    started_at = utc_now()
    try:
        proc = run(cmd, str(workspace), timeout_seconds)
    except FileNotFoundError as exc:
        return None, {"tool": tool, "error": f"toolchain_missing: {exc}", "started_at": started_at}
    except subprocess.TimeoutExpired:
        return None, {"tool": tool, "error": f"timeout_after_{timeout_seconds}s", "started_at": started_at}
    witness: dict[str, Any] = {
        "tool": tool,
        "exit_code": proc.returncode,
        "started_at": started_at,
        "finished_at": utc_now(),
    }
    stderr_tail = (proc.stderr or "")[-2000:]
    if proc.returncode not in ok_exit_codes:
        witness["error"] = f"witness_environment_exit_{proc.returncode}"
        witness["stderr_tail"] = stderr_tail
        return None, witness
    try:
        report = json.loads(proc.stdout)
        if not isinstance(report, dict):
            raise ValueError("witness output is not an object")
    except (json.JSONDecodeError, ValueError) as exc:
        witness["error"] = f"witness_output_unparseable: {exc}"
        witness["stderr_tail"] = stderr_tail
        return None, witness
    return report, witness


def build_synthetic_risk(node: dict[str, Any], *, round_number: int, closure_manifest_path: str) -> dict[str, Any]:
    """Shape one uncovered closure node as a CROSS_REVIEW_RISK-schema risk.

    The risk_id is ROUND-SCOPED (``COV-R{N}-<hash>``): resolved_review_risk_ids
    accumulates globally across rounds, so a stable id would let round N's
    "addressed" claim mask the SAME still-uncovered node re-detected in round
    N+1. A fresh id per round keeps machine verification authoritative.
    """
    node_id = str(node.get("node_id"))
    digest = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:8]
    return {
        "risk_id": f"COV-R{round_number}-{digest}",
        "risk_category": SYNTHETIC_RISK_CATEGORY,
        "severity": SYNTHETIC_RISK_SEVERITY,
        "summary": (
            f"Impact-closure node {node_id} ({node.get('kind')}) is not addressed by "
            f"affected_surfaces and not waived: {node.get('why')}"
        ),
        "recommendation": (
            "Widen affected_surfaces to address the node, or add a coverage.waivers "
            "entry {node, reason} the completeness critic can adjudicate"
        ),
        # ARIA-HIGH-354 — the manifest is a state-store record, not a repo
        # file, and a closure node names a project, not a file: the risk
        # lists no repository file, and cites the manifest by the pointer
        # every later planning envelope of this plan carries
        # (`plan_convergence._reviewed_coverage_pointers`).
        "affected_files": [],
        "evidence_refs": [coverage_manifest_pointer(closure_manifest_path)],
    }


def environment_unable_payload(
    *,
    round_number: int,
    target_revision_id: str,
    target_plan_content_hash: str,
    manifest_relpath: str,
    manifest_hash: str,
    computed_at_sha: str,
    witness: dict[str, Any],
) -> dict[str, Any]:
    return {
        "round_number": round_number,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_plan_content_hash,
        "verdict": "environment_unable",
        "closure_manifest_path": manifest_relpath,
        "closure_manifest_hash": manifest_hash,
        "closure_summary": {},
        "uncovered": [],
        "waived": [],
        "synthetic_risks": [],
        "computed_at_sha": computed_at_sha,
        "witness": witness,
    }


def parse_critic_adjudication(response: dict[str, Any] | None) -> dict[str, Any] | None:
    """Extract the completeness-critic verdict from a response envelope.

    Expected shape (documented in .claude/agents/aria-completeness-critic.md
    and the canonical-envelope knowledge file):

        details.waiver_adjudication = {
            "accepted": ["<node_id>", ...],
            "rejected": [{"node_id": "...", "reason": "..."}, ...],
        }

    Returns the normalized dict, or None when the response is missing or
    malformed — the caller treats None as "unadjudicated" (fail-closed:
    every waived node flips to uncovered).
    """
    if not isinstance(response, dict):
        return None
    details = response.get("details")
    if not isinstance(details, dict):
        return None
    raw = details.get("waiver_adjudication")
    if not isinstance(raw, dict):
        return None
    accepted_raw = raw.get("accepted")
    rejected_raw = raw.get("rejected")
    if not isinstance(accepted_raw, list) or not isinstance(rejected_raw, list):
        return None
    accepted = [item for item in accepted_raw if isinstance(item, str) and item]
    rejected: list[dict[str, str]] = []
    for item in rejected_raw:
        if not isinstance(item, dict):
            return None
        node_id = item.get("node_id")
        reason = item.get("reason")
        if not (isinstance(node_id, str) and node_id and isinstance(reason, str) and reason):
            return None
        rejected.append({"node_id": node_id, "reason": reason})
    return {"accepted": accepted, "rejected": rejected}


def adjudicate_waivers(
    *,
    payload: dict[str, Any],
    adjudication: dict[str, Any] | None,
    round_number: int,
    critic_request_id: str | None = None,
) -> dict[str, Any]:
    """Fold the critic verdict into a covered_with_waivers coverage payload.

    Fail-closed by construction: a waived node covers its closure node ONLY
    when the critic explicitly accepts it. Rejected nodes flip to uncovered
    with the critic's reason; nodes the critic never adjudicated (timeout,
    refusal, malformed response, or simply omitted) flip with
    ``waiver_unadjudicated`` — PR-1's machine-accepts-any-reason loosening
    ends here. Flipped nodes get fresh round-scoped synthetic risks so the
    existing material gate + revision loop carry them.
    """
    waived = list(payload.get("waived", []))
    if not waived:
        return payload
    accepted = set((adjudication or {}).get("accepted", []))
    rejected_reasons = {
        item["node_id"]: item["reason"]
        for item in (adjudication or {}).get("rejected", [])
    }
    kept: list[dict[str, Any]] = []
    flipped: list[dict[str, Any]] = []
    for waiver in waived:
        node_id = str(waiver.get("node_id"))
        if node_id in accepted:
            kept.append(waiver)
            continue
        if node_id in rejected_reasons:
            why = f"waiver_rejected_by_critic: {rejected_reasons[node_id]}"
        else:
            why = "waiver_unadjudicated"
        flipped.append({"node_id": node_id, "kind": "waiver_adjudication", "why": why})
    result = dict(payload)
    result["waived"] = kept
    result["uncovered"] = list(payload.get("uncovered", [])) + flipped
    manifest_path = str(payload.get("closure_manifest_path"))
    result["synthetic_risks"] = list(payload.get("synthetic_risks", [])) + [
        build_synthetic_risk(node, round_number=round_number, closure_manifest_path=manifest_path)
        for node in flipped
    ]
    if result["uncovered"]:
        result["verdict"] = "gaps"
    else:
        result["verdict"] = "covered_with_waivers" if kept else "covered"
    witness = dict(payload.get("witness") or {})
    witness["waiver_adjudication"] = {
        "adjudicated": adjudication is not None,
        "accepted": len(kept),
        "rejected": sum(1 for n in flipped if n["why"].startswith("waiver_rejected_by_critic")),
        "unadjudicated": sum(1 for n in flipped if n["why"] == "waiver_unadjudicated"),
        "critic_request_id": critic_request_id,
    }
    result["witness"] = witness
    return result


def _coverage_witness_input(plan_content: dict[str, Any]) -> dict[str, Any]:
    """The writer's normalized input, also used to verify its native artifact."""
    affected = plan_content.get("affected_surfaces") or {}
    # Preserve the direct wrapper shape while sharing native plan path extraction.
    paths = _affected_surface_paths([affected] if isinstance(affected, dict) else affected)
    waivers = (plan_content.get("coverage") or {}).get("waivers", [])
    return {
        "schema_version": 1,
        "affected_paths": [str(p) for p in (paths or [])],
        "waivers": [
            {"node": str(w.get("node")), "reason": str(w.get("reason"))}
            for w in waivers
            if isinstance(w, dict)
        ],
    }


def _coverage_report_fields(
    report: dict[str, Any], *, round_number: int, manifest_relpath: str,
) -> dict[str, Any]:
    """Derive event fields from the exact witness report without file writes."""
    uncovered = [
        {
            "node_id": str(node.get("node_id")),
            "kind": str(node.get("kind")),
            "why": str(node.get("why")),
        }
        for node in report.get("uncovered", [])
        if isinstance(node, dict)
    ]
    waived = [
        {"node_id": str(node.get("node_id")), "reason": str(node.get("reason"))}
        for node in report.get("waived", [])
        if isinstance(node, dict)
    ]
    closure = report.get("closure") or {}
    closure_summary = {
        "projects": len(closure.get("projects", [])),
        "closure_nodes": len(closure.get("closure_nodes", [])),
        "migration_couplings": len(closure.get("migration_couplings", [])),
        "unmapped_paths": len(report.get("unmapped_paths", [])),
        "waived": len(waived),
    }
    if uncovered:
        verdict = "gaps"
        synthetic_risks = [
            build_synthetic_risk(node, round_number=round_number, closure_manifest_path=manifest_relpath)
            for node in uncovered
        ]
    else:
        verdict = "covered_with_waivers" if waived else "covered"
        synthetic_risks = []
    return {
        "verdict": verdict,
        "closure_summary": closure_summary,
        "uncovered": uncovered,
        "waived": waived,
        "synthetic_risks": synthetic_risks,
    }


def compute_plan_coverage(
    *,
    plan_content: dict[str, Any],
    plan_id: str,
    round_number: int,
    target_revision_id: str,
    target_plan_content_hash: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    runner: Runner | None = None,
) -> dict[str, Any]:
    """Compute the impact-closure verdict for one plan revision.

    Returns a payload ready for ``plan_convergence.record_coverage``. The
    closure manifest (full witness output) is written as an artifact file
    under ``<tools>/coverage/`` and referenced by path+hash from the event —
    events stay small, the audit trail stays complete.
    """
    run = runner or _default_runner
    workspace = Path(workspace_root)
    root = ensure_tools_dir(base_dir)
    coverage_dir = root / COVERAGE_DIR
    coverage_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = coverage_dir / f"{plan_id}-r{round_number}.json"
    tools_root_name = root.name if root.is_absolute() else str(root)
    manifest_relpath = f"{tools_root_name}/{COVERAGE_DIR}/{manifest_path.name}"

    # The checkout the witness reads, through the kernel's one hermetic HEAD reader: an inherited
    # GIT_DIR never names another repository's commit as the one the closure was computed at.
    computed_at_sha = workspace_head_sha(workspace) or "unknown"

    # SE-4 — the closure has one owner, `impact_graph.impact_closure`, over the code facts of the
    # tree the witness reads (computed through the same runner); the witness reports gaps against
    # its node set and computes no project or event-consumer node of its own. Facts that cannot be
    # computed hold the plan by name before the witness runs: an import-only closure would pass a
    # plan whose contract dependents it never looked for.
    service_facts = compute_service_facts(
        workspace_root=workspace, base_sha=computed_at_sha, timeout_seconds=timeout_seconds, runner=run,
    )
    witness_input = _coverage_witness_input(plan_content)
    closure = impact_closure(
        changed_files=witness_input["affected_paths"], workspace_root=workspace, base_dir=base_dir,
        service_facts=service_facts, depth=PLAN_CLOSURE_DEPTH,
    )
    if "hold" in closure:
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash=sha256_digest(b""),
            computed_at_sha=computed_at_sha,
            witness={"tool": WITNESS_RELPATH, "error": closure["hold"]},
        )
    witness_input["closure_nodes"] = [
        {
            "node_id": f"project:{entry['project']}",
            "kind": "nx_project",
            "why": f"{entry['reason']} from {entry['reached_from']}"
            + (f" at {entry['evidence']}" if entry["evidence"] else ""),
            "reached_from": entry["reached_from"],
        }
        for entry in closure["impacted"]
    ]
    input_path = coverage_dir / f"{plan_id}-r{round_number}-input.json"
    input_path.write_text(json.dumps(witness_input, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    report, witness_meta = run_ts_json_entry(
        run,
        tool=WITNESS_RELPATH,
        args=["--input", str(input_path)],
        workspace=workspace,
        timeout_seconds=timeout_seconds,
        ok_exit_codes=(0, 1),
    )
    if report is None:
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash=sha256_digest(b""),
            computed_at_sha=computed_at_sha,
            witness=witness_meta,
        )

    manifest_bytes = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)
    manifest_hash = sha256_digest(manifest_bytes)

    fields = _coverage_report_fields(report, round_number=round_number, manifest_relpath=manifest_relpath)
    return {
        "round_number": round_number,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_plan_content_hash,
        "verdict": fields["verdict"],
        "closure_manifest_path": manifest_relpath,
        "closure_manifest_hash": manifest_hash,
        "closure_summary": fields["closure_summary"],
        "uncovered": fields["uncovered"],
        "waived": fields["waived"],
        "synthetic_risks": fields["synthetic_risks"],
        "computed_at_sha": computed_at_sha,
        "witness": witness_meta,
    }


def _service_facts_unavailable(base_sha: str, witness: dict[str, Any]) -> dict[str, Any]:
    return {"verdict": "environment_unable", "base_sha": base_sha, "witness": witness}


def _base_tree_error(workspace: Path, base_sha: str) -> str | None:
    """None when the disk the entries read is the content of ``base_sha``; otherwise the named error.

    Both entries enumerate the tree's tracked files (event-consumer-index.ts ``TrackedTree``) and
    read their content from disk, and the type checker resolves imports only inside that tracked
    set (adapter-ts ``containedCompilerHost`` with the tracked view), the workspace node_modules and
    the TypeScript lib directory. What this
    check proves is that the tracked content on disk is the base commit, so a fact stamped
    ``facts_sha = base_sha`` has a ``path:line`` that resolves against it (PLAN §3.1, §3.5, §3.6):

    * HEAD is ``base_sha``;
    * no index entry is flagged assume-unchanged or skip-worktree: ``git status`` does not compare
      such a file with the disk, so a clean status would vouch for a rewrite it never looked at
      (``tree_index_flagged``);
    * ``git status`` lists nothing, tracked change, staged path or untracked file
      (``tree_not_clean``).

    Every git read goes through the kernel's hermetic owner (``workspace_view``), never through the
    entry runner: an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE, or the repository's
    fsmonitor, would otherwise decide the answer for another index or another repository than the
    one the entries read. The errors carry counts, never path names, because a name in the tree is
    text the change's author chose. Ignored paths (``node_modules``, build output) are outside the
    tracked set, so they do not make the tree unclean.
    """
    head_sha = workspace_head_sha(workspace)
    if head_sha is None:
        return "head_unreadable: the base tree has no readable HEAD commit"
    if head_sha != base_sha:
        return f"tree_not_at_base: HEAD {head_sha} is not {base_sha}"
    try:
        flagged = index_flagged_paths(workspace)
    except WorkspaceViewRefused as exc:
        return f"tree_index_unreadable: {exc.reason}"
    if flagged:
        return (
            f"tree_index_flagged: {len(flagged)} tracked path(s) are flagged assume-unchanged or "
            "skip-worktree, so git status does not compare them with the disk"
        )
    try:
        status = hermetic_git(
            workspace, "status", "--porcelain", "-z", "--untracked-files=all",
            timeout=TREE_STATUS_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"tree_status_unreadable: {type(exc).__name__}"
    if status.returncode != 0:
        return f"tree_status_unreadable: git exit {status.returncode}"
    if status.stdout:
        return f"tree_not_clean: the base tree differs from {base_sha}"
    return None


def compute_service_facts(
    *,
    workspace_root: str | Path,
    base_sha: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    runner: Runner | None = None,
) -> dict[str, Any]:
    """The code facts of one change subject, computed on its base tree (service-expertise SE-3).

    ``workspace_root`` is a clean checkout of the diff's base: before and after both runs its HEAD
    must be ``base_sha``, no index entry may be flagged to hide the disk from ``git status``, and
    ``git status`` must list nothing (``_base_tree_error``, through the kernel's hermetic git
    owner), because the entries read the working tree and the facts are the pre-change contract
    the reviewer reads the diff against. Both ``--facts`` entries (``EVENT_FACTS_RELPATH``:
    per-application produced and consumed event sites, code x code edges, ACL grants as permission
    facts, NATS identity, event definition sites; ``MODULE_FACTS_RELPATH``: schema and table
    placement) run once, through the plan-coverage runner, with the base tree as their cwd and
    repo root. The runner runs those two entries and nothing else.

    Success: ``{"verdict": "computed", "facts_sha", "event_facts", "module_facts", "witness"}``,
    each facts object exactly as its entry printed it. Any failure, of the tree checks
    (``head_unreadable``, ``tree_not_at_base``, ``tree_index_unreadable``, ``tree_index_flagged``,
    ``tree_status_unreadable``, ``tree_not_clean``) or of either entry, is ``{"verdict": "environment_unable", "base_sha", "witness": {"error":
    <named>}}`` with no facts at all: a partial result would route the change with fewer services.
    Nothing is written; the facts live only in the request rows that carry them (PLAN SO-07).
    """
    run = runner or _default_runner
    workspace = Path(workspace_root)
    tree_error = _base_tree_error(workspace, base_sha)
    if tree_error is not None:
        return _service_facts_unavailable(base_sha, {"error": tree_error})

    facts: dict[str, dict[str, Any]] = {}
    witnesses: dict[str, dict[str, Any]] = {}
    for key, tool in (("event_facts", EVENT_FACTS_RELPATH), ("module_facts", MODULE_FACTS_RELPATH)):
        report, witness = run_ts_json_entry(
            run,
            tool=tool,
            args=["--facts", "--repo-root", str(workspace)],
            workspace=workspace,
            timeout_seconds=timeout_seconds,
            ok_exit_codes=(0,),
        )
        if report is None:
            return _service_facts_unavailable(base_sha, witness)
        facts[key] = report
        witnesses[key] = witness
    # The tree the entries read must still be the base after they ran: a file written or a HEAD
    # moved while they ran would otherwise be in the facts without being at base.
    tree_error = _base_tree_error(workspace, base_sha)
    if tree_error is not None:
        return _service_facts_unavailable(base_sha, {"error": tree_error})
    return {
        "verdict": "computed",
        "facts_sha": base_sha,
        "event_facts": facts["event_facts"],
        "module_facts": facts["module_facts"],
        "witness": witnesses,
    }


def compute_service_facts_at_head(*, workspace_root: str | Path, runner: Runner | None = None) -> dict[str, Any]:
    """The code facts of a checkout's own HEAD (`compute_service_facts`): the base of every closure
    the kernel computes over its own workspace (`impact_graph.impact_closure`; SE-4), where the
    change subject is the workspace rather than a diff. An unreadable HEAD is ``head_unreadable``."""
    workspace = Path(workspace_root)
    return compute_service_facts(workspace_root=workspace, base_sha=workspace_head_sha(workspace) or "", runner=runner)
