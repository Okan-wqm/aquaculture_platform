"""ORPHAN-HIGH-737 — a refused envelope is the executor working, not failing.

Measured: drain 32221242315 processed 11 requests, 10 succeeded, one judge
returned an envelope with no verdict block. The Y5 contract caught it and
released the claim — exactly its design — and the run was still marked
FAILED, because the refusal arm returned 1 and the drain maps any non-zero
child to a red workflow. A 10-of-11 night reading RED is the honest-partial-
red class ORPHAN-716 closed for the meta-watchdog; this closes it for the
executor. The infrastructure arms stay red on purpose.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
_TESTS = Path(__file__).resolve().parent
for _path in (str(_POC), str(_TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402

# The live-path fixture already builds a claim envelope, a mock CLI and the
# subprocess sequencer this defect needs; reusing it keeps ONE description of
# what an executor run looks like (a second copy would drift on the next
# envelope-shape change).
from test_ci_executor_live_path_smoke import (  # noqa: E402
    LivePathFetchTests,
    _make_fake_run_sequence,
)


class RefusalIsNotABuildFailure(LivePathFetchTests):
    """Reuses the live-path fixture; only the validation verdict differs."""

    def test_contract_refusal_releases_and_reports_success(self) -> None:
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.release_response_ok,
        )
        with patch.object(
            ci_executor, "_pre_submit_validate_envelope",
            return_value=["judge_verdict:absent"],
        ):
            exit_code = self._run_main(fake_run)
        self.assertEqual(
            exit_code, 0,
            "a contract refusal is a legitimate terminal — the claim is "
            "released and the request keeps its retry budget",
        )
        release_argv = fake_run.captured[-1]
        self.assertIn("release", release_argv)
        self.assertEqual(
            release_argv[release_argv.index("--reason") + 1],
            "judge_verdict_contract_violation",
        )

    def test_the_refusal_still_never_submits(self) -> None:
        # Green exit must not mean "sealed anyway": the submit call is the
        # thing the refusal exists to prevent.
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.release_response_ok,
        )
        with patch.object(
            ci_executor, "_pre_submit_validate_envelope",
            return_value=["judge_verdict:absent"],
        ):
            self._run_main(fake_run)
        self.assertFalse(
            any("submit" in argv for argv in fake_run.captured),
            f"refusal must not submit; argvs: {[list(c) for c in fake_run.captured]}",
        )

    def test_a_real_child_failure_still_reds_the_drain(self) -> None:
        # The counterweight: infrastructure failure keeps its red. Pinned
        # here so a later "make it green" cannot quietly cover both.
        source = (Path(ci_executor_drain.__file__)).read_text(encoding="utf-8")
        self.assertIn("return 0 if failed == 0 else 1", source)
        self.assertIn("stop_reason = selection_error", source)


if __name__ == "__main__":
    unittest.main()
