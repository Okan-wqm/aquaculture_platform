"""Plan ARIA-V3 §A3 + §2a — grammar validator for drafter bodies.

The kernel emits a structured ``DraftIntent`` (grammar) and delegates
body synthesis to ``tools/aria-poc/worker_executor.py`` (which spawns
``claude code agent --subagent-type aria-drafter``). On return, this
validator gates whether the body is acceptable BEFORE it reaches
``materialize_*``.

Five validation classes (each Tier-1 / Tier-2 architectural):

1. **Section presence** (I-V3-07a/b lock the required-sections list) —
   every section name in ``intent.required_sections`` must appear as
   a markdown header. Missing section → rejection.
2. **Banned-phrase scan** (I-V3-08) — body must contain ZERO entries
   from ``intent.banned_phrases``. Mirrors the CLAUDE.md banned list
   so the drafter cannot ship "for now" / "interim" / "deferred"
   etc. as gating excuses.
3. **Evidence ref allowlist** (I-V3-09) — every ``evidence_refs``
   citation in the body must appear in ``intent.evidence_allowlist``.
   The drafter cannot invent external paths.
4. **Diff classifier lane** (I-V3-10) — the target path the draft
   produces (intent.target_path) plus any path the body declares to
   modify must classify under the intent's lane via the SSoT
   ``auto_action_policy.json`` exclusion list (single source shared
   with ``auto_merge.evaluate_auto_merge`` — CRIT-V3-003 fix).
5. **PII-leak check** (I-V3-13b) — the body must NOT contain
   raw PII shapes (email / phone / SSN). The kernel pre-masks the
   intent (via ``draft_pii_filter``) but the drafter might be
   tempted to fabricate a plausible email. Reject if the regex
   matches a non-masked form.

The result is a structured :class:`ValidationResult` with a
list of complaint strings. On failure the dispatcher requeues
the work with the complaint as additional context (I-V3-11) up
to N attempts; escalation after N (I-V3-13).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .draft_intent import AgentDraftIntent, SkillDraftIntent
from .draft_pii_filter import _EMAIL_RE, _PHONE_RE, _SSN_RE


_SECTION_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_EVIDENCE_REF_RE = re.compile(
    r'(?:evidence_refs?|"evidence_refs?"\s*:)\s*[:=]?\s*'
    r'\[?\s*["\']([^"\']+)["\']',
)


@dataclass(frozen=True)
class ValidationResult:
    """Plan ARIA-V3 §A3 — structured validator output.

    ``valid=True`` means every check passed and the body is safe to
    materialize. ``valid=False`` means at least one complaint;
    ``complaints`` is the operator-readable list (one per check).
    """

    valid: bool
    complaints: tuple[str, ...] = field(default_factory=tuple)


def _l3_exclusion_globs(policy_path: Path) -> tuple[str, ...]:
    """Read the single-SSoT auto_action_policy.json (Plan ARIA-V3 §A0
    + §2a) and return its L3 exclusion glob list. Caller owns the
    fnmatch interpretation.
    """
    data = json.loads(policy_path.read_text(encoding="utf-8"))
    raw = data.get("l3_lane_exclusion_globs") or []
    return tuple(str(g) for g in raw)


def _path_matches_glob(rel_path: str, glob: str) -> bool:
    """fnmatch-style match with ``/`` separator. Mirrors the
    ``auto_action_policy.json`` doc note semantics.
    """
    import fnmatch
    return fnmatch.fnmatch(rel_path, glob) or fnmatch.fnmatch(
        rel_path, glob.lstrip("/"),
    )


def _scan_sections(body: str) -> set[str]:
    """Return the set of normalised section header titles found in
    the body. Header level is ignored (any `#`-prefix counts).
    """
    out: set[str] = set()
    for match in _SECTION_HEADER_RE.finditer(body):
        title = match.group(2).strip()
        if title:
            out.add(title)
    return out


def _scan_evidence_refs(body: str) -> set[str]:
    """Extract evidence_refs entries declared in the body. Conservative
    regex — matches the canonical Frontmatter pattern + JSON-quoted
    list. Misses are interpreted as "no refs declared" which still
    fails the allowlist subset check correctly (empty set IS a
    subset of any allowlist).
    """
    return {match.group(1) for match in _EVIDENCE_REF_RE.finditer(body)}


def _scan_target_paths_in_body(body: str) -> set[str]:
    """Find every repo-relative path the body mentions as a write
    target. Heuristic: paths in backticks under a section named
    ``## Target paths`` or ``## Writes to``. False positives are
    OK (better-safe-than-sorry); false negatives are bug-class so
    the regex is liberal.
    """
    out: set[str] = set()
    # Anything in single-backticks that looks like a repo path.
    for match in re.finditer(r"`([a-zA-Z0-9._/\-*]+\.[a-zA-Z]+)`", body):
        out.add(match.group(1))
    return out


def _scan_banned_phrases(body: str, banned: tuple[str, ...]) -> list[str]:
    """Case-insensitive substring scan; returns the matched phrases
    in the order they first appear (deterministic for replay).
    """
    found: list[str] = []
    lowered = body.lower()
    for phrase in banned:
        if phrase.lower() in lowered:
            found.append(phrase)
    return found


def _scan_pii_in_body(body: str) -> list[str]:
    """Return matched PII tokens (email / phone / SSN). An empty
    list means the body is clean. Hits use the same regexes as
    ``draft_pii_filter`` so an intent that was pre-masked stays
    masked in the body (drafter is not allowed to "rehydrate"
    redacted values).
    """
    hits: list[str] = []
    for kind, regex in (
        ("email", _EMAIL_RE),
        ("phone", _PHONE_RE),
        ("ssn", _SSN_RE),
    ):
        for m in regex.finditer(body):
            # Allow already-masked tokens like ``<pii:email:7e4b...>``
            # which trivially won't match the original PII regexes,
            # but defensively skip any match that looks like our
            # own token.
            value = m.group(0)
            if value.startswith("<pii:") and value.endswith(">"):
                continue
            hits.append(f"{kind}:{value}")
    return hits


# K6 (ORPHAN-MEDIUM-287) — the drafter's refusal wire format. aria-drafter
# writes the literal ``DRAFTER_REFUSAL:<reason_code>`` to --output-path when
# an intent cannot be satisfied (I-V3-00a contract). Before K6 no consumer
# parsed the sentinel: a deterministic refusal fell through the grammar
# complaints as required_sections_missing and burned the full retry budget.
DRAFTER_REFUSAL_PREFIX = "DRAFTER_REFUSAL:"
DRAFTER_REFUSAL_REASON_CODES: frozenset[str] = frozenset({
    "intent_underspecified",
    "evidence_allowlist_empty",
    "acceptance_tests_uninterpretable",
    "intent_kind_unrecognized",
    "target_path_violates_lane",
})
# reason_code -> aria/agent-refusal/v1 reason_class mapping (agent_contract).
DRAFTER_REFUSAL_CLASS_BY_CODE: dict[str, str] = {
    "intent_underspecified": "evidence",
    "evidence_allowlist_empty": "evidence",
    "acceptance_tests_uninterpretable": "evidence",
    "intent_kind_unrecognized": "law",
    "target_path_violates_lane": "scope",
}


def parse_drafter_refusal(body: str) -> str | None:
    """Return the refusal reason_code when ``body`` is a drafter refusal
    sentinel, else None. Unknown codes return the raw code (callers decide);
    a refusal is only recognized when the sentinel is the entire non-blank
    body — an embedded mention inside a real draft is draft content."""
    stripped = (body or "").strip()
    if not stripped.startswith(DRAFTER_REFUSAL_PREFIX):
        return None
    if "\n" in stripped.strip():
        return None
    return stripped[len(DRAFTER_REFUSAL_PREFIX):].strip()


def validate_body_against_intent(
    body: str,
    intent: AgentDraftIntent | SkillDraftIntent,
    *,
    auto_action_policy_path: Path | str,
) -> ValidationResult:
    """Plan ARIA-V3 §A3 — single entry point.

    Runs all five validation classes and returns a structured result.
    ``auto_action_policy_path`` MUST point at
    ``aria-kernel/aria_kernel/data/auto_action_policy.json`` (Plan
    ARIA-V3 §A0 SSoT). Resolved here so callers don't need to know
    the kernel-internal data dir.
    """
    if not isinstance(body, str) or not body.strip():
        return ValidationResult(
            valid=False,
            complaints=("body_empty_or_whitespace_only",),
        )

    # K6 — a refusal sentinel is a structured outcome, not a malformed
    # draft: return the distinct complaint so callers can record the
    # aria/agent-refusal/v1 row and skip the retry budget (a refusal is
    # deterministic; re-dispatching the same intent refuses again).
    refusal_code = parse_drafter_refusal(body)
    if refusal_code is not None:
        if refusal_code in DRAFTER_REFUSAL_REASON_CODES:
            return ValidationResult(
                valid=False,
                complaints=(f"drafter_refusal:{refusal_code}",),
            )
        return ValidationResult(
            valid=False,
            complaints=(f"drafter_refusal_unrecognized:{refusal_code}",),
        )

    complaints: list[str] = []

    # 1. Section presence — locked by I-V3-07a/b + I-V3-12c.
    found_sections = _scan_sections(body)
    missing = [
        section
        for section in intent.required_sections
        if section not in found_sections
    ]
    if missing:
        complaints.append(
            "required_sections_missing:" + ",".join(missing)
        )

    # 2. Banned-phrase scan — locked by I-V3-08.
    banned_hits = _scan_banned_phrases(body, intent.banned_phrases)
    if banned_hits:
        complaints.append("banned_phrases_present:" + ",".join(banned_hits))

    # 3. Evidence ref allowlist — locked by I-V3-09.
    evidence_refs_in_body = _scan_evidence_refs(body)
    allowed = set(intent.evidence_allowlist)
    out_of_allowlist = sorted(evidence_refs_in_body - allowed)
    if out_of_allowlist:
        complaints.append(
            "evidence_refs_outside_allowlist:" + ",".join(out_of_allowlist)
        )

    # 4. Diff classifier lane — locked by I-V3-10.
    policy_path = Path(auto_action_policy_path)
    exclusion_globs = _l3_exclusion_globs(policy_path)
    forbidden_paths_hit = []
    candidate_paths = set(_scan_target_paths_in_body(body))
    candidate_paths.add(intent.target_path)
    for path in sorted(candidate_paths):
        for glob in exclusion_globs:
            if _path_matches_glob(path, glob):
                forbidden_paths_hit.append(f"{path}::{glob}")
                break
    if forbidden_paths_hit:
        complaints.append(
            "diff_classifier_lane_violation:" + ",".join(forbidden_paths_hit)
        )

    # 5. PII-leak check — locked by I-V3-13b.
    pii_hits = _scan_pii_in_body(body)
    if pii_hits:
        complaints.append("pii_present_in_body:" + ",".join(pii_hits))

    return ValidationResult(
        valid=not complaints,
        complaints=tuple(complaints),
    )


__all__ = [
    "ValidationResult",
    "validate_body_against_intent",
]
