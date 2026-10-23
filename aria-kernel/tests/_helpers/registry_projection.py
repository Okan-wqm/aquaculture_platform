"""The registry's projection, for a fixture workspace that has no history.

WHY (MF-1, PROC-HIGH-039). Every kernel reader of the review registry reads
it through ``report_ingestion.read_registry_view``, which runs the registry
CLI's projection (``finding-registry.ts project``): RESOLVED is derived from
the ``Closes:`` trailers merged into HEAD. A unit fixture that writes a
registry into a scratch directory has no git history and no ``tools/gates``
to run, and for such a fixture the projection IS its stored rows — no merged
trailer closes anything. Tests of a reader's OWN logic (the deadline organ's
dating, ingestion's dedup, a plan source's ranking) install this stand-in
instead of building a repository per test.

The projection itself — derived closures, a rejected closer, the refusal
without ts-node — is tested against real repositories in
``tests/test_report_ingestion_registry_view.py``, and each kernel reader is
observed there once seeing a derived closure.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import report_ingestion


def _stored_rows(root: Path) -> str:
    return root.joinpath(*report_ingestion.REGISTRY_FINDINGS_RELPATH).read_text(encoding="utf-8")


def project_registry_as_stored(test: unittest.TestCase) -> None:
    """For the rest of ``test``: the projection of a fixture registry is its stored rows."""
    patcher = mock.patch.object(report_ingestion, "_projection_jsonl", side_effect=_stored_rows)
    patcher.start()
    test.addCleanup(patcher.stop)
