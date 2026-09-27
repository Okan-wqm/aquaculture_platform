from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .canonical_path import matches_repo_glob, normalize_repo_relpath
from .ledger import append_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


RiskLane = Literal["L1", "L2", "L3", "blocked"]

RISK_POLICY_SCHEMA = "aria/risk-policy/v1"
RISK_POLICY_PATH = Path(__file__).resolve().parents[2] / "docs" / "aria" / "policy" / "risk-policy.json"
CODEOWNERS_PATH = Path(__file__).resolve().parents[2] / ".github" / "CODEOWNERS"


@dataclass(frozen=True)
class RiskPolicyVerdict:
    valid: bool
    lane: RiskLane
    policy_hash: str
    reason_codes: tuple[str, ...]
    changed_files: tuple[str, ...]
    matched_lanes: tuple[str, ...]


def load_risk_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(policy) if policy is not None else json.loads(RISK_POLICY_PATH.read_text(encoding="utf-8"))
    _validate_policy(payload)
    return payload


def risk_policy_hash(policy: dict[str, Any] | None = None) -> str:
    payload = load_risk_policy(policy)
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def classify_change(
    changed_files: list[str | dict[str, Any]],
    *,
    policy: dict[str, Any] | None = None,
) -> RiskPolicyVerdict:
    active = load_risk_policy(policy)
    policy_hash = risk_policy_hash(active)
    raw_paths = [raw for raw in (_changed_file_path(item) for item in changed_files) if raw.strip()]
    try:
        paths = tuple(normalize_repo_relpath(raw) for raw in raw_paths)
    except GovernanceError:
        # ARIA-HIGH-186/187: an absolute or traversing path is not a repo
        # change the policy can place; refuse instead of classifying it.
        return RiskPolicyVerdict(
            valid=False,
            lane="blocked",
            policy_hash=policy_hash,
            reason_codes=("risk_path_invalid",),
            changed_files=tuple(raw_paths),
            matched_lanes=(),
        )
    if not paths:
        return RiskPolicyVerdict(
            valid=False,
            lane="blocked",
            policy_hash=policy_hash,
            reason_codes=("risk_changed_files_required",),
            changed_files=paths,
            matched_lanes=(),
        )

    blocked = [path for path in paths if _matches_any(path, active["blocked_globs"])]
    if blocked:
        return RiskPolicyVerdict(
            valid=False,
            lane="blocked",
            policy_hash=policy_hash,
            reason_codes=("risk_blocked_path",),
            changed_files=paths,
            matched_lanes=("blocked",),
        )

    matched: dict[str, list[str]] = {"L1": [], "L2": [], "L3": []}
    unknown: list[str] = []
    owned: list[str] = []
    lanes = active.get("lanes") or {}
    owner_globs = codeowners_globs()
    for path in paths:
        lane = _lane_for_path(path, active, owner_globs)
        if lane is None:
            unknown.append(path)
        else:
            matched[lane].append(path)
            if _is_owned(path, owner_globs):
                owned.append(path)
    if unknown:
        return RiskPolicyVerdict(
            valid=False,
            lane="blocked",
            policy_hash=policy_hash,
            reason_codes=("risk_unknown_path",),
            changed_files=paths,
            matched_lanes=tuple(lane for lane, values in matched.items() if values),
        )
    matched_lanes = tuple(lane for lane in ("L1", "L2", "L3") if matched[lane])
    if len(matched_lanes) != 1:
        return RiskPolicyVerdict(
            valid=False,
            lane="blocked",
            policy_hash=policy_hash,
            reason_codes=("risk_mixed_lanes",),
            changed_files=paths,
            matched_lanes=matched_lanes,
        )
    lane = matched_lanes[0]
    lane_policy = lanes.get(lane) if isinstance(lanes, dict) else {}
    reason = str((lane_policy or {}).get("reason_code") or f"risk_{lane.lower()}")
    reasons = (reason, "risk_codeowners_path") if owned else (reason,)
    return RiskPolicyVerdict(
        valid=True,
        lane=lane,  # type: ignore[arg-type]
        policy_hash=policy_hash,
        reason_codes=reasons,
        changed_files=paths,
        matched_lanes=matched_lanes,
    )


def record_risk_decision_for_pr(
    pr: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    changed_files = pr.get("changed_files", pr.get("files", []))
    if not isinstance(changed_files, list):
        changed_files = []
    verdict = classify_change(changed_files, policy=policy)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "row_id": f"risk:{pr.get('number')}:{_first_string(pr, 'head_sha', 'headRefOid', 'head')}",
        "row_type": "enterprise_risk_decision",
        "pr_number": pr.get("number"),
        "repo": _first_string(pr, "repository", "repo", "repo_full_name"),
        "target_ref": _first_string(pr, "base_branch", "baseRefName", "base", "target_ref"),
        "head_ref": _first_string(pr, "head_ref", "headRefName", "head_branch"),
        "head_sha": _first_string(pr, "head_sha", "headRefOid", "head"),
        "valid": verdict.valid,
        "lane": verdict.lane,
        "policy_hash": verdict.policy_hash,
        "reason_codes": list(verdict.reason_codes),
        "changed_files": list(verdict.changed_files),
        "matched_lanes": list(verdict.matched_lanes),
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "risk-decisions.jsonl",
        row,
        expected_surface="enterprise_risk_decisions",
    )


