"""A plan's origin, and the commit contract the commit-msg gate admits for it.

WHY. ARIA-HIGH-104 (4): the implementer prompt mandated a ``Closes:``
trailer of the form ``aria-findings/F-V9-NN.json#F-V9-NN`` — a spelling
``tools/gates/commit-msg-validator.ts`` has never accepted — while the plan
it implemented was keyed ``plan:<plan_id>`` on the change ledger, an id no
trailer form names. The agent was left to invent a trailer, and no kernel
gate read what it invented; the first commit it pushed would have been
refused by the husky hook and the CI range check with nothing upstream
having said so.

WHAT. Three facts, all derived and none asked of the agent:

* :func:`plan_origin` — what a plan was minted from. The candidate sources
  (``plan_synthesizer.convert_candidate_to_plan_content``) stamp the
  finding a plan addresses into ``plan_content.finding_id``; a plan with no
  finding (a git-diff synthesis, a failing-CI or operator-feedback plan, a
  mission) has none.
* :func:`compute_admission_scope` — the write bound a finding-origin plan is
  admitted with (ADR-0021), recorded on ``plan_started`` and enforced on
  every later body and on the implementation scope.
* :func:`commit_contract_for_plan` — the commit contract for that origin, in
  the terms the gate enforces: the exact trailer line when the origin has a
  form the gate accepts on a CI checkout, or no trailer and the commit
  types the gate does not require one for. The rules are the gate's own
  (``REQUIRE_CLOSES_TYPES``, ``CLOSES_TRAILER_REGEX``), mirrored here and
  pinned against the TypeScript source by
  ``tests/test_plan_origin_commit_contract.py`` so the mirror cannot drift.

The contract rides on the implementation envelope as a structured field
(``commit_contract``), the prompt prints it verbatim, and the pre-PR-open
perimeter (``implementation_safety._check_commit_contract_honoured``) reads
the branch's commits against the same derivation.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .finding import FINDING_ID_RE
from .tool_registry import GovernanceError

COMMIT_CONTRACT_SCHEMA_VERSION = 1

# tools/gates/commit-msg-validator.ts — REQUIRE_CLOSES_TYPES. A subject
# matching this MUST carry a trailer; one that does not may not carry one
# the gate cannot resolve, and under this contract carries none.
REQUIRE_CLOSES_SUBJECT_RE = re.compile(r"^(fix|security|refactor\(agentic,phase-|feat)")

# tools/gates/commit-msg-validator.ts — CLOSES_TRAILER_REGEX, the hard
# format of one trailer line.
CLOSES_TRAILER_RE = re.compile(
    r"^Closes:\s+(\S+?)#([A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}"
    r"|F-\d{3}|F-AUTO-V\d+\.\d+(?:-[A-Z0-9-]+)+|DEBT-\d{4}-\d{2}-\d{2}-\d{3})\s*$"
)

# The one origin kind whose trailer the gate can resolve on a CI checkout:
# an ORPHAN id is validated against the headings of a TRACKED document.
# ``aria-findings/`` (F-NNN) is gitignored, so the gate's ``existsSync`` on
# the cited file fails in the range check every PR runs — a trailer the
# kernel knows will be refused is not minted.
#
# Registry-form ids (``<PREFIX>-<SEV>-NNN``, resolved by the gate through
# ``docs/reviews/_registry/findings.jsonl`` and bound to that row's
# ``review_file``) are NOT an origin this module derives: the review-file
# binding the gate checks lives in the repository checkout's registry, which
# the plan store does not carry, and no synthesizer source mints a plan from
# one (``plan_synthesizer.convert_candidate_to_plan_content`` stamps ORPHAN
# and F ids only). ``plan_origin`` refuses such an id, and the plan contract
# applies that refusal at submission (``plan_contract.REASON_ORIGIN_UNRECOGNISED``)
# so a hand-seeded plan carrying one never CONVERGES — a plan with an origin
# the kernel cannot contract is refused before a round is spent on it, not
# at the implementation mint after staging.
ORPHAN_FINDING_ID_RE = re.compile(r"^ORPHAN-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$")
ORPHAN_FINDINGS_DOCUMENT = "docs/reviews/orphan-findings.md"
# The F-finding family this module recognises as an origin.
#
# The sequential form is READ from the kernel's own allocator
# (``finding.FINDING_ID_RE``, ``F-\d{3,}``): ``finding._allocate_finding_id``
# emits ``F-1000`` after ``F-999``, and a plan minted from such a finding
# must converge — a copy of the gate's ``F-\d{3}`` here (ARIA-HIGH-104
# round-2 verifier) refused it at submission (``plan_contract``
# ``plan_origin_unrecognised``) so it never could. The gate's form
# (``tools/gates/commit-msg-validator.ts`` ``isAriaFindingId``) IS narrower
# than the kernel's producer; that never binds a kernel-minted commit,
# because no trailer is minted for an F origin at all (``aria-findings/`` is
# gitignored — see ``commit_contract_for_plan``), so the gate's regex is
# never asked to resolve an F id the kernel wrote. The tracked-deferral
# form (``F-AUTO-V{X.Y}-{TOPIC}``) is the gate's and is mirrored verbatim.
# Both facts are pinned by ``tests/test_plan_origin_commit_contract.py``.
F_AUTO_FINDING_ID_RE = re.compile(r"^F-AUTO-V\d+\.\d+(?:-[A-Z0-9-]+)+$")

ORIGIN_ORPHAN_FINDING = "orphan_finding"
ORIGIN_F_FINDING = "f_finding"
ORIGIN_PLAN = "plan"
ORIGIN_KINDS: tuple[str, ...] = (ORIGIN_ORPHAN_FINDING, ORIGIN_F_FINDING, ORIGIN_PLAN)

# CLAUDE.md "Commit format" type vocabulary.
COMMIT_TYPES: tuple[str, ...] = ("fix", "feat", "refactor", "security", "test", "chore")
# The members of that vocabulary a bare `<type>(` subject may open without
# the gate demanding a trailer: derived from REQUIRE_CLOSES_SUBJECT_RE, not
# retyped, so the gate's regex growing a type shrinks this tuple.
TRAILERLESS_COMMIT_TYPES: tuple[str, ...] = tuple(
    kind for kind in COMMIT_TYPES if not REQUIRE_CLOSES_SUBJECT_RE.match(f"{kind}(scope): subject")
)


@dataclass(frozen=True)
class PlanOrigin:
    kind: str
    finding_id: str | None = None


def plan_origin(plan_content: Any) -> PlanOrigin:
    """What the plan was minted from, read from its own body."""
    finding_id = plan_content.get("finding_id") if isinstance(plan_content, dict) else None
    if not isinstance(finding_id, str) or not finding_id.strip():
        return PlanOrigin(kind=ORIGIN_PLAN)
    finding_id = finding_id.strip()
    if ORPHAN_FINDING_ID_RE.match(finding_id):
        return PlanOrigin(kind=ORIGIN_ORPHAN_FINDING, finding_id=finding_id)
    if FINDING_ID_RE.match(finding_id) or F_AUTO_FINDING_ID_RE.match(finding_id):
        return PlanOrigin(kind=ORIGIN_F_FINDING, finding_id=finding_id)
    raise GovernanceError(
        f"plan_origin_finding_id_unrecognised: {finding_id!r} is neither an ORPHAN "
        f"finding id nor an F-NNN finding id; a plan may only claim an origin this "
        f"module derives a commit contract for"
    )


def commit_contract_for_plan(plan_content: Any, *, plan_id: str) -> dict[str, Any]:
    """The commit contract the implementer must honour for this plan.

    ``trailer`` is the exact line to put on every commit, or None; ``commit_types``
    the subject types those commits may open with. Never a trailer the gate
    would refuse, never a guess for the agent to fill in.
    """
    origin = plan_origin(plan_content)
    trailer: str | None = None
    if origin.kind == ORIGIN_ORPHAN_FINDING:
        trailer = f"Closes: {ORPHAN_FINDINGS_DOCUMENT}#{origin.finding_id}"
    contract = {
        "schema_version": COMMIT_CONTRACT_SCHEMA_VERSION,
        "plan_id": plan_id,
        "origin_kind": origin.kind,
        "origin_finding_id": origin.finding_id,
        "trailer": trailer,
        "commit_types": list(COMMIT_TYPES if trailer is not None else TRAILERLESS_COMMIT_TYPES),
    }
    validate_commit_contract(contract)
    return contract


def validate_commit_contract(contract: Any) -> None:
    """Refuse a contract that is not one this module derives."""
    if not isinstance(contract, dict):
        raise GovernanceError("commit_contract must be an object")
    if contract.get("schema_version") != COMMIT_CONTRACT_SCHEMA_VERSION:
        raise GovernanceError("commit_contract.schema_version unknown")
    if contract.get("origin_kind") not in ORIGIN_KINDS:
        raise GovernanceError(f"commit_contract.origin_kind must be one of {ORIGIN_KINDS}")
    plan_id = contract.get("plan_id")
    if not isinstance(plan_id, str) or not plan_id.strip():
        raise GovernanceError("commit_contract.plan_id is required")
    trailer = contract.get("trailer")
    if trailer is not None and (not isinstance(trailer, str) or CLOSES_TRAILER_RE.match(trailer) is None):
        raise GovernanceError(f"commit_contract.trailer is not a form the commit-msg gate accepts: {trailer!r}")
    types = contract.get("commit_types")
    if not isinstance(types, list) or not types or any(kind not in COMMIT_TYPES for kind in types):
        raise GovernanceError(f"commit_contract.commit_types must be a non-empty subset of {COMMIT_TYPES}")
    if trailer is None and any(REQUIRE_CLOSES_SUBJECT_RE.match(f"{kind}(scope): s") for kind in types):
        raise GovernanceError("commit_contract without a trailer admits a commit type the gate requires one for")


# ADR-0018 D4 — a plan's origin is fixed when it starts. Every body later
# submitted for the plan (a challenger draft, a structured revision) names
# the same finding, or none when the plan started with none; any other body
# is refused by ``plan_convergence._validate_submitted_plan`` under this
# name, for every origin kind alike. Before it, a revision that dropped
# ``finding_id`` turned an operator- or F-sourced plan into a plain plan on
# the way to CONVERGED, and the commit contract and K-A closure lost the
# finding they were about.
PLAN_ORIGIN_CHANGED = "plan_origin_changed"


def started_origin_finding_id(state: Any) -> Any:
    """The ``finding_id`` the plan's ``plan_started`` body carried, or None."""
    started = state.get("plan_started") if isinstance(state, dict) else None
    content = started.get("plan_content") if isinstance(started, dict) else None
    return content.get("finding_id") if isinstance(content, dict) else None


