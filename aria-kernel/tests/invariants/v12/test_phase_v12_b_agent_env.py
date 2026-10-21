"""Plan 032 Faz 032b — the spawn environment is built, the workspace is explicit,
and the write scope is a mount, not a promise.

Invariants:
  I-V12-ENV-01   `build_agent_env` never copies: secret-shaped names that are not
                 explicitly granted are dropped (`CLAUDE_CODE_OAUTH_TOKEN` among
                 them, ARIA-MEDIUM-563); the baseline, non-secret `CLAUDE_CODE_*`
                 and the profile passthrough pass; HOME is synthetic and XDG_*
                 point inside it; the report names every decision without a value.
  I-V12-ENV-02   no login reaches a spawn (ARIA-MEDIUM-563): neither the operator's
                 login directory (`CLAUDE_CONFIG_DIR`, the real `$HOME/.claude`)
                 nor an OAuth token in the environment.
  I-V12-ENV-03   `run_claude_exec` spawns with the BUILT environment — the gateway
                 route's socket and placeholder credential added — runs the CLI it
                 resolved on that environment's PATH by absolute path, and hands
                 containment the settings and MCP documents it wrote and that
                 executable (ARIA-HIGH-077), and no login.
  I-V12-ENV-04   `wrap_bash_in_sandbox(write_scope=...)` mounts the workspace
                 read-only and only the scope writable; `**` keeps the legacy
                 whole-workspace bind; a scope escaping the workspace refuses.
  I-V12-ENV-05   the CI executor passes an explicit `cwd` and the agent profile to
                 the spawn.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import implementation_safety as isf
from aria_kernel.agent_env import (
    BASELINE_ENV_NAMES,
    SYNTHETIC_HOME_PREFIX,
    build_agent_env,
    cleanup_synthetic_home,
)
from aria_kernel.runtime_profiles import profile_by_id

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import claude_runtime  # noqa: E402


class EnvIsBuiltNotCopied(unittest.TestCase):
    def test_I_V12_ENV_01_secrets_drop_baseline_and_grants_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = {
                "PATH": "/usr/bin", "LANG": "C.UTF-8", "TERM": "xterm",
                "GH_TOKEN": "ghp_SECRETVALUE0001", "ARIA_LEASE_TOKEN": "lease-SECRETVALUE0002",
                "AWS_SECRET_ACCESS_KEY": "aws-SECRETVALUE0003", "ANTHROPIC_API_KEY": "sk-SECRETVALUE0004",
                "SOME_PASSWORD": "pw-SECRETVALUE0005", "OPERATOR_NOTE": "note-PLAINVALUE0006",
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096", "CLAUDE_CODE_OAUTH_TOKEN": "oauth",
                "ARIA_TOOLS_DIR": "/t", "ARIA_ZAI_API_KEY": "z", "HOME": tmp,
            }
            built = build_agent_env(base, profile_passthrough=("ARIA_TOOLS_DIR",), tmp_root=tmp)
            env, report = built.env, built.report
            try:
                for name in ("GH_TOKEN", "ARIA_LEASE_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY",
                             "SOME_PASSWORD", "OPERATOR_NOTE", "ARIA_ZAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"):
                    self.assertNotIn(name, env, name)
                for name in ("PATH", "LANG", "TERM", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "ARIA_TOOLS_DIR"):
                    self.assertIn(name, env, name)
                # ARIA-MEDIUM-563 — dropped as secret-shaped, by name.
                self.assertIn("CLAUDE_CODE_OAUTH_TOKEN", report.dropped_secret_shaped)
                self.assertTrue(Path(env["HOME"]).name.startswith(SYNTHETIC_HOME_PREFIX))
                self.assertNotEqual(env["HOME"], tmp)
                self.assertTrue(env["XDG_CONFIG_HOME"].startswith(env["HOME"]))
                self.assertTrue(Path(env["XDG_CACHE_HOME"]).is_dir())
                self.assertIn("GH_TOKEN", report.dropped_secret_shaped)
                self.assertIn("ARIA_LEASE_TOKEN", report.dropped_secret_shaped)
                self.assertNotIn("OPERATOR_NOTE", report.dropped_secret_shaped)
                self.assertEqual(report.passthrough, ("ARIA_TOOLS_DIR",))
                gov = report.to_governance()
                self.assertEqual(set(gov), {"passed", "profile_passthrough", "dropped_count",
                                            "dropped_secret_shaped", "synthetic_home"})
                for value in base.values():
                    if "VALUE" in value:
                        self.assertNotIn(value, str(gov), "values never enter the report")
            finally:
                cleanup_synthetic_home(report.home)
            self.assertFalse(Path(report.home).exists())

    def test_I_V12_ENV_01_the_operators_session_identity_never_nests_the_agent(self) -> None:
        # A dispatch from an operator's interactive Claude Code shell carries
        # that session's own child exports under the configuration prefix.
        # The agent's identity is the kernel's `--session-id`; none of these
        # reach it, while a genuine configuration knob still does.
        from aria_kernel.agent_env import CLAUDE_INSTANCE_ENV_NAMES

        with tempfile.TemporaryDirectory() as tmp:
            base = {"PATH": "/bin", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
                    **{name: "operator-session-PLAINVALUE" for name in CLAUDE_INSTANCE_ENV_NAMES}}
            built = build_agent_env(base, tmp_root=tmp)
            try:
                for name in CLAUDE_INSTANCE_ENV_NAMES:
                    self.assertTrue(name.startswith("CLAUDE_CODE_"), name)
                    self.assertNotIn(name, built.env, name)
                self.assertEqual(built.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "4096")
            finally:
                cleanup_synthetic_home(built.report.home)

    def test_I_V12_ENV_01_extra_is_added_after_the_filter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            built = build_agent_env({"PATH": "/bin"}, extra={"ANTHROPIC_BASE_URL": "https://x", "IS_SANDBOX": "1"}, tmp_root=tmp)
            self.assertEqual(built.env["ANTHROPIC_BASE_URL"], "https://x")
            self.assertEqual(built.env["IS_SANDBOX"], "1")
            cleanup_synthetic_home(built.report.home)
        self.assertNotIn("HOME", BASELINE_ENV_NAMES)

    def test_I_V12_ENV_02_no_login_reaches_a_spawn(self) -> None:
        # ARIA-MEDIUM-563 — the operator's login directory and token used to
        # be passed to every spawn; the gateway holds the credential now.
        with tempfile.TemporaryDirectory() as tmp:
            real_home = Path(tmp) / "home"
            (real_home / ".claude").mkdir(parents=True)
            (real_home / ".claude" / ".credentials.json").write_text("{}", encoding="utf-8")
            for base in ({"HOME": str(real_home), "PATH": "/bin"},
                         {"HOME": str(real_home), "PATH": "/bin", "CLAUDE_CONFIG_DIR": str(real_home / ".claude"),
                          "CLAUDE_CODE_OAUTH_TOKEN": "oauth-PLAINVALUE"}):
                built = build_agent_env(base, tmp_root=tmp)
                try:
                    self.assertNotIn("CLAUDE_CONFIG_DIR", built.env)
                    self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", built.env)
                    self.assertNotIn(str(real_home), " ".join(built.env.values()))
                finally:
                    cleanup_synthetic_home(built.report.home)
            from aria_kernel import agent_env

            self.assertFalse(hasattr(agent_env, "derive_claude_config_dir"))
            self.assertFalse(hasattr(agent_env, "CLAUDE_AUTH_ENV_NAMES"))


class TheSpawnUsesTheBuiltEnv(unittest.TestCase):
    def test_I_V12_ENV_03_run_claude_exec_passes_the_built_env_and_no_login(self) -> None:
        captured: dict = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["env"] = kwargs["env"]
            captured["cwd"] = kwargs["cwd"]

            class P:
                returncode = 0
                stdout = '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}\n'
                stderr = ""
            return P()

        def fake_containment(argv, **kwargs):
            captured["containment"] = kwargs
            return ["bwrap", "--", *argv]

        with tempfile.TemporaryDirectory() as tmp:
            real_home = Path(tmp) / "home"
            (real_home / ".claude").mkdir(parents=True)
            # The CLI the spawn runs is the one on the BUILT environment's
            # PATH, resolved to its real file — a fixture here, so the
            # invariant does not depend on the host's installation.
            binaries = Path(tmp) / "bin"
            binaries.mkdir()
            (binaries / "claude.real").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            (binaries / "claude.real").chmod(0o755)
            (binaries / "claude").symlink_to(binaries / "claude.real")
            with mock.patch.dict(os.environ, {"HOME": str(real_home), "GH_TOKEN": "ghp", "ARIA_LEASE_TOKEN": "l", "TMPDIR": tmp,
                                              "PATH": str(binaries)}, clear=False), \
                 mock.patch.object(claude_runtime, "preflight_claude_auth"), \
                 mock.patch.object(claude_runtime, "assert_write_runner_ok"), \
                 mock.patch.object(claude_runtime, "_assert_budget_before_spawn"), \
                 mock.patch.object(claude_runtime, "_clamp_timeout_to_job_deadline", side_effect=lambda s: s), \
                 mock.patch.object(claude_runtime, "_apply_write_containment", side_effect=fake_containment), \
                 mock.patch.object(claude_runtime, "_apply_resource_limits", side_effect=lambda argv, **kw: argv), \
                 mock.patch.object(claude_runtime.subprocess, "run", side_effect=fake_run):
                profile = type("P", (), {"profile_id": "implementer"})()
                # Faz 032b-2 (I-V12-HOOK-01): a write-capable profiled spawn needs the
                # ledger + workspace so its hooks can decide and journal.
                from aria_kernel.tool_registry import ensure_tools_dir

                recording = claude_runtime.UsageRecording(
                    request_id="AIR-env", role="implementation", target_agent="aria-implementer",
                    base_dir=ensure_tools_dir(Path(tmp) / "aria-tools"),
                )
                result = claude_runtime.run_claude_exec(
                    prompt_text="hi", timeout_seconds=60, model="opus", effort="max",
                    cwd=tmp, agent_profile=profile, usage_recording=recording,
                )
        self.assertEqual(result.returncode, 0)
        env = captured["env"]
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("ARIA_LEASE_TOKEN", env)
        self.assertNotIn("CLAUDE_CONFIG_DIR", env)
        # The gateway route's variables: the kernel's own socket outside a
        # room (the room names its bound path) and the placeholder.
        from aria_kernel.egress_proxy import kernel_egress_sockets
        from aria_kernel.provider_routes import ROOM_CREDENTIAL_PLACEHOLDER

        self.assertEqual(env["ANTHROPIC_UNIX_SOCKET"], str(kernel_egress_sockets()["anthropic"]))
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://localhost")
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], ROOM_CREDENTIAL_PLACEHOLDER)
        self.assertTrue(Path(env["HOME"]).name.startswith(SYNTHETIC_HOME_PREFIX))
        self.assertEqual(captured["cwd"], tmp)
        self.assertEqual(captured["containment"]["write_scope"], ("**",))
        containment = captured["containment"]
        self.assertNotIn("managed_login_dir", containment)
        self.assertEqual(containment["executable"], (binaries / "claude.real").resolve())
        self.assertEqual([path.name.split("-")[0] for path in containment["spawn_files"]], ["aria", "aria"])
        self.assertEqual({path.parent.name for path in containment["spawn_files"]},
                         {"aria-spawn-settings", "aria-spawn-mcp"})
        argv = captured["argv"]
        self.assertEqual(argv[argv.index("--") + 1], str((binaries / "claude.real").resolve()),
                         "the spawn runs the executable it resolved, by absolute path")
        for path in containment["spawn_files"]:
            self.assertIn(str(path), argv)
        self.assertIn("--disallowedTools", argv)
        # Faz 032d: the implementer is the ONE profile holding the external-write grant,
        # so the push rule is NOT projected for it (I-V12-DLV-01 pins the singularity).
        self.assertNotIn("Bash(git push*)", argv)
        self.assertIn("WebFetch", argv)
        self.assertNotIn("Bash", argv[argv.index("--disallowedTools"):], "the implementer keeps Bash")
        self.assertFalse(Path(env["HOME"]).exists(), "the synthetic home is removed after the spawn")

    def test_I_V12_ENV_03_no_profile_means_the_empty_envelope(self) -> None:
        denies, scope, passthrough = claude_runtime._envelope_from_profile(None)
        self.assertEqual(set(denies), {"WebFetch", "WebSearch"})
        self.assertIsNone(scope)
        self.assertEqual(passthrough, ())
        judge = profile_by_id("judge_opus")
        denies, scope, passthrough = claude_runtime._envelope_from_profile(type("P", (), {"profile_id": judge.profile_id})())
        self.assertIn("Bash", denies)
        self.assertEqual(scope, ())


class WriteScopeIsAMount(unittest.TestCase):
    def _wrap(self, workspace: Path, **kwargs) -> list[str]:
        with mock.patch.object(isf, "_bwrap_available", return_value=True):
            return isf.wrap_bash_in_sandbox(["claude"], workspace_root=workspace, provider="anthropic", **kwargs)

    def test_I_V12_ENV_04_scope_binds_only_its_directories_writable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp).resolve()
            (ws / "apps" / "svc").mkdir(parents=True)
            (ws / "libs").mkdir()
            (ws / "aria-kernel" / "aria_kernel").mkdir(parents=True)
            argv = self._wrap(ws, write_scope=["apps/**", "libs/*.ts"])
            joined = " ".join(argv)
            self.assertIn(f"--ro-bind {ws} {ws}", joined)
            self.assertIn(f"--bind {ws / 'apps'} {ws / 'apps'}", joined)
            self.assertIn(f"--bind {ws / 'libs'} {ws / 'libs'}", joined)
            self.assertNotIn(f"--bind {ws} {ws} ", joined + " ")
            # READONLY_PATHS stay on top even inside a scope.
            self.assertIn(f"--ro-bind {ws / 'aria-kernel' / 'aria_kernel'}", joined)
            legacy = " ".join(self._wrap(ws, write_scope=["**"]))
            self.assertIn(f"--bind {ws} {ws}", legacy)
            none = " ".join(self._wrap(ws))
            self.assertIn(f"--bind {ws} {ws}", none)
            with self.assertRaises(isf.PathEscape):
                self._wrap(ws, write_scope=["../outside/**"])
            extra = " ".join(self._wrap(ws, write_scope=["**"], extra_ro_binds=[str(ws / "libs")]))
            self.assertIn(f"--ro-bind {ws / 'libs'} {ws / 'libs'}", extra)

    def test_I_V12_ENV_04_scope_directories_are_the_prefix_before_the_wildcard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp).resolve()
            self.assertEqual(isf.scope_directories(ws, ["**"]), [ws])
            self.assertEqual(isf.scope_directories(ws, ["apps/x/**", "apps/x/y/*.py"]), [ws / "apps" / "x", ws / "apps" / "x" / "y"])


class TheExecutorNamesItsWorkspace(unittest.TestCase):
    def test_I_V12_ENV_05_ci_executor_passes_cwd_and_profile(self) -> None:
        source = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        call = source[source.index("def _dispatch_attempt(model: str, effort: str)"):]
        call = call[:call.index("def _gov(")]
        self.assertIn("cwd=_REPO_ROOT", call)
        self.assertIn("agent_profile=agent_profile", call)
        worker = (_POC / "worker_executor.py").read_text(encoding="utf-8")
        self.assertIn("agent_profile=profile", worker)


if __name__ == "__main__":
    unittest.main()
