"""WP-P — a night with ONE provider alive completes: cycle, round, attribution.

Operator decision (2026-10-18, HANDOVER §7 / WP-P package §3): "Sometimes it
is Z.ai, sometimes Codex, sometimes Claude. The system must not stop because
one is missing; with even one available, every cycle must complete." The
none-provider night holds (ARIA-HIGH-579, pinned beside this file); these are
the ANY-one nights, and they run through the same production entry point
(``aria-kernel autonomy run --profile standard``, in process) with the real
planner dispatch hook and its real ``ci_executor`` child — the lane 579's
harness stood down. The only declared substitute is the vendor (a recording
fake CLI; see ``tests/_helpers/night_harness.py`` for the full budget).

The completed-night contract (design WP-P round 2 §1), one behaviour per test:

* OBSERVABILITY OF "CYCLE COMPLETED" — exit ok with ``cycles_completed >= 1``
  is necessary and insufficient: the night must also write the
  ``cycle_completed`` phase, a TERMINAL ``completed`` row in cycles.jsonl, and
  a non-failed ``autonomy_orchestrator_exit`` governance row the doctor reads.
* NO SILENT SKIPPING — every ledger the held night leaves untouched
  (ARIA-HIGH-579's ``_UNTOUCHED_BY_A_HELD_NIGHT`` digest, inverted) must MOVE,
  and the night must show a REAL attempt on the surviving provider for the
  round request it minted: an exit-ok night that quietly judged nothing fails
  here, not at 3am.
* ATTRIBUTION — on an only-P night every attempt is P's: no attempt, usage or
  admission row charges a provider the scenario killed; the dead providers
  appear only as decided-unavailable rungs the admission walked past.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests._helpers.night_harness import (
    DynamicZaiVendor, NightStore, serving_claude_cli, serving_codex_cli,
)
from tests._helpers.operator_acts import operator_set_profile
from tests._helpers.single_provider_host import claude_host, codex_host, zai_host

_PROVIDER = "anthropic"
_PLAN = "plan-only-claude"

# The 579 digest, read from its owner file (no second copy): the ledgers a
# HELD night must leave byte-identical are exactly the ledgers a COMPLETED
# night must move.
from tests.test_night_holds_while_every_provider_is_out import (  # noqa: E402
    _UNTOUCHED_BY_A_HELD_NIGHT,
)


def _digest(store: NightStore, names: tuple[str, ...]) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for name in names:
        root = store.tools / name
        assert root.exists(), f"pinned path absent, so it pins nothing: {name}"
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if path.is_file() and not path.name.endswith(".lock"):
                out[str(path.relative_to(store.tools))] = path.read_bytes()
    return out


class OnlyClaudeNightCompletes(unittest.TestCase):
    """Two nights on a host that presents Anthropic and nothing else.

    Night 1 runs the cycle that mints the plan's challenger round request
    (the production order: the drain runs before the convergence phase that
    mints it — 579's nights 0 and 2 have the same shape). Night 2's drain
    finds it: the real hook claims it, the real executor child admits the
    Anthropic route (Z.ai and Codex decided-unavailable by name), runs the
    recording CLI inside the real room, and submits the envelope; the bridge
    folds it and the plan's round advances.
    """

    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        from aria_kernel.plan_convergence import start_plan

        cls._tmp = Path(tempfile.mkdtemp(prefix="aria-night-only-claude-"))
        cls.addClassCleanup(cls._cleanup)
        cls.host = claude_host()
        cls.addClassCleanup(cls.host.close)
        script = serving_claude_cli(log=cls.host.invocation_log, plan_title="only-claude night plan")
        cls.store = NightStore(cls._tmp, cli_script=script)
        env = cls.store.night_env(cls.host.environ())
        # ADR-040's acknowledgement, as the native Claude lane's fixture
        # carries it: the suite runs as root, and the room is a genuine
        # sandbox. The fixture binary is not the CLI; nothing else changes.
        env["ARIA_CLAUDE_SANDBOX"] = "1"
        cls._env = env
        import unittest.mock

        patch = unittest.mock.patch.dict(os.environ, env, clear=True)
        patch.start()
        cls.addClassCleanup(patch.stop)
        operator_set_profile("standard", base_dir=cls.store.tools)
        start_plan(plan_id=_PLAN, initial_revision_id="rev-0", plan_content={
            "schema_version": 1, "title": "only-claude night plan",
            "summary": "the plan the only-claude night carries",
            "affected_surfaces": [{"paths": ["src/app.ts"]}],
            "key_changes": [{"id": "kc-0", "description": "apply the declared change",
                             "paths": ["src/app.ts"], "imports": []}],
            "validation_commands": [{"cmd": "npx nx affected --target=lint", "timeout_ms": 600_000}],
            "evidence_refs": ["src/app.ts:1"], "architectural_tier": 1,
        }, base_dir=cls.store.tools)

        cls.n1 = cls.store.run()
        # A queued item, as the 579 fixture seeds one: the queues ledger a
        # held night freezes exists because a night queued it, and a completed
        # night must write its own.
        from aria_kernel.next_cycle_queue import append_pending

        append_pending(cls.store.tools, source_cycle_id="cyc-before-this-night",
                       pressure_id="PE-only-claude-queued")
        cls.digest_before = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.requests_after_n1 = cls.store.requests()
        cls.n2 = cls.store.run()
        cls.digest_after = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.gov_after_n2 = cls.store.governance()
        cls.cycles = cls.store.cycles_rows()

    @classmethod
    def _cleanup(cls) -> None:
        import shutil
        import os as _os
        if _os.environ.get("ARIA_NIGHT_KEEP"):
            print("KEEP", cls._tmp)
            return
        shutil.rmtree(cls._tmp, ignore_errors=True)

    # --- the host is what it says it is ---------------------------------------------------------

    def test_the_host_presents_anthropic_and_nothing_else(self) -> None:
        self.assertEqual([p.key for p in self.host.available()], ["anthropic"])

    # --- observability of "cycle completed" ------------------------------------------------------

    def test_the_night_exits_clean_and_completes_a_cycle(self) -> None:
        code, summary, _rows = self.n2
        self.assertEqual(code, 0, summary)
        self.assertEqual(summary["exit_reason"], "max_cycles")
        self.assertEqual(summary["overall_status"], "ok")
        self.assertGreaterEqual(summary["cycles_completed"], 1)

    def test_the_completed_cycle_is_observable_in_three_ledgers(self) -> None:
        _code, _summary, rows = self.n2
        self.assertIn("cycle_completed", [row["phase"] for row in rows])
        cycle_ids = {row["cycle_id"] for row in rows if row.get("cycle_id")}
        terminal = [row for row in self.cycles
                    if row.get("event") == "completed" and row.get("cycle_id") in cycle_ids]
        self.assertTrue(terminal, self.cycles)
        exits = [row for row in self.gov_after_n2 if row["kind"] == "autonomy_orchestrator_exit"]
        self.assertTrue(exits)
        self.assertNotIn(exits[-1]["details"]["exit_reason"],
                         ("cycle_failed", "autonomous_preflight_blocked"))

    # --- no silent skipping ---------------------------------------------------------------------

    def test_every_ledger_a_held_night_freezes_moves_on_a_completed_night(self) -> None:
        moved = {name for name, before in self.digest_before.items()
                 if self.digest_after.get(name) != before}
        frozen = {name for name in self.digest_before if name not in moved}
        self.assertFalse(frozen, sorted(frozen))

    def test_the_night_minted_and_the_next_night_really_served_the_round_request(self) -> None:
        minted = [row for row in self.requests_after_n1 if row.get("convergence_id") == _PLAN]
        self.assertEqual([row["role"] for row in minted], ["challenger_plan"], minted)
        rid = minted[0]["request_id"]
        from aria_kernel.agent_invocations import derive_request_state

        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.store.tools), "ACCEPTED")
        accepted = [row for row in self.gov_after_n2 if row["kind"] == "agent_result_accepted"]
        self.assertTrue(accepted)

    def test_the_serving_night_attempted_on_the_surviving_provider(self) -> None:
        attempts = [row["details"] for row in self.gov_after_n2
                    if row["kind"] == "runtime_attempt_started"]
        self.assertTrue(attempts, "the night completed without attempting any dispatch")
        self.assertEqual({attempt["provider"] for attempt in attempts}, {_PROVIDER})

    def test_the_vendor_was_reached_through_the_recording_cli(self) -> None:
        # Outside the room the status probe reached the host-side log; inside
        # the room the run's evidence rides the sealed envelope's details
        # (the native fixtures' rule: a child's observation travels in its
        # answer, because the room's private /tmp hides every host path).
        argvs = [row["argv"] for row in self.host.calls()]
        self.assertTrue(any(argv == ["--version"] for argv in argvs), argvs)
        minted = [row for row in self.requests_after_n1 if row.get("convergence_id") == _PLAN]
        envelope = json.loads(Path(minted[0]["expected_output_path"]).read_text(encoding="utf-8"))
        self.assertIn("-p", envelope["details"]["vendor_argv"], envelope["details"])

    # --- attribution ----------------------------------------------------------------------------------------------------------

    def test_no_row_charges_a_provider_the_scenario_killed(self) -> None:
        for row in self.gov_after_n2:
            if row["kind"] == "runtime_attempt_started":
                self.assertEqual(row["details"]["provider"], _PROVIDER)
        admissions = [row for row in self.gov_after_n2 if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(admissions, [], "the surviving provider needed no refusal row")

    def test_the_dead_providers_appear_only_as_rungs_the_admission_walked_past(self) -> None:
        attempt = next(row["details"] for row in self.gov_after_n2
                       if row["kind"] == "runtime_attempt_started")
        observations = {row["provider"]: row for row in attempt["admission"]["candidate_observations"]}
        self.assertEqual(set(observations), {"anthropic", "zai", "openai"})
        self.assertEqual(observations["anthropic"]["decision"], "available")
        for provider in ("zai", "openai"):
            self.assertEqual(observations[provider]["decision"], "unavailable", provider)

    # --- the round advanced ----------------------------------------------------------------------------------------------------

    def test_the_accepted_round_advanced_the_plan(self) -> None:
        requests = self.store.requests()
        roles = {row["role"] for row in requests if row.get("convergence_id") == _PLAN}
        self.assertIn("cross_review", roles, "the challenger was accepted but no review round followed")




class OnlyZaiNightCompletes(unittest.TestCase):
    """The same two nights on a host that presents Z.ai and nothing else.

    No CLI exists anywhere on the night's PATH: the kernel's own HTTP
    transport is the route, and the vendor substitute is a local server
    standing in for api.z.ai (the native Z.ai lane's fixture shape). The
    completed-night contract is OnlyClaudeNightCompletes' (inherited); what
    changes is the provider every attempt must name and the dead pair the
    admission walked past (Anthropic has no CLI on PATH, Codex no session).
    """

    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        from aria_kernel.plan_convergence import start_plan

        cls._tmp = Path(tempfile.mkdtemp(prefix="aria-night-only-zai-"))
        cls.addClassCleanup(cls._cleanup)
        cls.vendor = DynamicZaiVendor(plan_title="only-zai night plan").start()
        cls.addClassCleanup(cls.vendor.stop)
        cls.host = zai_host(endpoint=cls.vendor.base_url)
        cls.addClassCleanup(cls.host.close)
        cls.store = NightStore(cls._tmp)
        env = cls.store.night_env(cls.host.environ())
        cls._env = env
        import unittest.mock

        patch = unittest.mock.patch.dict(os.environ, env, clear=True)
        patch.start()
        cls.addClassCleanup(patch.stop)
        operator_set_profile("standard", base_dir=cls.store.tools)
        start_plan(plan_id=_PLAN, initial_revision_id="rev-0", plan_content={
            "schema_version": 1, "title": "only-zai night plan",
            "summary": "the plan the only-zai night carries",
            "affected_surfaces": [{"paths": ["src/app.ts"]}],
            "key_changes": [{"id": "kc-0", "description": "apply the declared change",
                             "paths": ["src/app.ts"], "imports": []}],
            "validation_commands": [{"cmd": "npx nx affected --target=lint", "timeout_ms": 600_000}],
            "evidence_refs": ["src/app.ts:1"], "architectural_tier": 1,
        }, base_dir=cls.store.tools)
        cls.n1 = cls.store.run()
        from aria_kernel.next_cycle_queue import append_pending

        append_pending(cls.store.tools, source_cycle_id="cyc-before-this-night",
                       pressure_id="PE-only-zai-queued")
        cls.digest_before = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.requests_after_n1 = cls.store.requests()
        cls.n2 = cls.store.run()
        cls.digest_after = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.gov_after_n2 = cls.store.governance()
        cls.cycles = cls.store.cycles_rows()

    @classmethod
    def _cleanup(cls) -> None:
        import shutil
        import os as _os
        if _os.environ.get("ARIA_NIGHT_KEEP"):
            print("KEEP", cls._tmp)
            return
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_the_host_presents_zai_and_nothing_else(self) -> None:
        self.assertEqual([p.key for p in self.host.available()], ["zai"])
        self.assertIsNone(self.host.which("claude"))
        self.assertIsNone(self.host.which("codex"))

    def test_the_night_exits_clean_and_completes_a_cycle(self) -> None:
        code, summary, _rows = self.n2
        self.assertEqual((code, summary["exit_reason"], summary["overall_status"]),
                         (0, "max_cycles", "ok"), summary)
        self.assertGreaterEqual(summary["cycles_completed"], 1)

    def test_the_completed_cycle_is_observable_in_three_ledgers(self) -> None:
        _code, _summary, rows = self.n2
        self.assertIn("cycle_completed", [row["phase"] for row in rows])
        cycle_ids = {row["cycle_id"] for row in rows if row.get("cycle_id")}
        terminal = [row for row in self.cycles
                    if row.get("event") == "completed" and row.get("cycle_id") in cycle_ids]
        self.assertTrue(terminal, self.cycles)
        exits = [row for row in self.gov_after_n2 if row["kind"] == "autonomy_orchestrator_exit"]
        self.assertTrue(exits)
        self.assertNotIn(exits[-1]["details"]["exit_reason"],
                         ("cycle_failed", "autonomous_preflight_blocked"))

    def test_every_ledger_a_held_night_freezes_moves_on_a_completed_night(self) -> None:
        frozen = {name for name, before in self.digest_before.items()
                  if self.digest_after.get(name) == before}
        self.assertFalse(frozen, sorted(frozen))

    def test_the_night_minted_and_the_next_night_really_served_the_round_request(self) -> None:
        minted = [row for row in self.requests_after_n1 if row.get("convergence_id") == _PLAN]
        self.assertEqual([row["role"] for row in minted], ["challenger_plan"], minted)
        rid = minted[0]["request_id"]
        from aria_kernel.agent_invocations import derive_request_state

        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.store.tools), "ACCEPTED")

    def test_the_serving_night_attempted_on_the_surviving_provider(self) -> None:
        attempts = [row["details"] for row in self.gov_after_n2
                    if row["kind"] == "runtime_attempt_started"]
        self.assertTrue(attempts, "the night completed without attempting any dispatch")
        self.assertEqual({attempt["provider"] for attempt in attempts}, {"zai"})

    def test_the_vendor_was_reached_through_the_local_transport(self) -> None:
        self.assertTrue(self.vendor.received, "the night never reached the vendor")
        self.assertTrue(all(row["path"] == "/chat/completions" for row in self.vendor.received))
        run_turns = [row["json"] for row in self.vendor.received
                     if "obligation_data" in str(row["json"]["messages"][-1]["content"])]
        self.assertTrue(run_turns, "no run turn reached the vendor")
        self.assertEqual(run_turns[-1]["model"], "glm-5.3")
        self.assertTrue(all(row["authorization"] for row in self.vendor.received))

    def test_no_row_charges_a_provider_the_scenario_killed(self) -> None:
        for row in self.gov_after_n2:
            if row["kind"] == "runtime_attempt_started":
                self.assertEqual(row["details"]["provider"], "zai")
        admissions = [row for row in self.gov_after_n2 if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(admissions, [], "the surviving provider needed no refusal row")

    def test_the_dead_providers_appear_only_as_rungs_the_admission_walked_past(self) -> None:
        attempt = next(row["details"] for row in self.gov_after_n2
                       if row["kind"] == "runtime_attempt_started")
        observations = {row["provider"]: row for row in attempt["admission"]["candidate_observations"]}
        self.assertEqual(set(observations), {"anthropic", "zai", "openai"})
        self.assertEqual(observations["zai"]["decision"], "available")
        for provider in ("anthropic", "openai"):
            self.assertEqual(observations[provider]["decision"], "unavailable", provider)




class OnlyCodexNightCompletes(unittest.TestCase):
    """The same two nights on a host that presents Codex and nothing else.

    Codex is not installed on this host (WP-P package §0): the CLI is the
    recording fake (status probe + one ``exec --json`` run honouring
    --output-last-message, exit 97 on unknown argv), the credential the
    managed ChatGPT session file under ``CODEX_HOME`` — never an API key.
    The read lane is what this night drives: glm_first's third rung serves
    the round request on a host where the first two rungs are
    decided-unavailable. The WRITE seat on Codex is WP-P's open cell (the
    matrix's ``implementation x openai`` refusal, ``admits_writes=False``);
    pinning its current refusal is test_provider_matrix_invariant's job and
    opening it is the gate-flip commit's, not this night's.
    """

    @classmethod
    def setUpClass(cls) -> None:
        import tempfile

        from aria_kernel.plan_convergence import start_plan

        cls._tmp = Path(tempfile.mkdtemp(prefix="aria-night-only-codex-"))
        cls.addClassCleanup(cls._cleanup)
        cls.host = codex_host()
        cls.addClassCleanup(cls.host.close)
        script = serving_codex_cli(log=cls.host.invocation_log, plan_title="only-codex night plan")
        cls.store = NightStore(cls._tmp)
        cls.store.install_cli("codex", script)
        env = cls.store.night_env(cls.host.environ())
        cls._env = env
        import unittest.mock

        patch = unittest.mock.patch.dict(os.environ, env, clear=True)
        patch.start()
        cls.addClassCleanup(patch.stop)
        operator_set_profile("standard", base_dir=cls.store.tools)
        start_plan(plan_id=_PLAN, initial_revision_id="rev-0", plan_content={
            "schema_version": 1, "title": "only-codex night plan",
            "summary": "the plan the only-codex night carries",
            "affected_surfaces": [{"paths": ["src/app.ts"]}],
            "key_changes": [{"id": "kc-0", "description": "apply the declared change",
                             "paths": ["src/app.ts"], "imports": []}],
            "validation_commands": [{"cmd": "npx nx affected --target=lint", "timeout_ms": 600_000}],
            "evidence_refs": ["src/app.ts:1"], "architectural_tier": 1,
        }, base_dir=cls.store.tools)
        cls.n1 = cls.store.run()
        from aria_kernel.next_cycle_queue import append_pending

        append_pending(cls.store.tools, source_cycle_id="cyc-before-this-night",
                       pressure_id="PE-only-codex-queued")
        cls.digest_before = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.requests_after_n1 = cls.store.requests()
        cls.n2 = cls.store.run()
        cls.digest_after = _digest(cls.store, _UNTOUCHED_BY_A_HELD_NIGHT)
        cls.gov_after_n2 = cls.store.governance()
        cls.cycles = cls.store.cycles_rows()

    @classmethod
    def _cleanup(cls) -> None:
        import shutil
        import os as _os
        if _os.environ.get("ARIA_NIGHT_KEEP"):
            print("KEEP", cls._tmp)
            return
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_the_host_presents_openai_and_nothing_else(self) -> None:
        self.assertEqual([p.key for p in self.host.available()], ["openai"])
        self.assertIsNone(self.host.which("claude"))

    def test_the_night_exits_clean_and_completes_a_cycle(self) -> None:
        code, summary, _rows = self.n2
        self.assertEqual((code, summary["exit_reason"], summary["overall_status"]),
                         (0, "max_cycles", "ok"), summary)
        self.assertGreaterEqual(summary["cycles_completed"], 1)

    def test_the_completed_cycle_is_observable_in_three_ledgers(self) -> None:
        _code, _summary, rows = self.n2
        self.assertIn("cycle_completed", [row["phase"] for row in rows])
        cycle_ids = {row["cycle_id"] for row in rows if row.get("cycle_id")}
        terminal = [row for row in self.cycles
                    if row.get("event") == "completed" and row.get("cycle_id") in cycle_ids]
        self.assertTrue(terminal, self.cycles)
        exits = [row for row in self.gov_after_n2 if row["kind"] == "autonomy_orchestrator_exit"]
        self.assertTrue(exits)
        self.assertNotIn(exits[-1]["details"]["exit_reason"],
                         ("cycle_failed", "autonomous_preflight_blocked"))

    def test_every_ledger_a_held_night_freezes_moves_on_a_completed_night(self) -> None:
        frozen = {name for name, before in self.digest_before.items()
                  if self.digest_after.get(name) == before}
        self.assertFalse(frozen, sorted(frozen))

    def test_the_night_minted_and_the_next_night_really_served_the_round_request(self) -> None:
        minted = [row for row in self.requests_after_n1 if row.get("convergence_id") == _PLAN]
        self.assertEqual([row["role"] for row in minted], ["challenger_plan"], minted)
        rid = minted[0]["request_id"]
        from aria_kernel.agent_invocations import derive_request_state

        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.store.tools), "ACCEPTED")

    def test_the_serving_night_attempted_on_the_surviving_provider(self) -> None:
        attempts = [row["details"] for row in self.gov_after_n2
                    if row["kind"] == "runtime_attempt_started"]
        self.assertTrue(attempts, "the night completed without attempting any dispatch")
        self.assertEqual({attempt["provider"] for attempt in attempts}, {"openai"})
        self.assertEqual({attempt["runtime"] for attempt in attempts}, {"codex"})

    def test_the_vendor_was_reached_through_the_recording_cli(self) -> None:
        # BOTH codex invocations run inside the room (the status probe and the
        # exec), so the host-side log stays empty: the run's evidence rides the
        # sealed envelope's details, and the status probe's answer is what the
        # admission's own observation recorded (auth_method chatgpt).
        self.assertEqual(self.host.calls(), [])
        minted = [row for row in self.requests_after_n1 if row.get("convergence_id") == _PLAN]
        envelope = json.loads(Path(minted[0]["expected_output_path"]).read_text(encoding="utf-8"))
        vendor_argv = envelope["details"]["vendor_argv"]
        self.assertEqual(vendor_argv[0], "exec", vendor_argv)
        self.assertIn("read-only", vendor_argv, vendor_argv)
        self.assertNotIn("workspace-write", vendor_argv, vendor_argv)
        attempt = next(row["details"] for row in self.gov_after_n2
                       if row["kind"] == "runtime_attempt_started")
        openai_row = next(row for row in attempt["admission"]["candidate_observations"]
                          if row["provider"] == "openai")
        self.assertEqual(openai_row["auth_method"], "chatgpt")

    def test_no_row_charges_a_provider_the_scenario_killed(self) -> None:
        for row in self.gov_after_n2:
            if row["kind"] == "runtime_attempt_started":
                self.assertEqual(row["details"]["provider"], "openai")
        admissions = [row for row in self.gov_after_n2 if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(admissions, [], "the surviving provider needed no refusal row")

    def test_the_dead_providers_appear_only_as_rungs_the_admission_walked_past(self) -> None:
        attempt = next(row["details"] for row in self.gov_after_n2
                       if row["kind"] == "runtime_attempt_started")
        observations = {row["provider"]: row for row in attempt["admission"]["candidate_observations"]}
        self.assertEqual(set(observations), {"anthropic", "zai", "openai"})
        self.assertEqual(observations["openai"]["decision"], "available")
        for provider in ("anthropic", "zai"):
            self.assertEqual(observations[provider]["decision"], "unavailable", provider)


if __name__ == "__main__":
    unittest.main()
