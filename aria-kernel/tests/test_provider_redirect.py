"""ORPHAN-HIGH-764 — a spawn may reach another vendor; the process may not.

Z.ai's documented Claude Code setup is to EXPORT ANTHROPIC_BASE_URL and
ANTHROPIC_AUTH_TOKEN. Following that literally here would redirect every
dispatch this process makes — judges, planners, implementer — to one vendor,
silently, because ARIA dispatches many models from one process and the model
is chosen per agent. So the redirect binds to a single spawn's env.

THE PART THAT IS EASY TO GET WRONG, and the reason these pins exist:
`assert_claude_policy_environment` inspects `os.environ`, so a run_env-only
injection never trips it. That makes it tempting to call the problem solved —
which would be routing around the gate that exists to notice exactly this. A
redirect is a NEW mode, so it carries its own authorisation and its own NAMED
refusals. The old gate asks "is this billing bypassing managed auth?"; this one
asks "which vendor does this spawn reach?". Two questions, two gates.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

from claude_runtime import (  # noqa: E402
    PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE,
    PROVIDER_REDIRECT_POLICY_ENV_VAR,
    PROVIDER_REDIRECTS,
    ProviderRedirectUnavailable,
    provider_redirect_disclosure,
    provider_redirect_env,
)

GLM = "glm-5.3"
TOKEN_VAR = PROVIDER_REDIRECTS[GLM]["token_env_var"]


class ProviderRedirectTests(unittest.TestCase):
    def test_an_anthropic_tier_is_not_redirected(self) -> None:
        """The default path must be byte-identical to before.

        If this ever returns anything, every Claude dispatch has quietly
        acquired a vendor override.
        """
        for model in ("opus", "fable", "sonnet", "haiku", None):
            with self.subTest(model=model):
                self.assertEqual(provider_redirect_env(model), {})

    def test_a_redirect_without_an_operator_policy_is_refused_by_name(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ProviderRedirectUnavailable) as caught:
                provider_redirect_env(GLM)
        self.assertIn("provider_redirect_unauthorised", str(caught.exception))
        self.assertIn(PROVIDER_REDIRECT_POLICY_ENV_VAR, str(caught.exception))

    def test_a_missing_credential_is_a_DIFFERENT_named_refusal(self) -> None:
        """Two operator problems, two names.

        "Nobody authorised this vendor" and "the key is not on the runner" send
        the reader to different places; one message for both would send them to
        the wrong one half the time.
        """
        with mock.patch.dict(
            os.environ, {PROVIDER_REDIRECT_POLICY_ENV_VAR: "aria:policy:zai-2026-08-20"}, clear=True,
        ):
            with self.assertRaises(ProviderRedirectUnavailable) as caught:
                provider_redirect_env(GLM)
        self.assertIn("provider_redirect_token_missing", str(caught.exception))
        self.assertIn(TOKEN_VAR, str(caught.exception))

    def test_an_authorised_redirect_yields_the_vendor_endpoint(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                PROVIDER_REDIRECT_POLICY_ENV_VAR: "aria:policy:zai-2026-08-20",
                TOKEN_VAR: "secret-key",
            },
            clear=True,
        ):
            env = provider_redirect_env(GLM)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "https://api.z.ai/api/anthropic")
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "secret-key")

    def test_the_process_environment_is_never_mutated(self) -> None:
        """The whole design in one assertion.

        A redirect that leaked into os.environ would make the NEXT dispatch —
        an opus judge, say — reach Z.ai without anyone choosing that.
        """
        with mock.patch.dict(
            os.environ,
            {
                PROVIDER_REDIRECT_POLICY_ENV_VAR: "aria:policy:zai-2026-08-20",
                TOKEN_VAR: "secret-key",
            },
            clear=True,
        ):
            provider_redirect_env(GLM)
            self.assertNotIn("ANTHROPIC_BASE_URL", os.environ)
            self.assertNotIn("ANTHROPIC_AUTH_TOKEN", os.environ)

    def test_the_injection_is_wired_at_the_per_spawn_seam(self) -> None:
        """Declared and reachable — the defect class this repository keeps finding.

        A redirect helper nobody calls would pass every test above and change
        nothing at runtime.
        """
        body = (_POC / "claude_runtime.py").read_text(encoding="utf-8")
        self.assertIn("run_env.update(provider_redirect_env(model))", body)
        self.assertNotIn(
            'os.environ["ANTHROPIC_BASE_URL"]', body,
        )


class BillingRouteTests(unittest.TestCase):
    """Which endpoint a spawn reaches decides which balance it spends.

    Z.ai bills the Coding-Plan route against the subscription and the general
    route against the prepaid wallet; the Anthropic-compatible route is a third
    protocol whose billing the vendor docs do not settle. So the endpoint is an
    operator-tunable fact, not a constant, and it is DISCLOSED — otherwise a
    paid plan can sit unused while a balance drains and no ledger can say so.
    """

    _AUTHORISED = {PROVIDER_REDIRECT_POLICY_ENV_VAR: "aria:policy:zai-2026-08-20", TOKEN_VAR: "k"}
    _OVERRIDE_VAR = PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE.format(provider="ZAI")

    def test_the_default_is_the_documented_anthropic_route(self) -> None:
        with mock.patch.dict(os.environ, dict(self._AUTHORISED), clear=True):
            env = provider_redirect_env(GLM)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "https://api.z.ai/api/anthropic")

    def test_the_operator_can_move_the_endpoint_without_a_code_change(self) -> None:
        """The billing answer is empirical, so switching must not need a deploy."""
        coding_route = "https://api.z.ai/api/coding/paas/v4"
        with mock.patch.dict(
            os.environ, {**self._AUTHORISED, self._OVERRIDE_VAR: coding_route}, clear=True,
        ):
            env = provider_redirect_env(GLM)
            disclosed = provider_redirect_disclosure(GLM)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], coding_route)
        self.assertEqual(disclosed["base_url"], coding_route)
        self.assertEqual(disclosed["base_url_source"], "operator_override")

    def test_the_disclosure_names_the_endpoint_and_never_the_token(self) -> None:
        with mock.patch.dict(os.environ, dict(self._AUTHORISED), clear=True):
            disclosed = provider_redirect_disclosure(GLM)
        self.assertEqual(disclosed["provider"], "zai")
        self.assertEqual(disclosed["base_url_source"], "default")
        self.assertNotIn("k", disclosed.values())
        self.assertFalse(
            [v for v in disclosed.values() if "AUTH" in v or v == "k"],
            "a disclosure that carries the credential is a leak, not a record",
        )

    def test_an_unredirected_model_discloses_nothing(self) -> None:
        self.assertEqual(provider_redirect_disclosure("opus"), {})


if __name__ == "__main__":
    unittest.main()
