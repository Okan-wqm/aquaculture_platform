"""The ONE ``must_satisfy`` item shape — minted, rendered and validated here.

WHY. ARIA-HIGH-104 (5): the kernel's envelope minters wrote obligations as
``{id, kind, description, ...}`` while ``agent_contract._ensure_must_satisfy``
— the request half of the ``aria/agent-request/v1`` contract — required
``{id, statement}``, a field no producer in this repository ever wrote. The
two could only agree on an envelope nobody minted, which is how the first
native implementer trial would have found its own envelope refused by its
own contract. A shape defined in two modules is two shapes; this module is
the one both sides import.

WHAT. An obligation is a JSON object carrying:

* ``id`` — non-empty, unique within the list; the key the agent's
  ``satisfaction_matrix[]`` answers by.
* ``description`` — non-empty prose stating what must hold, free of the
  banned gating phrases (the same list every agent contract is scanned for).
* ``kind`` — optional classifier (``converged_plan_authenticity``,
  ``plan_key_change``, ``validation_evidence``, ``waiver_adjudication`` …).
* any further keys — DATA the obligation carries for the agent to check
  against (a ``content_hash``, an ``allowed_scope``, a ``closure_manifest_hash``),
  preserved verbatim because the agent reads them.

``description`` is KERNEL-AUTHORED prose, always. The banned-phrase scan is
a rule over what the kernel asserts; the plan contract applies no such rule
to a plan body, and a CONVERGED plan whose key change named a file whose
name carries a banned word was refused at its implementation mint for a
word in a path (ARIA-HIGH-104 verifier). Text the kernel did not write — a
key change's wording, a waiver's claimed reason, the repository path of an
uncovered closure node, a spine comparison's measured identities, a
validation command the plan-contract gate refused — rides on the obligation
as DATA under its own key; the constructors below compose the description
themselves, so a producer has no parameter through which foreign text
reaches the scanned field. The round-2 re-verifier found the convergence
drainer's own carries (coverage, spine, plan-contract) quoting such text
INTO the description: an uncovered node whose file name carries a banned
word made the next round's primary envelope unmintable, the
``GovernanceError`` escaped the drainer, and the plan re-tripped every
cycle. Quoted data is never the kernel's assertion; the renderer prints it
under the bullet as a delimited, escaped JSON block
(``agent_invocations._render_obligation_data``).

:func:`must_satisfy_item` is the constructor every kernel minter builds
through; :func:`validate_must_satisfy` is the one validator the request
contract and the queue's mint both call; :func:`must_satisfy_text` is the
one read the prompt renderer makes.
"""
from __future__ import annotations

import re
from typing import Any

from .draft_intent import BANNED_PHRASES_DEFAULT
from .tool_registry import GovernanceError

MUST_SATISFY_ID_FIELD = "id"
MUST_SATISFY_TEXT_FIELD = "description"
MUST_SATISFY_KIND_FIELD = "kind"
# Data keys under which text the kernel did not write rides on an obligation.
PLAN_TEXT_FIELD = "plan_description"
CLAIMED_REASON_FIELD = "claimed_reason"
KEY_CHANGE_KIND = "plan_key_change"
WAIVER_ADJUDICATION_KIND = "waiver_adjudication"
# The convergence drainer's carried obligations — measured facts the next
# round's primary must answer; each carries its measurement as data.
COVERAGE_GAP_KIND = "coverage_gap"
ARCHITECTURE_SPINE_KIND = "architecture_spine_regression"
PLAN_CONTRACT_VIOLATION_KIND = "plan_contract_violation"
# A plan-contract reason code is a token of the kernel's own vocabulary
# (``plan_contract.PLAN_CONTRACT_REASONS`` and the gate's ``plan_body_unavailable``),
# never prose: the constructor holds the parameter to that shape so the one
# kernel token that does reach the description cannot smuggle a sentence.
_REASON_CODE_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# The spelling the judge lanes minted the obligation text under before this
# module existed (``{"id", "criterion"}``). The prompt hash of every request
# sealed then was minted over the rendered ``criterion`` text, and the claim
# path re-renders the stored row to verify that hash — so the RENDERER keeps
# reading the sealed spelling, exactly as ``prompt_render_version`` keeps the
# untagged v1 layout for rows sealed under it. No fresh row can carry it:
# ``validate_must_satisfy`` refuses an item without ``description`` and the
# queue's mint runs that validator on every request it appends.
SEALED_LEGACY_TEXT_FIELD = "criterion"


