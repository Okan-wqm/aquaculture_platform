"""ARIA-HIGH-397 — an implementer's scope refusal that names an enabling surface re-plans, bounded.

THE MEASURED CASE (F-015, 2026-10-08). The converged plan wrote three files in
``web/modules/hr-module``. Its key change prescribed an import the module's
tsconfig cannot resolve; the implementer type-checked, met TS2307 and refused
with class ``scope``: the one fix (the alias in the module's tsconfig) lay
outside the request's write set, though inside the operator's signed write
root ``web/modules/hr-module``. The refusal went to HUMAN_REQUIRED and an
operator signed a second request by hand. Nothing in the refusal needed a
person: the surface was one the operator had already allowed.

THE RULE. An implementation refused with class ``scope`` or ``law`` goes back
to planning when, and only when, the kernel can establish all of:

* the plan is still waiting on this implementation, and its lineage has
  re-planned fewer than :data:`MAX_REPLANS_PER_LINEAGE` times;
* the plan came from an operator request whose row still verifies against
  the committed trust anchor, read from the signed ledger itself and
  re-verified here (never a cached copy), and that row signs ``write_roots``;
* at least one enabling surface lies inside those roots, is not read-only to
  the kernel, is not an evidence-only surface of the plan, and is not already
  in its write set. A surface comes from the kernel's own measurement (the
  import witness on the converged body: the project configuration of a
  specifier it does not resolve) or is named by the implementer in the
  refusal's structured ``enabling_surfaces``, which the kernel checks as a
  path and nothing more. The implementer's prose never reaches the plan.

Then the plan ends ``implementation_replanned`` (``harness``: the lane's
planning was short a surface the roots allow, so nothing cools off) and a
SUCCESSOR plan starts from the converged body with the surfaces added, each
as a kernel-written key change stating only kernel facts. The successor binds
to the same consumed operator request (a ``synthesis_bound`` row naming its
own content and ``replan_of``), so the pre-merge join proves its provenance
exactly as it proves the predecessor's, and the executor's planning lane
advances it in the same run. Anything short of that is the old path:
HUMAN_REQUIRED, now with the reason the re-plan was not taken.

Why a successor and not a reopened plan: a converged plan's rounds, its
independence verdict and its coverage are signed history; reopening one
would rewrite what was agreed. A successor is the same pipeline the operator
ran by hand, with its lineage on the ledger.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

REPLAN_REASON_CLASSES = frozenset({"scope", "law"})
MAX_REPLANS_PER_LINEAGE = 2
MAX_IMPLEMENTER_SURFACES = 10
REPLANNED = "replanned"
INELIGIBLE = "ineligible"
FAILED = "failed"
REPLANNED_KIND = "implementation_replanned"
REPLAN_FAILED_KIND = "implementation_replan_failed"
BASIS_IMPORT_RESOLUTION = "import_resolution"
BASIS_IMPLEMENTER_NAMED = "implementer_named"
_AWAITING = frozenset({"IMPLEMENTATION_REQUESTED", "IMPLEMENTATION_IN_FLIGHT"})


@dataclass(frozen=True)
class EnablingSurface:
    path: str
    root: str
    basis: str
    fact: str = ""

    def record(self) -> dict[str, str]:
        return {"path": self.path, "root": self.root, "basis": self.basis, "fact": self.fact}


@dataclass
class _Context:
    request_id: str
    plan_id: str
    reason_class: str
    root: Path
    workspace: Path
    state: dict[str, Any] = field(default_factory=dict)
    content: dict[str, Any] = field(default_factory=dict)


def implementer_surfaces(raw: Any) -> tuple[str, ...]:
    """The refusal's ``enabling_surfaces`` as at most ten repo-path strings; anything else is dropped."""
    from .finding_grounding import safe_repo_ref

    if not isinstance(raw, list):
        return ()
    paths = [item.strip() for item in raw if isinstance(item, str) and item.strip()]
    return tuple(dict.fromkeys(path for path in paths if safe_repo_ref(path) and ":" not in path))[
        :MAX_IMPLEMENTER_SURFACES]


