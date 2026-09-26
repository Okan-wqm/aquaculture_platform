from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .canonical_path import matches_repo_glob, normalize_repo_relpath
from .change_paths import CHANGE_PATHS_SOURCE, platform_file_list_disagreement, read_change_paths
from .ledger import append_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


RiskLane = Literal["L1", "L2", "L3", "blocked"]

RISK_POLICY_SCHEMA = "aria/risk-policy/v1"
# ARIA-HIGH-211 (operator decision 2026-09-26) — a change outside the merge
# lane's candidate lanes still becomes a pull request; it carries this label
# and the merge lane names it with this decision instead of evaluating it.
HUMAN_MERGE_LABEL = "aria:human-merge"
HUMAN_MERGE_DECISION = "human_merge_lane"
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
    # A whitespace-only name is a legal POSIX name and is classified, not
    # dropped (ARIA-MEDIUM-224); only an entry that names nothing is skipped.
    raw_paths = [raw for raw in (_changed_file_path(item) for item in changed_files) if raw]
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
    rules = codeowners_rules()
    for path in paths:
        lane = _lane_for_path(path, active, rules)
        if lane is None:
            unknown.append(path)
        else:
            matched[lane].append(path)
            if _is_owned(path, rules):
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
    workspace_root: str | Path | None,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Classify the PR's change as git holds it, and record the decision.

    ARIA-CRITICAL-214 — the path set is read from the checkout at
    ``workspace_root`` (``change_paths.read_change_paths``: rename sources
    kept, never capped), not taken from the platform's file list, which
    names only the new side of a rename and stops at 100 entries. That list
    is a cross-check: when it cannot describe the git change, the decision
    is refused by name. There is no way to hand this function a path list.
    """
    listed = pr.get("changed_files", pr.get("files", []))
    listed_paths = [_changed_file_path(item) for item in listed] if isinstance(listed, list) else []
    listed_count = pr.get("changed_files_count")
    disagreement: str | None = None
    try:
        change = read_change_paths(
            workspace_root,
            _first_string(pr, "base_sha", "baseRefOid"),
            _first_string(pr, "head_sha", "headRefOid", "head"),
        )
    except GovernanceError:
        verdict = _refused(policy, "risk_change_paths_unavailable", ())
    else:
        disagreement = platform_file_list_disagreement(
            change, listed_paths=listed_paths, listed_count=listed_count,
        )
        if disagreement is not None:
            verdict = _refused(policy, "risk_pr_files_disagree_with_git", change.paths)
        else:
            verdict = classify_change(list(change.paths), policy=policy)
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
        "base_sha": _first_string(pr, "base_sha", "baseRefOid"),
        "changed_files_source": CHANGE_PATHS_SOURCE,
        "platform_listed_files": len(listed_paths),
        "platform_file_count": listed_count if type(listed_count) is int else None,
        "platform_disagreement": disagreement,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "risk-decisions.jsonl",
        row,
        expected_surface="enterprise_risk_decisions",
    )


def merge_route_for_change(
    workspace_root: str | Path | None,
    base_sha: object,
    head_sha: object,
    *,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Who merges the change ``base_sha``..``head_sha``: the merge lane, or a person.

    ARIA-HIGH-211 — decided when the pull request opens, from the change as
    git holds it (``change_paths``) and the merge gate's own classifier: a
    change is the merge lane's only when it is valid and in the policy's
    ``auto_merge_candidate_lanes``. Anything else — another lane, mixed
    lanes, a path the policy refuses, a change that cannot be read — is
    ``human_merge``: the PR still opens, marked for a person.
    """
    try:
        change = read_change_paths(workspace_root, base_sha, head_sha)
    except GovernanceError:
        verdict = _refused(policy, "risk_change_paths_unavailable", ())
    else:
        verdict = classify_change(list(change.paths), policy=policy)
    candidate_lanes = load_risk_policy(policy)["auto_merge_candidate_lanes"]
    return {
        "human_merge": not (verdict.valid and verdict.lane in candidate_lanes),
        "lane": verdict.lane,
        "valid": verdict.valid,
        "reason_codes": list(verdict.reason_codes),
        "policy_hash": verdict.policy_hash,
    }