def require_origin_unchanged(state: Any, body: Any) -> None:
    """Refuse a submitted body whose ``finding_id`` differs from, adds to or drops the start's."""
    started = started_origin_finding_id(state)
    submitted = body.get("finding_id") if isinstance(body, dict) else None
    if submitted != started:
        raise GovernanceError(
            f"{PLAN_ORIGIN_CHANGED}: the plan started with finding_id {started!r} and this "
            f"body carries {submitted!r}; a plan's origin is fixed when it starts"
        )


def carry_started_origin(plan_content: Any, state: Any) -> Any:
    """Stamp the started origin onto a planner body that names none.

    The origin is a kernel fact a planner cannot read — the challenger
    never sees the primary body, and the first revision's request carries
    no body at all — exactly like the round and parent hash the bridge
    already fills from kernel state. A body that names an origin keeps it
    and is judged by :func:`require_origin_unchanged`; an agent can omit the
    origin, never replace it.
    """
    started = started_origin_finding_id(state)
    if started is None or not isinstance(plan_content, dict) or "finding_id" in plan_content:
        return plan_content
    return {**plan_content, "finding_id": started}


# ADR-0021 (ARIA-MEDIUM-261) — the write bound of a finding-sourced plan.
#
# WHY. A finding- or operator-sourced plan is admitted on the surfaces its
# grounding names (``finding_grounding.admit_finding``, or the orphan
# register's evidence), but every later body was held only to its
# ``finding_id``: a revision could widen ``affected_surfaces`` anywhere, and
# the implementation's ``allowed_scope`` is the CONVERGED body's surfaces. The
# coverage gate makes a revision add dependents, so the bound cannot be the
# admitted surfaces alone.
#
# WHAT. ``plan_started`` carries an ``admission_scope``: the admitted surfaces
# (the kernel-converted seed's) plus the roots of their
# ``impact_graph.plan_downstream_impact`` project closure, computed by
# ``start_plan`` itself — no caller can hand one in — plus the subject pins of
# the committed subject-pin policy. Every challenger draft, every revision and
# the implementation scope is refused a path outside it.
REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE = "revision_scope_exceeds_admission_closure"
ADMISSION_SCOPE_MISSING = "admission_scope_missing"
# 2 adds ``pin_policy``; a version-1 record predates the committed policy.
# 3 adds ``dependency_roots`` (ADR-0021 D9, ARIA-HIGH-357): the roots of the
# projects the admitted surfaces import, which a planning-round agent may cite
# and no body may write.
ADMISSION_SCOPE_SCHEMA_VERSION = 3
_ADMISSION_SCOPE_LIST_FIELDS = ("admitted_surfaces", "closure_projects", "closure_roots", "policy_pins")

