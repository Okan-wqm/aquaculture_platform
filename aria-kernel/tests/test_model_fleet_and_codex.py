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
    fixture_directory = tempfile.TemporaryDirectory(prefix="aria-s4-provider-probe-")
    case.addCleanup(fixture_directory.cleanup)
    root = Path(fixture_directory.name)
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
    def _capture_codex_launch(self, **selection: str) -> tuple[object, list, str, str, Path]:
        import codex_runtime

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-s4-codex-cwd-")
        self.addCleanup(fixture_directory.cleanup)
        root = Path(fixture_directory.name)
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
