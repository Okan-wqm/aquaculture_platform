"""System One `ask` (ARIA-LOW-252) — registry-only questions, egress refusals, the call ledger.

The transport is a scripted callable (never the network). The registry is the
file ``<bound workspace>/aria-config/system-one-questions.json`` the store is
bound to — the only place a question can come from.

One property per test:

* A transport that fails (or raises) yields a pipeline-safe ``Unavailable`` and
  exactly one ``unavailable`` row; ``ask`` never raises into its caller.
* A question that is not English, a question not in the registry, and a call
  from a decision point the question is not registered for are refused, and
  the transport is never called.
* A state that looks like it carries a secret is refused before any egress.
* The ledger row carries the state's sha256, the exact model id the vendor
  named and the answer — never the state itself.
* Choice options are shuffled deterministically per (question, state).
* Disabled (the seeded default): no network, no row — main's behaviour.
* An answer from a model other than the registry's runs as shadow.
* The seeded registry validates, is disabled, and every question is shadow.
* The ledger is an observation surface, not memory, and no other kernel
  module names it (an answer is never read back as a lesson or must_satisfy).
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import system_one
from aria_kernel.jev_runtime import JevReply, JevUnavailable
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.state_manifest import STATE_SURFACES
from aria_kernel.system_one import Answer, Unavailable, ask, load_registry
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"

_J0 = {
    "id": "J0", "version": 1, "type": "noul",
    "instructions": "The diff fixes the problem described in the finding", "criteria": None,
    "decision_point": ["pre_pr_open", "merge_authority"], "mode": "shadow",
    "thresholds": {"question_below": 0.05}, "state_keys": ["finding", "diff"],
}
_KIND = {
    "id": "KIND", "version": 2, "type": "choice", "instructions": "Which kind of change the diff is",
    "criteria": {"fix": "A bug fix", "feature": "New behaviour", "refactor": "Same behaviour, new shape",
                 "test": "Tests only", "docs": "Documentation only"},
    "decision_point": ["pre_pr_open"], "mode": "order", "thresholds": {}, "state_keys": ["diff"],
}
_TURKISH = {**_J0, "id": "TR", "instructions": "Bu diff bulguyu düzeltiyor mu"}
_TRANSLIT = {**_J0, "id": "TRA", "instructions": "Bu diff bulguyu duzeltiyor mu"}

_STATE = {"finding": {"finding": "Repository query skips tenant scoping", "rule": "Use getScopedRepository"},
          "diff": "--- a/x.ts\n+++ b/x.ts\n-repo.getRepository(X)\n+repo.getScopedRepository(X)\n"}


class _Transport:
    def __init__(self, *replies: object) -> None:
        self.replies = list(replies)
        self.payloads: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> JevReply | JevUnavailable:
        self.payloads.append(payload)
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        assert isinstance(reply, (JevReply, JevUnavailable))
        return reply


def _noul(p: float, model: str = "jev-1.13.0", name: str = "J0") -> JevReply:
    return JevReply(model=model, answers={name: {"type": "noul", "noul": p}}, input_tokens=120)


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.write_registry([_J0, _KIND, _TURKISH, _TRANSLIT])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_registry(self, questions: list[dict[str, Any]], *, enabled: bool = True) -> None:
        path = self.root / "aria-config" / "system-one-questions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "$schema": "aria/system-one-questions/v1", "enabled": enabled, "model": "jev-1.13.0",
            "questions": questions,
        }), encoding="utf-8")

    def rows(self) -> list[dict[str, Any]]:
        path = self.tools.joinpath(*system_one.CALLS_RELPATH)
        return load_declared_jsonl(path, expected_surface=system_one.CALLS_SURFACE) if path.exists() else []

    def ask(self, question_id: str, state: Any, transport: _Transport, point: str = "pre_pr_open") -> Answer | Unavailable:
        return ask(question_id, state, decision_point=point, base_dir=self.tools, subject="test:1", transport=transport)


class Availability(_Store):
    def test_unavailable_transport_is_pipeline_safe_and_recorded_once(self) -> None:
        result = self.ask("J0", _STATE, _Transport(JevUnavailable("vendor_error_http_503")))
        self.assertEqual(result, Unavailable("J0", "unavailable", "vendor_error_http_503"))
        (row,) = self.rows()
        self.assertEqual((row["outcome"], row["reason"], row["answer"], row["model"]),
                         ("unavailable", "vendor_error_http_503", None, None))

    def test_a_raising_transport_never_reaches_the_caller(self) -> None:
        result = self.ask("J0", _STATE, _Transport(OSError("boom")))
        self.assertEqual(result, Unavailable("J0", "unavailable", "transport_raised:OSError"))
        self.assertEqual([row["outcome"] for row in self.rows()], ["unavailable"])

    def test_disabled_registry_calls_nothing_and_writes_nothing(self) -> None:
        self.write_registry([_J0], enabled=False)
        transport = _Transport()
        result = self.ask("J0", _STATE, transport)
        self.assertEqual(result, Unavailable("J0", "unavailable", "system_one_disabled"))
        self.assertEqual((transport.payloads, self.rows()), ([], []))

    def test_absent_registry_is_disabled(self) -> None:
        (self.root / "aria-config" / "system-one-questions.json").unlink()
        result = self.ask("J0", _STATE, _Transport())
        self.assertEqual(result, Unavailable("J0", "unavailable", "registry_absent"))
        self.assertEqual(self.rows(), [])


class Refusals(_Store):
    def assert_refused(self, result: Answer | Unavailable, transport: _Transport, reason: str) -> None:
        self.assertIsInstance(result, Unavailable)
        assert isinstance(result, Unavailable)
        self.assertEqual((result.outcome, result.reason.split(":")[0]), ("refused", reason))
        self.assertEqual(transport.payloads, [])
        self.assertEqual([(row["outcome"], row["reason"]) for row in self.rows()], [("refused", result.reason)])

    def test_non_english_question_is_refused(self) -> None:
        for question_id in ("TR", "TRA"):
            with self.subTest(question_id=question_id):
                transport = _Transport()
                self.assert_refused(self.ask(question_id, _STATE, transport), transport, "question_not_english")
                (self.tools / "system-one" / "calls.jsonl").unlink()

    def test_question_not_in_registry_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("J9", _STATE, transport), transport, "question_not_registered")

    def test_decision_point_the_question_is_not_registered_for_is_refused(self) -> None:
        transport = _Transport()
        self.assert_refused(self.ask("J0", _STATE, transport, point="judge_fanout"), transport,
                            "decision_point_not_registered")

    def test_secret_looking_state_is_refused_before_egress(self) -> None:
        secrets = (
            "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIE",
            "+DB_" + "PASSWORD=" + "hunter2hunter2",
            "token apikey_" + "0123456789abcdef" * 2,
            "gh" + "p_" + "A" * 36,
        )
        for leak in secrets:
            with self.subTest(leak=leak[:12]):
                transport = _Transport()
                state = {**_STATE, "diff": _STATE["diff"] + leak}
                self.assert_refused(self.ask("J0", state, transport), transport, "state_secret_shaped")
                self.assertNotIn(leak, (self.tools / "system-one" / "calls.jsonl").read_text(encoding="utf-8"))
                (self.tools / "system-one" / "calls.jsonl").unlink()

    def test_state_must_have_exactly_the_registered_keys(self) -> None:
        for state in ({"diff": "x"}, {**_STATE, "env": "x"}, "free text", {"finding": 3, "diff": "x"}):
            with self.subTest(state=str(state)[:20]):
                transport = _Transport()
                self.assert_refused(self.ask("J0", state, transport), transport, "state_shape")
                (self.tools / "system-one" / "calls.jsonl").unlink()

    def test_non_english_state_is_refused(self) -> None:
        transport = _Transport()
        state = {**_STATE, "finding": {"finding": "Kiracı sınırı aşılıyor", "rule": "r"}}
        self.assert_refused(self.ask("J0", state, transport), transport, "state_not_english")


class Ledger(_Store):
    def test_answered_row_carries_hash_model_answer_never_the_state(self) -> None:
        transport = _Transport(_noul(0.93))
        result = self.ask("J0", _STATE, transport)
        self.assertEqual(result, Answer(
            question_id="J0", version=1, type="noul", value=0.93, confidence=None, probabilities=None,
            model="jev-1.13.0", mode="shadow", decision_point="pre_pr_open",
        ))
        sent = transport.payloads[0]
        self.assertEqual((sent["model"], list(sent["questions"])), ("jev-1.13.0", ["J0"]))
        self.assertEqual(sent["questions"]["J0"], {"type": "noul", "instructions": _J0["instructions"]})
        (row,) = self.rows()
        self.assertEqual(row["state_sha256"], "sha256:" + hashlib.sha256(sent["state"].encode("utf-8")).hexdigest())
        self.assertEqual(json.loads(sent["state"]), _STATE)
        self.assertEqual(
            {k: row[k] for k in ("question_id", "question_version", "model", "decision_point", "mode",
                                 "outcome", "input_tokens", "subject")},
            {"question_id": "J0", "question_version": 1, "model": "jev-1.13.0", "decision_point": "pre_pr_open",
             "mode": "shadow", "outcome": "answered", "input_tokens": 120, "subject": "test:1"},
        )
        self.assertEqual(row["answer"], {"type": "noul", "noul": 0.93})
        self.assertIsInstance(row["latency_ms"], int)
        raw = (self.tools / "system-one" / "calls.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("getScopedRepository", raw)
        self.assertNotIn("tenant scoping", raw)

    def test_malformed_answer_is_unavailable(self) -> None:
        for answers in ({}, {"J0": {"type": "noul", "noul": 1.7}}, {"J0": {"type": "score", "score": 1}}):
            with self.subTest(answers=answers):
                result = self.ask("J0", _STATE, _Transport(JevReply("jev-1.13.0", answers, 5)))
                self.assertEqual(result, Unavailable("J0", "unavailable", "answer_malformed"))

    def test_other_model_answers_in_shadow(self) -> None:
        reply = JevReply("jev-1.14.0", {"KIND": {"type": "choice", "choice": "fix", "confidence": 0.8,
                                                 "probabilities": {"fix": 0.8, "test": 0.2}}}, 9)
        result = self.ask("KIND", {"diff": "x"}, _Transport(reply))
        assert isinstance(result, Answer)
        self.assertEqual((result.value, result.mode, result.model), ("fix", "shadow", "jev-1.14.0"))
        self.assertEqual(self.rows()[0]["declared_mode"], "order")


class Shuffle(_Store):
    def order_for(self, state: dict[str, str]) -> list[str]:
        transport = _Transport(JevReply("jev-1.13.0", {"KIND": {
            "type": "choice", "choice": "fix", "confidence": 0.9, "probabilities": {"fix": 0.9}}}, 1))
        self.ask("KIND", state, transport)
        return list(transport.payloads[0]["questions"]["KIND"]["criteria"])

    def test_options_are_a_deterministic_per_state_permutation(self) -> None:
        orders = [self.order_for({"diff": f"change {index}"}) for index in range(12)]
        for order in orders:
            self.assertEqual(sorted(order), sorted(_KIND["criteria"]))
        self.assertEqual(self.order_for({"diff": "change 3"}), orders[3])
        self.assertGreater(len({tuple(order) for order in orders}), 1)
        self.assertGreater(len({order[0] for order in orders}), 1)


class SeededRegistry(unittest.TestCase):
    def test_seed_is_valid_disabled_and_all_shadow_with_the_validated_wording(self) -> None:
        registry = load_registry(_REPO_ROOT)
        self.assertFalse(registry.enabled)
        self.assertEqual(registry.model, "jev-1.13.0")
        self.assertEqual(registry.invalid, {})
        self.assertEqual({q.mode for q in registry.questions.values()}, {"shadow"})
        self.assertEqual({qid: q.instructions for qid, q in registry.questions.items()}, {
            "J0": "The diff fixes the problem described in the finding",
            "R5": "The diff does what the message says",
            "J2": "The code excerpt is evidence for the problem the finding describes",
            "R4": "How relevant this file is to the problem described",
            "J1-tenant-scoping": "The query in this excerpt is scoped to the current tenant",
        })

    def test_registry_is_operator_policy_aria_cannot_write(self) -> None:
        from aria_kernel.implementation_safety import READONLY_PATHS
        from aria_kernel.self_improvement import AUTHORITY_SURFACES

        registry = "/".join(system_one.REGISTRY_RELPATH)
        self.assertTrue(any(registry.startswith(prefix) for prefix in READONLY_PATHS))
        self.assertIn(registry, AUTHORITY_SURFACES)

    def test_ledger_is_an_unread_observation_surface(self) -> None:
        (surface,) = [s for s in STATE_SURFACES if s.name == system_one.CALLS_SURFACE]
        self.assertEqual((surface.path_pattern, surface.observe_class, surface.memory, surface.write_driving),
                         ("system-one/calls.jsonl", "observation", False, False))
        readers = [
            path.name for path in _KERNEL.glob("*.py")
            if path.name not in ("system_one.py", "state_manifest.py")
            and ("system_one_calls" in (text := path.read_text(encoding="utf-8")) or "system-one/calls" in text)
        ]
        self.assertEqual(readers, [])


if __name__ == "__main__":
    unittest.main()
