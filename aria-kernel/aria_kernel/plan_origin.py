"""A plan's origin, and the commit contract the commit-msg gate admits for it.

WHY. ARIA-HIGH-104 (4): the implementer prompt mandated a ``Closes:``
trailer of the form ``aria-findings/F-V9-NN.json#F-V9-NN`` — a spelling
``tools/gates/commit-msg-validator.ts`` has never accepted — while the plan
it implemented was keyed ``plan:<plan_id>`` on the change ledger, an id no
trailer form names. The agent was left to invent a trailer, and no kernel
gate read what it invented; the first commit it pushed would have been
refused by the husky hook and the CI range check with nothing upstream
having said so.

WHAT. Two facts, both derived and neither asked of the agent:

* :func:`plan_origin` — what a plan was minted from. The candidate sources
  (``plan_synthesizer.convert_candidate_to_plan_content``) stamp the
  finding a plan addresses into ``plan_content.finding_id``; a plan with no
  finding (a git-diff synthesis, a failing-CI or operator-feedback plan, a
  mission) has none.
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

import re
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
    "REQUIRE_CLOSES_SUBJECT_RE",
    "TRAILERLESS_COMMIT_TYPES",
    "CommitContractVerdict",
    "PlanOrigin",
    "commit_contract_for_plan",
    "plan_origin",
    "render_commit_contract_section",
    "validate_commit_contract",
    "verify_commits_honour_contract",
]