def _ineligible(reason: str, **details: Any) -> dict[str, Any]:
    return {"status": INELIGIBLE, "reason": reason, **details}


def _converged_content(state: Mapping[str, Any]) -> dict[str, Any] | None:
    wanted = (state.get("implementation") or {}).get("converged_plan_content_hash")
    candidates = (
        ((state.get("latest_revision") or {}).get("content_hash"), (state.get("latest_revision") or {}).get("content")),
        ((state.get("challenger") or {}).get("content_hash"), (state.get("challenger") or {}).get("plan_content")),
        ((state.get("plan_started") or {}).get("content_hash"), (state.get("plan_started") or {}).get("plan_content")),
    )
    for digest, content in candidates:
        if wanted and digest == wanted and isinstance(content, dict):
            return content
    return None


def _lineage(root: Path, plan_id: str) -> tuple[str, int]:
    """(the lineage's first plan, how many re-plans led to ``plan_id``).

    Read from the durable ``replan_of`` synthesis bindings, written BEFORE a
    successor starts (review of #1908, item 7): a governance row is appended
    after, and a crash between the two must not reset the count.
    """
    from .ledger import load_declared_jsonl
    from .operator_feedback_ingestion import INGESTION_SURFACE, ingestion_ledger_path
    from .operator_request_spend import SYNTHESIS_BOUND_ROW_TYPE

    path = ingestion_ledger_path(root)
    parent_of = {
        str(row["replan_of"]["successor_plan_id"]): str(row["replan_of"]["plan_id"])
        for row in (load_declared_jsonl(path, expected_surface=INGESTION_SURFACE) if path.is_file() else [])
        if row.get("row_type") == SYNTHESIS_BOUND_ROW_TYPE and isinstance(row.get("replan_of"), dict)
        and row["replan_of"].get("successor_plan_id") and row["replan_of"].get("plan_id")
    }
    first, depth = plan_id, 0
    while first in parent_of and depth <= MAX_REPLANS_PER_LINEAGE:
        first, depth = parent_of[first], depth + 1
    return first, depth


def _signed_write_roots(ctx: _Context) -> tuple[list[str] | None, dict[str, Any] | None, str | None]:
    """(the verified row's write_roots, the predecessor's synthesis binding, or a refusal reason)."""
    from .ledger import load_declared_jsonl
    from .operator_feedback_ingestion import (
        INGESTION_SURFACE,
        PROVENANCE_REF_PREFIX,
        _read_feedback_ledger,
        ingestion_ledger_path,
    )
    from .operator_feedback_signature import OPERATOR_FEEDBACK_LEDGER_NAME
    from .operator_request_signature import allowed_signers_for_checkout, verify_operator_request
    from .operator_request_spend import SYNTHESIS_BOUND_ROW_TYPE
    from .plan_write_scope import write_roots_violation

    refs = [str(ref)[len(PROVENANCE_REF_PREFIX):] for ref in ctx.content.get("provenance_refs") or []
            if isinstance(ref, str) and ref.startswith(PROVENANCE_REF_PREFIX)]
    if len(refs) != 1:
        return None, None, "no_operator_request"
    request_id = refs[0]
    started_hash = (ctx.state.get("plan_started") or {}).get("content_hash")
    ingestion = ingestion_ledger_path(ctx.root)
    bindings = [row for row in (load_declared_jsonl(ingestion, expected_surface=INGESTION_SURFACE)
                                if ingestion.is_file() else [])
                if row.get("row_type") == SYNTHESIS_BOUND_ROW_TYPE and row.get("plan_content_hash") == started_hash]
    if not bindings:
        return None, None, "synthesis_binding_unavailable"
    binding = bindings[-1]
    consumed = [entry for entry in binding.get("consumed") or [] if isinstance(entry, dict)]
    if [entry.get("id") for entry in consumed] != [request_id]:
        return None, None, "synthesis_binding_mismatch"
    read = _read_feedback_ledger(ctx.root / OPERATOR_FEEDBACK_LEDGER_NAME)
    rows = [row for row in (read[0] if read is not None else [])
            if row.get("id") == request_id and row.get("ledger_hash") == consumed[0].get("ledger_hash")]
    if len(rows) != 1:
        return None, None, "operator_request_row_unavailable"
    signers, anchor_reason = allowed_signers_for_checkout(ctx.workspace, base_dir=ctx.root)
    if signers is None:
        return None, None, f"operator_request_anchor_unavailable:{anchor_reason}"
    verdict = verify_operator_request(rows[0], allowed_signers=signers)
    if verdict.reason is not None:
        return None, None, f"operator_request_unverified:{verdict.reason}"
    if "write_roots" not in rows[0]:
        return None, None, "no_signed_write_roots"
    roots = rows[0]["write_roots"]
    violation = write_roots_violation(roots)
    if violation is not None:
        return None, None, f"write_roots_invalid:{violation}"
    return [str(root) for root in roots], binding, None


