"""ARIA-MEDIUM-027 — the mixed-model fleet and the Codex runtime bridge.

Operator requirement 2026-08-29: agents must be deliberately MIXED across
available providers (never all one model when two are up), collapsing to a
single provider honestly when only one credential exists. These tests pin
both the policy and the bridge contract.
"""

from __future__ import annotations

import sys
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))
_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from aria_kernel.model_fleet import (  # noqa: E402
    assign_mixed_models,
    available_providers,
    provider_for_model,
)


def _probe(environ: dict[str, str]) -> list[str]:
    # Binary probes must read deterministically False on ANY host: point
    # PATH at an empty directory so shutil.which finds nothing, making
    # availability PURELY credential-env-driven in these fixtures.
    empty = tempfile.mkdtemp(prefix="aria-fleet-empty-path-")
    env = {"PATH": empty, **environ}
    return [p.key for p in available_providers(env)]


def _filesystem_provider_probe(
    case: unittest.TestCase, *, binaries: tuple[str, ...],
) -> tuple[Path, Path, Path]:
    scratch = tempfile.TemporaryDirectory(prefix="aria-s4-provider-probe-")
    case.addCleanup(scratch.cleanup)
    root = Path(scratch.name)
    effective_home = root / "effective-home"
    ambient_home = root / "ambient-home"
    binary_dir = root / "bin"
    for path in (effective_home, ambient_home, binary_dir):
        path.mkdir()
    for binary in binaries:
        executable = binary_dir / binary
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o755)
    return effective_home, ambient_home, binary_dir


class Availability(unittest.TestCase):
    def test_default_codex_home_uses_effective_home_dot_codex(self) -> None:
        effective_home, ambient_home, binary_dir = _filesystem_provider_probe(
            self, binaries=("codex",),
        )
        codex_home = effective_home / ".codex"
        codex_home.mkdir()
        # This is a file-presence fixture, not a usable provider credential.
        auth_path = codex_home / "auth.json"
        auth_path.write_text("{}\n", encoding="utf-8")
        with mock.patch("aria_kernel.model_fleet.Path.home", return_value=ambient_home):
            providers = available_providers({
                "HOME": str(effective_home), "PATH": str(binary_dir),
            })
        self.assertEqual([provider.key for provider in providers], ["openai"])
        self.assertEqual(auth_path.read_bytes(), b"{}\n")
        self.assertFalse((ambient_home / "auth.json").exists())
        self.assertFalse((effective_home / "auth.json").exists())

    def test_explicit_empty_path_does_not_use_ambient_cli(self) -> None:
        effective_home, ambient_home, binary_dir = _filesystem_provider_probe(
            self, binaries=("claude",),
        )
        from aria_kernel import model_fleet

        with mock.patch.dict(model_fleet.os.environ, {"PATH": str(binary_dir)}):
            with mock.patch("aria_kernel.model_fleet.Path.home", return_value=ambient_home):
                providers = available_providers({
                    "HOME": str(effective_home), "PATH": "",
                    "CODEX_HOME": str(effective_home / ".codex"),
                })
        self.assertEqual(providers, [])

    def test_no_credentials_means_no_providers(self) -> None:
        self.assertEqual(_probe({}), [])

    def test_zai_key_activates_zai_when_claude_absent(self) -> None:
        # Without a claude binary on PATH the managed session cannot be
        # proven — zai's own credential is not enough (its redirect still
        # rides the claude runtime). Fail-closed in the absent direction.
        self.assertEqual(_probe({"ARIA_ZAI_API_KEY": "k"}), [])

    def test_codex_subscription_session_activates_openai_without_api_key(self) -> None:
        # Operator decision 2026-08-29: Codex rides a ChatGPT subscription
        # login, not an API key. A CODEX_HOME carrying auth.json plus the
        # binary on PATH activates the provider with NO OPENAI_API_KEY.
        import tempfile as _tf
        from pathlib import Path as _P
        home = _tf.mkdtemp(prefix="aria-codex-home-")
        (_P(home) / "auth.json").write_text("{}", encoding="utf-8")
        binp = _tf.mkdtemp(prefix="aria-codex-bin-")
        (_P(binp) / "codex").write_text("#!/bin/sh\n", encoding="utf-8")
        (_P(binp) / "codex").chmod(0o755)
        found = _probe({"CODEX_HOME": home, "PATH": binp})
        self.assertIn("openai", found)

    def test_codex_without_session_or_key_stays_off(self) -> None:
        import tempfile as _tf
        from pathlib import Path as _P
        home = _tf.mkdtemp(prefix="aria-codex-empty-")
        binp = _tf.mkdtemp(prefix="aria-codex-bin2-")
        (_P(binp) / "codex").write_text("#!/bin/sh\n", encoding="utf-8")
        (_P(binp) / "codex").chmod(0o755)
        self.assertNotIn("openai", _probe({"CODEX_HOME": home, "PATH": binp}))


