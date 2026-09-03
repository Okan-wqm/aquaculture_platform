"""Plan ARIA-V3 §A3 + AUDITTRAIL-HIGH-008 — PII masking on DraftIntent.

The intent serialised to ``--intent-file`` and sent to the Claude
Code CLI MUST NOT carry raw PII. The kernel composes the intent
from evidence_refs which may include issue-tracker URLs,
commit-author emails, or operator notes; without masking those
strings reach the model AND get persisted in the audit ledger
(``drafter_invocation_recorded`` row with ``intent_file_sha256``).
SPEC §0.2 Hard Limit forbids "raw secrets in artifacts/logs/
prompts/reports" and L3 Operational Safety extends the same
discipline to operator/commit-author PII.

The masker normalises three PII shapes (mirrors the validator's
``_REASON_PII_PATTERNS`` from Plan ARIA-V2 §AUDITTRAIL-HIGH-005a)
and emits a deterministic redaction token so downstream readers
can prove a value was scrubbed (vs absent):

    user@example.com  →  <pii:email:7e4b...>
    (555) 123-4567    →  <pii:phone:0fa1...>
    123-45-6789       →  <pii:ssn:3b9a...>

The hash-prefix is sha256(value)[:8] so a re-run produces the same
token for the same input (idempotent + diffable). The plaintext
value never reaches the JSONL audit.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import replace
from typing import Any

from .draft_intent import AgentDraftIntent, SkillDraftIntent

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}")
_SSN_RE = re.compile(r"\d{3}-\d{2}-\d{4}")


def _redact(kind: str, raw: str) -> str:
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    return f"<pii:{kind}:{digest}>"


def mask_pii_in_string(value: str) -> str:
    """Apply email/phone/SSN masking in deterministic order."""
    if not value:
        return value
    masked = _EMAIL_RE.sub(lambda m: _redact("email", m.group(0)), value)
    masked = _PHONE_RE.sub(lambda m: _redact("phone", m.group(0)), masked)
    masked = _SSN_RE.sub(lambda m: _redact("ssn", m.group(0)), masked)
    return masked


def _mask_tuple_of_strings(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(mask_pii_in_string(v) for v in values)


def mask_pii_in_intent(
    intent: AgentDraftIntent | SkillDraftIntent,
) -> AgentDraftIntent | SkillDraftIntent:
    """Plan ARIA-V3 AUDITTRAIL-HIGH-008 — return a new intent with
    every PII-bearing string field masked. The dataclasses are
    frozen, so we use ``dataclasses.replace`` to produce a new
    instance preserving every other field.

    Fields scrubbed:
      * ``purpose`` / ``description`` (free-text)
      * ``evidence_allowlist`` (path strings — may contain branch
        names with operator handle)
      * ``acceptance_tests[].description``
      * ``required_sections`` (defensive — section names are
        operator-defined free text in some genesis flows)

    Fields NOT scrubbed:
      * ``intent_id`` / ``name`` / ``target_path`` — kernel-derived
        slugs; never contain PII.
      * ``scope_globs`` / ``forbidden_globs`` — kernel-derived path
        patterns.
      * ``banned_phrases`` — locked constant tuple.
    """
    from .draft_intent import AcceptanceTest

    new_acceptance = tuple(
        AcceptanceTest(
            name=t.name,
            expected=t.expected,
            description=mask_pii_in_string(t.description),
        )
        for t in intent.acceptance_tests
    )
    new_allowlist = _mask_tuple_of_strings(intent.evidence_allowlist)
    new_required = _mask_tuple_of_strings(intent.required_sections)

    if isinstance(intent, AgentDraftIntent):
        return replace(
            intent,
            purpose=mask_pii_in_string(intent.purpose),
            evidence_contract=mask_pii_in_string(intent.evidence_contract),
            required_sections=new_required,
            acceptance_tests=new_acceptance,
            evidence_allowlist=new_allowlist,
        )
    if isinstance(intent, SkillDraftIntent):
        return replace(
            intent,
            description=mask_pii_in_string(intent.description),
            required_sections=new_required,
            acceptance_tests=new_acceptance,
            evidence_allowlist=new_allowlist,
        )
    raise TypeError(
        f"mask_pii_in_intent expected AgentDraftIntent or SkillDraftIntent, "
        f"got {type(intent).__name__}"
    )


__all__ = ["mask_pii_in_intent", "mask_pii_in_string"]