def _validate_policy(policy: dict[str, Any]) -> None:
    if policy.get("$schema") != RISK_POLICY_SCHEMA:
        raise GovernanceError("risk_policy_schema_must_be_v1")
    if policy.get("schema_version") != 1:
        raise GovernanceError("risk_policy_schema_version_must_be_1")
    if policy.get("base_branch") != "main":
        raise GovernanceError("risk_policy_base_branch_must_be_main")
    if policy.get("merge_method") != "squash":
        raise GovernanceError("risk_policy_merge_method_must_be_squash")
    for key in ("blocked_globs", "auto_merge_candidate_lanes"):
        value = policy.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
            raise GovernanceError(f"risk_policy_{key}_must_be_nonempty_string_array")
    if policy.get("codeowners_lane") not in ("L2", "L3"):
        # An owned path merged unreviewed is exactly what L1 means; the lane
        # owned paths are forced into can never be L1 (ARIA-HIGH-187).
        raise GovernanceError("risk_policy_codeowners_lane_must_be_L2_or_L3")
    lanes = policy.get("lanes")
    if not isinstance(lanes, dict):
        raise GovernanceError("risk_policy_lanes_required")
    for lane in ("L1", "L2", "L3"):
        lane_policy = lanes.get(lane)
        if not isinstance(lane_policy, dict):
            raise GovernanceError(f"risk_policy_lane_required:{lane}")
        globs = lane_policy.get("globs")
        if not isinstance(globs, list) or not globs or not all(isinstance(item, str) and item.strip() for item in globs):
            raise GovernanceError(f"risk_policy_lane_globs_required:{lane}")


def classify_path(path: str, *, policy: dict[str, Any] | None = None) -> str | None:
    """Lane of ONE normalized repo path: ``blocked``, ``L3``, ``L2``, ``L1``
    or ``None`` (no lane claims it).

    The single low-risk answer (ARIA-HIGH-187): ``auto_merge`` asks this
    instead of keeping its own copy of the L1 list.
    """
    active = load_risk_policy(policy)
    if _matches_any(path, active["blocked_globs"]):
        return "blocked"
    return _lane_for_path(path, active, codeowners_globs())


def codeowners_globs(path: Path | None = None) -> tuple[str, ...]:
    """``.github/CODEOWNERS`` patterns translated to repo globs.

    GitHub semantics: a leading ``/`` anchors at the root; a trailing ``/``
    owns the whole directory; a pattern with no inner ``/`` matches at any
    depth; ``*`` does not cross ``/``. An owned path must never be merged
    without its owner, so L1 can never contain one — the policy's
    ``codeowners_lane`` (L3) overrides whatever lane its globs would pick.
    """
    source = path if path is not None else CODEOWNERS_PATH
    globs: list[str] = []
    for raw_line in source.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        pattern = line.split()[0]
        anchored = pattern.startswith("/")
        pattern = pattern.lstrip("/")
        directory = pattern.endswith("/")
        pattern = pattern.rstrip("/")
        if not pattern:
            continue
        if not anchored and "/" not in pattern:
            pattern = f"**/{pattern}"
        globs.append(f"{pattern}/**" if directory else pattern)
    return tuple(globs)


def _lane_for_path(path: str, active: dict[str, Any], owner_globs: tuple[str, ...]) -> str | None:
    if _matches_any(path, active["blocked_globs"]):
        return "blocked"
    lanes = active.get("lanes") or {}
    lane = _first_matching_lane(path, lanes)
    if _is_owned(path, owner_globs):
        return str(active.get("codeowners_lane") or "L3")
    return lane


def _is_owned(path: str, owner_globs: tuple[str, ...]) -> bool:
    return _matches_any(path, list(owner_globs))


def _first_matching_lane(path: str, lanes: dict[str, Any]) -> str | None:
    for lane in ("L3", "L2", "L1"):
        lane_policy = lanes.get(lane) if isinstance(lanes, dict) else None
        globs = lane_policy.get("globs") if isinstance(lane_policy, dict) else None
        if isinstance(globs, list) and _matches_any(path, globs):
            return lane
    return None


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(matches_repo_glob(path, pattern) for pattern in patterns)


def _changed_file_path(item: str | dict[str, Any]) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        for key in ("filename", "path", "file", "name"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ""


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


__all__ = [
    "RISK_POLICY_SCHEMA",
    "RISK_POLICY_PATH",
    "CODEOWNERS_PATH",
    "RiskPolicyVerdict",
    "classify_change",
    "classify_path",
    "codeowners_globs",
    "load_risk_policy",
    "record_risk_decision_for_pr",
    "risk_policy_hash",
]