class MixedAssignment(unittest.TestCase):
    def test_default_home_probe_reaches_real_mixed_assignment(self) -> None:
        effective_home, ambient_home, binary_dir = _filesystem_provider_probe(
            self, binaries=("claude", "codex"),
        )
        codex_home = effective_home / ".codex"
        codex_home.mkdir()
        (codex_home / "auth.json").write_text("{}\n", encoding="utf-8")
        roles = ["evidence_judgment", "adversarial_judgment", "consensus_arbitration"]
        # Both the filesystem probe and its existing assignment consumer run
        # normally. No provider-list or selection function is replaced.
        with mock.patch("aria_kernel.model_fleet.Path.home", return_value=ambient_home):
            assignment = assign_mixed_models(roles, environ={
                "HOME": str(effective_home), "PATH": str(binary_dir),
            })
        self.assertEqual(assignment, {
            "evidence_judgment": "opus",
            "adversarial_judgment": "gpt-5.2-codex",
            "consensus_arbitration": "opus",
        })

    def test_two_providers_stripe_roles_across_vendors(self) -> None:
        # Simulate both claude+codex binaries present by injecting them via
        # PATH built by available_providers is binary-gated; test the pure
        # assignment function through its provider list seam instead.
        from aria_kernel import model_fleet

        providers = [
            p for p in model_fleet._FLEET if p.key in ("anthropic", "openai")
        ]
        original = model_fleet.available_providers
        model_fleet.available_providers = lambda env=None: providers  # type: ignore[assignment]
        try:
            roles = ["evidence_judgment", "adversarial_judgment", "consensus_arbitration"]
            assignment = assign_mixed_models(roles)
        finally:
            model_fleet.available_providers = original  # type: ignore[assignment]
        # Adjacent roles NEVER share a vendor when >=2 providers exist —
        # the anti-groupthink property the operator asked for.
        self.assertEqual(assignment["evidence_judgment"], "opus")
        self.assertEqual(assignment["adversarial_judgment"], "gpt-5.2-codex")
        self.assertEqual(assignment["consensus_arbitration"], "opus")
        self.assertNotEqual(
            assignment["evidence_judgment"],
            assignment["adversarial_judgment"],
        )

    def test_single_provider_runs_everything_on_it(self) -> None:
        from aria_kernel import model_fleet

        providers = [p for p in model_fleet._FLEET if p.key == "zai"]
        original = model_fleet.available_providers
        model_fleet.available_providers = lambda env=None: providers  # type: ignore[assignment]
        try:
            assignment = assign_mixed_models(["a", "b", "c", "d"])
        finally:
            model_fleet.available_providers = original  # type: ignore[assignment]
        self.assertEqual(set(assignment.values()), {"glm-5.3"})

    def test_no_providers_assign_nothing(self) -> None:
        empty = tempfile.mkdtemp(prefix="aria-fleet-empty-path-")
        self.assertEqual(assign_mixed_models(["a"], environ={"PATH": empty}), {})

    def test_provider_for_model_mapping(self) -> None:
        self.assertEqual(provider_for_model("opus"), "anthropic")
        self.assertEqual(provider_for_model("glm-5.3"), "zai")
        self.assertEqual(provider_for_model("gpt-5.2-codex"), "openai")
        self.assertIsNone(provider_for_model("unknown-model"))


