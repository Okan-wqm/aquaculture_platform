"""ARIA-HIGH-016 — the derived two-SHA autonomy closure verdict (closure plan Task 20A).

WHY this module exists
----------------------
Closure was assessed only through per-finding proof-file pins
(``autonomy_evidence``'s policy references). Nothing derived the one
question the closure plan ends on — is the program closed at a named
commit? — from the authorities that own its parts, so the answer could
only be asserted.

WHAT it derives
---------------
Two SHAs, both explicit, never substituted for each other:

* ``evidence_target_sha`` — the code tree every runtime predicate is judged
  at. The closure policy (``docs/aria/policy/autonomy-closure-findings.json``)
  and the structured registry (``docs/reviews/_registry/findings.jsonl``) are
  read from THAT tree's Git objects, never from the checkout or a later
  commit, and the autonomy evidence status is derived at it.
* ``report_commit_sha`` — the final ``origin/main`` commit that carries the
  closure report. It is consulted only for ancestry, its allowed diff and
  the report blob: it must be the main tip, descend strictly from the
  evidence target, change nothing but the report documents, and hold a
  report whose canonical payload names the evidence target and its own
  digest.

Every predicate is evaluated and reported; none returns early, so a red
verdict names every failed predicate at once. The verdict is ``closed``
only when all hold. The verifier accepts no finding list, no booleans and
no policy copy from its caller; it appends nothing.

The parts it reads each have one owner, and this module only asks them:
the policy's structure and refs (``autonomy_evidence._operator_policy_shape``),
the capability evidence (``autonomy_evidence.derive_autonomy_evidence_status``),
and the registry's hash chain and closure rules (``finding-registry.ts verify
--stdin --closures-at``: the chain of ``finding-registry-chain.ts`` and the
admission ``close`` applies — reachability, an override reopen's rejection,
the exact ``Closes:`` trailer — run by the TypeScript owner on the
snapshot's bytes, never transcribed here). What it adds is the closure
policy's own rule for which commit closes a finding (``closing_sha_rule``)
and the two-SHA discipline above.
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping

from .autonomy_evidence import (
    CAPABILITY_SPECS,
    _git_text,
    _git_tree_entry,
    _operator_policy_shape,
    _policy_at_target,
    _read_git_blob_bounded,
    _resolve_repository,
    _run_git,
    derive_autonomy_evidence_status,
)
from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .digest import sha256_digest_text

CLOSURE_REPORT_PATH = "docs/aria/ARIA_AUTONOMY_CLOSURE_EVIDENCE.md"
# The closure plan's PR C: the report, the current-state boundary and the
# historical snapshot's pointer — nothing else may change between the
# evidence target and the report commit.
REPORT_COMMIT_PATHS = frozenset({
    CLOSURE_REPORT_PATH,
    "docs/aria/CURRENT_STATE.md",
    "docs/aria/BEHAVIOUR.md",
})
REGISTRY_PATH = "docs/reviews/_registry/findings.jsonl"
POLICY_PATH = "docs/aria/policy/autonomy-closure-findings.json"
MAIN_REF = "refs/remotes/origin/main"
# The report's canonical payload is the one fenced block with this info
# string; its digest field is excluded from the digest it carries.
PAYLOAD_FENCE_INFO = "json aria-closure-payload"
PAYLOAD_DIGEST_FIELD = "report_payload_sha256"
_MAX_REPORT_BYTES = 1024 * 1024
_MAX_REGISTRY_BYTES = 32 * 1024 * 1024
_REGISTRY_VERIFY_TIMEOUT_SECONDS = 300
_TS_NODE = "node_modules/.bin/ts-node"
_REGISTRY_CLI = "tools/gates/finding-registry.ts"
_GATES_TSCONFIG = "tools/gates/tsconfig.json"
_FENCE = re.compile(r"^```([^\n`]*)\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)

Verdict = Literal["closed", "open"]


@dataclass(frozen=True, slots=True)
class ClosurePredicate:
    """One named closure predicate: whether it holds and why not."""

    name: str
    passed: bool
    reasons: tuple[str, ...] = ()
    evidence_refs: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "reasons": list(self.reasons),
            "evidence_refs": list(self.evidence_refs),
        }


@dataclass(frozen=True, slots=True)
class AutonomyClosureVerdict:
    """The closure verdict at two explicit SHAs, as named predicates."""

    report_commit_sha: str
    evidence_target_sha: str
    predicates: tuple[ClosurePredicate, ...] = field(default=())

    @property
    def verdict(self) -> Verdict:
        return "closed" if self.predicates and all(p.passed for p in self.predicates) else "open"

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "report_commit_sha": self.report_commit_sha,
            "evidence_target_sha": self.evidence_target_sha,
            "failed": [p.name for p in self.predicates if not p.passed],
            "predicates": [p.to_dict() for p in self.predicates],
        }


def canonical_payload_digest(payload: Mapping[str, Any]) -> str:
    """sha256 over the payload's canonical JSON with its digest field excluded."""
    body = {key: value for key, value in payload.items() if key != PAYLOAD_DIGEST_FIELD}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_digest_text(canonical)


