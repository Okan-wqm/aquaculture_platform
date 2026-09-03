"""ORPHAN-CRITICAL-446 — the diversity layer must receive the reviewer's text.

WHAT WENT WRONG. `ORPHAN-HIGH-421` was closed under the title "make all three
convergence independence layers functional". Layers 1 and 2 became functional.
Layer 3 did not, and the way it failed was worse than the bug it replaced.

`convergence_drainer` records the round's role→dispatch map immediately after
minting the cross-review envelope — microseconds after, before the reviewer has
run — so it passed `agent_text=None` as a literal. Nothing refreshed that record
once the review landed. At gate time `_diversity_reasons` short-circuits on
`{role}_text_unavailable` whenever either side lacks text, so BOTH comparisons
the layer exists for (primary↔cross_review, challenger↔cross_review) were never
computed, in every production round.

The consequence went past "the check is a no-op": `verify_independence` could
never return True on the drainer's real inputs, so every `converged` verdict was
unconditionally downgraded to `cross_review_self_agreement`. Before the change
the layer was a vacuous pass; after it, a vacuous fail that also made
convergence structurally unreachable.

WHAT THESE TESTS PIN. Two things, at the two levels where it broke:

  * `_accepted_output_text` returns the delivered text, and returns `None` —
    never `""` — for every way delivery can be absent. The distinction is
    load-bearing: `RoundDispatch` fails closed on `None`, while `""` would
    score as maximally diverse against anything and PASS.
  * with the reviewer's text present, `verify_independence` actually computes
    the two comparisons instead of short-circuiting — and still catches an echo
    chamber when the reviewer parrots the primary.

`test_none_text_is_what_broke_it` asserts the pre-fix shape explicitly, so this
file cannot pass vacuously if the wiring regresses.

Role binding — that a result minted for a different role cannot satisfy this
reader — is enforced inside `accepted_result_for_request` and pinned by I-GATE-04
in `test_gate_accepted_result_binding.py`. It is not re-asserted here.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.agent_invocations import (  # noqa: E402
    claim_request,
    create_agent_invocation_request,
)
from aria_kernel.convergence_drainer import _accepted_output_text  # noqa: E402
from aria_kernel.cross_review_bridge import CROSS_REVIEW_ROLE  # noqa: E402
from aria_kernel.independence_check import (  # noqa: E402
    CHALLENGER_ROLE,
    CROSS_REVIEW_ROLE as IND_CROSS_REVIEW_ROLE,
    PRIMARY_ROLE,
    RoundDispatch,
    verify_independence,
)
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402

_QUEUE_ROLE = CROSS_REVIEW_ROLE[1]
_REQUEST_ID = "req-cross-review-001"
_REVIEW_TEXT = "The primary plan understates the migration risk on tenant cutover.\n"


class AcceptedOutputText(unittest.TestCase):
    """The reader that turns a delivered review into comparable text."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-xr-text-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.output = Path(self._tmp.name) / "cross-review.md"
        self.output.write_text(_REVIEW_TEXT, encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _read(self, accepted: object) -> str | None:
        """Run the reader with `accepted_result_for_request` stubbed.

        Stubbing the row lookup rather than driving the whole claim/submit
        lifecycle keeps this focused on the half that regressed — turning an
        accepted row into text — and matches how the sibling gate tests in
        `test_gate_accepted_result_binding.py` isolate the same seam.
        """
        with unittest.mock.patch(
            "aria_kernel.convergence_drainer.accepted_result_for_request",
            return_value=accepted,
        ):
            return _accepted_output_text(
                request_id=_REQUEST_ID, role=_QUEUE_ROLE, base_dir=self.tools,
            )

    def _accepted_row(self, **overrides: object) -> dict[str, object]:
        row: dict[str, object] = {
            "request_id": _REQUEST_ID,
            "role": _QUEUE_ROLE,
            "status": "accepted",
            "agent_id": "aria-cross-reviewer",
            "output_path": self.output.as_posix(),
        }
        row.update(overrides)
        return row

    def test_delivered_review_yields_its_text(self) -> None:
        self.assertEqual(self._read(self._accepted_row()), _REVIEW_TEXT)

    def test_absent_delivery_yields_none_not_empty_string(self) -> None:
        """Each way delivery can be missing. None of them may return ''."""
        cases: dict[str, object] = {
            # `accepted_result_for_request` already returns None for a claim
            # with no result, a rejection, a HUMAN_REQUIRED escalation, and a
            # row minted for another role (ORPHAN-HIGH-422 / I-GATE-04).
            "no accepted row": None,
            "row without an output_path": self._accepted_row(output_path=None),
            "row with a blank output_path": self._accepted_row(output_path=""),
            "row whose output_path is not a string": self._accepted_row(output_path=17),
            "row pointing at a file that does not exist": self._accepted_row(
                output_path="/nonexistent/cross-review.md",
            ),
        }
        for label, accepted in cases.items():
            with self.subTest(case=label):
                text = self._read(accepted)
                # `is None`, not merely falsy: '' would score as maximally
                # diverse against any text and pass the gate.
                self.assertIsNone(text, msg=f"{label} produced {text!r}")

    def test_blank_request_id_short_circuits(self) -> None:
        self.assertIsNone(
            _accepted_output_text(request_id="", role=_QUEUE_ROLE, base_dir=self.tools),
        )

    def test_empty_output_file_is_none_rather_than_empty(self) -> None:
        self.output.write_text("", encoding="utf-8")
        self.assertIsNone(self._read(self._accepted_row()))

    def test_unreadable_output_is_none_rather_than_a_crash(self) -> None:
        """A directory at output_path: `exists()` is true, `read_text` raises."""
        directory = Path(self._tmp.name) / "not-a-file"
        directory.mkdir()
        self.assertIsNone(self._read(self._accepted_row(output_path=directory.as_posix())))


class DiversityLayerActuallyRuns(unittest.TestCase):
    """The gate, on the shape the drainer hands it."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-xr-gate-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        # Three distinct principals, one per role, claimed through the real
        # queue so the claims ledger is properly hash-chained. Layers 1 and 2
        # must pass, so whatever layer 3 says is the only thing left deciding
        # the gate — otherwise a green result here could come from the wrong
        # layer.
        self.request_ids: dict[str, str] = {}
        for role, agent in (
            (PRIMARY_ROLE, "agent-primary"),
            (CHALLENGER_ROLE, "agent-challenger"),
            (IND_CROSS_REVIEW_ROLE, "agent-reviewer"),
        ):
            request = create_agent_invocation_request(
                target_agent=f"aria-{role.replace('_', '-')}",
                role=role,
                suggested_prompt=f"{role} for the independence fixture",
                must_satisfy=[{"id": "ind-fixture", "criterion": "independence"}],
                allowed_scope=["aria-kernel/**"],
                convergence_id="conv-ind-001",
                base_dir=self.tools,
            )
            request_id = str(request["request_id"])
            self.request_ids[role] = request_id
            claim_request(request_id=request_id, agent_id=agent, base_dir=self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    _PRIMARY_TEXT = (
        "Stage the tenant cutover behind a feature flag, backfill the nullable "
        "column, then flip the flag one region at a time."
    )

    def _dispatches(self, cross_review_text: str | None) -> dict[str, RoundDispatch]:
        return {
            "primary": RoundDispatch(
                role=PRIMARY_ROLE,
                request_id=self.request_ids[PRIMARY_ROLE],
                revision_id="rev-primary",
                agent_text=self._PRIMARY_TEXT,
            ),
            "challenger": RoundDispatch(
                role=CHALLENGER_ROLE,
                request_id=self.request_ids[CHALLENGER_ROLE],
                revision_id="rev-challenger",
                agent_text=(
                    "Take a maintenance window instead; a partially migrated "
                    "tenant set cannot be reasoned about during an incident."
                ),
            ),
            "cross_review": RoundDispatch(
                role=IND_CROSS_REVIEW_ROLE,
                request_id=self.request_ids[IND_CROSS_REVIEW_ROLE],
                # A cross-review has no revision of its own — matches the drainer.
                revision_id=None,
                agent_text=cross_review_text,
            ),
        }

    def test_none_text_is_what_broke_it(self) -> None:
        """The pre-fix shape, asserted explicitly so this file cannot pass vacuously.

        This is exactly what `convergence_drainer` handed the gate before
        ORPHAN-CRITICAL-446: everything else correct, reviewer text `None`.
        """
        ok, reasons = verify_independence(**self._dispatches(None), base_dir=self.tools)
        self.assertFalse(ok)
        self.assertIn("cross_review_text_unavailable", reasons)

    def test_independent_review_passes_once_its_text_is_present(self) -> None:
        ok, reasons = verify_independence(
            **self._dispatches(
                "Neither plan addresses rollback: the flag flip has no inverse "
                "once the backfill has run, and the window has no abort point.",
            ),
            base_dir=self.tools,
        )
        self.assertTrue(ok, msg=f"an independent review was rejected: {reasons}")
        self.assertEqual(reasons, [])

    def test_echo_chamber_is_still_caught(self) -> None:
        """Supplying the text must not turn the layer into a rubber stamp."""
        ok, reasons = verify_independence(
            **self._dispatches(self._PRIMARY_TEXT), base_dir=self.tools,
        )
        self.assertFalse(ok, msg="a reviewer parroting the primary passed the gate")
        self.assertTrue(
            any("jaccard" in reason for reason in reasons),
            msg=f"the diversity layer did not fire; reasons were {reasons}",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
