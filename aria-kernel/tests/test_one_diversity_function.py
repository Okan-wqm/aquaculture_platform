"""PLAN-v2 F0.8 — one diversity function: the seat law decides for all three consumers.

WHY THIS EXISTS. The operator's diversity law (2026-10-18: diversity comes
from PERSPECTIVE and METHOD, not from the provider) has one owner, the seat
law in ``feedback_store`` (WP-P; ``consensus_distinct_seats`` and the
distinct-seat count it is built on). Three consumers ask the diversity
question:

* the ANCHOR (``is_ground_truth_row``) — already asks the seat law;
* the CALIBRATED MAJORITY (``generate_ai_consensus`` under ``enforce``) —
  restates it inline as its own ``distinct_seats`` set;
* the CALIBRATION-GATE DOWNGRADE (``genesis_policy.effective_calibration_
  gate``) — asks ``observation_span`` for a distinct MODEL (or METHOD) span
  of at least two. On one provider every calibrated seat runs the one model
  that provider has, so the span is 1 and a configured ``enforce`` is
  downgraded to ``measure_only`` forever: the "different model >= 2" gate
  the enforce quorum was meant to answer can never be met.

F0.8 exit (PLAN-v2 §3 Faz 0): on a single-provider fixture, two calibrated
DISTINCT SEATS give ``effective == 'enforce'``. The method stamp and the
model are receipt legs of the seat law, never a span the gate counts.

Pinned here, one property per test:

* the exit criterion, on the production shape ``cycle`` passes
  (``{judge_id: {"calibration_status", "model"}}``) and with a method stamp
  shared by both seats — RED at the base for the defect's reason (the gate
  answers ``measure_only``);
* all three consumers ask the ONE seat function: with the seat law answering
  zero seats, the anchor, the calibrated majority and the gate all refuse —
  RED at the base because the calibrated majority and the gate never ask it.

The seat function is found, not named: it is the one ``feedback_store``
function that RETURNS the count of distinct ``judge_id`` seats (today
``consensus_distinct_seats``). The structural ban on a second diversity rule
anywhere in ``aria_kernel`` lives in
``tests/invariants/test_one_diversity_rule.py``.
"""
from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import feedback_store, genesis_policy
from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    CALIBRATED_QUORUM_MIN_JUDGES,
    generate_ai_consensus,
    is_ground_truth_row,
    provider_span_of,
    record_operator_feedback,
)
from aria_kernel.genesis_policy import effective_calibration_gate
from aria_kernel.tool_registry import ensure_tools_dir

_FEEDBACK_STORE = Path(feedback_store.__file__)

# The single-provider fleet: every calibrated seat on the ONE model the one
# provider serves. Proved single-provider through the kernel's own binding
# (`provider_span_of` -> model_fleet.dispatching_provider_for_model).
_ONE_PROVIDER_MODEL = "glm-5.3"


def _seat_count_functions() -> list[str]:
    """``feedback_store`` functions that RETURN a count of distinct judge seats.

    The shape the seat law has today: ``return len({... "judge_id" ...})``,
    directly or through a local name bound to that set.
    """
    tree = ast.parse(_FEEDBACK_STORE.read_text(encoding="utf-8"), filename=str(_FEEDBACK_STORE))

    def judge_id_set(node: ast.AST) -> bool:
        is_set = isinstance(node, ast.SetComp) or (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"set", "frozenset"}
        )
        return is_set and any(
            isinstance(c, ast.Constant) and c.value == "judge_id" for c in ast.walk(node)
        )

    found: list[str] = []
    for fn in tree.body:
        if not isinstance(fn, ast.FunctionDef):
            continue
        bound = {
            target.id
            for node in ast.walk(fn)
            if isinstance(node, ast.Assign) and judge_id_set(node.value)
            for target in node.targets
            if isinstance(target, ast.Name)
        }
        for node in ast.walk(fn):
            value = node.value if isinstance(node, ast.Return) else None
            if (
                isinstance(value, ast.Call)
                and isinstance(value.func, ast.Name)
                and value.func.id == "len"
                and len(value.args) == 1
                and (
                    judge_id_set(value.args[0])
                    or (isinstance(value.args[0], ast.Name) and value.args[0].id in bound)
                )
            ):
                found.append(fn.name)
                break
    return found


@contextmanager
def _seat_law_answers(seats: int) -> Iterator[str]:
    """Replace the ONE seat function with one answering ``seats``, wherever
    an ``aria_kernel`` module holds a binding to it."""
    names = _seat_count_functions()
    if len(names) != 1:
        raise AssertionError(
            f"expected exactly ONE feedback_store function returning the distinct-seat count, "
            f"found {names}: the seat law has one owner (F0.8)"
        )
    name = names[0]
    original = getattr(feedback_store, name)
    with ExitStack() as stack:
        for module_name, module in list(sys.modules.items()):
            if module_name.split(".")[0] == "aria_kernel" and getattr(module, name, None) is original:
                stack.enter_context(patch.object(module, name, lambda *_a, **_k: seats))
        yield name


