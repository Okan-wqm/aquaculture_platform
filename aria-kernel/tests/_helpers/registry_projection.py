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

import json
import subprocess
import unittest
from pathlib import Path
from typing import Sequence
from unittest import mock

from aria_kernel import report_ingestion


def _stored_records(root: Path, args: Sequence[str], **_: object) -> str:
    """``project --format=records`` of a registry with no history: every stored row, from the genesis file.

    A line that is not JSON passes through unchanged, so the view refuses it by name as it refuses the
    projection's own garbled output.
    """
    if tuple(args) != ("project", "--format=records"):
        raise AssertionError(f"the stand-in projects the registry only, not {list(args)}")
    stored = root.joinpath(*report_ingestion.REGISTRY_FINDINGS_RELPATH).read_text(encoding="utf-8")
    lines = []
    for line in stored.splitlines():
        try:
            lines.append(json.dumps({"row": json.loads(line), "source": "/".join(report_ingestion.REGISTRY_FINDINGS_RELPATH)}))
        except json.JSONDecodeError:
            lines.append(line)
    return "".join(f"{line}\n" for line in lines)


def project_registry_as_stored(test: unittest.TestCase) -> None:
    """For the rest of ``test``: the projection of a fixture registry is its stored rows.

    Patches the view's call of ``report_ingestion.run_registry_cli`` only; the
    autonomy closure verifier imports the runner by name and keeps the real one.
    """
    patcher = mock.patch.object(report_ingestion, "run_registry_cli", side_effect=_stored_records)
    patcher.start()
    test.addCleanup(patcher.stop)


def _public_rows(root: Path, args: Sequence[str], **_: object) -> str:
    """``project --ref=<public ref> --format=jsonl`` of a registry with no history: the rows the public ref holds."""
    from aria_kernel import system_one

    if tuple(args) != ("project", f"--ref={system_one.PUBLIC_REGISTRY_REF}", "--format=jsonl"):
        raise AssertionError(f"the stand-in projects the public registry only, not {list(args)}")
    completed = subprocess.run(
        ["git", "-C", str(root), "show",
         f"{system_one.PUBLIC_REGISTRY_REF}:{'/'.join(report_ingestion.REGISTRY_FINDINGS_RELPATH)}"],
        check=True, capture_output=True, text=True,
    )
    return completed.stdout


def public_registry_as_stored() -> "mock._patch[mock.MagicMock]":
    """A patcher (not started) that makes System One read a fixture's public registry as the rows the public ref stores.

    System One asks the registry's projection at the public ref (``_finding``); a fixture repository that
    holds only a ``findings.jsonl`` has no ``tools/gates`` to run and no merged trailer to derive. The stand-in
    keeps what those tests are about, that the registry is read at the PUBLIC ref and never from the working
    tree. What the projection folds (an event-born finding, an amended title) is tested against a real store in
    ``tests/test_registry_store_readers.py``.
    """
    from aria_kernel import system_one

    return mock.patch.object(system_one, "run_registry_cli", side_effect=_public_rows)


def project_public_registry_as_stored(test: unittest.TestCase) -> None:
    """For the rest of ``test``: System One reads a fixture's public registry as the rows the public ref stores."""
    patcher = public_registry_as_stored()
    patcher.start()
    test.addCleanup(patcher.stop)
