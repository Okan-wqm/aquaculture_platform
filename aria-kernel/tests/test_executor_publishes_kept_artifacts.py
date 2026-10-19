"""ARIA-MEDIUM-574 — the executor publishes the result files the kernel KEPT, after the terminal.

THE DEFECT. ``_main`` published ``envelope_path`` and ``transcript_path`` to
``GITHUB_OUTPUT`` at claim time, before the result existed, and the workflow's
"Upload response envelope" step uploads exactly those paths with
``if-no-files-found: error``. A credential refusal the kernel withholds
deletes both files (``agent_invocations._withhold_submission_sources``); on
the delivery path that terminal exits ``REFUSAL_EXIT_CODE`` (0), so the step
ran, found neither file and turned the job red on the withholding working as
designed. Every other exit-0 refusal after the claim that left no envelope
did the same.

WHAT IS PINNED:

* through the real delivery and the executor's own refusal terminal, a
  withheld envelope and transcript publish nothing, and a refusal that kept
  them publishes both;
* through the real entry (a real request, a real claim through the kernel
  CLI; only the spawn is substituted), the paths are published when the
  process exits, from what exists then: a spawn that wrote nothing publishes
  nothing, a spawn that wrote both files publishes both, and nothing is
  published while the spawn runs.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from tests import test_agent_claim_lifecycle_leak as lifecycle
from tests.test_delivery_refusal_withholds_refused_output import (
    _DB_PASSWORD,
    _KEY_HEADER,
    _RefusedDeliveryFixture,
)

_POC_DIR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


def _published(output_file: Path) -> list[str]:
    if not output_file.exists():
        return []
    return [line.split("=", 1)[0] for line in output_file.read_text(encoding="utf-8").splitlines()
            if line.startswith(("envelope_path=", "transcript_path="))]


class AWithheldRefusalPublishesNothingTests(_RefusedDeliveryFixture):
    def _publish_into(self, output_file: Path) -> list[str]:
        with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output_file), "GITHUB_WORKSPACE": str(self.root)}):
            ci_executor._publish_artifact_paths(self.output, self.transcript)
        return _published(output_file)

    def test_a_credential_refusal_the_kernel_withheld_leaves_no_path_to_upload(self) -> None:
        refused = self._refuse(
            self._envelope(note=_KEY_HEADER + "\n" + _DB_PASSWORD),
            transcript='{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n',
        )
        code, stderr = self._close(refused)

        # The step that uploads runs: the terminal is a by-design refusal.
        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        self.assertEqual(code, 0)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.transcript.exists())
        self.assertEqual(self._publish_into(self.root / "gh-output.txt"), [],
                         "a path the withholding deleted must not reach the upload step")

    def test_a_refusal_that_kept_its_files_publishes_both(self) -> None:
        refused = self._refuse(self._envelope(evidence_ref="src/app.ts:4000"), transcript='{"t":1}\n')
        code, stderr = self._close(refused)

        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        self.assertEqual(self._publish_into(self.root / "gh-output.txt"), ["envelope_path", "transcript_path"])


class TheEntryPublishesAtItsExitTests(unittest.TestCase):
    """The real-kernel entry harness of the lease guard's proof, composed
    (not inherited, so its own tests are not run twice)."""

    def setUp(self) -> None:
        lifecycle.TheGuardIsProvenOnTheRealKernel.setUp(self)

    def _run_entry(self) -> int:
        return lifecycle.TheGuardIsProvenOnTheRealKernel._run_entry(self)

    def _run_published(self, **spawn: object) -> tuple[int, list[str]]:
        output_file = self.runner_temp / "github-output.txt"
        environment = {"GITHUB_OUTPUT": str(output_file), "GITHUB_WORKSPACE": str(self.root)}
        with mock.patch.dict(os.environ, environment):
            if spawn:
                with mock.patch.object(self.executor, "invoke_claude_cli", **spawn):
                    code = self._run_entry()
            else:
                code = self._run_entry()
        return code, _published(output_file)

    def test_a_spawn_that_left_no_result_publishes_no_path(self) -> None:
        # The real spawn path: refused inside invoke_claude_cli by the cost
        # gate (opus against this metered workspace's per-run cap), after
        # the claim and before any envelope exists.
        code, published = self._run_published()

        self.assertEqual(code, 1)
        self.assertEqual(published, [], "the claim-time publication named files that never existed")

    def test_the_files_on_disk_at_exit_are_published_and_none_while_the_spawn_runs(self) -> None:
        seen_during_spawn: list[list[str]] = []

        def spawn(**kwargs: object) -> int:
            seen_during_spawn.append(_published(Path(os.environ["GITHUB_OUTPUT"])))
            output_path = Path(str(kwargs["output_path"]))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text("{}", encoding="utf-8")
            Path(str(kwargs["transcript_path"])).write_text("{}\n", encoding="utf-8")
            return 1

        code, published = self._run_published(side_effect=spawn)

        self.assertEqual(code, 1)
        self.assertEqual(seen_during_spawn, [[]], "nothing is published before the terminal")
        self.assertEqual(published, ["envelope_path", "transcript_path"])


del _RefusedDeliveryFixture
