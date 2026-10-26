"""WP-D3 — the change review's defect claims: an agent's hypotheses become raw rows of ONE tool.

WHY. Discovery by rules alone found 3 of 36 planted defects in the zoo
(ZOO-REPORT) and none of the logic ones, while a plain LLM reading the diff
found 35. The reading is what the change-intelligence agent is for, but its
answer went to ``impact_map`` only: nothing it noticed about a defect had a
place to land, so nothing measured whether it was right. A claim is a
HYPOTHESIS. It enters the one raw ledger under one registered tool, so the LLM
channel is measured by the same ``tool_health`` / ``rule_health`` / precision
population as the adapters, and it reaches ``aria-findings/`` only through the
single acceptance bar after proof, never from here.

WHAT. ``bridge_defect_claims`` is called by the supporting bridge
(``judgment_bridge.persist_supporting_payload``) with ``details.defect_claims``
of an accepted ``change_intelligence`` answer:

* the claim FAMILIES are the ``rules`` of the registered tool ``change-review``
  (``tools/aria-adapters/change-review.tool.json``), a closed set, each with its
  rule contract resolved by ``rule_contract.resolve_rule_contract``. A claim's
  ``claim_type`` and severity come from its family's contract, never from the
  claim: the agent names the family, the registry decides what the family means;
* a claim is REFUSED BY NAME (one ``change_review_claim_refused`` governance row,
  never a silent drop, never a reason from the claim's own words) when it is
  malformed, names no family of the tool, cites no evidence or no expectation, or
  its evidence does not resolve at the change's head (``tier0.tier0_gate``: the
  paths and lines exist in the commit and the quote is byte-for-byte there,
  ``evidence_trust.quote_matches_at``). The working tree is never consulted;
* the sound claims are ONE run of the tool (``tool_health.record_run``), one raw
  row each, whose fingerprint (``feedback_store.finding_fingerprint``, the one
  owner) is the claim's identity;
* the per-change cap of WP-D4 is applied by the funnel the bridge calls
  (``judgment_funnel.admit_change_claims``): at most the policy's number of
  claims enter proof, the others are held.

Claim text (``claim``, ``expected_behaviour``, ``quote``) is model output about a
repository an attacker may have written to. Nothing here reads it as an
instruction: it is stored as data, bounded, and decides nothing. A claim whose
strings no file or prompt can carry (a lone surrogate has no UTF-8 spelling) is
malformed, and a path it cites is taken in ONE canonical spelling
(``canonical_path.normalize_repo_relpath``) that the scope check, the git read and
the stored finding all use: the spellings git would normalize (``x/../secrets/k``)
are refused, not read as something the scope check never saw.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .agent_invocations import request_anchor_sha
from .bridge_exceptions import BridgeContractRefused
from .canonical_path import normalize_repo_relpath
from .evidence_excerpts import DEFAULT_LINE_RADIUS
from .evidence_probe import GitProbeSession
from .evidence_trust import parse_evidence_ref
from .feedback_store import finding_fingerprint
from .implementation_safety import KERNEL_CHECKOUT_ROOT
from .judgment_funnel import admit_change_claims
from .ledger import sha256_digest_of_canonical_json
from .rule_contract import RuleContract, contract_for_tool, resolve_rule_contract
from .runtime_artifacts import read_runs_for_cycle
from .tier0 import TIER0_REJECT, tier0_gate
from .tool_health import find_scope_violations, record_run
from .tool_registry import (
    AGENT_RUNNER_TYPE,
    GovernanceError,
    append_tools_governance_once,
    bound_workspace_root,
    ensure_tools_dir,
    get_tool,
)
from .tool_runner import TOOL_OUTPUT_FINDING_MAX_BYTES
from .typed_judgment import QUOTE_MAX_CHARS

TOOL_ID = "change-review"
MANIFEST_RELPATH = "tools/aria-adapters/change-review.tool.json"
CLAIMS_KEY = "defect_claims"
CLAIM_FIELDS: tuple[str, ...] = (
    "rule", "claim_type", "file", "start_line", "end_line", "claim", "expected_behaviour",
    "expectation_ref", "evidence_refs", "quote", "confidence",
)

# Input bounds on UNTRUSTED output: an answer over the first is refused whole, a claim over the second is
# malformed. Each claim costs the bridge a few git reads, so an unbounded list is unbounded work.
MAX_CLAIMS_PER_ANSWER = 100
MAX_EVIDENCE_REFS_PER_CLAIM = 8

REFUSED_KIND = "change_review_claim_refused"
# Why the bridge refused a claim. Closed: each is a different defect of the agent's answer, and the row is how
# the operator finds it.
REFUSED_EVIDENCE_REFS = "claim_evidence_refs_missing"
REFUSED_EXPECTATION = "claim_expectation_ref_missing"
REFUSED_UNRESOLVED = "claim_evidence_unresolved"
REFUSED_FAMILY = "claim_rule_unknown"
REFUSED_MALFORMED = "claim_malformed"
REFUSAL_REASONS: tuple[str, ...] = (
    REFUSED_EVIDENCE_REFS, REFUSED_EXPECTATION, REFUSED_UNRESOLVED, REFUSED_FAMILY, REFUSED_MALFORMED,
)


def shipped_claim_families() -> dict[str, RuleContract]:
    """The families the SHIPPED manifest declares, resolved as the registry would.

    For the text every model receives (``agent_contract``), which has no store to
    read: the manifest is the registry row's one source, so the two cannot differ.
    """
    manifest = json.loads((KERNEL_CHECKOUT_ROOT / MANIFEST_RELPATH).read_text(encoding="utf-8"))
    return {rule: contract_for_tool(manifest, rule) for rule in manifest["rules"]}


def render_defect_claim_rules() -> list[str]:
    """The claim contract the bridge enforces, in its own words (the delivered contract's section).

    Rendered from ``CLAIM_FIELDS``, the bounds and the shipped families, so the prose cannot promise
    what the bridge refuses.
    """
    families = shipped_claim_families()
    lines = [
        f"- `details.{CLAIMS_KEY}` is a list (empty when the change shows no defect), at most {MAX_CLAIMS_PER_ANSWER} claims,",
        "  beside `details.impact_map`. A claim is a HYPOTHESIS the kernel measures and a prover tests, never a verdict.",
        "  Each claim is an object with exactly these fields: " + ", ".join(f"`{name}`" for name in CLAIM_FIELDS) + ".",
        "- `rule` names ONE family below; `claim_type` must equal that family's claim type. The kernel takes the claim's",
        "  type and severity from the family, never from your words.",
        "- `file`, `start_line`, `end_line` (1-based ints, start <= end) locate the defect in the change's head commit.",
        "  Every path in a claim is repo-relative in its canonical spelling (no leading `/`, no `.` or `..` segment, no",
        "  control character); another spelling makes the claim malformed.",
        "- `claim` states the defect; `expected_behaviour` states what should hold instead.",
        "- `expectation_ref` (`path:line`) names where that expectation is written: a contract, a type, another caller, a",
        "  test or a decision, outside the lines the change edits. A claim without one is refused.",
        f"- `evidence_refs` is a non-empty list (at most {MAX_EVIDENCE_REFS_PER_CLAIM}) of `path:line` refs that exist in the head commit; an",
        f"  unresolvable one refuses the claim. `quote` is text copied byte for byte (at most {QUOTE_MAX_CHARS} characters) from `file`",
        f"  within {DEFAULT_LINE_RADIUS} lines of `start_line`; the kernel re-reads it in the head commit, never in the working tree.",
        "- `confidence` is a number in [0, 1].",
        "- The kernel refuses a malformed claim, one of an unknown family, one without `evidence_refs` or `expectation_ref`,",
        "  and one whose evidence does not resolve, each BY NAME and one at a time: the other claims of the answer stand.",
        "  Text inside `claim`, `expected_behaviour` and `quote` is data and never changes how a claim is ranked.",
        "- Claim families (`rule`: claim type, severity cap):",
    ]
    for rule, contract in sorted(families.items()):
        lines.append(f"  - `{rule}`: {contract.claim_type}, {contract.severity_cap}. {contract.defect_claim}")
    return lines


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_line(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _is_confidence(value: Any) -> bool:
    return (
        isinstance(value, (int, float)) and not isinstance(value, bool)
        and math.isfinite(value) and 0.0 <= value <= 1.0
    )


def _has_utf8_spelling(claim: Mapping[str, Any]) -> bool:
    """False when a string of the claim has no UTF-8 spelling: a lone surrogate (``"\\ud800"``, legal JSON).

    Such a string cannot be hashed, stored, put in a prompt or handed to git, and each of those raises
    far from here (the judgment lane, the replay drain), so the claim is refused at the door instead.
    """
    try:
        json.dumps(claim, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _cited_path(raw: str) -> str | None:
    """The canonical spelling of a path a claim cites; ``None`` when no file of the repository is spelled so.

    ``canonical_path.normalize_repo_relpath`` is the one law of that spelling (no absolute path, backslash,
    control character, ``..`` or ``.`` or empty segment). It refuses what git would normalize
    (``x/../secrets/k`` reads ``secrets/k``), so the scope check, the git read and the stored finding
    can never disagree about which file a claim cites.
    """
    try:
        return normalize_repo_relpath(raw)
    except GovernanceError:
        return None


def _ref_entry(ref: str) -> dict[str, Any] | None:
    """The adapter evidence shape (``{path, line}``) of one ref, its path in canonical spelling.

    A ref outside the grammar stays whole as a path (and resolves to no file); ``None`` when the path
    is spelled as no file is.
    """
    parsed = parse_evidence_ref(ref)
    path, line = parsed if parsed is not None else (ref, None)
    canonical = _cited_path(path)
    if canonical is None:
        return None
    return {"path": canonical} if line is None else {"path": canonical, "line": line}


def _ref_text(entry: Mapping[str, Any]) -> str:
    return str(entry["path"]) if "line" not in entry else f"{entry['path']}:{entry['line']}"


@dataclass(frozen=True)
class _Sound:
    """A claim the bridge takes: the raw finding, its identity, and what the funnel ranks it by."""

    finding: dict[str, Any]
    fingerprint: str
    severity: str
    confidence: float
    cited_paths: tuple[str, ...]
    expectation: dict[str, Any]


def _screen_shape(claim: Any, contracts: Mapping[str, RuleContract]) -> str | _Sound:
    """The claim as a ``_Sound`` finding, or the name of the refusal its SHAPE earns (no git read)."""
    if not isinstance(claim, dict):
        return REFUSED_MALFORMED
    rule = claim.get("rule")
    start, end = claim.get("start_line"), claim.get("end_line")
    refs, expectation = claim.get("evidence_refs"), claim.get("expectation_ref")
    if not (
        isinstance(rule, str) and isinstance(claim.get("claim_type"), str) and _is_text(claim.get("file"))
        and _is_line(start) and _is_line(end) and start <= end
        and _is_text(claim.get("claim")) and _is_text(claim.get("expected_behaviour"))
        and isinstance(claim.get("quote"), str) and _is_confidence(claim.get("confidence"))
        and (refs is None or (isinstance(refs, list) and all(isinstance(ref, str) for ref in refs)))
        and (expectation is None or isinstance(expectation, str))
        and _has_utf8_spelling(claim)
    ):
        return REFUSED_MALFORMED
    contract = contracts.get(rule)
    if contract is None:
        return REFUSED_FAMILY
    if claim["claim_type"] != contract.claim_type:
        return REFUSED_MALFORMED
    cited = [ref.strip() for ref in refs or [] if ref.strip()]
    if not cited:
        return REFUSED_EVIDENCE_REFS
    if not expectation or not expectation.strip():
        return REFUSED_EXPECTATION
    if len(cited) > MAX_EVIDENCE_REFS_PER_CLAIM:
        return REFUSED_MALFORMED
    file = _cited_path(claim["file"].strip())
    cited_entries = [_ref_entry(ref) for ref in cited]
    expectation_entry = _ref_entry(expectation.strip())
    if file is None or expectation_entry is None or None in cited_entries:
        return REFUSED_MALFORMED
    finding = {
        "id": f"{rule}:{file}:{start}-{end}",
        "rule": rule,
        "claim_type": contract.claim_type,
        "severity": contract.severity_cap,
        "path": file,
        "line": start,
        "end_line": end,
        "message": claim["claim"],
        "expected_behaviour": claim["expected_behaviour"],
        "expectation_ref": _ref_text(expectation_entry),
        "confidence": float(claim["confidence"]),
        "evidence": cited_entries,
        "quotes": {f"{file}:{start}": claim["quote"]},
    }
    if len(json.dumps(finding, sort_keys=True).encode("utf-8")) > TOOL_OUTPUT_FINDING_MAX_BYTES:
        return REFUSED_MALFORMED
    paths = {entry["path"] for entry in (*cited_entries, expectation_entry)} | {file}
    return _Sound(
        finding=finding, fingerprint=finding_fingerprint(TOOL_ID, finding), severity=contract.severity_cap,
        confidence=finding["confidence"], cited_paths=tuple(sorted(paths)), expectation=expectation_entry,
    )


def _screen_evidence(
    sound: _Sound, *, tool: dict[str, Any], workspace: Path, head: str, session: GitProbeSession,
) -> str | None:
    """``REFUSED_UNRESOLVED`` when the claim's evidence does not stand at ``head``; ``None`` when it does.

    The law is tier-0's, the gate the funnel runs on the same row later, so a claim refused here is one
    triage would refuse and a claim taken here is one it can read: every cited path and line exists in the
    commit and the quote is in the cited file's text there. A blank quote is no quote (``quote_matches_at``
    refuses it; tier-0 leaves an empty one to its submit door, which is this one). A path the tool may not
    read (``tool_health.find_scope_violations``: secrets, ``.git``) is refused before its bytes are
    touched, so a hostile claim cannot get the run quarantined for a read the claim asked for; the paths
    are the canonical ones ``_screen_shape`` took, the spelling git reads.
    A probe that could not run is no verdict about the claim: it raises, and the answer is bridged again.
    """
    finding = sound.finding
    (quote,) = finding["quotes"].values()
    if not quote.strip() or find_scope_violations(tool, list(sound.cited_paths)):
        return REFUSED_UNRESOLVED
    item = {
        "tool_id": TOOL_ID,
        "path": finding["path"],
        "evidence": [*finding["evidence"], {"path": finding["path"], "line": finding["end_line"]}, sound.expectation],
        "quotes": finding["quotes"],
    }
    verdict = tier0_gate(item, None, workspace, head, probe=session)
    if verdict["status"] == TIER0_REJECT:
        return REFUSED_UNRESOLVED
    if verdict["status"] != "pass" or verdict["note"] is not None:
        raise GovernanceError(
            f"change_review_evidence_unverified: {verdict['reason'] or verdict['note']} "
            f"(a probe that cannot run is no verdict; the answer is bridged again)"
        )
    return None


def _run_envelope(*, run_id: str, cycle_id: str, request_id: str, subject_ref: str, head: str, sound: list[_Sound]) -> dict[str, Any]:
    """The run of the tool: the answer's sound claims, nothing operator-facing, nothing spawned."""
    findings = [claim.finding for claim in sound]
    return {
        "schema_version": 1,
        "run_id": run_id,
        "tool_id": TOOL_ID,
        "cycle_id": cycle_id,
        "status": "ok",
        "input_hash": sha256_digest_of_canonical_json(
            {"request_id": request_id, "subject_ref": subject_ref, "target_sha": head},
        ),
        "output_hash": sha256_digest_of_canonical_json(findings),
        "read_paths": sorted({path for claim in sound for path in claim.cited_paths}),
        "emitted_observations": [],
        "emitted_findings": [],
        "raw_findings": findings,
        "evidence_validation": {"evidence_sources": [], "repository_mutation_attempt": False},
        "operator_feedback_refs": [],
        "duration_ms": 0,
        "cost_units": 0,
        "runner": {
            "type": AGENT_RUNNER_TYPE,
            "raw_findings_count": len(findings),
            "raw_observations_count": 0,
            "scoped_mutations": [],
            "scope_out_mutations": [],
        },
    }