def _kernel_surfaces(ctx: _Context) -> list[tuple[str, str]]:
    """(project configuration, fact) for each specifier the converged body prescribes that does not resolve."""
    from .plan_import_resolution import VERDICT_UNRESOLVED, compute_import_resolution

    block, _risks = compute_import_resolution(
        plan_content=ctx.content, round_number=0, workspace_root=ctx.workspace,
        input_path=ctx.root / "coverage" / f"{ctx.plan_id}-replan-imports-input.json",
    )
    if block.get("verdict") != VERDICT_UNRESOLVED:
        return []
    return [
        (str(entry.get("paths_config") or entry["project_config"]),
         f"the repository's TypeScript does not resolve '{entry['specifier']}' from {entry['from_path']}")
        for entry in block["unresolved"] if entry.get("paths_config") or entry.get("project_config")
    ]


def _eligible_surfaces(
    ctx: _Context, roots: list[str], candidates: list[tuple[str, str, str]],
) -> tuple[list[EnablingSurface], list[dict[str, str]]]:
    from .implementation_safety import _readonly_prefix
    from .plan_import_resolution import planned_paths
    from .plan_origin import admission_scope_for_plan

    from .plan_convergence import affected_surface_paths

    scope = admission_scope_for_plan(ctx.state) or {}
    evidence = set(scope.get("evidence_surfaces") or [])
    affected = ctx.content.get("affected_surfaces") or []
    planned = set(planned_paths(ctx.content)) | set(
        affected_surface_paths([affected] if isinstance(affected, dict) else affected))
    tracked = _tracked_files(ctx.workspace, [path for path, _basis, _fact in candidates])
    accepted: dict[str, EnablingSurface] = {}
    refused: list[dict[str, str]] = []
    for path, basis, fact in candidates:
        # Containment by path parts, never a string prefix: `apps/farm` is
        # not a root of `apps/farm-service/...` (review of #1908, item 9).
        root = next((entry for entry in roots
                     if Path(path).parts[:len(Path(entry).parts)] == Path(entry).parts
                     and len(Path(path).parts) > len(Path(entry).parts)), None)
        reason = ("outside_signed_write_roots" if root is None
                  # A tracked file only: no directory, no root itself, nothing
                  # gitignored (node_modules), so a refusal can never widen a
                  # plan to a tree (review of #1908, item 8).
                  else "not_a_tracked_file" if path not in tracked
                  else "readonly_to_the_kernel" if _readonly_prefix(path) is not None
                  else "evidence_only_surface" if path in evidence
                  else "already_in_the_write_set" if path in planned
                  else None)
        if reason is not None:
            refused.append({"path": path, "basis": basis, "reason": reason})
        elif path not in accepted:
            accepted[path] = EnablingSurface(path=path, root=str(root), basis=basis, fact=fact)
    return sorted(accepted.values(), key=lambda surface: surface.path), refused