# CB-5 / program ruling 15 (ARIA-LOW-280) — subject pins are committed policy
# data, never kernel literals. ADR-0021 shipped them as a Python tuple here, so
# the only way to pin a path was a literal in kernel source, and any caller of
# ``compute_admission_scope`` could pass its own. The bound now reads this file
# as committed at the workspace's main-proven commit, the anchor finding
# grounding admits on (``main_anchor``: scrubbed git, blob re-hashed), so a
# working-tree edit or an unmerged commit is never the policy. A missing,
# malformed or unanchored policy pins nothing and names why. A fix's journey
# pin (``<project>/src/__journeys__/``) needs no entry: it lies under its own
# project's closure root.
SUBJECT_PIN_POLICY_PATH = "docs/aria/policy/subject-pins.json"
SUBJECT_PIN_POLICY_REFUSED = "subject_pin_policy_refused"
SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE = "subject_pin_policy_anchor_unavailable"
SUBJECT_PIN_POLICY_MISSING = "subject_pin_policy_missing"
SUBJECT_PIN_POLICY_MALFORMED = "subject_pin_policy_malformed"
_SUBJECT_PIN_POLICY_KEYS = frozenset({"$schema", "schema_version", "policy_id", "subject_pins"})


@dataclass(frozen=True)
class SubjectPin:
    """Paths a subject pins into the bound of every plan it applies to.

    ``subject`` is matched against the plan's subjects: its origin finding id
    and the names of its closure projects.
    """

    subject: str
    paths: tuple[str, ...]