def derive_autonomy_closure_verdict(
    *,
    report_commit_sha: str,
    evidence_target_sha: str,
    repo_root: str | Path,
    base_dir: str | Path,
) -> AutonomyClosureVerdict:
    """The closure verdict for ``evidence_target_sha`` reported at ``report_commit_sha``."""
    repo = _resolve_repository(repo_root)
    report_ok = _is_commit(repo, report_commit_sha)
    evidence_ok = _is_commit(repo, evidence_target_sha)
    predicates: list[ClosurePredicate] = [
        _report_commit_is_main_tip(repo, report_commit_sha, report_ok),
        _evidence_target_is_report_ancestor(repo, evidence_target_sha, report_commit_sha, evidence_ok, report_ok),
        _report_commit_changes_only_report_documents(
            repo, evidence_target_sha, report_commit_sha, evidence_ok and report_ok,
        ),
    ]
    payload_predicate, payload = _report_payload_binds_evidence_target(
        repo, report_commit_sha, evidence_target_sha, report_ok,
    )
    predicates.append(payload_predicate)
    policy_predicate, policy_entries = _closure_policy_resolved(repo, evidence_target_sha, evidence_ok)
    predicates.append(policy_predicate)
    finding_ids = tuple(str(entry["finding_id"]) for entry in policy_entries or ())
    registry_predicate, registry_rows, closures = _registry_snapshot(
        repo, evidence_target_sha, evidence_ok, finding_ids,
    )
    predicates.append(registry_predicate)
    predicates.append(_closure_findings_resolved(policy_entries, registry_rows, closures))
    predicates.append(_capabilities_live_proven(repo, base_dir, evidence_target_sha, evidence_ok, payload))
    return AutonomyClosureVerdict(
        report_commit_sha=report_commit_sha,
        evidence_target_sha=evidence_target_sha,
        predicates=tuple(predicates),
    )


def _is_commit(repo: Path, sha: str) -> bool:
    if not isinstance(sha, str) or not is_object_id(sha, formats=ANY_OBJECT_FORMAT):
        return False
    returncode, resolved = _git_text(repo, "rev-parse", "--verify", f"{sha}^{{commit}}")
    return returncode == 0 and resolved == sha


def _is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return _run_git(repo, "merge-base", "--is-ancestor", ancestor, descendant).returncode == 0


def _report_commit_is_main_tip(repo: Path, report: str, report_ok: bool) -> ClosurePredicate:
    name = "report_commit_is_main_tip"
    if not report_ok:
        return ClosurePredicate(name, False, ("report_commit_unavailable",))
    returncode, tip = _git_text(repo, "rev-parse", "--verify", f"{MAIN_REF}^{{commit}}")
    if returncode != 0 or not is_object_id(tip, formats=ANY_OBJECT_FORMAT):
        return ClosurePredicate(name, False, ("main_ref_unavailable",))
    if tip != report:
        return ClosurePredicate(name, False, (f"report_commit_is_not_main_tip:{tip}",))
    return ClosurePredicate(name, True, evidence_refs=(f"{MAIN_REF}@{tip}",))


def _evidence_target_is_report_ancestor(
    repo: Path, evidence: str, report: str, evidence_ok: bool, report_ok: bool,
) -> ClosurePredicate:
    name = "evidence_target_is_report_ancestor"
    if not evidence_ok:
        return ClosurePredicate(name, False, ("evidence_target_unavailable",))
    if not report_ok:
        return ClosurePredicate(name, False, ("report_commit_unavailable",))
    # The report is written after the evidence it reports: the report
    # commit is never its own evidence target.
    if evidence == report:
        return ClosurePredicate(name, False, ("evidence_target_is_the_report_commit",))
    if not _is_ancestor(repo, evidence, report):
        return ClosurePredicate(name, False, ("evidence_target_not_report_ancestor",))
    return ClosurePredicate(name, True, evidence_refs=(evidence,))