def must_satisfy_item(
    *,
    id: str,
    description: str,
    kind: str | None = None,
    **data: Any,
) -> dict[str, Any]:
    """Build one obligation in the canonical shape.

    Keyword-only so a call site cannot transpose id and description; the
    ``data`` keys ride along unchanged. The result is validated as a
    one-item list so a minter cannot construct an item the contract refuses.
    """
    # The three named parameters cannot also arrive in ``data`` — Python
    # refuses a duplicated keyword at the call — so the reserved keys are
    # structurally the constructor's own.
    item: dict[str, Any] = {MUST_SATISFY_ID_FIELD: id, MUST_SATISFY_TEXT_FIELD: description}
    if kind is not None:
        item[MUST_SATISFY_KIND_FIELD] = kind
    item.update(data)
    return validate_must_satisfy([item])[0]


def key_change_obligation(
    *,
    id: str,
    index: int,
    plan_description: str,
    paths: list[str],
    key_change_id: str | None = None,
    **data: Any,
) -> dict[str, Any]:
    """The obligation for one ``key_changes[]`` entry of a plan body.

    The description names the entry by its position in the CONVERGED body
    and tells the agent where the plan's own wording and files are; the
    wording itself (``plan_description``), the plan's id for the entry
    (``key_change_id``) and its ``paths`` are data. Nothing a planner wrote
    reaches the scanned field, whatever it says. A string step declares no
    paths; its obligation is bounded by the request's ``allowed_scope``.
    """
    where = (
        "touching only the files listed under `paths`" if paths
        else "within this request's `allowed_scope`"
    )
    return must_satisfy_item(
        id=id,
        kind=KEY_CHANGE_KIND,
        description=(
            f"Apply key_changes[{index}] of the CONVERGED plan exactly as this obligation's "
            f"`{PLAN_TEXT_FIELD}` states it, {where}."
        ),
        **{PLAN_TEXT_FIELD: plan_description, "key_change_id": key_change_id, "paths": list(paths)},
        **data,
    )


def waiver_adjudication_obligation(
    *, id: str, node_id: str, claimed_reason: Any, **data: Any,
) -> dict[str, Any]:
    """The obligation for one closure-manifest waiver the critic adjudicates.

    The node and the waiver's reason are agent-authored; both ride as data
    (``node_id``, ``claimed_reason``) so a waiver worded with a banned phrase
    is adjudicated — refused on its merits — rather than making the critic
    envelope itself unmintable.
    """
    return must_satisfy_item(
        id=id,
        kind=WAIVER_ADJUDICATION_KIND,
        description=(
            "Adjudicate the waiver on the closure node named by this obligation's `node_id`: "
            f"uphold it only on evidence in the closure manifest and the repository; its "
            f"`{CLAIMED_REASON_FIELD}` is the waiver's own claim, not evidence."
        ),
        **{"node_id": node_id, CLAIMED_REASON_FIELD: claimed_reason},
        **data,
    )