@dataclass(frozen=True)
class SubjectPinPolicy:
    """The committed policy's pins, the blob they came from, or why there are none."""

    pins: tuple[SubjectPin, ...]
    commit: str | None
    blob_oid: str | None
    refused: str | None

    def record(self) -> dict[str, Any]:
        return {"path": SUBJECT_PIN_POLICY_PATH, "commit": self.commit,
                "blob_oid": self.blob_oid, "refused": self.refused}


class AdmissionScopeExceeded(GovernanceError):
    """A body or scope named paths outside its plan's admission bound."""

    def __init__(self, offending: list[str]) -> None:
        self.offending = tuple(offending)
        super().__init__(
            f"{REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE}: {list(self.offending)} lie outside the "
            f"admitted surfaces and their kernel-computed impact closure"
        )


def _bound_path(raw: Any) -> str | None:
    """The canonical spelling the bound compares, or None for one it cannot hold."""
    from .canonical_path import resolve_repo_relpath

    try:
        return resolve_repo_relpath(raw) if isinstance(raw, str) else None
    except GovernanceError:
        return None


def _admitted_surfaces(plan_content: Any) -> list[str]:
    """The seed's surfaces in the bound's spelling: what admission grounded."""
    from .plan_convergence import affected_surface_paths

    admitted = set()
    for path in affected_surface_paths(plan_content.get("affected_surfaces")):
        bound = _bound_path(path)
        if bound is None:
            raise GovernanceError(f"{ADMISSION_SCOPE_MISSING}: admitted surface {path!r} is not a repository path")
        admitted.add(bound)
    return sorted(admitted)


def _parse_subject_pins(content: bytes) -> tuple[SubjectPin, ...]:
    """Every pin the policy names, or GovernanceError: one bad entry refuses the whole file."""
    try:
        policy = json.loads(content.decode("utf-8"))
    except ValueError as exc:
        raise GovernanceError(f"not UTF-8 JSON ({type(exc).__name__})") from exc
    if (not isinstance(policy, dict) or set(policy) != _SUBJECT_PIN_POLICY_KEYS
            or type(policy["schema_version"]) is not int or policy["schema_version"] != 1
            or policy["policy_id"] != "aria-subject-pins"
            or not isinstance(policy["subject_pins"], list)):
        raise GovernanceError("the top level is not the aria/subject-pins/v1 shape")
    pins: list[SubjectPin] = []
    for index, entry in enumerate(policy["subject_pins"]):
        paths = entry.get("paths") if isinstance(entry, dict) else None
        if (not isinstance(entry, dict) or set(entry) != {"subject", "paths"}
                or not isinstance(entry["subject"], str) or not entry["subject"].strip()
                or not isinstance(paths, list) or not paths or any(_bound_path(p) != p for p in paths)):
            raise GovernanceError(f"subject_pins[{index}] is not {{subject, paths}} with canonical repository paths")
        pins.append(SubjectPin(entry["subject"], tuple(paths)))
    return tuple(pins)


