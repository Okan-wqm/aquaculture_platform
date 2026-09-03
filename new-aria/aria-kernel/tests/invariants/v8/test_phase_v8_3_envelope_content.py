"""Plan ARIA-V8.3 — cross_review envelope content enrichment.

Closes Bug 7 (live observation 2026-05-18 run 5): challenger envelope
SUBMIT succeeded (V8.1), state advanced to CHALLENGER_DRAFTED (V8.1),
drainer minted cross_review envelope (V8 producer pipeline), kernel
result_accepted... then aria-cross-reviewer Opus REFUSED with
`details.missing_inputs` — the agent's independence discipline
rightly blocked because the envelope's challenger_plan_text was a
hardcoded stub string `"(challenger plan loaded by aria-cross-
reviewer via Read tool)"` rather than the real challenger
plan_content from kernel state.

Tier-1 architectural fix: drainer fetches challenger.plan_content
from `fold_plan_state` after CHALLENGER_DRAFTED, serializes it to
JSON, and passes the real text as `challenger_plan_text` to
`issue_cross_review_envelope`. The envelope's `<untrusted_challenger_
plan>` delimiter now wraps real content, the cross-reviewer can
compare primary↔challenger substantively, and refusal-on-empty-
plan-body no longer fires.

Invariants:

- I-V8.3-CONTENT-01 — drainer source does NOT contain the legacy stub
  string `(challenger plan loaded by aria-cross-reviewer via Read
  tool)` (negative regression check)
- I-V8.3-CONTENT-02 — drainer fetches challenger.plan_content via
  fold_plan_state inside the round-1 helper (source-substring pin
  on `challenger.get("plan_content")`)
- I-V8.3-CONTENT-03 — drainer serializes plan_content_dict via
  json.dumps before passing to issue_cross_review_envelope
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import convergence_drainer


class TestV8CrossReviewEnvelopeContent(unittest.TestCase):

    def test_i_v8_3_content_01_no_stub_string_regression(self):
        """The drainer source MUST NOT contain the legacy stub string
        that pre-V8.3 caused the cross-reviewer to refuse with
        `details.missing_inputs`. Negative source-substring check —
        any future regression that reintroduces the stub flips this
        test, not a runtime cycle abandonment."""
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        self.assertNotIn(
            "challenger plan loaded by aria-cross-reviewer via Read tool", src,
            "V8.3 regression: the legacy stub challenger_plan_text "
            "is back in convergence_drainer — cross-reviewer will "
            "refuse all envelopes with missing_inputs",
        )

    def test_i_v8_3_content_02_drainer_reads_plan_content_from_state(self):
        """The drainer's round-1 cross_review mint path MUST fetch
        challenger.plan_content from fold_plan_state output."""
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        self.assertIn(
            'challenger.get("plan_content")', src,
            "drainer MUST extract challenger.plan_content from state — "
            "without it the cross_review envelope cannot carry the "
            "actual challenger plan body",
        )

    def test_i_v8_3_content_03_drainer_serializes_plan_content_json(self):
        """The drainer MUST serialize the challenger plan_content dict
        to JSON text before passing to issue_cross_review_envelope
        (the function expects str, not dict)."""
        src = inspect.getsource(convergence_drainer.run_convergence_drainer)
        # The serialization line must appear in the round-1 mint path
        self.assertIn(
            "_json.dumps(", src,
            "drainer MUST serialize plan_content_dict via json.dumps "
            "for the challenger_plan_text argument",
        )
        # The challenger_plan_text kwarg MUST receive the serialized
        # variable (not a stub literal)
        self.assertIn(
            "challenger_plan_text=challenger_plan_text", src,
            "drainer cross_review mint MUST pass the live "
            "challenger_plan_text variable",
        )


if __name__ == "__main__":
    unittest.main()
