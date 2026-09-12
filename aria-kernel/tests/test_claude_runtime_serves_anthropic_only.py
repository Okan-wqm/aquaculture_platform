"""The claude binary serves the managed Anthropic session and nothing else.

ORPHAN-HIGH-764 had taught claude_runtime to reach another vendor through a
per-spawn ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN injection carrying the
Z.ai key. The operator policy of 2026-09-11 forbids handing any other vendor's
credential to this CLI at all: Z.ai is served by the kernel's own HTTP
transport (tools/aria-poc/zai_runtime.py), and a model that belongs to another
provider is refused at this runtime's spawn seam by name.

What this pins, one property per test:

* The redirect machinery is gone — not disabled, not defaulted off — so no
  configuration can bring it back.
* A foreign-provider model is refused BEFORE any preflight, with a
  ClaudePolicyViolation naming the model and its provider.
* The provider of a model is the fleet's word (aria_kernel.model_fleet), so
  the ladder's cross-provider rung and the executor's route resolution
  cannot disagree with the dispatcher about who serves what.
* The spawn environment build has no seam that could carry a base-URL or
  auth-token override: the defect class this repository keeps finding is a
  helper nobody calls — and its mirror image, a hook nobody removed.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import claude_runtime  # noqa: E402
from aria_kernel.model_fleet import provider_for_model  # noqa: E402


class NoRedirectMachinery(unittest.TestCase):
    def test_the_redirect_names_no_longer_exist(self) -> None:
        for name in ("PROVIDER_REDIRECTS", "provider_redirect_env", "provider_redirect_disclosure",
                     "ProviderRedirectUnavailable", "PROVIDER_REDIRECT_POLICY_ENV_VAR",
                     "PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(claude_runtime, name), name)

    def test_the_spawn_environment_build_carries_no_vendor_override(self) -> None:
        body = (_POC / "claude_runtime.py").read_text(encoding="utf-8")
        self.assertNotIn("provider_redirect_env(", body)
        self.assertNotIn('"ANTHROPIC_BASE_URL":', body.replace("UNSAFE_BILLING_ENV_VARS", ""))
        self.assertIn("ANTHROPIC_BASE_URL", claude_runtime.UNSAFE_BILLING_ENV_VARS,
                      "the billing-bypass gate still names the base URL as unsafe")


class ForeignModelsAreRefused(unittest.TestCase):
    def test_a_zai_tier_is_refused_by_name_before_any_preflight(self) -> None:
        with self.assertRaises(claude_runtime.ClaudePolicyViolation) as caught:
            claude_runtime.assert_model_served_by_claude_runtime("glm-5.3")
        self.assertIn("model_not_served_by_claude_runtime", str(caught.exception))
        self.assertIn("'glm-5.3'", str(caught.exception))
        self.assertIn("'zai'", str(caught.exception))

    def test_anthropic_tiers_and_unlisted_models_pass(self) -> None:
        for model in ("fable", "opus", "sonnet", "haiku", None, "some-future-anthropic-alias"):
            with self.subTest(model=model):
                claude_runtime.assert_model_served_by_claude_runtime(model)

    def test_run_claude_exec_refuses_at_its_first_line(self) -> None:
        """The check is the FIRST thing run_claude_exec does — before auth
        preflight, budget, or containment could fail for a different reason
        and mask the policy refusal."""
        import ast

        tree = ast.parse((_POC / "claude_runtime.py").read_text(encoding="utf-8"))
        function = next(node for node in ast.walk(tree)
                        if isinstance(node, ast.FunctionDef) and node.name == "run_claude_exec")
        first = function.body[0]
        self.assertIsInstance(first, ast.Expr)
        self.assertIsInstance(first.value, ast.Call)
        self.assertEqual(first.value.func.id, "assert_model_served_by_claude_runtime")


class TheFleetIsTheOneBinding(unittest.TestCase):
    def test_the_ladder_reads_provider_from_the_fleet(self) -> None:
        self.assertEqual(claude_runtime._model_provider("glm-5.3"), provider_for_model("glm-5.3"))
        self.assertEqual(claude_runtime._model_provider("glm-5.3"), "zai")
        self.assertEqual(claude_runtime._model_provider("opus"), "anthropic")
        self.assertEqual(claude_runtime._model_provider(None), "anthropic")

    def test_an_anthropic_auth_failure_still_walks_to_the_zai_rung(self) -> None:
        """ARIA-HIGH-023 survives the transport change: the cross-provider
        rung is still glm-5.3 — the executor now serves that rung through the
        Z.ai transport instead of a redirected claude spawn. For a READ-ONLY
        role: the Z.ai transport admits no writes (operator decision
        2026-09-12), so a write-scope profile has no rung there."""
        self.assertEqual(claude_runtime._cross_provider_auth_fallback("opus", write_capable=False), "glm-5.3")
        self.assertIsNone(claude_runtime._cross_provider_auth_fallback("opus", write_capable=True))
        self.assertEqual(claude_runtime._cross_provider_auth_fallback("glm-5.3", write_capable=False), "opus")
        # sonnet is no rung of anything any more.
        self.assertIsNone(claude_runtime._cross_provider_auth_fallback("sonnet", write_capable=False))


if __name__ == "__main__":
    unittest.main()
