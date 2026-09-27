"""ARIA-HIGH-162 — a profile that cannot write spawns in the READ shape.

Measured 2026-09-19: every judge (profiles ``judge_opus``, ``judge_glm``,
``arbiter`` — tools Read/Grep/Glob, no write scope, no MCP server) spawned
with ``--dangerously-skip-permissions`` under the WRITE containment, because
``invoke_claude_cli`` never passed ``skip_permissions=False``. Dropping the
sandbox instead would have been worse: an unconfined ``-p`` run inherits the
host's real ``~/.claude`` (``permissions.defaultMode: auto`` on this host,
plugins, session persistence), and ``--disallowedTools`` is a deny-list over
a twelve-name universe that does not name ``Skill``, ``EnterWorktree``,
``Artifact`` or ``SendMessage``.

What this pins, one property per test:

* eligibility is the pinned set AND the profile facts — exactly three kernel
  profiles qualify today; the planner profiles (MCP server) and every
  write-capable profile do not;
* the read shape's argv carries ``--restricted``, ``--permission-prompts
  none`` and ``--tools <the profile's grant>``, never the bypass flag, and
  keeps ``--disallowedTools`` as the belt; a read shape with write
  permissions cannot be built;
* the read containment binds the workspace read-only with no writable scope
  under it, keeps the managed login writable (ARIA-HIGH-157), binds no MCP
  broker socket, and refuses to spawn without a sandbox backend;
* ``invoke_claude_cli`` passes the read shape for a judge and the write
  shape for the implementer, and records ``claude_spawn_read_contained``;
* a denied tool call under ``-p`` exits instead of hanging: the CLI is told
  nobody answers prompts, so the spawn's wall clock is the model's, not a
  prompt's.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.runtime_profiles import load_runtime_profiles
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import claude_runtime as cr  # noqa: E402


def _profile(profile_id: str, model: str = "opus", tools=("Read", "Grep", "Glob")) -> AgentRuntimeProfile:
    return AgentRuntimeProfile(agent_name=f"agent-{profile_id}", model=model, effort="max",
                               source="kernel_profile", profile_id=profile_id, tools=tuple(tools))


def _pairs(command: list[str], flag: str) -> list[tuple[str, str]]:
    return [(command[i + 1], command[i + 2]) for i, token in enumerate(command) if token == flag]


class EligibilityIsThePinnedSetAndTheProfileFacts(unittest.TestCase):
    def test_exactly_three_kernel_profiles_take_the_read_shape(self) -> None:
        eligible = sorted(pid for pid in load_runtime_profiles() if cr.read_contained_profile(_profile(pid)))
        self.assertEqual(eligible, ["arbiter", "judge_glm", "judge_opus"])
        self.assertEqual(sorted(cr.READ_CONTAINED_PROFILE_IDS), eligible)

    def test_a_planner_stays_on_the_write_path_because_of_its_mcp_server(self) -> None:
        self.assertFalse(cr.read_contained_profile(_profile("planner")))
        self.assertFalse(cr.read_contained_profile(_profile("planner_orchestrator")))

    def test_write_capable_and_profile_less_spawns_are_not_read_contained(self) -> None:
        self.assertFalse(cr.read_contained_profile(_profile("implementer")))
        self.assertFalse(cr.read_contained_profile(None))
        self.assertFalse(cr.read_contained_profile(AgentRuntimeProfile(
            agent_name="x", model="opus", effort="max", source="frontmatter")))


class TheReadShapeArgv(unittest.TestCase):
    def _argv(self, **kwargs) -> list[str]:
        base = dict(model="opus", effort="max", skip_permissions=False, permission_mode=None,
                    disallowed_tools=("Bash", "Edit", "Write"), read_shape=True, read_shape_tools=("Read", "Grep", "Glob"))
        base.update(kwargs)
        with mock.patch.object(cr, "claude_binary", return_value="claude"):
            return cr.build_claude_exec_argv(**base)

    def test_it_carries_the_three_flags_and_never_the_bypass(self) -> None:
        argv = self._argv()
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertNotIn("--permission-mode", argv)
        self.assertIn("--restricted", argv)
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Grep,Glob")
        self.assertIn("--disallowedTools", argv)
        self.assertLess(argv.index("--tools"), argv.index("--disallowedTools"),
                        "the positive list precedes the belt so neither variadic flag swallows the other")

    def test_a_read_shape_with_write_permissions_cannot_be_built(self) -> None:
        with self.assertRaisesRegex(cr.ClaudePolicyViolation, "claude_read_shape_with_write_permissions"):
            self._argv(skip_permissions=True)
        with self.assertRaisesRegex(cr.ClaudePolicyViolation, "claude_read_shape_with_write_permissions"):
            self._argv(permission_mode="acceptEdits")

    def test_the_write_shape_is_unchanged(self) -> None:
        argv = self._argv(skip_permissions=True, read_shape=False, read_shape_tools=())
        self.assertIn("--dangerously-skip-permissions", argv)
        for flag in ("--restricted", "--permission-prompts", "--tools"):
            self.assertNotIn(flag, argv)


class TheReadContainment(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-read-contained-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.workspace = self.root / "workspace"
        (self.workspace / "aria-kernel" / "aria_kernel").mkdir(parents=True)
        (self.workspace / "src").mkdir()
        import subprocess
        subprocess.run(["git", "init", "-q", str(self.workspace)], check=True)
        install = self.root / "install" / "versions"
        install.mkdir(parents=True)
        (install / "2.1.278").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (install / "2.1.278").chmod(0o755)
        (self.root / "claude").symlink_to(install / "2.1.278")
        self.login = self.root / "login"
        self.login.mkdir()
        (self.login / impl.CLAUDE_LOGIN_CREDENTIALS_FILENAME).write_text('{"fixture": "managed"}\n', encoding="utf-8")
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _contain(self, **overrides) -> list[str]:
        arguments = dict(skip_permissions=False, permission_mode=None, workspace_root=self.workspace,
                         write_scope=(), executable=self.root / "claude", spawn_files=(),
                         managed_login_dir=self.login, read_containment=True)
        arguments.update(overrides)
        return cr._apply_write_containment(["claude", "-p", "--restricted"], **arguments)

    def test_the_workspace_is_bound_read_only_with_nothing_writable_under_it(self) -> None:
        command = self._contain()
        self.assertIn("bwrap", command[0])
        self.assertIn((str(self.workspace), str(self.workspace)), _pairs(command, "--ro-bind"))
        writable = [src for src, _dst in _pairs(command, "--bind")]
        self.assertFalse(any(Path(src).is_relative_to(self.workspace) for src in writable), writable)
        # ARIA-HIGH-157 — the managed login stays writable for the OAuth refresh.
        self.assertTrue(any(Path(src) == self.login / impl.CLAUDE_LOGIN_CREDENTIALS_FILENAME or Path(src) == self.login
                            for src in writable), writable)
        sources = [src for src, _dst in _pairs(command, "--bind") + _pairs(command, "--ro-bind")]
        self.assertFalse(any("mcp" in src.lower() for src in sources), "no MCP broker socket in the read shape")

    def test_a_plain_read_only_spawn_without_read_containment_is_left_as_built(self) -> None:
        argv = ["claude", "-p"]
        self.assertEqual(cr._apply_write_containment(argv, skip_permissions=False, permission_mode=None,
                                                     workspace_root=self.workspace, write_scope=()), argv)

    def test_without_a_sandbox_backend_the_read_shape_refuses(self) -> None:
        with mock.patch.object(impl, "_bwrap_available", return_value=False):
            with self.assertRaisesRegex(cr.ClaudePolicyViolation, "claude_read_containment_required"):
                self._contain()


class InvokeClaudeCliPassesTheShape(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-read-contained-cli-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.tools = ensure_tools_dir(self.root / "aria-tools")
        self.prompt = self.root / "prompt.md"
        self.prompt.write_text("judge it\n", encoding="utf-8")
        self.output = self.root / "out" / "envelope.md"

    def _captured_run(self, subagent_type: str, role: str) -> dict:
        captured: dict = {}

        def fake_run(**kwargs):
            captured.update(kwargs)
            return cr.ClaudeRunResult(returncode=0, stdout="", stderr="", final_message="", usage=None, events=(),
                                      model=kwargs.get("model"))

        with mock.patch.object(ci_executor, "run_claude_exec", side_effect=fake_run), \
             mock.patch.object(ci_executor, "_MOCK_MODE_AT_ENTRY", True), \
             mock.patch.object(ci_executor, "_deliver_agent_contract", return_value=mock.Mock(text="contract", contract_hash="sha256:c")):
            try:
                ci_executor.invoke_claude_cli(
                    request_id="AIR-1", subagent_type=subagent_type, prompt_file=self.prompt,
                    output_path=self.output, timeout_seconds=30, role=role, claim_id="claim_1",
                    agent_id="ci-executor:t", tools_dir=self.tools,
                )
            except Exception:
                pass
        return captured

    def test_a_judge_takes_the_read_shape_and_the_implementer_the_write_shape(self) -> None:
        judge = self._captured_run("aria-evidence-judge", "evidence_judgment")
        self.assertEqual((judge.get("skip_permissions"), judge.get("read_containment")), (False, True))
        implementer = self._captured_run("aria-implementer", "implementation")
        self.assertEqual((implementer.get("skip_permissions"), implementer.get("read_containment")), (True, False))

    def test_the_read_shape_is_recorded_on_the_governance_ledger(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl
        self._captured_run("aria-adversarial-judge", "adversarial_judgment")
        rows = [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                if row.get("kind") == "claude_spawn_read_contained"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["details"]["profile_id"], rows[0]["details"]["tools"]),
                         ("judge_glm", ["Read", "Grep", "Glob"]))


class ADeniedToolCallExitsInsteadOfHanging(unittest.TestCase):
    def test_the_cli_is_told_nobody_answers_prompts(self) -> None:
        # The property the CLI documents for `--permission-prompts none`:
        # "anything that would prompt is denied automatically". A judge
        # prompt that attempts Write is denied by the tool list before it
        # could prompt; a tool that would prompt is denied instead of waited
        # on. The argv carries both facts; the CLI's own help is the SSoT.
        with mock.patch.object(cr, "claude_binary", return_value="claude"):
            argv = cr.build_claude_exec_argv(model="opus", effort="max", skip_permissions=False, permission_mode=None,
                                             disallowed_tools=("Write",), read_shape=True, read_shape_tools=("Read",))
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertEqual(argv[argv.index("--tools") + 1], "Read")
        self.assertIn("Write", argv[argv.index("--disallowedTools") + 1:])


if __name__ == "__main__":
    unittest.main()


class TheJournalNamesWhereASearchLookedNeverWhatFor(unittest.TestCase):
    def test_grep_and_glob_rows_carry_scope_and_glob_only(self) -> None:
        from aria_kernel.hooks import sanitize_journal_entry
        grep = sanitize_journal_entry({"tool_name": "Grep", "tool_input": {"pattern": "AKIA[0-9A-Z]{16}", "path": "apps/auth"}})
        self.assertEqual((grep["command_family"], grep["search_scope"]), ("file_search", "apps/auth"))
        self.assertNotIn("AKIA", json_dumps(grep))
        glob = sanitize_journal_entry({"tool_name": "Glob", "tool_input": {"pattern": "**/*.env", "path": "/srv"}})
        self.assertEqual((glob["search_scope"], glob["search_glob"]), ("/srv", "**/*.env"))


def json_dumps(row: dict) -> str:
    import json
    return json.dumps(row, sort_keys=True)
