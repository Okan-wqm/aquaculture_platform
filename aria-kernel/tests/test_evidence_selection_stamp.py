"""WP-J review — ``evidence_selection`` states only verifications the kernel
performed.

``judgment_bridge`` stamped ``evidence_selection: index`` for ANY typed-parse
answer, but the typed parse accepts citations whose quote was never checked
(``verified=None`` when the mint pinned no excerpt, carried as ``False``),
so a fabricated quote on an unpinned request entered the ledger as a
mechanically verified trace. The arbiter's evidence rank then listed that
seat FIRST and printed ``evidence=quote-verified`` about it — above honest
seats that merely cited refs — advertising a check the kernel never made.

The stamp is the one owner: ``index`` only when EVERY citation's own
``verified`` flag is True; anything else is ``ref``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.judge_fanout import (
    _seat_payload,
    render_evidence_weighing_prompt,
)
from aria_kernel.tool_registry import ensure_tools_dir

_REF_IN_EXCERPT = "apps/auth/src/mfa.resolver.ts:128"
_REF_HONEST_A = "apps/auth/src/mfa.guard.ts:40"
_REF_HONEST_B = "apps/auth/src/mfa.guard.ts:57"


def _request(excerpts: list[dict] | None) -> dict:
    return {
        "request_id": "AIR-judge-1", "tool_id": "tool-a", "run_id": "run-1",
        "finding_id": "F-1", "judgment_group_id": "judge:tool-a:fp1",
        "finding_fingerprint": "fp1",
        "evidence_refs": [_REF_IN_EXCERPT, "docs/adr/046.md"],
        "evidence_excerpts": excerpts,
        "suggested_prompt": "Judge whether this finding is a true_positive or false_positive.",
    }


_PINNED_EXCERPT = {
    "path": "apps/auth/src/mfa.resolver.ts", "start_line": 120, "end_line": 130,
    "content_hash": "sha256:feedface", "content": "  @Public()\n  async setupMfa(@Args() input: SetupMfaInput) {\n",
}


def _typed_response(quote: str, *, agent: str = "aria-adversarial-judge") -> dict:
    return {
        "role": "adversarial_judgment",
        "details": {
            "agent_subagent_type": agent, "agent_dispatch_model": "glm-5.3",
            "agent_confidence_source": "self_reported",
            "verdict": {
                "primitive": "choice", "value": "false_positive",
                "probabilities": {"true_positive": 0.2, "false_positive": 0.8},
                "confidence": 0.8,
                "evidence": [{"index": 0, "quote": quote}],
                "rationale": "The endpoint is public by declaration and rate limited two lines below.",
            },
        },
    }


def _legacy_response(refs: list[str]) -> dict:
    return {
        "role": "evidence_judgment",
        "details": {
            "agent_subagent_type": "aria-evidence-judge",
            "agent_dispatch_model": "glm-5.3",
            "agent_confidence_source": "self_reported",
            "verdict": {
                "verdict": "false_positive", "confidence": 0.85,
                "rationale": "the guard is missing at both cited lines",
                "evidence_refs": refs,
            },
        },
    }


class TheStampStatesOnlyPerformedVerifications(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = ensure_tools_dir(
            Path(tempfile.mkdtemp(prefix="aria-wpj-stamp-")) / "aria-tools"
        )

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_an_unpinned_typed_quote_stamps_ref_not_index(self) -> None:
        """Nothing was pinned at the mint, so the kernel verified NOTHING:
        the quote is the judge's word (typed_judgment carries it with
        ``verified=False``), and the row must not claim a verified trace."""
        row = record_judge_verdict_from_response(
            request=_request(excerpts=None),
            response=_typed_response("totally fabricated quote"),
            base_dir=self.tools,
        )
        self.assertEqual(row["evidence_selection"], "ref")
        # The refs still materialize — the seat DID cite; only the
        # verification claim is refused.
        self.assertEqual(row["evidence_refs"], [_REF_IN_EXCERPT])

    def test_a_pinned_and_matched_typed_quote_still_stamps_index(self) -> None:
        row = record_judge_verdict_from_response(
            request=_request(excerpts=[_PINNED_EXCERPT]),
            response=_typed_response("@Public()"),
            base_dir=self.tools,
        )
        self.assertEqual(row["evidence_selection"], "index")

    def test_the_arbiter_brief_never_ranks_an_unverified_seat_first(self) -> None:
        """The brief the arbiter reads: an honest ref-citing seat outranks a
        seat whose typed quote was never checked, and no seat is printed
        ``evidence=quote-verified`` unless the kernel verified its quotes."""
        unpinned = record_judge_verdict_from_response(
            request=_request(excerpts=None),
            response=_typed_response("totally fabricated quote"),
            base_dir=self.tools,
        )
        honest = record_judge_verdict_from_response(
            request=_request(excerpts=None),
            response=_legacy_response([_REF_HONEST_A, _REF_HONEST_B]),
            base_dir=self.tools,
        )
        prompt = render_evidence_weighing_prompt({
            "tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-1",
            "judgment_group_id": "judge:tool-a:fp1",
            "judges": [
                _seat_payload("aria-adversarial-judge", unpinned),
                _seat_payload("aria-evidence-judge", honest),
            ],
        })
        self.assertNotIn("evidence=quote-verified", prompt)
        honest_line = next(
            line for line in prompt.splitlines() if _REF_HONEST_A in line
        )
        unpinned_line = next(
            line for line in prompt.splitlines() if _REF_IN_EXCERPT in line
        )
        self.assertLess(
            prompt.index(honest_line), prompt.index(unpinned_line),
            "a seat whose quotes were never checked must not outrank a "
            "citing seat in the arbiter's evidence ledger",
        )


if __name__ == "__main__":
    unittest.main()