class CodexBridge(unittest.TestCase):
    def test_managed_child_cannot_reach_disposable_host_process_root(self) -> None:
        import os
        import subprocess
        import select
        import codex_runtime
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-managed-pid-boundary-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        workspace, runtime, auth, binaries = [root / name for name in ("workspace", "runtime", "auth", "bin")]
        for directory in (workspace, runtime, auth, binaries):
            directory.mkdir()
        (auth / "auth.json").write_text('{"fixture":"public-managed-session"}\n', encoding="utf-8")
        sentinel = root / "ordinary-sibling-sentinel.txt"
        sentinel.write_text("public disposable sibling sentinel\n", encoding="utf-8")
        sibling = subprocess.Popen(
            [sys.executable, "-B", "-c", "import sys; print('ready', flush=True); sys.stdin.read()"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            cwd=str(root), env={"PATH": os.defpath},
        )
        def reap_sibling() -> None:
            if sibling.stdin is not None:
                sibling.stdin.close()
            try:
                sibling.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sibling.kill()
                sibling.wait(timeout=5)
            if sibling.stdout is not None:
                sibling.stdout.close()
            if sibling.stderr is not None:
                sibling.stderr.close()
        self.addCleanup(reap_sibling)
        self.assertTrue(select.select([sibling.stdout], [], [], 5)[0])
        self.assertEqual(sibling.stdout.readline().strip(), "ready")
        self.assertIsNone(sibling.poll())
        sibling_root_sentinel = Path("/proc") / str(sibling.pid) / "root" / str(sentinel).lstrip("/")
        self.assertEqual(sibling_root_sentinel.read_text(), sentinel.read_text())
        sibling_namespace = (Path("/proc") / str(sibling.pid) / "ns/pid").stat().st_ino
        executable = binaries / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json,os,sys\nfrom pathlib import Path\n"
            "assert sys.argv[-2:]==['login','status']\n"
            "auth=json.loads((Path(os.environ['CODEX_HOME'])/'auth.json').read_text())\n"
            f"sibling=Path('/proc/{sibling.pid}')\n"
            f"sentinel=Path({str(sibling_root_sentinel)!r})\n"
            "observation={'auth_matches':auth=={'fixture':'public-managed-session'},\n"
            " 'sibling_visible':sibling.exists(),'root_sentinel_visible':sentinel.exists(),\n"
            " 'pid_namespace':Path('/proc/self/ns/pid').stat().st_ino}\n"
            "(Path(os.environ['TMPDIR'])/'pid-boundary.json').write_text(json.dumps(observation))\n"
            "print('Logged in using ChatGPT',file=sys.stderr)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        context = codex_runtime._prepare_managed_codex_context(
            workspace=workspace, runtime_directory=runtime,
            environment={**os.environ, "PATH": str(binaries) + os.pathsep + os.defpath,
                         "HOME": str(root), "CODEX_HOME": str(auth)},
            profile=read_agent_runtime_profile("aria-adversarial-judge", repo_root=_PARENT.parent),
        )
        status = codex_runtime._probe_codex_auth_status(
            environ=context.environment, timeout_seconds=15,
            _wrap_command=lambda argv: context.wrap(argv, 15),
        )
        self.assertEqual((status.exit_code, status.auth_observation, status.auth_method), (0, "available", "chatgpt"))
        child = json.loads((runtime / "tmp/pid-boundary.json").read_text())
        self.assertTrue(child["auth_matches"])
        self.assertFalse(child["sibling_visible"])
        self.assertFalse(child["root_sentinel_visible"])
        self.assertNotEqual(child["pid_namespace"], sibling_namespace)
        self.assertIsNone(sibling.poll())
        self.assertEqual(sentinel.read_text(), "public disposable sibling sentinel\n")

    def test_managed_auth_file_is_available_without_supervisor_history(self) -> None:
        import os
        import codex_runtime
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-auth-file-boundary-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        workspace, runtime, auth, binaries = [root / name for name in ("workspace", "runtime", "auth", "bin")]
        for directory in (workspace, runtime, auth, binaries):
            directory.mkdir()
        auth_file = auth / "auth.json"
        auth_file.write_text('{"fixture":"public-managed-session"}\n', encoding="utf-8")
        (auth / "sessions").mkdir()
        (auth / "sessions/ordinary-history.txt").write_text("public history sentinel\n", encoding="utf-8")
        (auth / "ordinary-oracle.txt").write_text("public oracle sentinel\n", encoding="utf-8")
        before = {str(path.relative_to(auth)): path.read_bytes() for path in auth.rglob("*") if path.is_file()}
        executable = binaries / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json,os,sys\nfrom pathlib import Path\n"
            "assert sys.argv[-2:]==['login','status']\n"
            "home=Path(os.environ['CODEX_HOME']); selected=home/'auth.json'\n"
            f"original=Path({str(auth)!r})\n"
            "observation={'pid':os.getpid(),'child_home':str(home),\n"
            " 'auth_matches':json.loads(selected.read_text())=={'fixture':'public-managed-session'},\n"
            " 'auth_inode':[selected.stat().st_dev,selected.stat().st_ino],\n"
            " 'relative_history_visible':(home/'sessions/ordinary-history.txt').exists(),\n"
            " 'absolute_history_visible':(original/'sessions/ordinary-history.txt').exists(),\n"
            " 'relative_oracle_visible':(home/'ordinary-oracle.txt').exists(),\n"
            " 'absolute_oracle_visible':(original/'ordinary-oracle.txt').exists()}\n"
            "try:\n selected.write_text('ordinary attempted rewrite')\n observation['auth_write_refused']=False\n"
            "except OSError:\n observation['auth_write_refused']=True\n"
            "try:\n (home/'ordinary-child-cache.txt').write_text('private child state')\n observation['private_state_writable']=True\n"
            "except OSError:\n observation['private_state_writable']=False\n"
            "(Path(os.environ['TMPDIR'])/'auth-boundary-observation.json').write_text(json.dumps(observation))\n"
            "print('Logged in using ChatGPT',file=sys.stderr)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        environment = {**os.environ, "PATH": str(binaries) + os.pathsep + os.defpath,
                       "HOME": str(root), "CODEX_HOME": str(auth)}
        context = codex_runtime._prepare_managed_codex_context(
            workspace=workspace, runtime_directory=runtime, environment=environment,
            profile=read_agent_runtime_profile("aria-adversarial-judge", repo_root=_PARENT.parent),
        )
        status = codex_runtime._probe_codex_auth_status(
            environ=context.environment, timeout_seconds=15,
            _wrap_command=lambda argv: context.wrap(argv, 15),
        )
        self.assertEqual((status.exit_code, status.auth_observation, status.auth_method), (0, "available", "chatgpt"))
        child = json.loads((runtime / "tmp/auth-boundary-observation.json").read_text())
        self.assertNotEqual(child["pid"], os.getpid())
        self.assertTrue(child["auth_matches"])
        self.assertFalse(child["relative_history_visible"])
        self.assertFalse(child["absolute_history_visible"])
        self.assertFalse(child["relative_oracle_visible"])
        self.assertFalse(child["absolute_oracle_visible"])
        self.assertTrue(Path(child["child_home"]).is_relative_to(runtime))
        self.assertNotEqual(Path(child["child_home"]), auth)
        self.assertEqual(child["auth_inode"], [auth_file.stat().st_dev, auth_file.stat().st_ino])
        self.assertTrue(child["auth_write_refused"])
        self.assertTrue(child["private_state_writable"])
        self.assertEqual({str(path.relative_to(auth)): path.read_bytes() for path in auth.rglob("*") if path.is_file()}, before)

    def test_managed_status_accepts_known_readonly_path_alias_warning(self) -> None:
        import os
        import codex_runtime

        with tempfile.TemporaryDirectory(prefix="aria-status-warning-") as fixture_directory:
            root = Path(fixture_directory)
            program = root / "status.py"
            program.write_text(
                "import sys\n"
                "print('WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)',file=sys.stderr)\n"
                "print('Logged in using ChatGPT',file=sys.stderr)\n",
                encoding="utf-8",
            )
            status = codex_runtime._probe_codex_auth_status(
                environ={"PATH": os.defpath, "HOME": str(root)}, timeout_seconds=5,
                _wrap_command=lambda argv: [sys.executable, "-B", str(program)],
            )
        self.assertEqual(status.exit_code, 0)
        self.assertEqual(status.auth_observation, "available")
        self.assertEqual(status.auth_method, "chatgpt")
        self.assertEqual(status.quota_observation, "unknown")
        self.assertEqual(status.reason, "cli_reported_managed_login_with_readonly_path_alias_warning")

    def test_managed_status_keeps_conflicting_or_additional_output_unknown(self) -> None:
        import os
        import codex_runtime

        warning = "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)\n"
        managed = "Logged in using ChatGPT\n"
        cases = {
            "conflicting-auth": warning + managed + "Logged in using an API key - ordinary-inert-fixture\n",
            "unknown-warning": "WARNING: ordinary unsupported diagnostic\n" + managed,
            "extra-output": warning + managed + "ordinary additional output\n",
            "duplicate-auth": warning + managed + managed,
        }
        with tempfile.TemporaryDirectory(prefix="aria-status-unknown-") as fixture_directory:
            root = Path(fixture_directory)
            program = root / "status.py"
            for label, transcript in cases.items():
                with self.subTest(case=label):
                    program.write_text(
                        "import sys\nsys.stderr.write(" + repr(transcript) + ")\n",
                        encoding="utf-8",
                    )
                    status = codex_runtime._probe_codex_auth_status(
                        environ={"PATH": os.defpath, "HOME": str(root)}, timeout_seconds=5,
                        _wrap_command=lambda argv: [sys.executable, "-B", str(program)],
                    )
                    self.assertEqual(status.exit_code, 0)
                    self.assertEqual(status.auth_observation, "unknown")
                    self.assertEqual(status.auth_method, "unknown")
                    self.assertEqual(status.quota_observation, "unknown")
                    self.assertEqual(status.reason, "status_output_unrecognized")

    def test_managed_limiter_receives_bus_plumbing_without_exposing_it_to_codex(self) -> None:
        import os
        import codex_runtime
        from aria_kernel import implementation_safety
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-managed-limiter-env-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        workspace, runtime, auth, binaries = [root / name for name in ("workspace", "runtime", "auth", "bin")]
        for directory in (workspace, runtime, auth, binaries):
            directory.mkdir()
        (auth / "ordinary-sentinel.txt").write_text("public fixture state\n")
        observations = root / "limiter-observations.jsonl"
        bus_names = ("DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR")
        bus_values = {bus_names[0]: "unix:path=/ordinary-fixture-bus", bus_names[1]: str(root / "user-runtime")}
        (root / "user-runtime").mkdir()
        limiter = binaries / "systemd-run"
        limiter.write_text(
            f"#!{sys.executable}\n"
            "import json,os,sys\n"
            f"names={bus_names!r}; expected={bus_values!r}\n"
            "probe=sys.argv[-1]=='/bin/true'\n"
            f"with open({str(observations)!r},'a') as stream:\n"
            " stream.write(json.dumps({'probe':probe,'pid':os.getpid(),\n"
            "  'bus_present':[name for name in names if os.environ.get(name)==expected[name]]})+'\\n')\n"
            "if any(os.environ.get(name)!=expected[name] for name in names):\n"
            " print('Failed to connect to bus: No medium found',file=sys.stderr);raise SystemExit(1)\n"
            "if probe:raise SystemExit(0)\n"
            "index=1\n"
            "while sys.argv[index].startswith('--'):index+=1\n"
            "os.execvp(sys.argv[index],sys.argv[index:])\n", encoding="utf-8",
        )
        limiter.chmod(0o755)
        executable = binaries / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json,os,sys\n"
            "from pathlib import Path\n"
            "assert sys.argv[-2:]==['login','status'],sys.argv[1:]\n"
            f"names={bus_names!r}+('OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ARIA_ZAI_API_KEY')\n"
            "result={'pid':os.getpid(),'received_names':[name for name in names if name in os.environ],\n"
            " 'home':os.environ['HOME'],'codex_home':os.environ['CODEX_HOME']}\n"
            "(Path(os.environ['TMPDIR'])/'child-observation.json').write_text(json.dumps(result))\n"
            "print('Logged in using ChatGPT',file=sys.stderr)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        environment = {**os.environ, **bus_values, "PATH": str(binaries) + os.pathsep + os.defpath,
                       "HOME": str(root), "CODEX_HOME": str(auth),
                       "OPENAI_API_KEY": "ordinary-inert-key", "ARIA_ZAI_API_KEY": "ordinary-inert-zai-key"}
        implementation_safety._systemd_run_available.cache_clear()
        self.addCleanup(implementation_safety._systemd_run_available.cache_clear)
        # Only the limiter transport and provider status are declared
        # substitutes. Real owners build the commands/environments; bwrap,
        # Popen, namespace containment, pipes and status parsing remain real.
        with mock.patch.dict(os.environ, environment, clear=True):
            context = codex_runtime._prepare_managed_codex_context(
                workspace=workspace, runtime_directory=runtime, environment=environment,
                profile=read_agent_runtime_profile("aria-adversarial-judge", repo_root=_PARENT.parent),
            )
            status = codex_runtime._probe_codex_auth_status(
                environ=context.environment, timeout_seconds=10,
                _wrap_command=lambda argv: context.wrap(argv, 10),
            )
        rows = [json.loads(line) for line in observations.read_text().splitlines()]
        self.assertTrue(rows[0]["probe"])
        self.assertEqual(rows[0]["bus_present"], list(bus_names))
        self.assertTrue(any(not row["probe"] for row in rows), "The selected limiter must actually run.")
        self.assertEqual((status.auth_observation, status.auth_method), ("available", "chatgpt"))
        self.assertEqual([row["bus_present"] for row in rows if not row["probe"]], [list(bus_names)])
        child = json.loads((runtime / "tmp/child-observation.json").read_text())
        self.assertNotEqual(child["pid"], os.getpid())
        self.assertEqual(child["received_names"], [])
        self.assertEqual(child["home"], implementation_safety.SANDBOX_HOME)
        self.assertEqual(child["codex_home"], str(auth))
        self.assertEqual((auth / "ordinary-sentinel.txt").read_text(), "public fixture state\n")

    def test_wrapped_status_distinguishes_user_bus_failure_from_provider_auth(self) -> None:
        import os
        import codex_runtime

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-limiter-status-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        executable = root / "ordinary-control.py"
        executable.write_text(
            "import sys\n"
            "print('Failed to connect to bus: No medium found',file=sys.stderr)\n"
            "raise SystemExit(1)\n", encoding="utf-8",
        )
        # The declared control substitute emits the exact public error already
        # observed from systemd-run. Popen/pipe/byte cap/reaping stay real.
        status = codex_runtime._probe_codex_auth_status(
            environ={"PATH": os.defpath, "HOME": str(root)}, timeout_seconds=5,
            _wrap_command=lambda argv: [sys.executable, "-B", str(executable)],
        )
        self.assertEqual(status.exit_code, 1)
        self.assertEqual(status.auth_observation, "unknown")
        self.assertEqual(status.auth_method, "unknown")
        self.assertEqual(status.quota_observation, "unknown")
        self.assertEqual(status.reason, "control_plane_failure")
        self.assertEqual(status.control_status, "unavailable")
        self.assertEqual(status.control_reason, "user_bus_unavailable")

    def test_actual_codex_exec_child_excludes_ambient_and_explicit_provider_keys(self) -> None:
        import os
        from codex_runtime import codex_dispatch

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-managed-codex-child-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
        workspace = root / "workspace"
        binary_dir = root / "bin"
        managed_home = root / "managed-home"
        for directory in (workspace, binary_dir, managed_home):
            directory.mkdir()
        observations = root / "public-child-observations.jsonl"
        names = ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY",
                 "CLAUDE_API_KEY", "ARIA_ZAI_API_KEY", "ANTHROPIC_AUTH_TOKEN")
        executable = binary_dir / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "args = sys.argv[1:]\n"
            "if args == ['login', 'status']:\n"
            "    print('Logged in using ChatGPT', file=sys.stderr)\n"
            "    raise SystemExit(0)\n"
            "if not args or args[0] != 'exec': raise SystemExit(97)\n"
            f"names = {names!r}\n"
            "row = {'argv': args, 'pid': os.getpid(), 'cwd': os.getcwd(), "
            "'provider_key_names': sorted(name for name in names if name in os.environ)}\n"
            f"with open({str(observations)!r}, 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(row) + '\\n')\n"
            "output = pathlib.Path(args[args.index('--output-last-message') + 1])\n"
            "output.write_text('ordinary simulated managed CLI response', encoding='utf-8')\n"
            "print(json.dumps({'type': 'turn.completed'}))\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        # Public inert fixture strings only. This is a real local process,
        # not an installed CLI, credential record or provider model call.
        ambient = {
            "PATH": str(binary_dir), "HOME": str(managed_home),
            "CODEX_HOME": str(managed_home), "TMPDIR": str(root),
            "LANG": "C.UTF-8", "OPENAI_API_KEY": "ordinary-ambient-placeholder",
            "ANTHROPIC_API_KEY": "ordinary-ambient-placeholder",
            "ARIA_ZAI_API_KEY": "ordinary-ambient-placeholder",
        }
        explicit = {
            "CODEX_API_KEY": "ordinary-explicit-placeholder",
            "CLAUDE_API_KEY": "ordinary-explicit-placeholder",
            "ANTHROPIC_AUTH_TOKEN": "ordinary-explicit-placeholder",
        }
        with mock.patch.dict(os.environ, ambient, clear=True):
            result = codex_dispatch(
                "Read the ordinary fixture.", model="gpt-6-astra", effort="ultra",
                sandbox="read-only", cwd=workspace, timeout_seconds=10,
                env=explicit,
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.final_message, "ordinary simulated managed CLI response")
        rows = [json.loads(line) for line in observations.read_text().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertIsInstance(rows[0]["pid"], int)
        self.assertGreater(rows[0]["pid"], 0)
        self.assertEqual(rows[0]["cwd"], str(workspace))
        argv = rows[0]["argv"]
        self.assertEqual(argv[0], "exec")
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-6-astra")
        self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
        self.assertIn('model_reasoning_effort="ultra"', argv)
        self.assertEqual(rows[0]["provider_key_names"], [])
        self.assertFalse(Path(argv[argv.index("--output-last-message") + 1]).exists())

    def _capture_codex_launch(self, **selection: str) -> tuple[object, list, str, str, Path]:
        import codex_runtime

        scratch = tempfile.TemporaryDirectory(prefix="aria-s4-codex-cwd-")
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        launches = []
        # This is a deterministic transport fixture, never provider-observed
        # model/effort evidence. The real adapter constructs argv and parses it.
        transcript = '{"type":"thread.started","thread_id":"offline-fixture"}\n' \
                     '{"type":"turn.completed"}\n'
        final_message = "ordinary deterministic transport response\n"

        def transport(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            launches.append((list(argv), kwargs))
            output = Path(argv[argv.index("--output-last-message") + 1])
            output.write_text(final_message, encoding="utf-8")
            return subprocess.CompletedProcess(argv, 0, stdout=transcript, stderr="")

        with mock.patch.object(codex_runtime.subprocess, "run", side_effect=transport):
            result = codex_runtime.codex_dispatch(
                "Read the ordinary fixture.", sandbox="read-only", cwd=root,
                run=codex_runtime.run_codex_exec, timeout_seconds=17,
                env={"ARIA_S4_PUBLIC_FIXTURE": "transport-only"}, **selection,
            )
        return result, launches, transcript, final_message, root

    def test_astra_ultra_reaches_actual_codex_launch_configuration(self) -> None:
        result, launches, transcript, final_message, root = self._capture_codex_launch(
            model="gpt-6-astra", effort="ultra",
        )
        self.assertEqual(len(launches), 1)
        argv, kwargs = launches[0]
        self.assertEqual(argv[:7], ["codex", "exec", "--json", "--sandbox",
                                   "read-only", "--model", "gpt-6-astra"])
        overrides = [argv[index + 1] for index, value in enumerate(argv) if value == "-c"]
        self.assertEqual(overrides, [
            "sandbox_workspace_write.network_access=false",
            "sandbox_read_only.network_access=false",
            'model_reasoning_effort="ultra"',
        ])
        self.assertEqual(argv[argv.index("--cd") + 1], str(root))
        self.assertEqual(argv[-1], "Read the ordinary fixture.")
        self.assertEqual(kwargs["cwd"], str(root))
        self.assertEqual(kwargs["timeout"], 17)
        self.assertFalse(kwargs["check"])
        self.assertTrue(kwargs["capture_output"])
        self.assertTrue(kwargs["text"])
        self.assertEqual(kwargs["env"]["ARIA_S4_PUBLIC_FIXTURE"], "transport-only")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, transcript)
        self.assertEqual(result.final_message, final_message)
        self.assertEqual(result.events, tuple(json.loads(line) for line in transcript.splitlines()))
        self.assertEqual(result.model, "gpt-6-astra")  # Existing requested-value echo only.
        self.assertTrue(all("model" not in event and "effort" not in event for event in result.events))
        self.assertFalse(Path(argv[argv.index("--output-last-message") + 1]).exists())

    def test_omitted_effort_preserves_legacy_codex_launch_configuration(self) -> None:
        result, launches, transcript, final_message, root = self._capture_codex_launch()
        self.assertEqual(len(launches), 1)
        argv, kwargs = launches[0]
        output = argv[argv.index("--output-last-message") + 1]
        self.assertEqual(argv, [
            "codex", "exec", "--json", "--sandbox", "read-only",
            "--model", "gpt-5.2-codex",
            "-c", "sandbox_workspace_write.network_access=false",
            "-c", "sandbox_read_only.network_access=false",
            "--output-last-message", output, "--cd", str(root),
            "Read the ordinary fixture.",
        ])
        self.assertEqual(kwargs["timeout"], 17)
        self.assertEqual(kwargs["cwd"], str(root))
        self.assertEqual(result.model, "gpt-5.2-codex")
        self.assertEqual(result.stdout, transcript)
        self.assertEqual(result.final_message, final_message)

    def test_omitted_effort_preserves_existing_dispatch_runner_call(self) -> None:
        from codex_runtime import CodexRunResult, codex_dispatch

        calls = []

        def legacy_runner(prompt: str, *, model: str, sandbox: str, cwd: Path | None) -> CodexRunResult:
            calls.append((prompt, model, sandbox, cwd))
            return CodexRunResult(0, "", "", "ordinary legacy runner", model=model)

        result = codex_dispatch("ordinary legacy prompt", run=legacy_runner)
        self.assertEqual(calls, [("ordinary legacy prompt", "gpt-5.2-codex", "read-only", None)])
        self.assertEqual(result.final_message, "ordinary legacy runner")

    def test_provider_alias_keeps_existing_fleet_defaults(self) -> None:
        from aria_kernel import model_fleet

        self.assertEqual(provider_for_model("gpt-6-astra"), "openai")
        self.assertIsNone(provider_for_model("gpt-6-astra-unlisted"))
        self.assertIsNone(provider_for_model("gpt-unlisted"))
        self.assertEqual([(p.key, p.default_model, p.runtime_hint, p.credential_env)
                          for p in model_fleet._FLEET], [
            ("anthropic", "opus", "claude", None),
            ("zai", "glm-5.3", "claude", "ARIA_ZAI_API_KEY"),
            ("openai", "gpt-5.2-codex", "codex", "OPENAI_API_KEY"),
        ])
        # Only availability is simulated; the real assignment owner still
        # stripes its original defaults. This is not a distinct-model trial.
        with mock.patch.object(model_fleet, "available_providers", return_value=list(model_fleet._FLEET)):
            assignment = assign_mixed_models(["judge", "reviewer", "arbiter", "scout"])
        self.assertEqual(assignment, {
            "judge": "opus", "reviewer": "glm-5.3", "arbiter": "gpt-5.2-codex", "scout": "opus",
        })

    def test_argv_shape_is_the_pinned_contract(self) -> None:
        from codex_runtime import build_codex_argv

        argv = build_codex_argv(
            "do the thing",
            model="gpt-5.2-codex",
            sandbox="read-only",
            output_last_message=Path("/tmp/last.txt"),
            cwd=Path("/repo"),
        )
        self.assertEqual(argv[0:4], ["codex", "exec", "--json", "--sandbox"])
        self.assertIn("gpt-5.2-codex", argv)
        self.assertIn("--output-last-message", argv)
        self.assertIn("--cd", argv)
        self.assertEqual(argv[-1], "do the thing")

    def test_invalid_sandbox_refused(self) -> None:
        from codex_runtime import build_codex_argv

        with self.assertRaises(ValueError):
            build_codex_argv("x", sandbox="danger-full-access")

    def test_401_events_map_to_typed_auth_failure(self) -> None:
        from codex_runtime import classify_codex_events

        result = classify_codex_events(
            [{"type": "turn.failed", "error": {"message": "unexpected status 401 Unauthorized: Missing bearer"}}],
            returncode=1,
        )
        self.assertIsNotNone(result.auth_failure)
        self.assertIsNone(result.credit_exhaustion)

    def test_quota_events_map_to_credit_exhaustion(self) -> None:
        from codex_runtime import classify_codex_events

        result = classify_codex_events(
            [{"type": "error", "message": "usage limit reached"}],
            returncode=1,
        )
        self.assertIsNotNone(result.credit_exhaustion)
        self.assertIsNone(result.auth_failure)

    def test_clean_run_has_no_typed_failure(self) -> None:
        from codex_runtime import classify_codex_events

        result = classify_codex_events([{"type": "turn.completed"}], returncode=0)
        self.assertIsNone(result.auth_failure)
        self.assertIsNone(result.credit_exhaustion)


if __name__ == "__main__":
    unittest.main()