def load_subject_pin_policy(workspace_root: Any) -> SubjectPinPolicy:
    """The policy as committed at ``workspace_root``'s main-proven commit; never the working tree."""
    from .main_anchor import committed_blob, resolve_main_anchor

    anchor = resolve_main_anchor(workspace_root)
    if anchor.commit is None:
        return SubjectPinPolicy((), None, None, f"{SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE}: {anchor.reason}")
    blob = committed_blob(workspace_root, commit=anchor.commit, path=SUBJECT_PIN_POLICY_PATH)
    if blob is None:
        return SubjectPinPolicy((), anchor.commit, None, SUBJECT_PIN_POLICY_MISSING)
    try:
        pins = _parse_subject_pins(blob.content)
    except GovernanceError as exc:
        return SubjectPinPolicy((), blob.commit, blob.blob_oid, f"{SUBJECT_PIN_POLICY_MALFORMED}: {exc}")
    return SubjectPinPolicy(pins, blob.commit, blob.blob_oid, None)


def compute_admission_scope(
    plan_content: Any, *, workspace_root: Any, base_dir: Any,
) -> dict[str, Any] | None:
    """The bound a plan is admitted with, or None for a plan with no finding origin."""
    from .impact_graph import plan_downstream_impact
    from .tool_registry import append_tools_governance_once

    origin = plan_origin(plan_content)
    if origin.kind == ORIGIN_PLAN:
        return None
    if workspace_root is None:
        raise GovernanceError(
            f"{ADMISSION_SCOPE_MISSING}: a plan started from {origin.finding_id} is bounded by the "
            f"closure of its admitted surfaces, which needs the workspace to compute it in"
        )
    admitted = _admitted_surfaces(plan_content)
    impact = plan_downstream_impact(changed_files=admitted, workspace_root=workspace_root, base_dir=base_dir)
    projects = sorted({*impact["changed_projects"], *impact["downstream_projects"]})
    roots = sorted({root for root in map(_bound_path, impact["project_roots"].values()) if root})
    # ADR-0021 D9 — read-only: a dependency root under a closure root is
    # already writable, so only the rest is recorded.
    dependency_roots = sorted({
        root for root in map(_bound_path, (impact.get("upstream_project_roots") or {}).values())
        if root and not any(root == entry or root.startswith(entry + "/") for entry in roots)
    })
    policy = load_subject_pin_policy(workspace_root)
    if policy.refused is not None:
        # A refused policy is a standing fact of its commit, disclosed once.
        append_tools_governance_once(base_dir, SUBJECT_PIN_POLICY_REFUSED, {
            "origin_finding_id": origin.finding_id, **policy.record(),
        }, claim_keys=("refused", "commit", "blob_oid"))
    subjects = {origin.finding_id, *projects}
    scope = {
        "schema_version": ADMISSION_SCOPE_SCHEMA_VERSION,
        "origin_finding_id": origin.finding_id,
        "admitted_surfaces": admitted,
        "closure_projects": projects,
        "closure_roots": roots,
        "dependency_roots": dependency_roots,
        "policy_pins": sorted({p for pin in policy.pins if pin.subject in subjects for p in pin.paths}),
        "pin_policy": policy.record(),
        "graph_source": impact["graph_source"],
        "impact_graph_ledger_hash": impact["ledger_hash"],
    }
    validate_admission_scope(scope, plan_content)
    return scope


