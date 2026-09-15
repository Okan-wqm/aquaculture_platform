"""ARIA-HIGH-107 (verifier, 2026-09-12) — the vendor's answer decides before its exit code.

Both managed CLIs report a logged-out session as an answer AND a non-zero
exit: Claude Code 2.1.269 prints `{"loggedIn": false, ...}` then
`process.exit(loggedIn ? 0 : 1)` (read from the installed binary; reproduced
offline with an empty config dir), Codex 0.154.0 prints `Not logged in` and
exits 1 (reproduced offline with an empty CODEX_HOME). A probe that tested
`returncode != 0` before reading the document laundered that DECIDED "no"
into UNDECIDED `status_not_confirmed` — retried three times with backoff,
then `provider_undecided` with no failover — the inverse of the finding: an
auth-unavailable fact, the one class a read-only role may fail over on,
turned into a stall that halts every dispatch until a human logs in.

What this pins, one property per test:

* `status_answers.classify_claude_status_answer` / `classify_codex_status_answer`
  read the document or line first: a logged-out answer with exit 1 is
  DECIDED unavailable carrying `exit_code=1`; a login line is DECIDED
  available; only an answer-less run lets the exit code name the undecided
  reason (`status_not_confirmed` non-zero, `status_output_unrecognized` zero).
* Structurally (AST): neither classifier compares `returncode` anywhere but
  the shared no-answer arm, so the ordering cannot regress silently.
* The real probes (`claude_runtime._probe_claude_auth_status`,
  `codex_runtime._probe_codex_auth_status`) reach the same decisions
  through scripted binaries that mirror the installed CLIs' exit codes,
  including Codex's read-only PATH-alias warning tolerance.
* `codex_runtime._prepare_managed_codex_context` names a DECIDED route
  refusal (`ManagedCodexRouteUnavailable`: no managed credential, no CLI,
  a profile the route cannot serve) as its own type, distinct from the
  host's `SandboxUnavailable` / `ResourceLimitsUnavailable`, so the
  executor's observe arm cannot round a missing login into a halt.
"""
from __future__ import annotations

import ast
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))


def _decision(name: str):
    # Imported per test rather than at module import: on the pre-change tip
    # (no `status_probe`) the probe-level cases below still collect and fail
    # on the laundering itself — `status_not_confirmed` / `unknown` where a
    # decided refusal belongs — instead of on an ImportError.
    from aria_kernel.status_probe import StatusDecision

    return StatusDecision[name]

_CLAUDE_COMMAND = ("claude", "auth", "status", "--json")
_CODEX_COMMAND = ("codex", "login", "status")
_LOGGED_OUT_DOCUMENT = json.dumps({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty",
                                   "analyticsDisabled": False, "projectsDirectory": "/x", "configDirectory": "/x"})
_LOGGED_IN_DOCUMENT = json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                                  "subscriptionType": "max", "email": "ordinary@example.invalid"})
_CONSOLE_DOCUMENT = json.dumps({"loggedIn": True, "authMethod": "console", "apiProvider": "firstParty"})
_READONLY_WARNING = (
    "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)"
)


class TheClaudeDocumentDecidesBeforeTheExitCode(unittest.TestCase):
    def _classify(self, stdout: str, returncode: int):
        from status_answers import classify_claude_status_answer

        return classify_claude_status_answer(stdout, returncode, command=_CLAUDE_COMMAND)

    def test_a_logged_out_document_with_exit_one_is_decided_unavailable(self) -> None:
        # The installed CLI's shape. The defect, first: exit-code-first
        # classification called this `status_not_confirmed` / undecided.
        observed = self._classify(_LOGGED_OUT_DOCUMENT + "\n", 1)
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code, observed.credential_source),
                         ("unavailable", "managed_session_logged_out", 1, "managed_session"))
        self.assertEqual(observed.command, _CLAUDE_COMMAND)

    def test_a_logged_in_subscription_is_decided_available(self) -> None:
        observed = self._classify(_LOGGED_IN_DOCUMENT, 0)
        self.assertIs(observed.decision, _decision("AVAILABLE"))
        self.assertEqual((observed.auth_observation, observed.reason, observed.auth_method, observed.exit_code),
                         ("available", "managed_session_logged_in", "subscription", 0))

    def test_a_console_login_is_decided_unavailable_by_name(self) -> None:
        observed = self._classify(_CONSOLE_DOCUMENT, 0)
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self.assertEqual((observed.reason, observed.auth_method), ("api_key_auth_not_managed", "api_key"))

    def test_only_an_answer_less_run_lets_the_exit_code_speak(self) -> None:
        for stdout, returncode, reason in (
            ("", 1, "status_not_confirmed"),
            ("Segmentation fault", 139, "status_not_confirmed"),
            ("", 0, "status_output_unrecognized"),
            ("{\"loggedIn\": \"yes\"}", 0, "status_output_unrecognized"),
            ("[1, 2]", 1, "status_not_confirmed"),
            ("not json at all", 0, "status_output_unrecognized"),
        ):
            with self.subTest(stdout=stdout, returncode=returncode):
                observed = self._classify(stdout, returncode)
                self.assertIs(observed.decision, _decision("UNDECIDED"))
                self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code),
                                 ("unknown", reason, returncode))