def _tracked_files(workspace: Path, paths: list[str]) -> set[str]:
    """The given paths git tracks at the checkout (files only: a directory is never listed as itself)."""
    import subprocess

    if not paths:
        return set()
    done = subprocess.run(["git", "ls-files", "-z", "--", *paths], cwd=workspace, capture_output=True,
                          text=True, check=False, timeout=60)
    listed = set(done.stdout.split("\0")) if done.returncode == 0 else set()
    return {path for path in paths if path in listed}


def _successor_content(ctx: _Context, surfaces: list[EnablingSurface], depth: int) -> dict[str, Any]:
    content = copy.deepcopy(ctx.content)
    affected = content.get("affected_surfaces")
    if isinstance(affected, list) and affected and all(isinstance(item, dict) for item in affected):
        affected.append({"paths": [surface.path for surface in surfaces]})
    elif isinstance(affected, list):
        affected.extend(surface.path for surface in surfaces)
    else:
        content["affected_surfaces"] = [surface.path for surface in surfaces]
    for index, surface in enumerate(surfaces, start=1):
        fact = f" Kernel measurement: {surface.fact}." if surface.fact else ""
        content["key_changes"].append({
            "id": f"{ctx.plan_id}-replan-{depth}-key-change-{index:03d}",
            "description": (
                f"Re-plan {depth} of {ctx.plan_id} (ARIA-HIGH-397). The implementer of {ctx.request_id} refused "
                f"the converged plan with class '{ctx.reason_class}'; {surface.path} is a surface the change needs "
                f"({surface.basis}), inside the operator-signed write root {surface.root}.{fact} Change it so the "
                f"plan's other key changes compile and pass their validation, inside that root."
            ),
            "paths": [surface.path],
        })
    return content