def validate_admission_scope(scope: Any, plan_content: Any) -> None:
    """Refuse an ``admission_scope`` record that is not the shape the kernel computes."""
    version = scope.get("schema_version") if isinstance(scope, dict) else None
    if type(version) is not int or version not in (1, 2, ADMISSION_SCOPE_SCHEMA_VERSION):
        raise GovernanceError(f"admission_scope must be a schema_version 1 to {ADMISSION_SCOPE_SCHEMA_VERSION} object")
    # A dependency root is read-only context (D9): v3 records it, an earlier
    # record never does, and nothing reads it as a place a body may write.
    if version >= 3:
        dependency_roots = scope.get("dependency_roots")
        if (not isinstance(dependency_roots, list)
                or any(not isinstance(item, str) or _bound_path(item) != item for item in dependency_roots)):
            raise GovernanceError("admission_scope.dependency_roots must be an array of canonical repository paths")
    elif "dependency_roots" in scope:
        raise GovernanceError(f"admission_scope v{version} predates dependency_roots")
    record = scope.get("pin_policy")
    if version == 1:
        # Recorded when the only policy was the kernel's empty tuple: no pins, no policy record.
        if record is not None or scope.get("policy_pins") != []:
            raise GovernanceError("admission_scope v1 predates the committed policy: policy_pins must be empty")
    elif (not isinstance(record, dict) or record.get("path") != SUBJECT_PIN_POLICY_PATH
          or (record.get("refused") is None and not all(isinstance(record.get(k), str) for k in ("commit", "blob_oid")))
          or (record.get("refused") is not None and scope.get("policy_pins") != [])):
        raise GovernanceError("admission_scope.pin_policy must name the committed blob it read; a refused policy "
                              "pins nothing")
    for name in _ADMISSION_SCOPE_LIST_FIELDS:
        value = scope.get(name)
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            raise GovernanceError(f"admission_scope.{name} must be an array of non-empty strings")
    finding_id = plan_content.get("finding_id") if isinstance(plan_content, dict) else None
    if scope.get("origin_finding_id") != finding_id:
        raise GovernanceError("admission_scope.origin_finding_id must be the started plan's finding_id")
    # The admitted half is re-derivable from the seed it is recorded beside,
    # so a record that widens or narrows it is refused on every fold.
    if not scope["admitted_surfaces"] or scope["admitted_surfaces"] != _admitted_surfaces(plan_content):
        raise GovernanceError("admission_scope.admitted_surfaces must be the started plan's surfaces")


def admission_scope_for_plan(state: Any) -> dict[str, Any] | None:
    """The bound recorded at the plan's start; None only for a plan with no finding origin."""
    started = state.get("plan_started") if isinstance(state, dict) else None
    scope = started.get("admission_scope") if isinstance(started, dict) else None
    if scope is not None:
        return scope
    finding_id = started_origin_finding_id(state)
    if finding_id is None:
        return None
    raise GovernanceError(
        f"{ADMISSION_SCOPE_MISSING}: plan {state.get('plan_id')!r} started from {finding_id} "
        f"without the admission record its bodies are bounded by; restart it to record one"
    )


def paths_outside_admission_scope(scope: Mapping[str, Any], paths: list[Any]) -> list[str]:
    """Every path that is neither a bound entry nor under one, named safely, in order."""
    from .finding_grounding import safe_repo_ref

    bound = [*scope["admitted_surfaces"], *scope["closure_roots"], *scope["policy_pins"]]
    offending: list[str] = []
    for raw in paths:
        path = _bound_path(raw)
        if path is not None and any(path == entry or path.startswith(entry + "/") for entry in bound):
            continue
        text = str(raw)
        label = text if safe_repo_ref(text) else "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
        if label not in offending:
            offending.append(label)
    return offending


def require_within_admission_scope(scope: Mapping[str, Any] | None, paths: list[Any]) -> None:
    """Raise :class:`AdmissionScopeExceeded` when ``paths`` leave ``scope``; None bounds nothing."""
    if scope is None:
        return
    offending = paths_outside_admission_scope(scope, paths)
    if offending:
        raise AdmissionScopeExceeded(offending)


def body_paths(body: Any) -> list[str]:
    """Every path a plan body names: its surfaces and its key changes' paths."""
    from .plan_convergence import affected_surface_paths, key_change_paths

    changes = body.get("key_changes") if isinstance(body.get("key_changes"), list) else []
    return [*affected_surface_paths(body.get("affected_surfaces")),
            *(path for change in changes for path in key_change_paths(change))]


def record_admission_scope_refusal(
    base_dir: Any, *, plan_id: Any, stage: str, error: AdmissionScopeExceeded,
) -> None:
    """The plan-keyed governance row every bound refusal leaves behind."""
    from .tool_registry import append_tools_governance

    append_tools_governance(base_dir, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE, {
        "plan_id": plan_id, "stage": stage, "offending_paths": list(error.offending),
    })