class TheCodexLineDecidesBeforeTheExitCode(unittest.TestCase):
    def _classify(self, output: str | bytes, returncode: int):
        from status_answers import classify_codex_status_answer

        raw = output if isinstance(output, bytes) else output.encode("utf-8")
        return classify_codex_status_answer(raw, returncode, command=_CODEX_COMMAND)

    def test_not_logged_in_with_exit_one_is_decided_unavailable(self) -> None:
        # The installed CLI's shape (login.rs: eprintln + exit 1). The
        # defect, first: this was `status_not_confirmed` / undecided.
        observed = self._classify("Not logged in\n", 1)
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code, observed.auth_method),
                         ("unavailable", "cli_reported_not_logged_in", 1, "unknown"))

    def test_not_logged_in_behind_the_readonly_alias_warning_is_the_same_decision(self) -> None:
        observed = self._classify(_READONLY_WARNING + "\nNot logged in\n", 1)
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self.assertEqual(observed.reason, "cli_reported_not_logged_in_with_readonly_path_alias_warning")

    def test_a_managed_login_is_decided_available(self) -> None:
        observed = self._classify("Logged in using ChatGPT\n", 0)
        self.assertIs(observed.decision, _decision("AVAILABLE"))
        self.assertEqual((observed.reason, observed.auth_method, observed.exit_code),
                         ("cli_reported_managed_login", "chatgpt", 0))

    def test_an_api_key_login_is_decided_unavailable(self) -> None:
        observed = self._classify("Logged in using an API key - ***\n", 0)
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self.assertEqual((observed.reason, observed.auth_method), ("managed_login_required", "api_key"))

    def test_only_an_answer_less_run_lets_the_exit_code_speak(self) -> None:
        for output, returncode, reason in (
            ("", 1, "status_not_confirmed"),
            ("error: something else entirely\n", 2, "status_not_confirmed"),
            ("Ordinary status format not yet supported\n", 0, "status_output_unrecognized"),
            ("Not logged in\nextra line\n", 1, "status_not_confirmed"),
            (b"\xff\xfe not utf-8\n", 0, "status_output_unrecognized"),
        ):
            with self.subTest(output=output, returncode=returncode):
                observed = self._classify(output, returncode)
                self.assertIs(observed.decision, _decision("UNDECIDED"))
                self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code),
                                 ("unknown", reason, returncode))


class TheOrderingIsStructural(unittest.TestCase):
    """The exit code may be compared in the shared no-answer arm and nowhere
    else in either classifier: a `returncode != 0` test reintroduced ahead
    of the document fails here, before any fixture has to reproduce it."""

    def test_neither_classifier_compares_the_exit_code(self) -> None:
        tree = ast.parse((_POC_DIR / "status_answers.py").read_text(encoding="utf-8"))
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        for name in ("classify_claude_status_answer", "classify_codex_status_answer"):
            with self.subTest(function=name):
                compared = [
                    node for node in ast.walk(functions[name])
                    if isinstance(node, ast.Compare)
                    and any(isinstance(operand, ast.Name) and operand.id == "returncode"
                            for operand in (node.left, *node.comparators))
                ]
                self.assertEqual(compared, [], f"{name} must not branch on the exit code")
        no_answer = functions["_no_answer"]
        self.assertTrue(any(isinstance(node, ast.Compare) and isinstance(node.left, ast.Name)
                            and node.left.id == "returncode" for node in ast.walk(no_answer)),
                        "the no-answer arm is where the exit code names the undecided reason")


