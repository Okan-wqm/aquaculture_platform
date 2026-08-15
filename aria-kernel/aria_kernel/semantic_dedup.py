from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_jsonl
from .batch_containment import guard_item, with_item_failures
from .pressure import effective_workspace_pressures
from .tool_registry import append_tools_governance, update_tools_index
from .workspace import WorkspacePaths


COSINE_THRESHOLD = 0.62
CLUSTER_CAP = 20


def semantic_dedup_compute(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    threshold: float = COSINE_THRESHOLD,
    cluster_cap: int = CLUSTER_CAP,
) -> dict[str, Any]:
    if tools_root is None:
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "tools_root_required", "merged_count": 0}
    root = Path(tools_root)
    pressures = [row for row in effective_workspace_pressures(paths) if row.get("effective_state") in {"active", "faded", "sleeping"}]
    existing = {_cluster_identity(row) for row in load_jsonl(root / "problem_clusters.jsonl")}
    clusters: list[dict[str, Any]] = []
    item_failures: list[dict[str, Any]] = []
    used: set[str] = set()
    for pressure in pressures:
        primary = _pressure_id(pressure)
        if not primary or primary in used:
            continue
        members = [pressure]
        used.add(primary)
        for candidate in pressures:
            cid = _pressure_id(candidate)
            if not cid or cid in used:
                continue
            if len(members) >= cluster_cap:
                break
            if _same_surface_parser(pressure, candidate) and _ref_root_overlap(pressure, candidate) and _cosine(_tokens(pressure), _tokens(candidate)) >= threshold:
                members.append(candidate)
                used.add(cid)
        if len(members) <= 1:
            continue
        row = _cluster_row(cycle_id, members)
        identity = _cluster_identity(row)
        if identity in existing:
            continue
        # `used` has already absorbed this cluster's members, so a raise here
        # burns those pressures for the cycle: they are neither clustered nor
        # available to a later cluster. Containment keeps that damage to one.
        ok, stored = guard_item(
            item_failures,
            item_kind="pressure_cluster",
            item_id=primary,
            work=lambda row=row: _store_cluster(root, row, cycle_id=cycle_id),
        )
        if not ok or stored is None:
            continue
        clusters.append(stored)
    return with_item_failures(
        {"schema_version": 1, "cycle_id": cycle_id, "merged_count": len(clusters), "clusters": clusters},
        item_failures,
    )


def _store_cluster(root: Path, row: dict[str, Any], *, cycle_id: str) -> dict[str, Any]:
    stored = append_declared_jsonl(root / "problem_clusters.jsonl", row, expected_surface="problem_clusters")
    update_tools_index(root)
    append_tools_governance(
        root,
        "semantic_cluster_merged",
        {
            "cycle_id": cycle_id,
            "primary_pressure": stored["primary_pressure"],
            "member_pressures": stored["member_pressures"],
            "cluster_size": len(stored["member_pressures"]),
        },
    )
    return stored


def _cluster_row(cycle_id: str, members: list[dict[str, Any]]) -> dict[str, Any]:
    ids = sorted(_pressure_id(row) for row in members)
    primary = ids[0]
    surface, _, parser = _gap_parts(members[0])
    return {
        "$schema": "aria/problem-cluster/v1",
        "schema_version": 1,
        "cycle_id": cycle_id,
        "cluster_id": "PC-" + hashlib.sha256("|".join(ids).encode("utf-8")).hexdigest()[:16],
        "primary_pressure": primary,
        "member_pressures": ids,
        "cluster_key": f"{surface}:semantic:{parser}",
        "capability_gap_keys": sorted({str(row.get("capability_gap_key")) for row in members if row.get("capability_gap_key")}),
        "evidence_refs": sorted({ref for row in members for ref in row.get("evidence_refs", []) if isinstance(ref, str)}),
    }


def _cluster_identity(row: dict[str, Any]) -> str:
    return json.dumps({"primary": row.get("primary_pressure"), "members": row.get("member_pressures", [])}, sort_keys=True)


def _pressure_id(row: dict[str, Any]) -> str:
    return str(row.get("event_id") or row.get("pressure_id") or row.get("pressure_event_id") or "")


def _gap_parts(row: dict[str, Any]) -> tuple[str, str, str]:
    parts = str(row.get("capability_gap_key") or "repo:unknown:unknown").split(":")
    parts = (parts + ["unknown", "unknown", "unknown"])[:3]
    return parts[0], parts[1], parts[2]


def _same_surface_parser(left: dict[str, Any], right: dict[str, Any]) -> bool:
    ls, _, lp = _gap_parts(left)
    rs, _, rp = _gap_parts(right)
    return ls == rs and lp == rp


def _ref_root_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return bool(_ref_roots(left) & _ref_roots(right))


def _ref_roots(row: dict[str, Any]) -> set[str]:
    refs = row.get("evidence_refs") or []
    roots = set()
    for ref in refs:
        if not isinstance(ref, str):
            continue
        path = ref.split(":", 1)[0].removeprefix("./")
        roots.add(path.split("/", 1)[0] if "/" in path else path)
    return roots or {_gap_parts(row)[0]}


def _tokens(row: dict[str, Any]) -> dict[str, int]:
    text = " ".join(
        str(row.get(key) or "")
        for key in ("primitive", "subtype", "capability_gap_key", "reason", "recommended_action")
    )
    text += " " + " ".join(str(ref) for ref in row.get("evidence_refs", []) if isinstance(ref, str))
    counts: dict[str, int] = {}
    for token in re.findall(r"[a-z0-9_]{3,}", text.lower()):
        counts[token] = counts.get(token, 0) + 1
    return counts


def _cosine(left: dict[str, int], right: dict[str, int]) -> float:
    if not left or not right:
        return 0.0
    dot = sum(value * right.get(token, 0) for token, value in left.items())
    ln = math.sqrt(sum(value * value for value in left.values()))
    rn = math.sqrt(sum(value * value for value in right.values()))
    return dot / (ln * rn) if ln and rn else 0.0