def bridge_defect_claims(
    *,
    request: Mapping[str, Any],
    claims: Any,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Turn ``details.defect_claims`` of an accepted answer into raw rows; return what was done, as counts.

    Idempotent per request: the run is recorded once (its id is the request's), a refusal row is written
    once per claim position, and the funnel's rows are written once per claim, so a replay of the bridge
    (``bridge_status_ledger.replay_pending_bridges``) adds nothing and finishes what a stopped call left.
    A claim told twice in one answer is one hypothesis (one fingerprint). A claim the bridge refuses never
    aborts the answer; an answer the bridge cannot read at all is refused whole (``BridgeContractRefused``,
    the retry lane ends by name), and one it cannot verify yet raises ``GovernanceError`` and is bridged again.
    """
    request_id = str(request.get("request_id") or "")
    subject_ref, head, cycle_id = request.get("subject_ref"), request_anchor_sha(request), request.get("cycle_id")
    for name, value in (("request_id", request_id), ("subject_ref", subject_ref), ("target_sha", head), ("cycle_id", cycle_id)):
        if not _is_text(value):
            raise BridgeContractRefused(
                f"change_review_request_unanchored: the request carries no {name}; a claim is verified at the "
                "commit its request was minted at and recorded under the request's change and cycle"
            )
    if not isinstance(claims, list):
        raise BridgeContractRefused(f"supporting bridge expects response.details.{CLAIMS_KEY} to be a list")
    if len(claims) > MAX_CLAIMS_PER_ANSWER:
        raise BridgeContractRefused(
            f"change_review_claims_over_bound: {len(claims)} claims, at most {MAX_CLAIMS_PER_ANSWER} per answer"
        )
    root = ensure_tools_dir(base_dir)
    tool = get_tool(TOOL_ID, root)
    if tool["status"] == "QUARANTINED":
        # The runner refuses a quarantined tool its runs (tool_runner.run_tool); an answer is no way round it.
        raise GovernanceError(f"change_review_tool_quarantined: {TOOL_ID} takes no claims until it is released; the answer is bridged again")
    contracts = {rule: resolve_rule_contract(tool_id=TOOL_ID, rule=rule, base_dir=root) for rule in tool["rules"]}
    workspace, session = bound_workspace_root(root), GitProbeSession()
    sound: list[_Sound] = []
    refused = 0
    for index, claim in enumerate(claims):
        screened = _screen_shape(claim, contracts)
        if not isinstance(screened, str):
            screened = _screen_evidence(screened, tool=tool, workspace=workspace, head=head, session=session) or screened
        if isinstance(screened, str):
            refused += 1
            append_tools_governance_once(
                root, REFUSED_KIND,
                {"subject_ref": subject_ref, "request_id": request_id, "claim_index": index, "reason": screened},
                claim_keys=("subject_ref", "request_id", "claim_index"),
            )
        elif all(screened.fingerprint != taken.fingerprint for taken in sound):
            sound.append(screened)
    run_id = f"{TOOL_ID}:{request_id}"
    if not any(row.get("run_id") == run_id for row in read_runs_for_cycle(base_dir=root, cycle_uid=cycle_id)):
        record_run(
            _run_envelope(
                run_id=run_id, cycle_id=cycle_id, request_id=request_id, subject_ref=subject_ref, head=head, sound=sound,
            ),
            base_dir=root,
        )
    split = (
        admit_change_claims(
            subject_ref,
            [{"claim_id": claim.fingerprint, "severity": claim.severity, "confidence": claim.confidence} for claim in sound],
            base_dir=root,
        )
        if sound else {"admitted": [], "held": []}
    )
    return {
        "run_id": run_id, "raw": len(sound), "refused": refused,
        "admitted": len(split["admitted"]), "held": len(split["held"]),
    }


__all__ = [
    "CLAIMS_KEY",
    "CLAIM_FIELDS",
    "MANIFEST_RELPATH",
    "REFUSAL_REASONS",
    "REFUSED_KIND",
    "TOOL_ID",
    "bridge_defect_claims",
    "render_defect_claim_rules",
    "shipped_claim_families",
]