def _refused(policy: dict[str, Any] | None, reason: str, paths: tuple[str, ...]) -> RiskPolicyVerdict:
    return RiskPolicyVerdict(
        valid=False,
        lane="blocked",
        policy_hash=risk_policy_hash(policy),
        reason_codes=(reason,),
        changed_files=paths,
        matched_lanes=(),
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
    if policy.get("codeowners_lane") != "L3":
        # An owned path merged unreviewed is exactly what L1 means
        # (ARIA-HIGH-187), and an owned path must reach its owner, which only
        # the policy-approval lane does (ARIA-MEDIUM-224): L2 is refused too.
        raise GovernanceError("risk_policy_codeowners_lane_must_be_L3")
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
    return _lane_for_path(path, active, codeowners_rules())


@dataclass(frozen=True)
class CodeownersRule:
    """One ``.github/CODEOWNERS`` line: its pattern, the repo globs the
    pattern means, and its owners (empty when the line names none)."""

    line: int
    pattern: str
    globs: tuple[str, ...]
    owners: tuple[str, ...]


def codeowners_rules(path: Path | None = None) -> tuple[CodeownersRule, ...]:
    """``.github/CODEOWNERS`` in file order, each pattern translated to globs."""
    source = path if path is not None else CODEOWNERS_PATH
    rules: list[CodeownersRule] = []
    for number, raw_line in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        pattern, *owners = line.split()
        globs = _codeowners_pattern_globs(pattern)
        if globs:
            rules.append(CodeownersRule(line=number, pattern=pattern, globs=globs, owners=tuple(owners)))
    return tuple(rules)


def _codeowners_pattern_globs(pattern: str) -> tuple[str, ...]:
    """GitHub's CODEOWNERS (gitignore) semantics, as repo globs.

    ARIA-MEDIUM-224:
    * a leading ``/`` anchors the pattern at the repository root;
    * a pattern with no ``/`` except a trailing one matches at any depth;
      any other ``/`` anchors it;
    * a pattern names a file or a directory, with or without a trailing
      ``/``, and a directory owns everything below it — so every pattern is
      ``P`` and ``P/**``. ``docs/aria`` was once matched as a file only, and
      nothing under it was owned;
    * ``*`` does not cross ``/``.

    Where GitHub owns less — ``docs/*`` does not reach ``docs/a/b.md``, a
    trailing ``/`` does not own a same-named file — the translation owns
    more. That errs to "owned", the side that can never open the
    unreviewed lane.
    """
    anchored = pattern.startswith("/")
    body = pattern.strip("/")
    if not body:
        return ()
    if not anchored and "/" not in body:
        body = f"**/{body}"
    return (body, f"{body}/**")


def codeowners_last_match(
    path: str,
    *,
    source: Path | None = None,
    rules: tuple[CodeownersRule, ...] | None = None,
) -> CodeownersRule | None:
    """The rule GitHub applies to ``path``: the LAST matching line, or None."""
    match: CodeownersRule | None = None
    for rule in rules if rules is not None else codeowners_rules(source):
        if _matches_any(path, list(rule.globs)):
            match = rule
    return match


def codeowners_globs(path: Path | None = None) -> tuple[str, ...]:
    """Every glob of every ``.github/CODEOWNERS`` rule, in file order."""
    return tuple(glob for rule in codeowners_rules(path) for glob in rule.globs)


def _lane_for_path(path: str, active: dict[str, Any], rules: tuple[CodeownersRule, ...]) -> str | None:
    if _matches_any(path, active["blocked_globs"]):
        return "blocked"
    lanes = active.get("lanes") or {}
    lane = _first_matching_lane(path, lanes)
    if _is_owned(path, rules):
        return str(active["codeowners_lane"])
    return lane


def _is_owned(path: str, rules: tuple[CodeownersRule, ...]) -> bool:
    """An owned path must never be merged without its owner, so L1 can never
    contain one: the policy's ``codeowners_lane`` (L3) overrides whatever lane
    its globs would pick.

    GitHub gives a path the owners of its last matching line, and a last
    line with no owners leaves the path unowned. Here that path stays owned:
    an owner forgotten on a later line must not open the unreviewed lane.
    """
    return codeowners_last_match(path, rules=rules) is not None


# ARIA-CRITICAL-215 — L1 is an explicit allowlist carved out of the
# supervised trees (a unit test under `apps/**/src/**` is L1, its source L2),
# and L3 is the exclusion list that outranks it: a path any L3 glob names is
# never L1, whatever L1 glob also matches it.
_LANE_PRECEDENCE: tuple[str, ...] = ("L3", "L1", "L2")


def _first_matching_lane(path: str, lanes: dict[str, Any]) -> str | None:
    for lane in _LANE_PRECEDENCE:
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
            if isinstance(value, str) and value:
                return value
    return ""


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


__all__ = [
    "HUMAN_MERGE_DECISION",
    "HUMAN_MERGE_LABEL",
    "RISK_POLICY_SCHEMA",
    "RISK_POLICY_PATH",
    "CODEOWNERS_PATH",
    "CodeownersRule",
    "RiskPolicyVerdict",
    "classify_change",
    "classify_path",
    "codeowners_globs",
    "codeowners_last_match",
    "codeowners_rules",
    "load_risk_policy",
    "merge_route_for_change",
    "record_risk_decision_for_pr",
    "risk_policy_hash",
]