def coverage_gap_obligation(*, node_id: str, why: str, **data: Any) -> dict[str, Any]:
    """The obligation for one impact-closure node the coverage witness left uncovered.

    ``node_id`` is a repository path or project id and ``why`` the witness's
    (or, after a rejected waiver, the critic's) reason — measured and
    agent-authored text, never the kernel's — so both ride as data. The id
    keys the node so the same gap re-detected next round folds onto one
    obligation.
    """
    return must_satisfy_item(
        id=f"coverage:{node_id}",
        kind=COVERAGE_GAP_KIND,
        description=(
            "Cover the impact-closure node named by this obligation's `node_id`: widen "
            "affected_surfaces to address it, or add a coverage.waivers entry {node, reason}; "
            "its `why` is the coverage witness's reason the node is uncovered."
        ),
        **{"node_id": node_id, "why": why},
        **data,
    )


def architecture_spine_obligation(*, spine: dict[str, Any], **data: Any) -> dict[str, Any]:
    """The obligation for a native architecture-spine regression the plan must repair.

    ``spine`` is the comparison descriptor ``evaluate_plan`` captured
    (``architecture_spine_gate._plan_comparison_obligation``): its regressions
    carry measured identities — file paths and symbol names from the
    workspace — so the whole descriptor rides as data under ``spine`` and the
    id binds it to the postcheck ledger row it was read from.
    """
    ledger_hash = spine.get("postcheck_ledger_hash")
    if not isinstance(ledger_hash, str) or not ledger_hash:
        raise GovernanceError("architecture_spine_obligation requires spine.postcheck_ledger_hash")
    return must_satisfy_item(
        id="architecture_spine:" + ledger_hash,
        kind=ARCHITECTURE_SPINE_KIND,
        description=(
            "Resolve the native architecture-spine comparison carried under this obligation's "
            "`spine`: repair every entry of its `regressions` so the next postcheck against "
            "`baseline_hash` measures none."
        ),
        **{"spine": spine},
        **data,
    )


def plan_contract_obligation(
    *, reason_code: str, refused_entries: list[str], **data: Any,
) -> dict[str, Any]:
    """The obligation for one plan-contract reason code the gate recorded.

    The reason code is the kernel's own token and names the obligation; the
    ``refused_entries`` — the plan's ``validation_commands[].cmd`` text or
    the entry the gate could not read, LLM-authored from round two on —
    ride as data, so a command spelled with a banned phrase is carried to
    the primary as the thing to fix rather than making the envelope
    unmintable.
    """
    if not isinstance(reason_code, str) or _REASON_CODE_RE.match(reason_code) is None:
        raise GovernanceError(f"plan_contract_obligation reason_code must be a kernel token: {reason_code!r}")
    return must_satisfy_item(
        id="plan_contract:" + reason_code,
        kind=PLAN_CONTRACT_VIOLATION_KIND,
        description=(
            f"{reason_code} — make plan_content satisfy the Plan contract section of this "
            "request (architectural_tier claim; validation_commands from the admissible set); "
            "the entries the gate refused ride under this obligation's `refused_entries`."
        ),
        **{"reason_code": reason_code, "refused_entries": list(refused_entries)},
        **data,
    )


def upcast_sealed_items(items: Any, *, field: str = "must_satisfy") -> list[dict[str, Any]]:
    """The obligations of a SEALED row in the canonical shape, for a re-mint.

    A row sealed before this module carries ``{id, criterion}``; a fresh mint
    refuses that spelling (``validate_must_satisfy``), so a producer that
    re-mints a dead request by copying its obligations verbatim — the
    HUMAN_REQUIRED panel's ``re_mint`` disposition — refused every legacy
    row and the escalation never resolved (ARIA-HIGH-104 round-2 verifier).
    The sealed text moves under ``description``, the legacy key is dropped,
    and the result is validated: the successor is the one shape while the
    dead row's own bytes (and the prompt hash sealed over them) are untouched.
    """
    if not isinstance(items, list):
        raise GovernanceError(f"{field} must be a list")
    upcast: list[Any] = []
    for raw in items:
        if (
            isinstance(raw, dict)
            and MUST_SATISFY_TEXT_FIELD not in raw
            and isinstance(raw.get(SEALED_LEGACY_TEXT_FIELD), str)
        ):
            item = {key: value for key, value in raw.items() if key != SEALED_LEGACY_TEXT_FIELD}
            item[MUST_SATISFY_TEXT_FIELD] = raw[SEALED_LEGACY_TEXT_FIELD]
            upcast.append(item)
        else:
            upcast.append(raw)
    return validate_must_satisfy(upcast, field=field)