def replan_after_refusal(
    *,
    request_id: str,
    reason_class: str,
    implementer_named: tuple[str, ...],
    base_dir: Path,
    workspace_root: Path,
    cycle_id: str,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Re-plan the implementation ``request_id`` refused, or say by name why not (module docstring)."""
    import os

    from .agent_invocations import _find_request_by_id
    from .convergence_drainer import AUTONOMY_CYCLE_MAX_ROUNDS, run_convergence_drainer
    from .executor_convergence import writer_lease_held
    from .implementation_rejections import settlement_for_replan
    from .implementation_settlement import SETTLED, _settle
    from .bridge_exceptions import BridgeContractViolation
    from .ledger import LedgerIntegrityError, append_declared_jsonl
    from .operator_feedback_ingestion import INGESTION_SURFACE, ingestion_ledger_path
    from .plan_convergence import abandon_plan, content_hash, fold_plan_state
    from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

    if reason_class not in REPLAN_REASON_CLASSES:
        return _ineligible("reason_class_not_replannable")
    root = ensure_tools_dir(base_dir)
    request = _find_request_by_id(root, request_id) or {}
    plan_id = str(request.get("convergence_id") or "")
    if request.get("role") != "implementation" or not plan_id:
        return _ineligible("not_an_implementation_request")
    ctx = _Context(request_id=request_id, plan_id=plan_id, reason_class=reason_class, root=root,
                   workspace=Path(workspace_root).resolve(), state=fold_plan_state(plan_id=plan_id, base_dir=root))
    if ctx.state.get("state") not in _AWAITING:
        return _ineligible("plan_not_awaiting_implementation", plan_id=plan_id)
    content = _converged_content(ctx.state)
    if content is None:
        return _ineligible("converged_content_unavailable", plan_id=plan_id)
    ctx.content = content
    first, depth = _lineage(root, plan_id)
    if depth >= MAX_REPLANS_PER_LINEAGE:
        return _ineligible("replan_bound_reached", plan_id=plan_id, depth=depth)
    # The executor's own gate on starting work in the store: only the job
    # holding the aria/state writer lease may (`executor_convergence`).
    if not writer_lease_held(os.environ if environ is None else environ):
        return _ineligible("writer_lease_not_held", plan_id=plan_id)
    roots, binding, refusal = _signed_write_roots(ctx)
    if refusal is not None or roots is None or binding is None:
        return _ineligible(refusal or "no_signed_write_roots", plan_id=plan_id)
    candidates = [(path, BASIS_IMPORT_RESOLUTION, fact) for path, fact in _kernel_surfaces(ctx)]
    candidates += [(path, BASIS_IMPLEMENTER_NAMED, "") for path in implementer_named]
    surfaces, refused = _eligible_surfaces(ctx, roots, candidates)
    if not surfaces:
        return _ineligible("no_eligible_enabling_surface", plan_id=plan_id, refused_surfaces=refused)

    successor_id = f"{first}-rp{depth + 1}"
    successor = _successor_content(ctx, surfaces, depth + 1)
    record = {
        "plan_id": plan_id, "successor_plan_id": successor_id, "request_id": request_id,
        "reason_class": reason_class, "depth": depth + 1, "lineage_first_plan_id": first,
        "surfaces": [surface.record() for surface in surfaces], "refused_surfaces": refused,
    }
    # Review of #1908, item 6 — the successor STARTS first; the predecessor
    # is settled only once the successor demonstrably exists, and a
    # settlement another writer won un-starts the successor. No settled
    # re-plan without a successor, and no two live plans for one request.
    try:
        append_declared_jsonl(ingestion_ledger_path(root), {
            **{key: binding.get(key) for key in ("schema_version", "row_type", "cycle_id", "ingestion_ledger_hash",
                                                 "candidate_id", "source_type", "consumed")},
            "bound_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "plan_content_hash": content_hash(successor),
            "replan_of": {"plan_id": plan_id, "successor_plan_id": successor_id,
                          "binding_ledger_hash": binding.get("ledger_hash"), "request_id": request_id},
        }, expected_surface=INGESTION_SURFACE)
        result = run_convergence_drainer(cycle_id=cycle_id, base_dir=root, workspace_root=ctx.workspace,
                                         plan_id=successor_id, plan_seed=successor,
                                         max_rounds=AUTONOMY_CYCLE_MAX_ROUNDS)
    except (GovernanceError, BridgeContractViolation, LedgerIntegrityError, OSError) as exc:
        # A store or contract fault of the successor's start: recorded by
        # name, and the refusal falls back to a person. Programming errors raise.
        append_tools_governance(root, REPLAN_FAILED_KIND, {**record, "error_class": type(exc).__name__,
                                                           "error_message": str(exc)[:500]})
        return {"status": FAILED, "reason": f"successor_start_failed:{type(exc).__name__}", **record}
    if fold_plan_state(plan_id=successor_id, base_dir=root).get("state") is None:
        append_tools_governance(root, REPLAN_FAILED_KIND, {**record, "verdict": result.get("arbiter_verdict")})
        return {"status": FAILED, "reason": "successor_not_started", **record}
    settled = _settle(settlement_for_replan(request_id=request_id, reason_class=reason_class),
                      base_dir=root, plan_id=plan_id)
    if settled["status"] != SETTLED:
        abandon_plan(plan_id=successor_id, reason=f"replan_predecessor_not_settled:{settled['status']}",
                     base_dir=root)
        append_tools_governance(root, REPLAN_FAILED_KIND, {**record, "predecessor_settlement": settled["status"]})
        return {"status": FAILED, "reason": f"predecessor_settlement_{settled['status']}", **record}
    append_tools_governance(root, REPLANNED_KIND, {
        **record, "minted_request_ids": list(result.get("request_ids") or []),
    })
    return {"status": REPLANNED, **record}


__all__ = [
    "FAILED",
    "INELIGIBLE",
    "MAX_REPLANS_PER_LINEAGE",
    "REPLANNED",
    "REPLANNED_KIND",
    "REPLAN_FAILED_KIND",
    "REPLAN_REASON_CLASSES",
    "implementer_surfaces",
    "replan_after_refusal",
]
