"""ARIA-LOW-741 (package F3.1) — "which (provider, model) executed this sealed response" has ONE resolver.

WHAT BASE DOES TODAY. ``independence_check.executed_route(response, attempt_rows=...)`` is
the one resolver (native attempt row, or the executor-stamped ``details.agent_dispatch_model``
under ``model_fleet.dispatching_provider_for_model``), but its only production caller,
``_bind_seats``, first has to load the governance ledger itself. A second consumer of the
route (the delivery's decision stamp) would have to repeat that load-and-bind, and the
executors write the ``agent_dispatch_model`` key from two inline spellings
(``ci_executor`` ``if model: details[k] = m else: details.pop(k)``, the judge-batch envelope's
dict literal). ``executed_route_of``, ``stamp_dispatch_model`` and ``DISPATCH_MODEL_KEY`` do
not exist.

WHAT THIS PINS (all through ``independence_check``, the owner):

* ``executed_route_of(response, *, base_dir)`` is ``executed_route`` with the attempt rows read
  from ``governance.jsonl`` ONLY when the envelope carries ``runtime_attempt_ledger_hash`` (the
  spawn path reads no ledger); a read failure the ledger itself names returns ``None``; it
  decides nothing (C1-C3);
* ``stamp_dispatch_model(details, model)`` is the one writer of the key: a model overwrites what
  the agent wrote, no model REMOVES the key (C4); both executor builders call it, so they agree.

NEW API. Every test reaches the new names through ``_owner()``, which raises ``AssertionError``
naming the missing one, so base is red by assertion. The builder-parity test (C4, last class) is a
regression pin on today's behaviour that cannot pass at base only because it resolves the route
through the new function: it asks for both builders' stamps AND that they resolve to the same route.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import independence_check as ic
from aria_kernel.ledger import LedgerIntegrityError
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests.test_seat_principal import _response

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


def _owner():
    missing = [name for name in ("executed_route_of", "stamp_dispatch_model", "DISPATCH_MODEL_KEY") if not hasattr(ic, name)]
    if missing:
        raise AssertionError(f"F3.1: aria_kernel.independence_check has no {' / '.join(missing)} (the route owner is not extended)")
    return ic


class TheSpawnPathReadsNoLedgerTests(unittest.TestCase):
    def test_the_stamped_dispatch_model_names_the_route_and_no_ledger_is_read(self) -> None:
        owner = _owner()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ic, "load_declared_jsonl") as load:
            for model, expected in (
                ("glm-5.3", ("zai", "glm-5.3")),
                ("claude-opus-5", ("anthropic", "claude-opus-5")),
                ("sonnet", ("anthropic", "sonnet")),  # a tier the fleet does not list: the managed Anthropic session's
            ):
                with self.subTest(model=model):
                    self.assertEqual(owner.executed_route_of(_response(agent_dispatch_model=model), base_dir=tmp), expected)
            load.assert_not_called()

    def test_no_stamp_and_no_attempt_is_no_route(self) -> None:
        owner = _owner()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ic, "load_declared_jsonl") as load:
            self.assertIsNone(owner.executed_route_of(_response(), base_dir=tmp))
            self.assertIsNone(owner.executed_route_of(_response(agent_dispatch_model="  "), base_dir=tmp))
            self.assertIsNone(owner.executed_route_of({"details": "not-an-object"}, base_dir=tmp))
            load.assert_not_called()


class TheNativePathReadsTheGovernanceLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-f31-route-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def _attempt(self, **overrides: object) -> dict:
        details = {"request_id": "AIR-1", "claim_id": "claim-1", "provider": "openai", "model": "gpt-6-astra", **overrides}
        return append_tools_governance(self.tools, "runtime_attempt_started", details)

    def _native(self, row: dict, **details: object) -> dict:
        return _response(runtime_attempt_ledger_hash=row["ledger_hash"], **details)

    def test_the_attempt_row_bound_to_this_request_and_claim_names_the_route(self) -> None:
        owner = _owner()
        row = self._attempt()
        self.assertEqual(owner.executed_route_of(self._native(row), base_dir=self.tools), ("openai", "gpt-6-astra"))
        # A stamp that agrees with the row is not a contradiction.
        self.assertEqual(owner.executed_route_of(self._native(row, agent_dispatch_model="gpt-6-astra"), base_dir=self.tools),
                         ("openai", "gpt-6-astra"))

    def test_every_disagreement_between_the_envelope_and_the_ledger_is_no_route(self) -> None:
        owner = _owner()
        control = self._attempt()
        self.assertIsNotNone(owner.executed_route_of(self._native(control), base_dir=self.tools))
        other_claim = self._attempt(claim_id="claim-2")
        other_request = self._attempt(request_id="AIR-2")
        cases = {
            "a row bound to another claim": self._native(other_claim),
            "a row bound to another request": self._native(other_request),
            "a stamp that contradicts the row's model": self._native(control, agent_dispatch_model="opus"),
            "a hash the ledger does not hold": _response(runtime_attempt_ledger_hash="sha256:elsewhere"),
        }
        for name, response in cases.items():
            with self.subTest(case=name):
                self.assertIsNone(owner.executed_route_of(response, base_dir=self.tools))

    def test_a_hash_the_ledger_holds_twice_is_no_route(self) -> None:
        owner = _owner()
        row = self._attempt()
        with mock.patch.object(ic, "load_declared_jsonl", return_value=[row, dict(row)]):
            self.assertIsNone(owner.executed_route_of(self._native(row), base_dir=self.tools))
        # The control: the same call over a ledger that holds it once.
        with mock.patch.object(ic, "load_declared_jsonl", return_value=[row]):
            self.assertEqual(owner.executed_route_of(self._native(row), base_dir=self.tools), ("openai", "gpt-6-astra"))

    def test_an_unreadable_governance_ledger_is_no_route_and_does_not_raise(self) -> None:
        owner = _owner()
        row = self._attempt()
        (self.tools / "governance.jsonl").write_text("not json at all\n", encoding="utf-8")
        self.assertIsNone(owner.executed_route_of(self._native(row), base_dir=self.tools))

    def test_only_the_ledger_s_own_failure_modes_are_swallowed(self) -> None:
        owner = _owner()
        row = self._attempt()
        response = self._native(row)
        for failure in (GovernanceError("g"), LedgerIntegrityError("l"), OSError("o"), ValueError("v")):
            with self.subTest(failure=type(failure).__name__), mock.patch.object(ic, "load_declared_jsonl", side_effect=failure):
                self.assertIsNone(owner.executed_route_of(response, base_dir=self.tools))
        # Anything else is a defect and propagates (the contract ``_LEDGER_READ_FAILURES`` documents).
        with mock.patch.object(ic, "load_declared_jsonl", side_effect=RuntimeError("a defect")):
            with self.assertRaises(RuntimeError):
                owner.executed_route_of(response, base_dir=self.tools)


class ThereIsOneResolutionTests(unittest.TestCase):
    def test_executed_route_of_returns_what_executed_route_resolved(self) -> None:
        owner = _owner()
        sentinel = ("sentinel-provider", "sentinel-model")
        response = _response(agent_dispatch_model="glm-5.3")
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ic, "executed_route", return_value=sentinel) as resolve:
            self.assertEqual(owner.executed_route_of(response, base_dir=tmp), sentinel)
        resolve.assert_called_once()
        self.assertIs(resolve.call_args.args[0], response)

    def test_the_resolver_reads_the_stamp_through_the_one_key_constant(self) -> None:
        owner = _owner()
        self.assertEqual(owner.DISPATCH_MODEL_KEY, "agent_dispatch_model")
        with mock.patch.object(ic, "DISPATCH_MODEL_KEY", "route_probe_key"):
            self.assertEqual(ic.executed_route({"details": {"route_probe_key": "glm-5.3"}}, attempt_rows=()), ("zai", "glm-5.3"))
            self.assertIsNone(ic.executed_route({"details": {"agent_dispatch_model": "glm-5.3"}}, attempt_rows=()))


class TheStampWriterTests(unittest.TestCase):
    def test_a_named_model_overwrites_whatever_the_agent_wrote(self) -> None:
        owner = _owner()
        details = {"agent_dispatch_model": "claude-opus-5", "agent_subagent_type": "aria-implementer"}
        self.assertIsNone(owner.stamp_dispatch_model(details, "glm-5.3"))
        self.assertEqual(details, {"agent_dispatch_model": "glm-5.3", "agent_subagent_type": "aria-implementer"})
        fresh: dict = {}
        owner.stamp_dispatch_model(fresh, "glm-5.3")
        self.assertEqual(fresh, {"agent_dispatch_model": "glm-5.3"})

    def test_no_model_removes_the_key_rather_than_leaving_the_agents_spelling(self) -> None:
        owner = _owner()
        for model in (None, ""):
            with self.subTest(model=model):
                details = {"agent_dispatch_model": "claude-opus-5", "keep": 1}
                owner.stamp_dispatch_model(details, model)
                self.assertEqual(details, {"keep": 1})
        empty: dict = {}
        owner.stamp_dispatch_model(empty, None)
        self.assertEqual(empty, {})


class BothExecutorBuildersWriteTheSameStampTests(unittest.TestCase):
    """The generic envelope builder and the judge-batch builder each used to spell the key inline."""

    @staticmethod
    def _generic(model: str | None) -> dict:
        from ci_executor import _build_envelope_from_claude_output

        final = "```json\n" + json.dumps({"status": "submitted", "details": {"agent_dispatch_model": "claude-opus-5"}}) + "\n```"
        stdout = json.dumps({"type": "result", "result": final, "subtype": "success"})
        return _build_envelope_from_claude_output(
            raw_stdout=stdout, request_id="AIR-1", claim_id="claim-1", agent_id="ci-executor:gha-1", role="evidence_judgment",
            subagent_type="aria-adversarial-judge", must_satisfy=[], dispatch_model=model,
        )

    @staticmethod
    def _judge_batch(model: str) -> dict:
        from types import SimpleNamespace

        from ci_executor_judge_batch import build_envelope_from_typed_answer

        from aria_kernel.typed_judgment import TypedAnswer

        answer = TypedAnswer(question_id="AIR-1", primitive="noul", value="true_positive", probabilities=None,
                             confidence=0.9, evidence=(), rationale="seen")
        return build_envelope_from_typed_answer(
            question=SimpleNamespace(evidence_refs=()), answer=answer, request={"request_id": "AIR-1"}, claim_id="claim-1",
            agent_id="ci-executor:gha-1", role="evidence_judgment", subagent_type="aria-adversarial-judge", must_satisfy=[],
            dispatch_model=model, confidence_source="self_reported", contract_hash="sha256:" + "c" * 64,
            attempt_ledger_hash="sha256:" + "d" * 64,
        )

    def test_the_two_builders_stamp_the_same_model_and_it_resolves_to_one_route(self) -> None:
        owner = _owner()
        for model, route in (("glm-5.3", ("zai", "glm-5.3")), ("claude-opus-5", ("anthropic", "claude-opus-5"))):
            with self.subTest(model=model):
                generic, batch = self._generic(model), self._judge_batch(model)
                self.assertEqual(generic["details"]["agent_dispatch_model"], model)
                self.assertEqual(batch["details"]["agent_dispatch_model"], model)
                with tempfile.TemporaryDirectory() as tmp:
                    # The batch envelope also names a runtime attempt; the spawn-shaped one does not. Compare the stamp's
                    # route on the spawn-shaped envelope and the stamp alone on the batch one.
                    self.assertEqual(owner.executed_route_of(generic, base_dir=tmp), route)
                    self.assertEqual(ic.executed_route({"details": {owner.DISPATCH_MODEL_KEY: batch["details"][owner.DISPATCH_MODEL_KEY]}},
                                                       attempt_rows=()), route)

    def test_a_route_that_named_no_model_leaves_no_stamp_on_the_generic_envelope(self) -> None:
        owner = _owner()
        envelope = self._generic(None)
        self.assertNotIn(owner.DISPATCH_MODEL_KEY, envelope["details"])


if __name__ == "__main__":
    unittest.main()