class TheRealProbesReachTheSameDecisions(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-status-answers-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.binaries = self.root / "bin"
        self.binaries.mkdir()
        self.environ = {"PATH": str(self.binaries) + os.pathsep + os.defpath, "HOME": str(self.root)}

    def _script(self, name: str, stream: str, text: str, exit_code: int) -> None:
        executable = self.binaries / name
        executable.write_text(
            f"#!{sys.executable}\nimport sys\nsys.{stream}.write({text!r})\nraise SystemExit({exit_code})\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)

    def test_the_claude_probe_decides_a_logged_out_exit_one(self) -> None:
        from claude_runtime import _probe_claude_auth_status

        self._script("claude", "stdout", _LOGGED_OUT_DOCUMENT + "\n", 1)
        observed = _probe_claude_auth_status(environ=self.environ, timeout_seconds=10)
        # The defect, first: exit-code-first classification reported
        # ("unknown", "status_not_confirmed", 1) for the vendor's own "no".
        self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code),
                         ("unavailable", "managed_session_logged_out", 1))
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self._script("claude", "stdout", _LOGGED_IN_DOCUMENT + "\n", 0)
        observed = _probe_claude_auth_status(environ=self.environ, timeout_seconds=10)
        self.assertIs(observed.decision, _decision("AVAILABLE"))
        self._script("claude", "stderr", "panic\n", 1)
        observed = _probe_claude_auth_status(environ=self.environ, timeout_seconds=10)
        self.assertEqual((observed.decision, observed.reason), (_decision("UNDECIDED"), "status_not_confirmed"))

    def test_the_codex_probe_decides_a_not_logged_in_exit_one(self) -> None:
        from codex_runtime import _probe_codex_auth_status

        self._script("codex", "stderr", "Not logged in\n", 1)
        observed = _probe_codex_auth_status(environ=self.environ, timeout_seconds=10)
        # The defect, first: ("unknown", "status_not_confirmed", 1) for the
        # CLI's own "Not logged in".
        self.assertEqual((observed.auth_observation, observed.reason, observed.exit_code),
                         ("unavailable", "cli_reported_not_logged_in", 1))
        self.assertIs(observed.decision, _decision("UNAVAILABLE"))
        self._script("codex", "stderr", "Logged in using ChatGPT\n", 0)
        observed = _probe_codex_auth_status(environ=self.environ, timeout_seconds=10)
        self.assertIs(observed.decision, _decision("AVAILABLE"))
        self._script("codex", "stderr", "unexpected\n", 3)
        observed = _probe_codex_auth_status(environ=self.environ, timeout_seconds=10)
        self.assertEqual((observed.decision, observed.reason, observed.exit_code),
                         (_decision("UNDECIDED"), "status_not_confirmed", 3))

    def test_the_wrapped_codex_probe_still_names_a_dead_user_bus(self) -> None:
        # The limiter arm (ARIA-HIGH-076) stays ahead of the line: its
        # exact public error is a control fact, not a vendor answer.
        from codex_runtime import _probe_codex_auth_status

        program = self.root / "control.py"
        program.write_text("import sys\nsys.stderr.write('Failed to connect to bus: No medium found\\n')\n"
                           "raise SystemExit(1)\n", encoding="utf-8")
        observed = _probe_codex_auth_status(
            environ=self.environ, timeout_seconds=5,
            _wrap_command=lambda argv: [sys.executable, "-B", str(program)],
        )
        self.assertEqual((observed.decision, observed.reason, observed.control_status, observed.control_reason),
                         (_decision("UNDECIDED"), "control_plane_failure", "unavailable", "user_bus_unavailable"))


class TheManagedCodexRouteRefusalIsItsOwnType(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-codex-route-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.binaries = self.root / "bin"
        self.binaries.mkdir()
        codex = self.binaries / "codex"
        codex.write_text(f"#!{sys.executable}\nraise SystemExit(97)\n", encoding="utf-8")
        codex.chmod(0o755)
        (self.root / "runtime").mkdir()
        self.environment = {"PATH": str(self.binaries) + os.pathsep + os.defpath, "HOME": str(self.root),
                            "CODEX_HOME": str(self.root / "codex-home")}

    def _prepare(self, profile):
        import codex_runtime

        return codex_runtime._prepare_managed_codex_context(
            workspace=self.root, runtime_directory=self.root / "runtime", environment=self.environment, profile=profile,
        )

    def test_a_missing_managed_credential_is_a_decided_auth_refusal(self) -> None:
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from aria_kernel.implementation_safety import SandboxUnavailable
        from codex_runtime import ManagedCodexRouteUnavailable

        profile = read_agent_runtime_profile("aria-adversarial-judge", repo_root=_REPO_ROOT)
        (self.root / "codex-home").mkdir()
        with self.assertRaises(ManagedCodexRouteUnavailable) as caught:
            self._prepare(profile)
        self.assertEqual((caught.exception.reason, caught.exception.auth_observation),
                         ("codex_managed_auth_file_unavailable", "unavailable"))
        self.assertNotIsInstance(caught.exception, SandboxUnavailable,
                                 "a missing login is not the host's containment fault")
        self.environment["CODEX_HOME"] = str(self.root / "absent")
        with self.assertRaises(ManagedCodexRouteUnavailable) as caught:
            self._prepare(profile)
        self.assertEqual(caught.exception.reason, "codex_managed_auth_directory_unavailable")

    def test_a_profile_the_route_cannot_serve_is_decided_without_a_session_claim(self) -> None:
        from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
        from codex_runtime import ManagedCodexRouteUnavailable

        writer = AgentRuntimeProfile(agent_name="implementer", model="opus", effort="max", source="frontmatter",
                                     tools=("Read", "Edit", "Bash"))
        with self.assertRaises(ManagedCodexRouteUnavailable) as caught:
            self._prepare(writer)
        self.assertEqual((caught.exception.reason, caught.exception.auth_observation),
                         ("codex_native_profile_controls_unavailable", "unknown"))

    def test_an_absent_cli_is_decided_unavailable(self) -> None:
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from codex_runtime import ManagedCodexRouteUnavailable

        (self.binaries / "codex").unlink()
        self.environment["PATH"] = str(self.binaries)
        with self.assertRaises(ManagedCodexRouteUnavailable) as caught:
            self._prepare(read_agent_runtime_profile("aria-adversarial-judge", repo_root=_REPO_ROOT))
        self.assertEqual((caught.exception.reason, caught.exception.auth_observation),
                         ("codex_cli_unavailable", "unavailable"))


if __name__ == "__main__":
    unittest.main()