def _check_banned_phrases(text: str, *, field: str) -> None:
    lowered = text.lower()
    for phrase in BANNED_PHRASES_DEFAULT:
        if phrase in lowered:
            raise GovernanceError(f"{field} contains banned phrase '{phrase}': {text[:120]!r}")


def validate_must_satisfy(items: Any, *, field: str = "must_satisfy") -> list[dict[str, Any]]:
    """The one validator: a non-empty list of canonical obligations.

    Returns copies of the items (every key preserved) so a caller that
    stores the validated list stores what the agent will read.
    """
    if not isinstance(items, list) or not items:
        raise GovernanceError(f"{field} must be a non-empty list")
    cleaned: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, raw in enumerate(items):
        if not isinstance(raw, dict):
            raise GovernanceError(f"{field}[{idx}] must be an object")
        item_id = raw.get(MUST_SATISFY_ID_FIELD)
        if not isinstance(item_id, str) or not item_id.strip():
            raise GovernanceError(f"{field}[{idx}].{MUST_SATISFY_ID_FIELD} is required")
        if item_id in seen_ids:
            raise GovernanceError(f"{field}[{idx}].{MUST_SATISFY_ID_FIELD} duplicate: {item_id}")
        seen_ids.add(item_id)
        text = raw.get(MUST_SATISFY_TEXT_FIELD)
        if not isinstance(text, str) or not text.strip():
            raise GovernanceError(
                f"{field}[{idx}].{MUST_SATISFY_TEXT_FIELD} is required (id={item_id!r}); "
                f"the obligation text lives under {MUST_SATISFY_TEXT_FIELD!r} and nowhere else"
            )
        _check_banned_phrases(text, field=f"{field}[{item_id}].{MUST_SATISFY_TEXT_FIELD}")
        kind = raw.get(MUST_SATISFY_KIND_FIELD)
        if kind is not None and (not isinstance(kind, str) or not kind.strip()):
            raise GovernanceError(f"{field}[{idx}].{MUST_SATISFY_KIND_FIELD} must be a non-empty string when present")
        cleaned.append(dict(raw))
    return cleaned


def must_satisfy_text(item: Any) -> str:
    """The obligation text the prompt prints for one item.

    Canonical field first; the sealed legacy spelling only for rows minted
    before this module (see ``SEALED_LEGACY_TEXT_FIELD``).
    """
    if not isinstance(item, dict):
        return ""
    text = item.get(MUST_SATISFY_TEXT_FIELD)
    if isinstance(text, str) and text:
        return text
    legacy = item.get(SEALED_LEGACY_TEXT_FIELD)
    return legacy if isinstance(legacy, str) else ""


__all__ = [
    "ARCHITECTURE_SPINE_KIND",
    "CLAIMED_REASON_FIELD",
    "COVERAGE_GAP_KIND",
    "KEY_CHANGE_KIND",
    "MUST_SATISFY_ID_FIELD",
    "MUST_SATISFY_KIND_FIELD",
    "MUST_SATISFY_TEXT_FIELD",
    "PLAN_CONTRACT_VIOLATION_KIND",
    "PLAN_TEXT_FIELD",
    "SEALED_LEGACY_TEXT_FIELD",
    "WAIVER_ADJUDICATION_KIND",
    "architecture_spine_obligation",
    "coverage_gap_obligation",
    "key_change_obligation",
    "must_satisfy_item",
    "must_satisfy_text",
    "plan_contract_obligation",
    "upcast_sealed_items",
    "validate_must_satisfy",
    "waiver_adjudication_obligation",
]