def _report_commit_changes_only_report_documents(
    repo: Path, evidence: str, report: str, both_ok: bool,
) -> ClosurePredicate:
    name = "report_commit_changes_only_report_documents"
    if not both_ok:
        return ClosurePredicate(name, False, ("commits_unavailable",))
    result = _run_git(repo, "diff", "--name-only", "-z", "--no-renames", evidence, report)
    if result.returncode != 0:
        return ClosurePredicate(name, False, ("report_diff_unavailable",))
    changed = sorted(path.decode("utf-8", errors="replace") for path in result.stdout.split(b"\0") if path)
    foreign = [path for path in changed if path not in REPORT_COMMIT_PATHS]
    if foreign:
        return ClosurePredicate(name, False, tuple(f"non_report_path_changed:{path}" for path in foreign))
    return ClosurePredicate(name, True, evidence_refs=tuple(changed))


def _report_payload_binds_evidence_target(
    repo: Path, report: str, evidence: str, report_ok: bool,
) -> tuple[ClosurePredicate, dict[str, Any] | None]:
    name = "report_payload_binds_evidence_target"
    if not report_ok:
        return ClosurePredicate(name, False, ("report_commit_unavailable",)), None
    try:
        entry = _git_tree_entry(repo, report, CLOSURE_REPORT_PATH)
        if entry is None:
            return ClosurePredicate(name, False, ("closure_report_missing",)), None
        if entry[1] not in {"100644", "100755"} or entry[2] != "blob":
            return ClosurePredicate(name, False, ("closure_report_not_regular",)), None
        text = _read_git_blob_bounded(
            repo, entry[3], max_bytes=_MAX_REPORT_BYTES,
            too_large="closure_report_too_large", unavailable="closure_report_unavailable",
        ).decode("utf-8")
    except (RuntimeError, UnicodeDecodeError) as exc:
        reason = str(exc) if isinstance(exc, RuntimeError) else "closure_report_not_utf8"
        return ClosurePredicate(name, False, (reason,)), None
    blocks = [body for info, body in _FENCE.findall(text) if info.strip() == PAYLOAD_FENCE_INFO]
    if len(blocks) != 1:
        return ClosurePredicate(name, False, (f"closure_payload_blocks:{len(blocks)}",)), None
    try:
        payload = json.loads(blocks[0])
    except json.JSONDecodeError:
        return ClosurePredicate(name, False, ("closure_payload_not_json",)), None
    if not isinstance(payload, dict):
        return ClosurePredicate(name, False, ("closure_payload_not_object",)), None
    reasons: list[str] = []
    if payload.get("evidence_target_sha") != evidence:
        reasons.append("closure_payload_names_another_evidence_target")
    if payload.get(PAYLOAD_DIGEST_FIELD) != canonical_payload_digest(payload):
        reasons.append("closure_payload_digest_mismatch")
    tip = payload.get("state_evidence_tip")
    if not isinstance(tip, str) or not is_object_id(tip, formats=ANY_OBJECT_FORMAT):
        reasons.append("closure_payload_state_evidence_tip_invalid")
    if reasons:
        return ClosurePredicate(name, False, tuple(reasons)), None
    refs = (f"{report}:{CLOSURE_REPORT_PATH}", str(payload[PAYLOAD_DIGEST_FIELD]))
    return ClosurePredicate(name, True, evidence_refs=refs), payload


def _closure_policy_resolved(
    repo: Path, evidence: str, evidence_ok: bool,
) -> tuple[ClosurePredicate, list[dict[str, Any]] | None]:
    """The policy at the evidence target: structurally valid, every ref present."""
    name = "closure_policy_resolved_at_evidence_target"
    if not evidence_ok:
        return ClosurePredicate(name, False, ("evidence_target_unavailable",)), None
    policy = _policy_at_target(repo, evidence)
    if isinstance(policy, str):
        return ClosurePredicate(name, False, (policy,)), None
    shape = _operator_policy_shape(policy, repo_root=repo, target_sha=evidence)
    if not shape.valid:
        return ClosurePredicate(name, False, ("operator_prerequisite_policy_invalid",)), None
    entries = list(policy["entries"])
    if shape.unresolved_refs:
        return ClosurePredicate(name, False, tuple(
            f"closure_policy_regression_ref_unresolved:{ref}" for ref in shape.unresolved_refs
        )), entries
    return ClosurePredicate(name, True, evidence_refs=(f"{evidence}:{POLICY_PATH}",)), entries


