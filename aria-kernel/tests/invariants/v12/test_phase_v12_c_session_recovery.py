"""Plan 032 Faz 032c — sessions are fingerprinted; recovery is a classification.

Invariants:
  I-V12-SESS-01  the fingerprint changes when ANY authority input changes
                 (target sha, profile, prompt hash, settings hash, model family,
                 policy version) and is stable otherwise.
  I-V12-SESS-02  `decide_session` resumes only when the last bound session has the
                 same fingerprint AND journal progress; otherwise it mints a fresh
                 session; every decision is bound on `agent-invocations/sessions.jsonl`.
  I-V12-SESS-03  `build_claude_exec_argv` carries `--session-id` for a fresh session
                 and `--resume` for a resumed one.
  I-V12-RECV-01  intent/receipt rows land on `recovery/external-effects.jsonl`; an
                 intent without a receipt is `unresolved`.
  I-V12-RECV-02  `classify_recovery`: no effects → idempotent_replay; unresolved
                 intent + remote says present → receipt recorded +
                 external_effect_check; remote cannot answer → human_required;
                 same fingerprint + progress → resume; every decision recorded.
  I-V12-RECV-03  `pr_manager.open_pr_for_action` records intent before and receipt
                 after `gh pr create` (source-level pin).
  I-V12-RECV-04  the executor releases with `recovery_unresolved_external_effect`
                 on a human_required decision (reason is classified request-fault
                 and has a structured code).

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import hooks, recovery, session_continuity as sc
from aria_kernel.agent_invocations import REQUEST_FAULT_RELEASE_REASONS, classify_release_reason
from aria_kernel.release_reason import parse_release_reason
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


class Fingerprints(unittest.TestCase):
    def test_I_V12_SESS_01_every_authority_input_moves_the_fingerprint(self) -> None:
        base = dict(target_sha="a" * 40, profile_id="implementer", prompt_hash="sha256:p", settings_hash="sha256:s", model="opus")
        stable = sc.session_fingerprint(**base)
        self.assertEqual(stable, sc.session_fingerprint(**base))
        for key, value in (("target_sha", "b" * 40), ("profile_id", "judge_opus"), ("prompt_hash", "sha256:q"),
                           ("settings_hash", "sha256:t"), ("model", "glm-5.3")):
            self.assertNotEqual(stable, sc.session_fingerprint(**{**base, key: value}), key)
        self.assertEqual(sc.session_fingerprint(**{**base, "model": "sonnet"}), stable, "same vendor family")
        self.assertNotEqual(sc.session_fingerprint(**base, policy_version="other"), stable)


class SessionsAreBound(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_SESS_02_resume_only_with_same_fingerprint_and_progress(self) -> None:
        first, resumed = sc.decide_session(request_id="AIR-1", claim_id="c1", fingerprint="fp:a", base_dir=self.tools)
        self.assertFalse(resumed)
        # no progress yet → a fresh session even with the same fingerprint
        second, resumed = sc.decide_session(request_id="AIR-1", claim_id="c2", fingerprint="fp:a", base_dir=self.tools)
        self.assertFalse(resumed)
        self.assertNotEqual(first, second)
        hooks.record_journal({"tool_name": "Bash", "tool_input": {"command": "git status"}},
                             base_dir=self.tools, request_id="AIR-1", session_id=second, tool_use_id="t")
        third, resumed = sc.decide_session(request_id="AIR-1", claim_id="c3", fingerprint="fp:a", base_dir=self.tools)
        self.assertTrue(resumed)
        self.assertEqual(third, second)
        fourth, resumed = sc.decide_session(request_id="AIR-1", claim_id="c4", fingerprint="fp:b", base_dir=self.tools)
        self.assertFalse(resumed, "a changed envelope never resumes")
        rows = sc.sessions_for("AIR-1", base_dir=self.tools)
        self.assertEqual([r["claim_id"] for r in rows], ["c1", "c2", "c3", "c4"])
        self.assertEqual(rows[2]["resumed_from"], "c2")

    def test_I_V12_SESS_03_argv_carries_the_session_flag(self) -> None:
        import claude_runtime

        fresh = claude_runtime.build_claude_exec_argv(model="opus", session_id="11111111-1111-1111-1111-111111111111")
        self.assertIn("--session-id", fresh)
        self.assertNotIn("--resume", fresh)
        resumed = claude_runtime.build_claude_exec_argv(model="opus", session_id="x", resume=True)
        self.assertEqual(resumed[resumed.index("--resume") + 1], "x")
        self.assertNotIn("--session-id", claude_runtime.build_claude_exec_argv(model="opus"))


class RecoveryClassifies(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_RECV_01_intents_and_receipts(self) -> None:
        intent = recovery.record_intent(request_id="AIR-1", effect_kind="pr_create", target="main<-aria-impl-1",
                                        intended_postcondition={"head_ref": "aria-impl-1"}, base_dir=self.tools)
        self.assertEqual([i["operation_id"] for i in recovery.unresolved_intents("AIR-1", base_dir=self.tools)], [intent["operation_id"]])
        recovery.record_receipt(operation_id=intent["operation_id"], request_id="AIR-1", observed={"pr_number": 7}, base_dir=self.tools)
        self.assertEqual(recovery.unresolved_intents("AIR-1", base_dir=self.tools), [])
        with self.assertRaises(ValueError):
            recovery.record_intent(request_id="AIR-1", effect_kind="teleport", target="x", intended_postcondition={}, base_dir=self.tools)

    def test_I_V12_RECV_02_decisions(self) -> None:
        clean = recovery.classify_recovery("AIR-0", base_dir=self.tools, fingerprint="fp:a", remote_reader=lambda i: None)
        self.assertEqual(clean.decision, "idempotent_replay")
        recovery.record_intent(request_id="AIR-1", effect_kind="git_push", target="origin/aria-impl-1",
                               intended_postcondition={"branch": "aria-impl-1"}, base_dir=self.tools)
        blind = recovery.classify_recovery("AIR-1", base_dir=self.tools, fingerprint="fp:a", remote_reader=lambda i: None)
        self.assertEqual(blind.decision, "human_required")
        self.assertEqual(len(blind.unresolved_intents), 1)
        answered = recovery.classify_recovery("AIR-1", base_dir=self.tools, fingerprint="fp:a",
                                              remote_reader=lambda i: {"present": True, "remote_sha": "abc"})
        self.assertEqual(answered.decision, "external_effect_check")
        self.assertEqual(recovery.unresolved_intents("AIR-1", base_dir=self.tools), [])
        session_id, _ = sc.decide_session(request_id="AIR-2", claim_id="c1", fingerprint="fp:z", base_dir=self.tools)
        hooks.record_journal({"tool_name": "Bash", "tool_input": {"command": "git status"}},
                             base_dir=self.tools, request_id="AIR-2", session_id=session_id, tool_use_id="t")
        resume = recovery.classify_recovery("AIR-2", base_dir=self.tools, fingerprint="fp:z", remote_reader=lambda i: None)
        self.assertEqual((resume.decision, resume.session_id), ("resume", session_id))
        changed = recovery.classify_recovery("AIR-2", base_dir=self.tools, fingerprint="fp:other", remote_reader=lambda i: None)
        self.assertEqual((changed.decision, changed.reason), ("idempotent_replay", "fingerprint_changed"))
        from aria_kernel.ledger import load_declared_jsonl

        rows = load_declared_jsonl(self.tools.joinpath(*recovery.RECOVERY_DECISIONS_RELPATH), expected_surface=recovery.RECOVERY_DECISIONS_SURFACE)
        self.assertEqual([r["decision"] for r in rows], ["idempotent_replay", "human_required", "external_effect_check", "resume", "idempotent_replay"])

    def test_I_V12_RECV_03_pr_manager_brackets_the_external_write(self) -> None:
        source = (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "pr_manager.py").read_text(encoding="utf-8")
        create = source.index('"gh", "pr", "create"')
        self.assertLess(source.rindex("record_intent(", 0, create), create)
        self.assertGreater(source.index("record_receipt(", create), create)
        push = source.index('["push", "-u", remote, branch]')
        self.assertLess(source.rindex('effect_kind="git_push"', 0, push), push)

    def test_I_V12_RECV_04_the_executor_release_reason_is_owned_and_coded(self) -> None:
        self.assertIn("recovery_unresolved_external_effect", REQUEST_FAULT_RELEASE_REASONS)
        self.assertEqual(classify_release_reason("recovery_unresolved_external_effect"), "request")
        self.assertEqual(parse_release_reason("recovery_unresolved_external_effect").reason_code, "RECOVERY_UNRESOLVED_EXTERNAL_EFFECT")
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        self.assertIn('reason="recovery_unresolved_external_effect"', executor)
        self.assertIn("_decide_session_and_recovery(", executor)


if __name__ == "__main__":
    unittest.main()
