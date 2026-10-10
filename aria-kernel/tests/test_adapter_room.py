"""ARIA-CRITICAL-399 — every adapter runs in the room, and the room holds.

Before this module the tool runner spawned adapters with ``env=dict(os.environ)``
and the fixture runner with no ``env=`` at all, unconfined: an adapter read the
job's GH_TOKEN, the OIDC request token, GITHUB_ENV, the App private key the
nightly lane writes into RUNNER_TEMP, the kernel's own ``/proc/<pid>/environ``,
the durable store, and could write the workspace.

The live tests build the RUNNER's layout — workspace ``_work/<repo>/<repo>``
with the store checked out inside it, RUNNER_TEMP its sibling ``_work/_temp``
holding the key file — under ``/var/tmp``, not ``/tmp``: the room mounts its
own ``/tmp``, which would hide a key under ``/tmp`` for the wrong reason. The
probe adapter (``_helpers/adapter_room_probe.py``) tries every reach and exits
non-zero when any one lands, so an ``ok`` run IS the proof; its reported facts
are asserted as well.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.adapter_room import (
    ADAPTER_NODE_HEAP_DEFAULT_MB,
    adapter_environment,
    prepare_adapter_spawn,
    wrap_adapter_in_sandbox,
)
from aria_kernel.fixture_runner import refresh_fixture_suites, run_fixture_suite
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError, register_tool
from aria_kernel.tool_runner import run_tool
from tests.test_enterprise_cycle import shadow_tool

PROBE = Path(__file__).resolve().parent / "_helpers" / "adapter_room_probe.py"
TOOL_ID = "room-probe-adapter"
# Shaped like the nightly job's environment; none of these values is real.
JOB_ENVIRONMENT = {
    "GH_TOKEN": "ghs_roomprobe_not_a_real_token",
    "GITHUB_TOKEN": "ghs_roomprobe_not_a_real_token",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "roomprobe-oidc",
    "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.actions.invalid/roomprobe",
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic cm9vbXByb2Jl",
    "CLAUDE_CLI_MOCK": "true",
}


class RunnerLayout:
    """``_work/repo/repo`` (+ the store inside it) and ``_work/_temp`` (+ the key)."""

    def __init__(self, test: unittest.TestCase) -> None:
        base = Path(tempfile.mkdtemp(prefix="aria-room-", dir="/var/tmp"))
        test.addCleanup(shutil.rmtree, base, True)
        work = base / "_work"
        self.workspace = work / "repo" / "repo"
        (self.workspace / "src").mkdir(parents=True)
        (self.workspace / "src" / "app.ts").write_text("export const app = 1;\n", encoding="utf-8")
        self.runner_temp = work / "_temp"
        self.runner_temp.mkdir()
        self.pem = self.runner_temp / "aria-gh-app-private-key-1-1.pem"
        self.pem.write_text("-----BEGIN RSA PRIVATE KEY-----\nroomprobe\n", encoding="utf-8")
        self.pem.chmod(0o600)
        self.store = self.workspace / ".aria-state-store"
        self.tools = self.store / "aria-tools"
        self.tools.mkdir(parents=True)
        (self.store / "canary.jsonl").write_text("{}\n", encoding="utf-8")
        self.marker = base / "adapter-started"
        self.environment = {
            **JOB_ENVIRONMENT,
            "RUNNER_TEMP": str(self.runner_temp),
            "GITHUB_ENV": str(self.runner_temp / "_runner_file_commands" / "set_env_roomprobe"),
            "ARIA_TOOLS_DIR": str(self.tools),
        }

    def probe_argv(self, *, touch: bool = False) -> list[str]:
        argv = ["python3", PROBE.as_posix(), "--pem", str(self.pem), "--store", str(self.store)]
        return [*argv, "--touch", str(self.marker)] if touch else argv

    def tool(self, *, touch: bool = False, cwd: str = "src") -> dict:
        tool = shadow_tool()
        tool.update({"tool_id": TOOL_ID, "fixture_set": f"fixtures/{TOOL_ID}"})
        tool["runner"] = {
            **tool["runner"],
            "argv": self.probe_argv(touch=touch),
            "cwd": cwd,
            "timeout_ms": 60000,
            "stdin_json": False,
        }
        return tool

    def fixture_case(self) -> None:
        cases = self.workspace / "fixtures" / TOOL_ID / "cases"
        cases.mkdir(parents=True)
        (cases / "room.json").write_text(json.dumps({
            "name": "room",
            "input": {},
            "expected": {"status": "ok", "required_observations": ["fixture"]},
        }), encoding="utf-8")

    def run_tool(self) -> dict:
        with mock.patch.dict(os.environ, self.environment):
            return run_tool(
                TOOL_ID,
                {"repo_snapshot": {"allowed_paths": ["src/app.ts"], "snapshot_mode": "committed", "snapshot_hash": "sha256:room"}},
                "cyc-room-probe",
                workspace_root=self.workspace,
                base_dir=self.tools,
            )


def _probe_facts(envelope: dict) -> dict:
    """What the probe reported, from the run's own stdout (the returned
    envelope keeps the runtime-artifact payload the ledger row drops)."""
    stdout = (envelope.get("_runtime_artifact_payload") or {}).get("stdout") or ""
    return json.loads(stdout)["observations"][0]["details"] if stdout.strip() else {}


def _requires_backend(test: unittest.TestCase) -> None:
    if impl.sandbox_backend() is None:
        test.skipTest(f"bwrap is not usable on this host: {impl.sandbox_unavailable_detail()}")


class LiveRoomTests(unittest.TestCase):
    """The probe through the REAL runners, inside a real bwrap room."""

    def setUp(self) -> None:
        _requires_backend(self)
        self.layout = RunnerLayout(self)

    def test_the_tool_runner_runs_the_adapter_in_a_room_that_holds(self) -> None:
        # The key file is there and readable — by the kernel, outside.
        self.assertTrue(self.layout.pem.read_text(encoding="utf-8").startswith("-----BEGIN"))
        register_tool(self.layout.tool(), base_dir=self.layout.tools)
        result = self.layout.run_tool()
        envelope = result["envelope"]
        facts = _probe_facts(envelope)
        self.assertEqual(envelope["status"], "ok", f"the probe reached something: {facts or envelope['runner']['stderr_sample']}")
        self.assertEqual(facts["forbidden_env"], [])
        self.assertEqual(facts["pem"], "refused:FileNotFoundError")
        self.assertEqual(facts["proc_environ_leaks"], [])
        self.assertLessEqual(facts["visible_pids"], 3, "the room must not see the host's processes")
        self.assertEqual(facts["store_entries"], [])
        self.assertEqual(facts["workspace_write"], "refused:OSError")
        self.assertTrue(facts["network"].startswith("refused:"), facts["network"])
        # The declared names, and the runner's cwd inside the room.
        self.assertEqual(facts["repo_root"], str(self.layout.workspace.resolve()))
        self.assertTrue(facts["node_options"].endswith(f"--max-old-space-size={ADAPTER_NODE_HEAP_DEFAULT_MB}"))
        self.assertEqual(facts["cwd"], str((self.layout.workspace / "src").resolve()))
        # The envelope says, by NAME, that it was contained and what it withheld.
        runner = envelope["runner"]
        self.assertEqual(runner["sandbox_backend"], "bwrap")
        withheld = set(runner["spawn_environment"]["dropped_secret_shaped"])
        self.assertTrue({"GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"} <= withheld, withheld)
        self.assertIn("ARIA_TOOLS_DIR", runner["spawn_environment"]["dropped_store_bindings"])
        self.assertNotIn("GITHUB_ENV", runner["spawn_environment"]["passed"])
        self.assertNotIn("roomprobe", json.dumps(runner["spawn_environment"]), "names only, never values")

    def test_the_fixture_runner_runs_the_adapter_in_the_same_room(self) -> None:
        register_tool(self.layout.tool(), base_dir=self.layout.tools)
        self.layout.fixture_case()
        with mock.patch.dict(os.environ, self.layout.environment):
            summary = run_fixture_suite(
                TOOL_ID, workspace_root=self.layout.workspace, cycle_id="cyc-room-fixture", base_dir=self.layout.tools,
            )
        [case] = summary["cases"]
        self.assertEqual((case["status"], case["passed"]), ("ok", True), case["errors"])


    def test_the_genesis_sandbox_runs_a_drafted_adapter_in_the_same_room(self) -> None:
        from aria_kernel.skill_genesis_sandbox import execute_in_sandbox

        drafted = self.layout.workspace / "drafted_adapter.py"
        drafted.write_text(
            "import os\n"
            "print(sorted(n for n in ('GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_ENV') if n in os.environ))\n"
            "try:\n"
            f"    open({str(self.layout.pem)!r}).read()\n"
            "    print('pem:reached')\n"
            "except OSError:\n"
            "    print('pem:refused')\n",
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, self.layout.environment):
            result = execute_in_sandbox(drafted, workspace_root=self.layout.workspace, timeout_seconds=60)
        self.assertEqual((result.exit_code, result.stdout), (0, "[]\npem:refused\n"), result.stderr)


class NoBackendTests(unittest.TestCase):
    """No usable backend: the adapter never starts, in mock mode or real."""

    def setUp(self) -> None:
        self.layout = RunnerLayout(self)
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_tool_run_is_environment_unavailable_and_the_adapter_never_started(self) -> None:
        register_tool(self.layout.tool(touch=True), base_dir=self.layout.tools)
        result = self.layout.run_tool()
        envelope = result["envelope"]
        self.assertFalse(self.layout.marker.exists(), "the adapter ran without a room")
        self.assertEqual(envelope["status"], "environment_unavailable")
        self.assertIn("adapter_sandbox_unavailable", envelope["runner"]["stderr_sample"])
        self.assertIsNone(envelope["runner"]["sandbox_backend"])
        # An environment fault prices the host, not the tool.
        self.assertNotEqual(result["health_decision"].get("action"), "quarantine")

    def test_the_fixture_suite_is_refused_by_name_and_the_refresh_reports_it(self) -> None:
        register_tool(self.layout.tool(touch=True), base_dir=self.layout.tools)
        self.layout.fixture_case()
        with mock.patch.dict(os.environ, self.layout.environment):
            with self.assertRaisesRegex(GovernanceError, "adapter_sandbox_unavailable"):
                run_fixture_suite(
                    TOOL_ID, workspace_root=self.layout.workspace, cycle_id="cyc-room-none", base_dir=self.layout.tools,
                )
            refreshed = refresh_fixture_suites(
                workspace_root=self.layout.workspace, cycle_id="cyc-room-none", base_dir=self.layout.tools,
            )
        self.assertFalse(self.layout.marker.exists(), "the adapter ran without a room")
        self.assertEqual([entry["status"] for entry in refreshed["tools"]], ["blocked"])
        self.assertIn("adapter_sandbox_unavailable", refreshed["tools"][0]["reason"])
        blocked = [row for row in load_jsonl(self.layout.tools / "governance.jsonl") if row.get("kind") == "fixture_refresh_blocked"]
        self.assertEqual(len(blocked), 1)


class MockNightWithoutBackendTests(unittest.TestCase):
    """A mock night on a host without bwrap is DEGRADED by name, not crashed."""

    def test_the_cycle_completes_degraded_with_the_tool_environment_unavailable(self) -> None:
        from aria_kernel.cycle import run_enterprise_cycle
        from tests._helpers.production_shaped import cycle_workspace

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fixture = cycle_workspace(Path(tmp.name))
        register_tool(shadow_tool(), base_dir=fixture.tools_dir)
        with mock.patch.object(impl, "_bwrap_available", return_value=False), \
                mock.patch.dict(os.environ, {"CLAUDE_CLI_MOCK": "true"}):
            result = run_enterprise_cycle(
                workspace_root=fixture.workspace_root, cycle_id="cyc-room-mock-night", base_dir=fixture.tools_dir,
            )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["runtime_status"], "degraded")
        self.assertEqual(
            [(tool["tool_id"], tool["degradation_class"]) for tool in result["degraded_tools"]],
            [("fixture-shadow-tool", "environment_unavailable")],
        )


class RoomShapeTests(unittest.TestCase):
    """The argv, read without running it (the backend is assumed present)."""

    def setUp(self) -> None:
        self.layout = RunnerLayout(self)
        patcher = mock.patch.object(impl, "_bwrap_available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _room(self, *, base: dict | None = None, cwd: Path | None = None) -> list[str]:
        environ = dict(base if base is not None else self.layout.environment, PATH=os.environ.get("PATH", os.defpath))
        built = adapter_environment(environ, workspace_root=self.layout.workspace)
        return wrap_adapter_in_sandbox(
            self.layout.probe_argv(), workspace_root=self.layout.workspace,
            cwd=cwd or self.layout.workspace / "src", environment=built.env, store=self.layout.tools, base=environ,
        )

    @staticmethod
    def _binds(argv: list[str]) -> list[tuple[str, str, str]]:
        flags = ("--bind", "--ro-bind")
        return [(argv[i], argv[i + 1], argv[i + 2]) for i in range(len(argv) - 2) if argv[i] in flags]

    def test_the_workspace_is_read_only_the_network_and_pids_are_private(self) -> None:
        argv = self._room()
        workspace = str(self.layout.workspace.resolve())
        self.assertIn(("--ro-bind", workspace, workspace), self._binds(argv))
        self.assertNotIn(("--bind", workspace, workspace), self._binds(argv))
        separator = argv.index("--")
        for flag in ("--unshare-net", *impl.MANAGED_SPAWN_ISOLATION_FLAGS):
            self.assertIn(flag, argv[:separator])
        chdirs = [argv[i + 1] for i, flag in enumerate(argv[:separator]) if flag == "--chdir"]
        self.assertEqual(chdirs, [str((self.layout.workspace / "src").resolve())])

    def test_the_store_and_keys_are_masked_after_the_workspace_bind(self) -> None:
        argv = self._room()
        tmpfs = [argv[i + 1] for i, flag in enumerate(argv) if flag == "--tmpfs"]
        self.assertIn(str(self.layout.store.resolve()), tmpfs)
        self.assertIn(str((self.layout.workspace / "aria-debts" / "keys").resolve()), tmpfs)
        # The tools root lies inside the store: one mask hides both.
        self.assertNotIn(str(self.layout.tools.resolve()), tmpfs)
        workspace_bind = argv.index(str(self.layout.workspace.resolve()))
        self.assertGreater(argv.index(str(self.layout.store.resolve())), workspace_bind)

    def test_no_bind_reaches_runner_temp(self) -> None:
        argv = self._room()
        runner_temp = self.layout.runner_temp.resolve()
        for _, source, _ in self._binds(argv):
            self.assertFalse(runner_temp == Path(source) or runner_temp.is_relative_to(source), source)

    def test_a_runner_temp_inside_the_workspace_is_masked(self) -> None:
        inside = self.layout.workspace / "_temp"
        inside.mkdir()
        argv = self._room(base={**self.layout.environment, "RUNNER_TEMP": str(inside)})
        tmpfs = [argv[i + 1] for i, flag in enumerate(argv) if flag == "--tmpfs"]
        self.assertIn(str(inside.resolve()), tmpfs)

    def test_a_toolchain_prefix_holding_runner_temp_is_refused(self) -> None:
        toolchain_bin = self.layout.runner_temp / "bin"
        toolchain_bin.mkdir()
        fake = toolchain_bin / "python3"
        fake.write_text("#!/bin/sh\n", encoding="utf-8")
        fake.chmod(0o755)
        environ = {**self.layout.environment, "PATH": f"{toolchain_bin}:{os.environ.get('PATH', os.defpath)}"}
        built = adapter_environment(environ, workspace_root=self.layout.workspace)
        with self.assertRaisesRegex(impl.SandboxUnavailable, "adapter_toolchain_bind_contains_runner_temp"):
            wrap_adapter_in_sandbox(
                self.layout.probe_argv(), workspace_root=self.layout.workspace, cwd=self.layout.workspace,
                environment=built.env, store=self.layout.tools, base=environ,
            )

    def test_a_store_that_is_the_workspace_is_refused(self) -> None:
        built = adapter_environment(self.layout.environment, workspace_root=self.layout.workspace)
        with self.assertRaisesRegex(impl.SandboxUnavailable, "adapter_room_workspace_is_private_root"):
            wrap_adapter_in_sandbox(
                self.layout.probe_argv(), workspace_root=self.layout.workspace, cwd=self.layout.workspace,
                environment={**built.env, "PATH": os.environ.get("PATH", os.defpath)},
                store=self.layout.workspace, base=self.layout.environment,
            )

    def test_an_unresolvable_command_is_the_missing_file_it_always_was(self) -> None:
        with mock.patch.dict(os.environ, self.layout.environment):
            with self.assertRaises(FileNotFoundError):
                prepare_adapter_spawn(
                    ["no-such-adapter-binary"], workspace_root=self.layout.workspace, cwd=self.layout.workspace,
                )


class PublishedRowTests(unittest.TestCase):
    def test_the_published_by_cycle_row_names_the_backend_and_no_environment(self) -> None:
        from aria_kernel.runtime_artifacts import _runner_summary

        summary = _runner_summary({"type": "subprocess", "sandbox_backend": "bwrap", "spawn_environment": {"passed": ["PATH"]}})
        self.assertEqual(summary["sandbox_backend"], "bwrap")
        self.assertNotIn("spawn_environment", summary)
        self.assertIsNone(_runner_summary({"type": "subprocess"})["sandbox_backend"])


class AdapterEnvironmentTests(unittest.TestCase):
    def test_job_credentials_never_reach_the_adapter_and_the_declared_names_do(self) -> None:
        base = {**JOB_ENVIRONMENT, "PATH": "/usr/bin", "NODE_OPTIONS": "--enable-source-maps", "GITHUB_ENV": "/x", "RUNNER_TEMP": "/y"}
        built = adapter_environment(base, workspace_root="/work/repo", node_heap_mb=3072)
        for name in ("GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL",
                     "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GITHUB_ENV", "RUNNER_TEMP"):
            self.assertNotIn(name, built.env)
        # Composed, never overwritten: the operator's flag survives.
        self.assertEqual(built.env["NODE_OPTIONS"], "--enable-source-maps --max-old-space-size=3072")
        self.assertEqual(built.env["ARIA_REPO_ROOT"], str(Path("/work/repo").resolve()))
        self.assertEqual(set(built.report.declared), {"NODE_OPTIONS", "ARIA_REPO_ROOT"})


class SandboxChdirTests(unittest.TestCase):
    """``wrap_bash_in_sandbox(chdir=...)``: the room can start in the runner's cwd."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.workspace = Path(tmp.name).resolve() / "ws"
        (self.workspace / "tools" / "aria-poc").mkdir(parents=True)

    def test_the_default_argv_is_unchanged_for_every_existing_caller(self) -> None:
        default = impl._sandbox_argv(["true"], workspace_root=self.workspace, allow_network=False)
        explicit = impl._sandbox_argv(["true"], workspace_root=self.workspace, allow_network=False, chdir=self.workspace)
        self.assertEqual(default, explicit)
        index = default.index("--chdir")
        self.assertEqual(default[index + 1], str(self.workspace))
        self.assertEqual(default.count("--chdir"), 1)

    def test_a_subdirectory_changes_only_the_chdir_value(self) -> None:
        default = impl._sandbox_argv(["true"], workspace_root=self.workspace, allow_network=False)
        sub = self.workspace / "tools" / "aria-poc"
        moved = impl._sandbox_argv(["true"], workspace_root=self.workspace, allow_network=False, chdir=sub)
        index = default.index("--chdir")
        self.assertEqual(moved[:index + 1] + moved[index + 2:], default[:index + 1] + default[index + 2:])
        self.assertEqual(moved[index + 1], str(sub))

    def test_a_chdir_outside_the_workspace_is_refused(self) -> None:
        with self.assertRaisesRegex(impl.SandboxUnavailable, "sandbox_chdir_outside_workspace"):
            impl._sandbox_argv(["true"], workspace_root=self.workspace, allow_network=False, chdir=self.workspace.parent)


if __name__ == "__main__":
    unittest.main()
