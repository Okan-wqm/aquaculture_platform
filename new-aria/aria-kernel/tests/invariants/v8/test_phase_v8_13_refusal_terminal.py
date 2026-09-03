"""Plan ARIA-V8.13 — agent refusal as first-class terminal outcome.

Closes operator concern from 11th live ARIA run: aria/agent-refusal/v1
envelopes were treated by ci_executor as normal submissions, the
pre-submit canonical validator rejected them on `plan_content:
absent_or_not_object`, the consumer requeued, and after N retries the
request landed in HUMAN_REQUIRED — burning ~3× $0.35 of Opus tokens
per refusal cycle.

V8.13 detects the refusal envelope inside `details.agent_text` BEFORE
running pre-submit validation, dispatches `aria_kernel human-required
record` so the operator sees the structured triage row, releases the
claim with `reason=agent_refused:<class>`, and returns 0. The kernel
state machine already recognizes the human_required event as terminal
(no parallel kernel state required). Cost per refusal stays at 1×.

3 invariants pin the V8.13 architectural anchors:

- I-V8.13-REF-01 — ci_executor source defines refusal detection on
  `aria/agent-refusal/v1` schema marker
- I-V8.13-REF-02 — refusal path calls `human-required record` CLI
  with reason carrying the agent's reason_class
- I-V8.13-REF-03 — refusal detection precedes the pre-submit
  canonical validator (source-substring order pin)
"""
from __future__ import annotations

import unittest
from pathlib import Path

from . import _helpers  # noqa: F401


REPO_ROOT = Path(__file__).resolve().parents[4]
CI_EXECUTOR_PATH = REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"


class TestV8RefusalTerminal(unittest.TestCase):

    def setUp(self) -> None:
        self.src = CI_EXECUTOR_PATH.read_text(encoding="utf-8")

    def test_i_v8_13_ref_01_refusal_schema_marker_detection(self):
        """ci_executor MUST check for the `aria/agent-refusal/v1`
        schema marker in the inner extracted JSON. Three alias keys
        (`$schema`, `envelope`, `schema`) are accepted because Opus
        non-deterministically picks between them."""
        self.assertIn(
            '"aria/agent-refusal/v1"', self.src,
            "ci_executor MUST detect refusal envelopes via the "
            "aria/agent-refusal/v1 schema literal",
        )
        # All three alias-key checks present
        self.assertIn('$schema', self.src)
        self.assertIn('envelope', self.src)
        self.assertIn('schema', self.src)

    def test_i_v8_13_ref_02_dispatches_human_required_record(self):
        """The refusal handler MUST dispatch `aria_kernel
        human-required record` so the operator-visible triage row is
        persisted + the kernel state machine marks the request
        terminal (existing line 596 of agent_invocations.py
        recognizes the human_required event as HUMAN_REQUIRED)."""
        self.assertIn(
            '"human-required"', self.src,
            "ci_executor refusal path MUST invoke the `human-required` CLI",
        )
        self.assertIn(
            '"record"', self.src,
            "ci_executor refusal path MUST use `human-required record` "
            "(not list/sweep/resolve)",
        )
        # Reason field carries the agent's reason_class for forensic
        # operator visibility.
        self.assertIn(
            "agent_refused:", self.src,
            "ci_executor refusal release MUST tag reason with "
            "`agent_refused:<class>` prefix",
        )

    def test_i_v8_13_ref_03_detection_precedes_validator(self):
        """Source-substring order pin: the refusal detection block MUST
        appear in source BEFORE the pre-submit canonical validator
        call. If a future refactor moves validation earlier, a refusal
        envelope would bounce on plan_content:absent before reaching
        the refusal handler — defeating the V8.13 fast-path."""
        refusal_marker = "agent_refusal_detected"
        validator_marker = "validation_errors = _pre_submit_validate_envelope"
        self.assertIn(refusal_marker, self.src)
        self.assertIn(validator_marker, self.src)
        self.assertLess(
            self.src.index(refusal_marker),
            self.src.index(validator_marker),
            "ci_executor MUST detect refusals BEFORE the canonical "
            "validator runs (V8.13 fast-path ordering invariant)",
        )


if __name__ == "__main__":
    unittest.main()