@dataclass(frozen=True, slots=True)
class RegistrySnapshotVerdict:
    """What the registry's owner says about a snapshot: its chain, and each
    named finding's closure as of a commit (reasons; empty when closed)."""

    chain_ok: bool
    chain_reason: str | None = None
    closures: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


def _registry_snapshot(
    repo: Path, evidence: str, evidence_ok: bool, finding_ids: tuple[str, ...],
) -> tuple[ClosurePredicate, list[dict[str, Any]] | None, Mapping[str, tuple[str, ...]] | None]:
    """The registry blob at the evidence target, judged by its owner."""
    name = "registry_chain_valid_at_evidence_target"
    if not evidence_ok:
        return ClosurePredicate(name, False, ("evidence_target_unavailable",)), None, None
    try:
        entry = _git_tree_entry(repo, evidence, REGISTRY_PATH)
        if entry is None or entry[1] not in {"100644", "100755"} or entry[2] != "blob":
            return ClosurePredicate(name, False, ("registry_unavailable",)), None, None
        raw = _read_git_blob_bounded(
            repo, entry[3], max_bytes=_MAX_REGISTRY_BYTES,
            too_large="registry_too_large", unavailable="registry_unavailable",
        )
    except RuntimeError as exc:
        return ClosurePredicate(name, False, (str(exc),)), None, None
    verdict = verify_registry_snapshot(repo, raw, at=evidence, finding_ids=finding_ids)
    if not verdict.chain_ok:
        return ClosurePredicate(name, False, (f"registry_chain_invalid:{verdict.chain_reason}",)), None, None
    try:
        rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ClosurePredicate(name, False, ("registry_unparseable",)), None, None
    refs = (f"{evidence}:{REGISTRY_PATH}@{entry[3]}",)
    return ClosurePredicate(name, True, evidence_refs=refs), rows, verdict.closures


def verify_registry_snapshot(
    repo: Path, raw: bytes, *, at: str, finding_ids: tuple[str, ...],
) -> RegistrySnapshotVerdict:
    """Run the registry's own verifier (TypeScript) over ``raw``.

    ``finding-registry.ts verify --stdin --closures-at <at> <ID>...`` applies
    ``finding-registry-chain.verify``, the one admission test every registry
    writer runs, to the bytes given, then judges each named finding's closure
    as of ``at`` by the rules ``close`` admits a closer with, and prints
    ``{ok, entries, reason, tip, closures}``. The repository's own ts-node
    runs it, as for every gate. A verdict that names fewer closures than were
    asked for is unreadable, never a partial pass.
    """
    ts_node = repo / _TS_NODE
    if not ts_node.is_file():
        return RegistrySnapshotVerdict(False, "registry_verifier_unavailable:ts_node_absent")
    argv = [str(ts_node), "--transpile-only", "--project", _GATES_TSCONFIG, _REGISTRY_CLI, "verify", "--stdin"]
    if finding_ids:
        argv += ["--closures-at", at, *finding_ids]
    try:
        completed = subprocess.run(
            argv, cwd=repo, input=raw, capture_output=True, check=False,
            timeout=_REGISTRY_VERIFY_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return RegistrySnapshotVerdict(False, "registry_verifier_unavailable")
    lines = completed.stdout.decode("utf-8", errors="replace").strip().splitlines()
    try:
        result = json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError:
        result = None
    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
        return RegistrySnapshotVerdict(False, "registry_verifier_output_unreadable")
    if result["ok"] is not True:
        return RegistrySnapshotVerdict(False, str(result.get("reason") or "registry_chain_invalid"))
    closures: dict[str, tuple[str, ...]] = {}
    for item in result.get("closures") or []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) \
                or not isinstance(item.get("reasons"), list):
            return RegistrySnapshotVerdict(False, "registry_verifier_output_unreadable")
        closures[item["id"]] = tuple(str(reason) for reason in item["reasons"])
    if set(closures) != set(finding_ids):
        return RegistrySnapshotVerdict(False, "registry_verifier_output_unreadable")
    return RegistrySnapshotVerdict(True, None, closures)


