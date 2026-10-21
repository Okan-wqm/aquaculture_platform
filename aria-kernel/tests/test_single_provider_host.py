"""WP-P — the three single-provider hosts a night is run on, probed by the fleet.

Operator decision (2026-10-18, HANDOVER §7): with ANY single provider alive —
Claude, Z.ai or Codex — every cycle completes. The night tests that prove it
need a host that presents exactly one provider to the production availability
oracle (`model_fleet.available_providers`), and the oracle's answer is itself
the ratchet: a fixture that stops isolating (a stray credential boundary, a
CLI leaking through PATH) fails here before it can quietly widen a night.

One behaviour per test:

* each builder's environment presents its provider and ONLY its provider to
  the oracle, in fleet order;
* each builder isolates the OTHER two vendors' boundaries (the binary, the
  credential file, the credential variable), so a night cannot silently
  fail over to a provider the scenario killed;
* the codex host presents the managed-session boundary (a ``CODEX_HOME``
  auth.json), never an ``OPENAI_API_KEY`` — the operator's 2026-08-29
  subscription-auth decision, pinned at the host seam;
* the recording CLI the hosts install logs every invocation and answers the
  public status probes, so a night that reaches the vendor leaves evidence.
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

from tests._helpers.single_provider_host import (
    RECORDING_CLAUDE, RECORDING_CODEX, claude_host, codex_host, zai_host,
)


class TheClaudeHostPresentsExactlyClaude(unittest.TestCase):
    def test_the_oracle_sees_anthropic_alone(self) -> None:
        host = claude_host()
        self.assertEqual([p.key for p in host.available()], ["anthropic"])

    def test_the_zai_and_codex_boundaries_are_absent(self) -> None:
        host = claude_host()
        env = host.environ()
        self.assertNotIn("ARIA_ZAI_API_KEY", env)
        self.assertNotIn("ARIA_ZAI_API_KEY_FILE", env)
        self.assertNotIn("CODEX_HOME", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertIsNone(host.which("codex"))
        self.assertIsNone(host.which("zai"))


class TheZaiHostPresentsExactlyZai(unittest.TestCase):
    def test_the_oracle_sees_zai_alone(self) -> None:
        host = zai_host()
        self.assertEqual([p.key for p in host.available()], ["zai"])

    def test_no_cli_reaches_the_night(self) -> None:
        host = zai_host()
        self.assertIsNone(host.which("claude"))
        self.assertIsNone(host.which("codex"))
        self.assertNotIn("OPENAI_API_KEY", host.environ())
        self.assertNotIn("CODEX_HOME", host.environ())


class TheCodexHostPresentsExactlyCodex(unittest.TestCase):
    def test_the_oracle_sees_openai_alone(self) -> None:
        host = codex_host()
        self.assertEqual([p.key for p in host.available()], ["openai"])

    def test_the_managed_session_is_the_credential_not_an_api_key(self) -> None:
        host = codex_host()
        env = host.environ()
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertTrue(Path(env["CODEX_HOME"], "auth.json").is_file())
        self.assertIsNone(host.which("claude"))
        self.assertNotIn("ARIA_ZAI_API_KEY_FILE", env)
        self.assertNotIn("ARIA_ZAI_API_KEY", env)


class TheRecordingClisAnswerThePublicProbes(unittest.TestCase):
    """A host's CLI is the declared vendor substitute; it must answer what the kernel asks."""

    def test_the_claude_cli_answers_version(self) -> None:
        import subprocess

        with claude_host() as host:
            completed = subprocess.run(
                [str(host.binary_dir / "claude"), "--version"],
                capture_output=True, text=True, timeout=20, env=host.environ(),
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Claude Code", completed.stdout)

    def test_the_codex_cli_answers_login_status_and_refuses_unknown_argv(self) -> None:
        import subprocess

        with codex_host() as host:
            binary = str(host.binary_dir / "codex")
            status = subprocess.run([binary, "login", "status"],
                                    capture_output=True, text=True, timeout=20, env=host.environ())
            unknown = subprocess.run([binary, "frobnicate"],
                                     capture_output=True, text=True, timeout=20, env=host.environ())
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("Logged in using ChatGPT", status.stderr + status.stdout)
        self.assertNotEqual(unknown.returncode, 0)
        self.assertEqual(unknown.returncode, 97)

    def test_every_cli_invocation_is_recorded(self) -> None:
        import subprocess

        with codex_host() as host:
            subprocess.run([str(host.binary_dir / "codex"), "login", "status"],
                           capture_output=True, text=True, timeout=20, env=host.environ())
            calls = host.calls()
        self.assertEqual([row["argv"] for row in calls], [["login", "status"]])


class TheHostDropsTheCallingEnvironmentsVariables(unittest.TestCase):
    """FIXTURE GIT discipline (2026-10-18) applied to the whole boundary, not only GIT_*."""

    def test_no_other_vendors_boundary_and_no_git_variable_reaches_the_host(self) -> None:
        from tests._helpers.single_provider_host import VENDOR_BOUNDARY_NAMES

        for build, provider in ((claude_host, "anthropic"), (zai_host, "zai"), (codex_host, "openai")):
            with build() as host:
                env = host.environ()
            others = {name for other, names in VENDOR_BOUNDARY_NAMES.items() if other != provider
                      for name in names}
            for name in sorted(others):
                self.assertNotIn(name, env, f"{provider} host carries {name}")
            self.assertTrue(all(not name.startswith("GIT_") for name in env), provider)

    def test_the_builder_refuses_a_host_that_stopped_isolating(self) -> None:
        # The deliberate break (the JUDGE-DIGEST pattern): a second vendor's
        # credential boundary leaking into a host must fail the BUILDER, not
        # pass silently and widen a night to a provider the scenario killed.
        from tests._helpers.single_provider_host import HostIsolationError

        with self.assertRaises(HostIsolationError):
            claude_host(extra_env={"ARIA_ZAI_API_KEY_FILE": "/tmp/elsewhere.key"})
        with self.assertRaises(HostIsolationError):
            codex_host(extra_env={"ARIA_ZAI_API_KEY_FILE": "/tmp/elsewhere.key"})
        # The Z.ai host's complement needs the codex BINARY too (a key alone
        # admits nothing without a CLI to name) — pinned by the oracle itself:
        zai = zai_host(extra_env={"OPENAI_API_KEY": "fixture-key"})
        try:
            self.assertEqual([p.key for p in zai.available()], ["zai"])
        finally:
            zai.close()


if __name__ == "__main__":
    unittest.main()