@dataclass(frozen=True)
class CommitContractVerdict:
    honoured: bool
    violations: tuple[str, ...] = field(default_factory=tuple)


def _trailer_lines(message: str) -> list[str]:
    return [line.rstrip() for line in message.splitlines() if line.startswith("Closes:")]


def verify_commits_honour_contract(
    commits: list[dict[str, str]], contract: dict[str, Any],
) -> CommitContractVerdict:
    """Judge every commit on an implementation branch against the contract.

    ``commits`` are ``{sha, subject, body}`` rows in branch order. With a
    trailer: every commit carries exactly that trailer line and no other. Without
    one: no commit carries any ``Closes:`` line (the agent never invents a
    trailer) and no subject opens with a type the gate requires one for.
    """
    validate_commit_contract(contract)
    trailer = contract.get("trailer")
    violations: list[str] = []
    if not commits:
        return CommitContractVerdict(honoured=False, violations=("no_commits_on_branch",))
    for commit in commits:
        sha = str(commit.get("sha") or "?")[:12]
        subject = str(commit.get("subject") or "")
        lines = _trailer_lines(str(commit.get("body") or ""))
        if trailer is not None:
            if lines != [trailer]:
                violations.append(f"{sha}:trailer_mismatch:expected={trailer!r} found={lines!r}")
        else:
            if lines:
                violations.append(f"{sha}:invented_trailer:{lines!r}")
            if REQUIRE_CLOSES_SUBJECT_RE.match(subject):
                violations.append(f"{sha}:subject_type_requires_trailer:{subject[:80]!r}")
    return CommitContractVerdict(honoured=not violations, violations=tuple(violations))


def render_commit_contract_section(contract: Any) -> str:
    """The prompt section an implementation envelope's contract renders as."""
    if not isinstance(contract, dict) or not contract:
        return ""
    trailer = contract.get("trailer")
    types = ", ".join(f"`{kind}`" for kind in contract.get("commit_types") or [])
    lines = [
        "## Commit contract (derived by aria_kernel.plan_origin; verified at pre-PR-open)",
        "",
        f"- Plan `{contract.get('plan_id')}` origin: {contract.get('origin_kind')}"
        + (f" `{contract.get('origin_finding_id')}`" if contract.get("origin_finding_id") else ""),
    ]
    if trailer is not None:
        lines.append(f"- Every commit ends with exactly this trailer line, verbatim: `{trailer}`")
    else:
        lines.append("- No `Closes:` trailer exists for this origin; write none. Never invent one.")
    lines.append(f"- Commit subject types admitted: {types}")
    return "\n".join(lines) + "\n\n"


__all__ = [
    "ADMISSION_SCOPE_MISSING",
    "ADMISSION_SCOPE_SCHEMA_VERSION",
    "AdmissionScopeExceeded",
    "CLOSES_TRAILER_RE",
    "COMMIT_CONTRACT_SCHEMA_VERSION",
    "COMMIT_TYPES",
    "F_AUTO_FINDING_ID_RE",
    "ORIGIN_F_FINDING",
    "ORIGIN_KINDS",
    "ORIGIN_ORPHAN_FINDING",
    "ORIGIN_PLAN",
    "ORPHAN_FINDINGS_DOCUMENT",
    "ORPHAN_FINDING_ID_RE",
    "PLAN_ORIGIN_CHANGED",
    "REQUIRE_CLOSES_SUBJECT_RE",
    "REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE",
    "SUBJECT_PIN_POLICY_ANCHOR_UNAVAILABLE",
    "SUBJECT_PIN_POLICY_MALFORMED",
    "SUBJECT_PIN_POLICY_MISSING",
    "SUBJECT_PIN_POLICY_PATH",
    "SUBJECT_PIN_POLICY_REFUSED",
    "SubjectPin",
    "SubjectPinPolicy",
    "TRAILERLESS_COMMIT_TYPES",
    "CommitContractVerdict",
    "PlanOrigin",
    "admission_scope_for_plan",
    "body_paths",
    "carry_started_origin",
    "commit_contract_for_plan",
    "compute_admission_scope",
    "load_subject_pin_policy",
    "paths_outside_admission_scope",
    "plan_origin",
    "record_admission_scope_refusal",
    "render_commit_contract_section",
    "require_origin_unchanged",
    "require_within_admission_scope",
    "started_origin_finding_id",
    "validate_admission_scope",
    "validate_commit_contract",
    "verify_commits_honour_contract",
]
