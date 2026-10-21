"""ARIA-HIGH-005 — the one test-side builder of pre-merge predicate inputs.

``implementation_safety._PreMergeEvidence`` refuses construction without
the token its producer (``merge_authority._pre_merge_evidence``) holds, so
a snapshot cannot be forged by instantiating fields. Predicate tests still
need to hand a check a precise field set; they build it here, through the
producer's own constructor, so the refusal stays the rule everywhere else
and ``tests/test_pre_merge_evidence.py`` pins it.
"""
from __future__ import annotations

from typing import Any

from aria_kernel.implementation_safety import _PreMergeEvidence
from aria_kernel.merge_authority import _pre_merge_evidence


def fixture_pre_merge_evidence(unavailable_reasons: tuple[str, ...] = (), **fields: Any) -> _PreMergeEvidence:
    """A pre-merge snapshot with exactly ``fields``, built by the producer."""
    return _pre_merge_evidence(unavailable_reasons, **fields)