def _closure_findings_resolved(
    policy_entries: list[dict[str, Any]] | None,
    registry_rows: list[dict[str, Any]] | None,
    closures: Mapping[str, tuple[str, ...]] | None,
) -> ClosurePredicate:
    """Every policy finding closed in the snapshot by the commit its rule names.

    The registry's owner judged each closure (``closures``); the policy's
    ``closing_sha_rule`` is this verifier's to apply: ``last_historical_fix``
    requires the entry's last historical fix, as the policy names it (a full
    SHA), among the closing commits the registry records — the commit the
    closure plan's reconciliation (Task 20 PR B) closes it with.
    """
    name = "closure_findings_resolved_at_evidence_target"
    if policy_entries is None:
        return ClosurePredicate(name, False, ("closure_policy_unavailable",))
    if registry_rows is None or closures is None:
        return ClosurePredicate(name, False, ("registry_unavailable",))
    rows_by_id = {str(row.get("id")): row for row in registry_rows if isinstance(row, dict)}
    reasons: list[str] = []
    refs: list[str] = []
    for entry in policy_entries:
        finding_id = str(entry["finding_id"])
        owner_reasons = closures[finding_id]
        reasons.extend(f"{finding_id}:{reason}" for reason in owner_reasons)
        if owner_reasons:
            continue
        closing = [str(sha) for sha in rows_by_id[finding_id]["closing_commits"]]
        if entry["closing_sha_rule"] == "last_historical_fix":
            last = str(entry["historical_fix_shas"][-1])
            if last not in closing:
                reasons.append(f"{finding_id}:closing_commit_not_last_historical_fix:{last}")
                continue
        refs.extend(f"{finding_id}@{sha}" for sha in closing)
    if reasons:
        return ClosurePredicate(name, False, tuple(reasons))
    return ClosurePredicate(name, True, evidence_refs=tuple(refs))


def _capabilities_live_proven(
    repo: Path, base_dir: str | Path, evidence: str, evidence_ok: bool, payload: dict[str, Any] | None,
) -> ClosurePredicate:
    """Every capability live-proven at the target, on the state chain the report names.

    The evidence is derived at the target from the published state tip it
    reads now; the report recorded the tip it was rendered from. The report
    stays valid while ARIA keeps publishing: its tip must be that tip or an
    ancestor of it on the state store's chain, never a tip off it.
    """
    name = "capabilities_live_proven_at_evidence_target"
    if not evidence_ok:
        return ClosurePredicate(name, False, ("evidence_target_unavailable",))
    status = derive_autonomy_evidence_status(base_dir=base_dir, repo_root=repo, target_sha=evidence)
    reasons: list[str] = [
        f"capability_not_derived:{capability}"
        for capability in CAPABILITY_SPECS if capability not in status.capabilities
    ]
    state_commits: set[str] = set()
    for capability, evidence_status in status.capabilities.items():
        if evidence_status.state != "live_proven":
            reasons.append(f"capability_not_live_proven:{capability}:{evidence_status.state}")
        reasons.extend(f"capability_blocked:{capability}:{blocker}" for blocker in evidence_status.blockers)
        state_commits.update(ref.state_commit for ref in evidence_status.evidence_refs)
    tip = payload.get("state_evidence_tip") if payload is not None else None
    if tip is None:
        reasons.append("closure_payload_unavailable")
    elif len(state_commits) != 1:
        reasons.append(f"derived_state_commits:{len(state_commits)}")
    else:
        [derived_tip] = state_commits
        if tip != derived_tip and not _state_tip_reaches(base_dir, repo, str(tip), derived_tip):
            reasons.append(f"state_evidence_tip_off_chain:{tip}")
    if reasons:
        return ClosurePredicate(name, False, tuple(reasons))
    return ClosurePredicate(name, True, evidence_refs=(f"state:{tip}",))


def _state_tip_reaches(base_dir: str | Path, repo: Path, tip: str, derived_tip: str) -> bool:
    """Whether ``tip`` is an ancestor of ``derived_tip`` in the state store the
    evidence was derived from (opened as the derivation opens it)."""
    from .state_store import StateStoreError, open_state_store
    from .tool_registry import ensure_tools_dir_readonly

    tools = ensure_tools_dir_readonly(base_dir)
    if tools is None or not is_object_id(tip, formats=ANY_OBJECT_FORMAT):
        return False
    try:
        store = open_state_store(repo, store_dir=tools.parent)
    except StateStoreError:
        return False
    return _run_git(Path(store.root), "merge-base", "--is-ancestor", tip, derived_tip).returncode == 0


__all__ = [
    "AutonomyClosureVerdict",
    "CLOSURE_REPORT_PATH",
    "ClosurePredicate",
    "MAIN_REF",
    "PAYLOAD_FENCE_INFO",
    "REPORT_COMMIT_PATHS",
    "RegistrySnapshotVerdict",
    "canonical_payload_digest",
    "derive_autonomy_closure_verdict",
    "verify_registry_snapshot",
]
