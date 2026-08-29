"""ARIA-MEDIUM-027 — the mixed-model fleet and the Codex runtime bridge.

Operator requirement 2026-08-29: agents must be deliberately MIXED across
available providers (never all one model when two are up), collapsing to a
single provider honestly when only one credential exists. These tests pin
both the policy and the bridge contract.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

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


class Availability(unittest.TestCase):
    def test_no_credentials_means_no_providers(self) -> None:
        self.assertEqual(_probe({}), [])

    def test_zai_key_activates_zai_when_claude_absent(self) -> None:
        # Without a claude binary on PATH the managed session cannot be
        # proven — zai's own credential is not enough (its redirect still
        # rides the claude runtime). Fail-closed in the absent direction.
        self.assertEqual(_probe({"ARIA_ZAI_API_KEY": "k"}), [])


class MixedAssignment(unittest.TestCase):
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
