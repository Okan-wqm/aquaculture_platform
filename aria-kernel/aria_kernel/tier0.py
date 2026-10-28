"""WP-J slice A — tier-0: the mechanical, zero-LLM gate before any paid seat.

THE SEAM (slice C calls, slice A owns). ``rule_contract`` names this module
as the minter of ``CLAIM_NOT_FALSIFIABLE`` (MEASURE mode first: a governance
row per refusal through the judgment funnel, never yet a hard enforcement).
Slice C's judgment funnel calls ``tier0_gate`` for every sampled finding
BEFORE any mint and early-stops on a reject.

TRI-STATE LAW (the ``evidence_trust._git_blob_matches`` rule): a probe that
could not run is NOT a verdict. No anchor, no repository, or a git that
does not answer means the item PASSES with a note — unknown is never green,
but it is also never a refusal; the paid tiers still verify.

THE FULL LAW (each check named, each refusal closed-vocabulary):

1. Falsifiability — a contract that declares no ``observable``, for an item
   that carries no reproduction recipe, is refused ``CLAIM_NOT_FALSIFIABLE``
   (the ``rule_contract`` constant; one owner). ``contract=None`` is NOT a
   refusal here: the no-contract refusal already has owners (the judge
   fan-out and the promotion gate refuse a finding whose rule states no
   product claim), and a second copy of that rule is exactly what WP-J
   forbids. The funnel passes ``None`` until it resolves contracts itself.
2. Fingerprint dedup — the item's ``finding_fingerprint`` (ONE owner:
   ``feedback_store.finding_fingerprint``) against a caller-supplied
   seen-set: a duplicate asks for a second judgment of one claim.
3. Refs resolve at the SHA — every cited path (and, when a line is named,
   that line within the blob) must exist in the committed tree the judges
   would be anchored to; ``git show`` returning empty for the path is the
   named refusal slice C pinned first, a line past EOF is
   ``tier0_ref_line_out_of_range``.
4. Quotes byte-match — ``evidence_trust.quote_matches_at`` is THE law. With
   pinned excerpts (the mint's ``evidence_excerpts`` rows): a skip entry is
   the NAMED stale refusal ``tier0_quote_stale_excerpt`` (the mint could not
   read those bytes), no row for the ref is ``tier0_quote_unpinned``, bytes
   that do not contain the quote are ``tier0_quote_mismatch``. Without
   pinned excerpts the quote is checked against the cited line's window in
   the blob at the SHA.
5. Static premise checks — the contract's per-family observable
   (``rule_contract.RULE_CONTRACT_OBSERVABLE_KINDS``):
   ``cited_line_bytes_at_sha`` requires pinned bytes for every cited ref
   (``tier0_quote_required`` otherwise); ``referenced_path_absent_at_sha``
   resolves the path the finding's id names (the doc-staleness id contract,
   last ``:``-separated segment) and REFUTES the claim for free when the
   path exists at the SHA (``tier0_observable_premise_violated``).

Zero mints by construction: the gate is read-only over the repository and
writes nothing — no ledger row, no governance row, no file. Its callers
record what they refuse.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

TIER0_PASS = "pass"
TIER0_REJECT = "reject"

# Named refusals. Every reject carries one of these, verbatim, onto the
# governance row and the routing row — an unnamed rejection is
# indistinguishable from a dropped one. The two slice-C names keep their
# spelling; the rest are the slice-A law.
REJECT_CITED_PATH_ABSENT = "cited_path_absent_at_target_sha"
REJECT_EVIDENCE_REF_ABSENT = "evidence_ref_absent_at_target_sha"

from .rule_contract import CLAIM_NOT_FALSIFIABLE  # noqa: E402 — one owner, named above

TIER0_REFUSAL_REASONS: tuple[str, ...] = (
    CLAIM_NOT_FALSIFIABLE,
    REJECT_CITED_PATH_ABSENT,
    REJECT_EVIDENCE_REF_ABSENT,
    "tier0_fingerprint_duplicate",
    "tier0_ref_line_out_of_range",
    "tier0_quote_required",
    "tier0_quote_unpinned",
    "tier0_quote_stale_excerpt",
    "tier0_quote_mismatch",
    "tier0_observable_subject_unreadable",
    "tier0_observable_premise_violated",
)

# The note a pass carries when nothing could be checked (tri-state law).
NOTE_NO_ANCHOR = "tier0_unverified_no_anchor"
NOTE_GIT_UNAVAILABLE = "tier0_unverified_git_unavailable"

# F0.3 landing (N2) — the gate could not COMPUTE a verdict for the item.
# Neither a refusal of the claim (``TIER0_REFUSAL_REASONS``: the claim's own
# citations failed) nor the tri-state pass note (the probe could not run, the
# paid tiers still verify): an item whose identity the ONE fingerprint owner
# cannot derive has nothing the dedup, the verdict cache or the routing rows
# can key on, and a gate that crashed decided nothing. Either is HELD under
# its own name — never a second, hand-made identity, never a pass.
TIER0_FAILED = "failed"
TIER0_FINGERPRINT_UNCOMPUTABLE = "tier0_fingerprint_uncomputable"
TIER0_GATE_CRASHED = "tier0_gate_crashed"
TIER0_FAILURE_REASONS: tuple[str, ...] = (TIER0_FINGERPRINT_UNCOMPUTABLE, TIER0_GATE_CRASHED)


def _reject(reason: str, note: str | None, fingerprint: str, checks: list[str]) -> dict[str, Any]:
    return {
        "status": TIER0_REJECT, "reason": reason, "note": note,
        "fingerprint": fingerprint, "checks": list(checks),
    }


def _pass(note: str | None, fingerprint: str, checks: list[str]) -> dict[str, Any]:
    return {
        "status": TIER0_PASS, "reason": None, "note": note,
        "fingerprint": fingerprint, "checks": list(checks),
    }


def tier0_failure(reason: str, note: str | None, checks: Sequence[str] = ()) -> dict[str, Any]:
    """The verdict shape for a gate that could not compute (F0.3 N2).

    One constructor for both failure names, so the funnel's crash record and
    the gate's own uncomputable-identity record cannot drift apart. Carries
    no fingerprint: the ONE owner produced none, and no other identity is
    made up in its place.
    """
    if reason not in TIER0_FAILURE_REASONS:
        raise ValueError(f"unknown tier0 failure reason: {reason!r}")
    return {
        "status": TIER0_FAILED, "reason": reason, "note": note,
        "fingerprint": "", "checks": list(checks),
    }


def _item_fingerprint(item: Mapping[str, Any], contract: Any) -> str:
    """The item's finding fingerprint, from its ONE owner.

    ``feedback_store.finding_fingerprint`` reads rule/path/evidence/message
    off the finding dict and is the same fingerprint the sampler and the
    re-mint derive. Its failures are the caller's to NAME (``tier0_gate``
    records ``TIER0_FINGERPRINT_UNCOMPUTABLE``); there is no second identity.
    """
    from .feedback_store import finding_fingerprint

    tool_id = str(item.get("tool_id") or (getattr(contract, "tool_id", "") or ""))
    return finding_fingerprint(tool_id, dict(item))


def _item_recipe(item: Mapping[str, Any]) -> bool:
    """Does the item carry a reproduction recipe binding?"""
    reproduction = item.get("reproduction")
    if isinstance(reproduction, Mapping) and str(reproduction.get("recipe_id") or "").strip():
        return True
    return bool(str(item.get("recipe_id") or "").strip())


def _ref_path_and_line(ref: str) -> tuple[str, int | None]:
    from .evidence_trust import parse_evidence_ref

    parsed = parse_evidence_ref(ref)
    if parsed is None:
        return ref, None
    return parsed


def _pinned_rows_for(
    ref_path: str, pinned_excerpts: Sequence[Mapping[str, Any]] | None,
) -> list[Mapping[str, Any]]:
    return [row for row in (pinned_excerpts or ()) if str(row.get("path") or "") == ref_path]


def _quote_in_window(quote: str, blob_text: str, line: int | None) -> bool:
    """The quote law against the cited line's window in the blob.

    The window is the excerpt packer's radius (``evidence_excerpts``), so a
    quote the mint would have pinned is exactly a quote this admits.
    """
    from .evidence_excerpts import DEFAULT_LINE_RADIUS
    from .evidence_trust import quote_matches_at

    lines = blob_text.splitlines(keepends=True)
    if line is None:
        return quote_matches_at(quote, excerpt_content=blob_text) is True
    if not 1 <= line <= len(lines):
        return False
    start = max(1, line - DEFAULT_LINE_RADIUS)
    end = min(len(lines), line + DEFAULT_LINE_RADIUS)
    window = "".join(lines[start - 1:end])
    return quote_matches_at(quote, excerpt_content=window) is True


def tier0_gate(
    item: dict[str, Any],
    contract: Any,
    repo_root: str | Path | None,
    target_sha: str | None,
    *,
    probe: Any = None,
    seen_fingerprints: Iterable[str] = (),
    pinned_excerpts: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Pure mechanical verdict for one sampled finding. Zero LLM calls.

    Returns ``{"status": "pass"|"reject"|"failed", "reason": str|None,
    "note": str|None, "fingerprint": str, "checks": [str, ...]}``. A reject
    means the claim's own citations, quotes or declared observable fail
    against the tree the judges would be anchored to — the funnel refuses to
    pay for judging it (and records the named refusal). ``failed`` means the
    gate could not compute (``TIER0_FAILURE_REASONS``): the funnel holds the
    item by that name. Writes nothing.
    """
    checks: list[str] = []
    if not isinstance(item, Mapping):
        return _pass("tier0_item_unreadable", "", checks)
    try:
        fingerprint = _item_fingerprint(item, contract)
    except (TypeError, ValueError) as exc:
        # The owner's canonical encoding refuses this item's shape
        # (json.dumps: TypeError for an unencodable value, ValueError for a
        # circular one). Named and held (F0.3 N2), never re-identified.
        return tier0_failure(
            TIER0_FINGERPRINT_UNCOMPUTABLE, f"{type(exc).__name__}: {exc}"[:300], checks,
        )

    # 1. Falsifiability (needs no repository): a contract that states no
    # observable, for an item with no recipe, states nothing a mechanical
    # or executable check can ever refute.
    observable = getattr(contract, "observable", None)
    if observable is not None:
        checks.append("falsifiable:observable")
    elif _item_recipe(item):
        checks.append("falsifiable:recipe")
    elif contract is not None:
        return _reject(CLAIM_NOT_FALSIFIABLE, "neither observable nor recipe", fingerprint, checks)

    # 2. Fingerprint dedup against the caller's seen-set.
    if fingerprint and fingerprint in set(seen_fingerprints or ()):
        return _reject("tier0_fingerprint_duplicate", fingerprint, fingerprint, checks)

    # Tri-state: no anchor to verify against is NOT a verdict.
    if not isinstance(repo_root, (str, Path)) or not str(repo_root).strip():
        return _pass(NOTE_NO_ANCHOR, fingerprint, checks)
    if not isinstance(target_sha, str) or not target_sha.strip():
        return _pass(NOTE_NO_ANCHOR, fingerprint, checks)

    from .evidence_probe import GitProbeSession
    from .item_citations import CITED_PATH, item_cited_refs

    session = probe if probe is not None else GitProbeSession()
    root = Path(repo_root)

    # 3. Refs resolve at the SHA (path and, when named, line).
    refs = item_cited_refs(item)
    blobs: dict[str, str] = {}
    for kind, ref in refs:
        rel, line = _ref_path_and_line(ref)
        outcome = session.run(["git", "show", f"{target_sha}:{rel}"], cwd=root)
        if not outcome.answered:
            # One silent git is no verdict for the whole batch (tri-state).
            return _pass(NOTE_GIT_UNAVAILABLE, fingerprint, checks)
        if outcome.returncode != 0:
            return _reject(
                REJECT_CITED_PATH_ABSENT if kind == CITED_PATH else REJECT_EVIDENCE_REF_ABSENT,
                f"{rel}@{target_sha[:12]}", fingerprint, checks,
            )
        text = outcome.stdout.decode("utf-8", errors="replace")
        blobs[rel] = text
        if line is not None and not 1 <= line <= len(text.splitlines()):
            return _reject(
                "tier0_ref_line_out_of_range",
                f"{rel}:{line} past EOF at {target_sha[:12]}", fingerprint, checks,
            )
    checks.append(f"refs_resolve_at:{target_sha[:12]}")

    # 4. Quotes byte-match (THE law: evidence_trust.quote_matches_at).
    quotes = item.get("quotes") if isinstance(item.get("quotes"), Mapping) else {}
    for ref, quote in quotes.items():
        rel, line = _ref_path_and_line(str(ref))
        if not isinstance(quote, str) or not quote.strip():
            continue  # an empty quote is the untyped submit's refusal, not tier-0's
        rows = _pinned_rows_for(rel, pinned_excerpts)
        if pinned_excerpts is not None and not rows:
            return _reject("tier0_quote_unpinned", str(ref), fingerprint, checks)
        skipped = [str(row.get("skipped")) for row in rows if row.get("skipped")]
        if skipped:
            return _reject(
                "tier0_quote_stale_excerpt", ", ".join(sorted(set(skipped))), fingerprint, checks,
            )
        if rows:
            from .evidence_trust import quote_matches_at

            if not any(
                quote_matches_at(quote, excerpt_content=str(row.get("content") or "")) is True
                for row in rows
            ):
                return _reject("tier0_quote_mismatch", str(ref), fingerprint, checks)
        else:
            blob_text = blobs.get(rel)
            if blob_text is None:
                outcome = session.run(["git", "show", f"{target_sha}:{rel}"], cwd=root)
                if not outcome.answered:
                    return _pass(NOTE_GIT_UNAVAILABLE, fingerprint, checks)
                if outcome.returncode != 0:
                    return _reject(REJECT_EVIDENCE_REF_ABSENT, str(ref), fingerprint, checks)
                blob_text = outcome.stdout.decode("utf-8", errors="replace")
            if not _quote_in_window(quote, blob_text, line):
                return _reject("tier0_quote_mismatch", str(ref), fingerprint, checks)
        checks.append(f"quote_matches:{rel}")

    # 5. Static premise checks — the contract's per-family observable.
    if observable == "cited_line_bytes_at_sha":
        for _kind, ref in refs:
            rel, _line = _ref_path_and_line(ref)
            has_quote = any(_ref_path_and_line(str(qr))[0] == rel for qr in quotes)
            rows = _pinned_rows_for(rel, pinned_excerpts)
            if has_quote:
                continue
            if pinned_excerpts is not None and not rows:
                return _reject("tier0_quote_required", rel, fingerprint, checks)
            if rows and any(row.get("skipped") for row in rows):
                skipped = sorted({str(row.get("skipped")) for row in rows if row.get("skipped")})
                return _reject("tier0_quote_stale_excerpt", ", ".join(skipped), fingerprint, checks)
            if rows:
                continue  # the mint pinned bytes; step 4 checked any explicit quote
            return _reject("tier0_quote_required", rel, fingerprint, checks)
    elif observable == "referenced_path_absent_at_sha":
        subject = str(item.get("id") or item.get("finding_id") or "")
        segments = subject.split(":")
        if len(segments) < 2 or not segments[-1].strip():
            return _reject(
                "tier0_observable_subject_unreadable", subject, fingerprint, checks,
            )
        referenced = segments[-1].strip()
        outcome = session.run(["git", "cat-file", "-e", f"{target_sha}:{referenced}"], cwd=root)
        if not outcome.answered:
            return _pass(NOTE_GIT_UNAVAILABLE, fingerprint, checks)
        if outcome.returncode == 0:
            return _reject(
                "tier0_observable_premise_violated",
                f"{referenced} exists at {target_sha[:12]}", fingerprint, checks,
            )
        checks.append(f"referenced_path_absent:{referenced}")

    return _pass(None, fingerprint, checks)


__all__ = [
    "NOTE_GIT_UNAVAILABLE",
    "NOTE_NO_ANCHOR",
    "REJECT_CITED_PATH_ABSENT",
    "REJECT_EVIDENCE_REF_ABSENT",
    "TIER0_FAILED",
    "TIER0_FAILURE_REASONS",
    "TIER0_FINGERPRINT_UNCOMPUTABLE",
    "TIER0_GATE_CRASHED",
    "TIER0_PASS",
    "TIER0_REJECT",
    "TIER0_REFUSAL_REASONS",
    "tier0_failure",
    "tier0_gate",
]
