"""Operator approval — an authority grant is proven by a GitHub act of an operator.

ARIA-CRITICAL-216. The previous grammar resolved ``gov:<event_id>`` against
ANY governance event (ARIA writes most of them), ``review:<path>#<id>``
against any file carrying the text and ``ack-env:<VAR>`` against a variable a
workflow sets for itself. Every one of those is something the governed system
can author, and each one granted authority: a merge lane, a runtime profile,
a lifted self-merge freeze, a tool promotion.

Operator decision (2026-09-26): approval is a comment or a pull request
review posted by an operator's GitHub account, read back through the GitHub
API. Two verifiers, one per class of caller:

``verify_operator_approval``
    For AUTHORITY_RAISING_SURFACES only. The reference is
    ``gh:<owner>/<repo>#<number>/comment/<id>`` (issue or PR comment) or
    ``gh:<owner>/<repo>#<number>/review/<id>`` (PR review). It resolves only
    when the act is in the policy repository, was posted by a login listed in
    ``docs/aria/policy/operators.json`` whose account type is ``User``, was
    never edited, is younger than the policy's max age, and carries exactly
    one approval line naming the surface and every field of the caller's
    scope. The act is consumed once (a governance row), so it authorizes one
    grant and nothing else.

``verify_recorded_reference``
    For RECORD_SURFACES only: references that attest a decision which grants
    no authority. The recorded grammar stays there and is refused, by
    construction, on every raising surface.

Authority-LOWERING actions (revoke a grant, freeze, a lower profile or
ceiling) call neither: a reason on the record is enough to narrow authority.
The whole caller population is pinned by
``tests/test_operator_approval_callers.py``.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol

from .tool_registry import GovernanceError, ensure_tools_dir


class OperatorApprovalUnrecorded(Exception):
    """The reference does not resolve to recorded operator authority."""


REPO_ROOT = Path(__file__).resolve().parents[2]
OPERATORS_POLICY_SCHEMA = "aria/operators/v1"
OPERATORS_POLICY_PATH = REPO_ROOT / "docs" / "aria" / "policy" / "operators.json"

APPROVAL_MARKER = "ARIA-APPROVE"
APPROVAL_CONSUMED_EVENT = "operator_approval_consumed"
GITHUB_REF_GRAMMAR = (
    "gh:<owner>/<repo>#<number>/comment/<id> (issue or PR comment) or "
    "gh:<owner>/<repo>#<number>/review/<id> (PR review)"
)

# Surface -> the scope fields its approval line must carry, in line order.
AUTHORITY_RAISING_SURFACES: Mapping[str, tuple[str, ...]] = MappingProxyType({
    "merge_lane_grant": ("lane", "expires"),
    "runtime_profile": ("profile", "ceiling"),
    "self_merge_unfreeze": ("freeze_id",),
    "tool_promote": ("tool", "target"),
    "tool_unquarantine": ("tool",),
    "l3_policy_approval": ("pr", "head_sha", "stage"),
})

# Decisions recorded with a reference that widen no authority.
RECORD_SURFACES: frozenset[str] = frozenset({
    "consensus_finding_promotion",
    "knowledge_graph_anti_pattern",
    "runtime_v2_promotion",
    "surface_reset",
})

# A review that is pending was never shown to anyone; a dismissed one was
# withdrawn; "changes requested" contradicts an approval line.
_STANDING_REVIEW_STATES = frozenset({"APPROVED", "COMMENTED"})
_CLOCK_SKEW = timedelta(minutes=5)
_REF_PATTERN = re.compile(
    r"^gh:(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(?P<repo>[A-Za-z0-9._-]+)"
    r"#(?P<number>[1-9][0-9]*)/(?P<act>comment|review)/(?P<act_id>[1-9][0-9]*)$"
)


def load_operators_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    """The code-owned operator identity policy, validated."""
    payload = dict(policy) if policy is not None else json.loads(
        OPERATORS_POLICY_PATH.read_text(encoding="utf-8")
    )
    if payload.get("$schema") != OPERATORS_POLICY_SCHEMA:
        raise GovernanceError("operators_policy_schema_must_be_v1")
    if payload.get("schema_version") != 1:
        raise GovernanceError("operators_policy_schema_version_must_be_1")
    logins = payload.get("operator_logins")
    if (
        not isinstance(logins, list)
        or not logins
        or not all(isinstance(login, str) and login.strip() for login in logins)
    ):
        raise GovernanceError("operators_policy_requires_operator_logins")
    repository = payload.get("repository")
    if not isinstance(repository, str) or repository.count("/") != 1 or not all(repository.split("/")):
        raise GovernanceError("operators_policy_requires_owner_slash_repo")
    max_age = payload.get("approval_max_age_hours")
    if not isinstance(max_age, int) or isinstance(max_age, bool) or max_age <= 0:
        raise GovernanceError("operators_policy_requires_positive_approval_max_age_hours")
    return payload


class OperatorActReader(Protocol):
    """The GitHub reads the verifier makes (the kernel's gh adapter)."""

    owner: str | None
    repo: str | None

    def get_issue_comment(self, comment_id: int) -> dict[str, Any]: ...

    def get_pull_request_review(self, number: int, review_id: int) -> dict[str, Any]: ...

    def get_review_last_edited_at(self, node_id: str) -> str | None: ...


def github_act_reader() -> OperatorActReader:
    """The production reader: the kernel's ``gh`` adapter at the repository root."""
    from .auto_merge import GhCliGitHubAdapter

    return GhCliGitHubAdapter(cwd=REPO_ROOT)


@dataclass(frozen=True)
class GitHubApprovalRef:
    owner: str
    repo: str
    number: int
    act: str
    act_id: int

    @property
    def repository(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def act_key(self) -> str:
        """Comment and review ids are unique across GitHub; the act IS its id."""
        return f"{self.act}/{self.act_id}"

    @property
    def canonical(self) -> str:
        return f"gh:{self.repository}#{self.number}/{self.act}/{self.act_id}"


def parse_github_approval_ref(ref: str | None, *, surface: str) -> GitHubApprovalRef:
    """Syntax only — no network, nothing consumed."""
    text = (ref or "").strip()
    match = _REF_PATTERN.match(text)
    if match is None:
        raise OperatorApprovalUnrecorded(
            f"{surface}: operator approval {text!r} is not a GitHub act; an authority "
            f"grant is proven by {GITHUB_REF_GRAMMAR} posted by a listed operator "
            "(`aria-kernel operator approval-template` prints the line to post)"
        )
    return GitHubApprovalRef(
        owner=match["owner"],
        repo=match["repo"],
        number=int(match["number"]),
        act=match["act"],
        act_id=int(match["act_id"]),
    )


def _canonical_utc(value: str) -> str:
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if moment.tzinfo is None:
        return value
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Fields with more than one spelling of the same value; both sides of the
# comparison pass through the same canonical form.
_SCOPE_CANONICALIZERS = {"expires": _canonical_utc}


def canonical_scope(surface: str, scope: Mapping[str, object]) -> dict[str, str]:
    """``scope`` as the surface's declared fields, in declared order."""
    keys = AUTHORITY_RAISING_SURFACES.get(surface)
    if keys is None:
        raise OperatorApprovalUnrecorded(
            f"{surface}: not an authority-raising surface "
            f"(known: {sorted(AUTHORITY_RAISING_SURFACES)})"
        )
    if set(scope) != set(keys):
        raise OperatorApprovalUnrecorded(
            f"{surface}: scope keys {sorted(scope)} must be exactly {list(keys)}"
        )
    canonical: dict[str, str] = {}
    for key in keys:
        value = str(scope[key]).strip()
        if not value or any(char.isspace() for char in value):
            raise OperatorApprovalUnrecorded(
                f"{surface}: scope field {key}={scope[key]!r} must be one non-empty token"
            )
        canonical[key] = _SCOPE_CANONICALIZERS.get(key, str)(value)
    return canonical


def approval_line(surface: str, scope: Mapping[str, object]) -> str:
    """The exact line an operator posts to approve ``surface`` for ``scope``."""
    fields = canonical_scope(surface, scope)
    return " ".join(
        [APPROVAL_MARKER, f"surface={surface}", *(f"{key}={value}" for key, value in fields.items())]
    )


def _parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _read_act(source: OperatorActReader, parsed: GitHubApprovalRef, *, surface: str) -> dict[str, Any]:
    """Fetch the act and reduce it to what the rules read."""
    try:
        if parsed.act == "comment":
            payload = source.get_issue_comment(parsed.act_id)
            container = str(payload.get("issue_url") or "")
            container_suffix = f"/repos/{parsed.repository}/issues/{parsed.number}"
            posted_at = payload.get("created_at")
            edited = payload.get("updated_at") != posted_at
            state = None
        else:
            payload = source.get_pull_request_review(parsed.number, parsed.act_id)
            container = str(payload.get("pull_request_url") or "")
            container_suffix = f"/repos/{parsed.repository}/pulls/{parsed.number}"
            posted_at = payload.get("submitted_at")
            edited = source.get_review_last_edited_at(str(payload.get("node_id") or "")) is not None
            state = str(payload.get("state") or "")
    except (GovernanceError, OSError, ValueError) as exc:
        raise OperatorApprovalUnrecorded(
            f"{surface}: GitHub act {parsed.canonical} could not be read: {exc}"
        ) from exc
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    return {
        "id": payload.get("id"),
        "login": str(user.get("login") or ""),
        "user_type": str(user.get("type") or ""),
        "body": str(payload.get("body") or ""),
        "posted_at": posted_at,
        "edited": edited,
        "state": state,
        "on_container": container.casefold().endswith(container_suffix.casefold()),
        "url": payload.get("html_url"),
    }


def _approval_fields(body: str, *, surface: str, ref: str) -> dict[str, str]:
    lines = [line.split() for line in body.splitlines() if line.split()[:1] == [APPROVAL_MARKER]]
    if len(lines) != 1:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {ref} must carry exactly one {APPROVAL_MARKER} line, found {len(lines)}"
        )
    fields: dict[str, str] = {}
    for token in lines[0][1:]:
        key, sep, value = token.partition("=")
        if not sep or not key or not value or key in fields:
            raise OperatorApprovalUnrecorded(
                f"{surface}: {ref} approval line has a malformed or repeated field {token!r}"
            )
        fields[key] = value
    return fields


def _consume(
    root: Path,
    parsed: GitHubApprovalRef,
    *,
    surface: str,
    scope: dict[str, str],
    act: dict[str, Any],
) -> dict[str, Any]:
    """Record the act as spent; refuse it if it already was.

    The governance ledger is the existing record of operator control-plane
    acts, so the consumption lives there, checked and appended under the
    ledger's own lock. It lands under any profile, like the thaw it may
    authorize (``runtime_profile._write_control_plane_state``).
    """
    from .ledger import state_transaction
    from .tool_registry import append_tools_governance

    governance = root / "governance.jsonl"
    with state_transaction([governance]) as txn:
        rows = (
            txn.load_declared_jsonl(governance, expected_surface="tools_governance")
            if governance.exists()
            else []
        )
        for row in rows:
            details = row.get("details") if isinstance(row.get("details"), dict) else {}
            if row.get("kind") == APPROVAL_CONSUMED_EVENT and details.get("act_key") == parsed.act_key:
                raise OperatorApprovalUnrecorded(
                    f"{surface}: {parsed.canonical} was already consumed for "
                    f"{details.get('surface')} {details.get('scope')} "
                    f"({row.get('event_id')}); one GitHub act authorizes one grant"
                )
        return append_tools_governance(
            root,
            APPROVAL_CONSUMED_EVENT,
            {
                "ref": parsed.canonical,
                "act_key": parsed.act_key,
                "surface": surface,
                "scope": scope,
                "login": act["login"],
                "posted_at": act["posted_at"],
                "url": act["url"],
            },
            bypass_profile_gate=True,
            transaction=txn,
        )


def verify_operator_approval(
    ref: str | None,
    *,
    surface: str,
    scope: Mapping[str, object],
    base_dir: str | Path | None,
    reader: OperatorActReader | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Prove ``ref`` is an operator's GitHub act approving exactly ``scope``.

    Returns the proof (recorded by the caller next to the grant) or raises
    :class:`OperatorApprovalUnrecorded`. Success consumes the act.
    """
    expected = canonical_scope(surface, scope)
    parsed = parse_github_approval_ref(ref, surface=surface)
    policy = load_operators_policy()
    repository = str(policy["repository"])
    if parsed.repository.casefold() != repository.casefold():
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} is not in the policy repository {repository}"
        )
    try:
        source = reader if reader is not None else github_act_reader()
    except (GovernanceError, OSError, ValueError) as exc:
        raise OperatorApprovalUnrecorded(
            f"{surface}: GitHub could not be asked about {parsed.canonical}: {exc}"
        ) from exc
    answered_for = f"{source.owner}/{source.repo}"
    if answered_for.casefold() != repository.casefold():
        raise OperatorApprovalUnrecorded(
            f"{surface}: the GitHub reader reads {answered_for}, not the policy repository {repository}"
        )
    act = _read_act(source, parsed, surface=surface)
    if act["id"] != parsed.act_id or not act["on_container"]:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.act} {parsed.act_id} was not posted on #{parsed.number}"
        )
    operators = {str(login).casefold() for login in policy["operator_logins"]}
    if act["login"].casefold() not in operators:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} was posted by {act['login']!r}, not a listed operator "
            "(docs/aria/policy/operators.json)"
        )
    if act["user_type"] != "User":
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} author {act['login']!r} is of type "
            f"{act['user_type']!r}; an operator act comes from a User account"
        )
    if act["state"] is not None and act["state"] not in _STANDING_REVIEW_STATES:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} review state {act['state']!r} is not one of "
            f"{sorted(_STANDING_REVIEW_STATES)}"
        )
    if act["edited"]:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} was edited after it was posted; post a new approval"
        )
    posted = _parse_utc(act["posted_at"])
    moment = now or datetime.now(timezone.utc)
    max_age = timedelta(hours=int(policy["approval_max_age_hours"]))
    if posted is None:
        raise OperatorApprovalUnrecorded(f"{surface}: {parsed.canonical} carries no posting time")
    if posted > moment + _CLOCK_SKEW:
        raise OperatorApprovalUnrecorded(f"{surface}: {parsed.canonical} is dated in the future")
    if moment - posted > max_age:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} is older than {policy['approval_max_age_hours']}h"
        )
    fields = _approval_fields(act["body"], surface=surface, ref=parsed.canonical)
    named_surface = fields.pop("surface", None)
    if named_surface != surface:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} approves surface {named_surface!r}"
        )
    try:
        approved = canonical_scope(surface, fields)
    except OperatorApprovalUnrecorded as exc:
        raise OperatorApprovalUnrecorded(f"{surface}: {parsed.canonical} approval line: {exc}") from exc
    if approved != expected:
        raise OperatorApprovalUnrecorded(
            f"{surface}: {parsed.canonical} approves {approved}, not {expected}; "
            f"expected line: {approval_line(surface, expected)}"
        )
    event = _consume(ensure_tools_dir(base_dir), parsed, surface=surface, scope=expected, act=act)
    return {
        "kind": "gh",
        "ref": parsed.canonical,
        "surface": surface,
        "scope": expected,
        "login": act["login"],
        "act": parsed.act,
        "act_id": parsed.act_id,
        "number": parsed.number,
        "posted_at": act["posted_at"],
        "url": act["url"],
        "consumed_event_id": event.get("event_id"),
    }


def verify_recorded_reference(
    ref: str | None,
    *,
    base_dir: str | Path | None,
    surface: str,
) -> dict[str, Any]:
    """Resolve a record-only reference: ``gov:``, ``review:`` or ``ack-env:``.

    ``gov:<event_id>``      a governance event that exists in the ledger;
    ``review:<path>#<id>``  a review document on disk carrying the id;
    ``ack-env:<VAR>``       an operator-injected variable, non-empty now.

    None of these proves who acted, which is why an authority-raising surface
    may not call this (refused below, pinned by the caller classification).
    """
    if surface not in RECORD_SURFACES:
        raise OperatorApprovalUnrecorded(
            f"{surface}: a recorded reference attests a decision that grants no authority; "
            "this surface is not one of them — use verify_operator_approval"
        )
    text = (ref or "").strip()
    if not text:
        raise OperatorApprovalUnrecorded(f"{surface}: a recorded reference is required")
    kind, _, value = text.partition(":")
    if not value:
        raise OperatorApprovalUnrecorded(
            f"{surface}: reference {text!r} has no '<kind>:<value>' form"
        )
    if kind == "gov":
        root = ensure_tools_dir(base_dir)
        ledger = root / "governance.jsonl"
        if not ledger.exists():
            raise OperatorApprovalUnrecorded(
                f"{surface}: governance ledger absent — {text!r} cannot resolve"
            )
        for line in ledger.read_text(encoding="utf-8").splitlines():
            if f'"event_id": "{value}"' in line or f'"event_id":"{value}"' in line:
                return {"kind": "gov", "event_id": value, "surface": surface}
        raise OperatorApprovalUnrecorded(
            f"{surface}: governance event {value!r} not found — a producer may "
            "not bless itself with an unrecorded reference"
        )
    if kind == "review":
        path_part, _, anchor = value.partition("#")
        if not path_part or not anchor:
            raise OperatorApprovalUnrecorded(
                f"{surface}: review reference needs '<path>#<finding-id>'"
            )
        doc = Path(path_part)
        if not doc.is_file() or anchor not in doc.read_text(encoding="utf-8", errors="replace"):
            raise OperatorApprovalUnrecorded(
                f"{surface}: review document does not carry {anchor!r}"
            )
        return {"kind": "review", "path": path_part, "anchor": anchor, "surface": surface}
    if kind == "ack-env":
        if not os.environ.get(value, "").strip():
            raise OperatorApprovalUnrecorded(
                f"{surface}: acknowledgment variable {value!r} is empty or unset"
            )
        return {"kind": "ack-env", "variable": value, "surface": surface}
    raise OperatorApprovalUnrecorded(
        f"{surface}: reference {text!r} is not one of "
        "gov:<event_id>, review:<path>#<id>, ack-env:<VAR>"
    )


__all__ = (
    "APPROVAL_CONSUMED_EVENT",
    "APPROVAL_MARKER",
    "AUTHORITY_RAISING_SURFACES",
    "GITHUB_REF_GRAMMAR",
    "OPERATORS_POLICY_PATH",
    "RECORD_SURFACES",
    "GitHubApprovalRef",
    "OperatorActReader",
    "OperatorApprovalUnrecorded",
    "approval_line",
    "canonical_scope",
    "github_act_reader",
    "load_operators_policy",
    "parse_github_approval_ref",
    "verify_operator_approval",
    "verify_recorded_reference",
)
