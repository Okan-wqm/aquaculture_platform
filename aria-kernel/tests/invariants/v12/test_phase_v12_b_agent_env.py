"""Plan 032 Faz 032b — the spawn environment is built, the workspace is explicit,
and the write scope is a mount, not a promise.

Invariants:
  I-V12-ENV-01   `build_agent_env` never copies: secret-shaped names that are not
                 explicitly granted are dropped; the baseline, the CLI auth set,
                 non-secret `CLAUDE_CODE_*` and the profile passthrough pass; HOME
                 is synthetic and XDG_* point inside it; the report names every
                 decision without a value.
  I-V12-ENV-02   the managed-login directory is made explicit (`CLAUDE_CONFIG_DIR`)
                 when the runner relied on the real `$HOME/.claude`.
  I-V12-ENV-03   `run_claude_exec` spawns with the BUILT environment and hands the
                 login directory to the sandbox as a read-only bind.
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
    derive_claude_config_dir,
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
                             "SOME_PASSWORD", "OPERATOR_NOTE", "ARIA_ZAI_API_KEY"):
                    self.assertNotIn(name, env, name)
                for name in ("PATH", "LANG", "TERM", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
                             "CLAUDE_CODE_OAUTH_TOKEN", "ARIA_TOOLS_DIR"):
                    self.assertIn(name, env, name)
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
                                            "dropped_secret_shaped", "synthetic_home",
                                            "claude_config_dir_bound"})
                for value in base.values():
                    if "VALUE" in value:
                        self.assertNotIn(value, str(gov), "values never enter the report")
            finally:
                cleanup_synthetic_home(report.home)
            self.assertFalse(Path(report.home).exists())

    def test_I_V12_ENV_01_extra_is_added_after_the_filter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            built = build_agent_env({"PATH": "/bin"}, extra={"ANTHROPIC_BASE_URL": "https://x", "IS_SANDBOX": "1"}, tmp_root=tmp)
            self.assertEqual(built.env["ANTHROPIC_BASE_URL"], "https://x")
            self.assertEqual(built.env["IS_SANDBOX"], "1")
            cleanup_synthetic_home(built.report.home)
        self.assertNotIn("HOME", BASELINE_ENV_NAMES)

    def test_I_V12_ENV_02_managed_login_dir_is_made_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            real_home = Path(tmp) / "home"
            (real_home / ".claude").mkdir(parents=True)
            self.assertEqual(derive_claude_config_dir({"HOME": str(real_home)}), str(real_home / ".claude"))
            self.assertEqual(derive_claude_config_dir({"HOME": str(real_home), "CLAUDE_CONFIG_DIR": "/opt/c"}), "/opt/c")
            self.assertIsNone(derive_claude_config_dir({"HOME": str(Path(tmp) / "nohome")}))
            built = build_agent_env({"HOME": str(real_home), "PATH": "/bin"}, tmp_root=tmp)
            self.assertEqual(built.env["CLAUDE_CONFIG_DIR"], str(real_home / ".claude"))
            self.assertTrue(built.report.claude_config_dir)
            cleanup_synthetic_home(built.report.home)


class TheSpawnUsesTheBuiltEnv(unittest.TestCase):
    def test_I_V12_ENV_03_run_claude_exec_passes_the_built_env_and_binds_the_login_dir(self) -> None:
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
            with mock.patch.dict(os.environ, {"HOME": str(real_home), "GH_TOKEN": "ghp", "ARIA_LEASE_TOKEN": "l", "TMPDIR": tmp}, clear=False), \
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
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(real_home / ".claude"))
        self.assertTrue(Path(env["HOME"]).name.startswith(SYNTHETIC_HOME_PREFIX))
        self.assertEqual(captured["cwd"], tmp)
        self.assertEqual(captured["containment"]["write_scope"], ("**",))
        self.assertEqual(captured["containment"]["extra_ro_binds"], (str(real_home / ".claude"),))
        argv = captured["argv"]
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
            return isf.wrap_bash_in_sandbox(["claude"], workspace_root=workspace, allow_network=True, **kwargs)

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