class _Ledger(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-f08-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge(self, judge_id: str, *, model: str, evidence_refs: list[str] | None = None) -> None:
        record_operator_feedback(
            tool_id="tool-a",
            run_id="run-1",
            finding_id="F-1",
            verdict="true_positive",
            severity="high",
            note=f"{judge_id} verdict",
            source_type="ai_judge",
            judge_id=judge_id,
            model=model,
            confidence=0.95,
            evidence_refs=evidence_refs,
            judgment_group_id="judge:tool-a:F-1",
            finding_fingerprint="fp-F-1",
            base_dir=self.tools,
        )


class SingleProviderCalibratedSeatsEnforce(unittest.TestCase):
    """The F0.8 exit criterion: two calibrated distinct seats on one provider
    give the enforce gate its quorum."""

    def test_two_calibrated_distinct_seats_on_one_provider_enforce(self) -> None:
        self.assertEqual(
            provider_span_of([_ONE_PROVIDER_MODEL, _ONE_PROVIDER_MODEL]), "single",
            "fixture precondition: both seats dispatch through one provider",
        )
        # The production shape: cycle._phase_judgment_pipeline builds
        # {judge_id: {"calibration_status", "model"}} from score_judges.
        gate = effective_calibration_gate("enforce", {
            "aria-evidence-judge": {"calibration_status": "calibrated", "model": _ONE_PROVIDER_MODEL},
            "aria-adversarial-judgment-seat": {"calibration_status": "calibrated", "model": _ONE_PROVIDER_MODEL},
        })
        self.assertEqual(
            (gate["effective"], gate["reason"]), ("enforce", "calibrated_quorum_available"),
            "two calibrated DISTINCT SEATS on one provider are the calibrated quorum; "
            "a distinct-model (or distinct-method) span is not the diversity law (F0.8)",
        )
        self.assertEqual(
            gate["calibrated_judges"], ["aria-adversarial-judgment-seat", "aria-evidence-judge"],
        )

    def test_a_shared_method_stamp_is_a_receipt_leg_not_a_span(self) -> None:
        gate = effective_calibration_gate("enforce", {
            "a": {"calibration_status": "calibrated", "model": _ONE_PROVIDER_MODEL, "method": "static_trace"},
            "b": {"calibration_status": "calibrated", "model": _ONE_PROVIDER_MODEL, "method": "static_trace"},
        })
        self.assertEqual(
            gate["effective"], "enforce",
            "the method stamp names WHAT a seat's receipt is; two seats sharing one method "
            "are still two calibrated seats (F0.8: the method is a leg of the seat law)",
        )


class TheThreeConsumersAskTheOneSeatFunction(_Ledger):
    """With the seat law answering zero seats, every consumer must refuse.
    A consumer that still decides on its own count is a second diversity rule."""

    def test_the_seat_law_decides_the_anchor_the_calibrated_majority_and_the_gate(self) -> None:
        # Anchor: three distinct seats with evidence settle as ground truth.
        for judge_id, model in (("s1", "opus"), ("s2", "glm-5.3"), ("s3", "fable")):
            self._judge(judge_id, model=model, evidence_refs=["src/app.ts:10"])
        anchor_row = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)["consensus"][0]
        self.assertEqual(anchor_row["judge_count"], ANCHOR_MIN_JUDGE_COUNT)
        self.assertTrue(is_ground_truth_row(anchor_row), "fixture precondition: the anchor stands")

        # Calibrated majority and gate fixtures that close/enforce on any
        # diversity reading (two calibrated seats, two models, two providers).
        calibrated_map = {
            "a": {"calibration_status": "calibrated", "model": "opus"},
            "b": {"calibration_status": "calibrated", "model": "glm-5.3"},
        }
        self.assertEqual(len(calibrated_map), CALIBRATED_QUORUM_MIN_JUDGES)
        self.assertEqual(
            effective_calibration_gate("enforce", calibrated_map)["effective"], "enforce",
            "fixture precondition: the gate enforces on two calibrated seats",
        )

        def calibrated_majority() -> dict[str, Any]:
            with tempfile.TemporaryDirectory(prefix="aria-f08-cm-") as tmp:
                tools = Path(tmp) / "aria-tools"
                ensure_tools_dir(tools)
                for judge_id, entry in calibrated_map.items():
                    record_operator_feedback(
                        tool_id="tool-a", run_id="run-1", finding_id="F-1",
                        verdict="true_positive", severity="high", note=f"{judge_id} verdict",
                        source_type="ai_judge", judge_id=judge_id, model=entry["model"],
                        confidence=0.95, judgment_group_id="judge:tool-a:F-1",
                        finding_fingerprint="fp-F-1", base_dir=tools,
                    )
                return generate_ai_consensus(
                    tool_id="tool-a",
                    base_dir=tools,
                    judge_calibration={jid: "calibrated" for jid in calibrated_map},
                    calibration_gate="enforce",
                )

        self.assertEqual(calibrated_majority()["consensus_count"], 1,
                         "fixture precondition: the calibrated majority closes")

        with _seat_law_answers(0) as seat_function:
            wrong: list[str] = []
            if is_ground_truth_row(anchor_row):
                wrong.append("anchor (is_ground_truth_row) still stands")
            result = calibrated_majority()
            reasons = [u["reason"] for u in result["uncertainties"]]
            if result["consensus_count"] != 0 or reasons != ["confidence_uncalibrated"]:
                wrong.append(
                    "calibrated majority (generate_ai_consensus under enforce) still closes: "
                    f"consensus_count={result['consensus_count']} uncertainties={reasons}"
                )
            gate = genesis_policy.effective_calibration_gate("enforce", calibrated_map)
            if gate["effective"] != "measure_only":
                wrong.append(f"calibration gate (effective_calibration_gate) still {gate['effective']!r}")
        self.assertEqual(
            wrong, [],
            f"with the seat law ({seat_function}) answering zero seats, these consumers decided "
            "on a diversity count of their own — a second diversity rule (F0.8):\n" + "\n".join(wrong),
        )


if __name__ == "__main__":
    unittest.main()
