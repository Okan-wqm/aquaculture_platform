"""ARIA-HIGH-208 — the identity that opens ARIA's pull requests.

Both self-hosted lanes deliver: the executor drain pushes the implementer's
branch and opens its PR (``implementation_delivery``), and the nightly cycle
can open a self-revert PR (``self_revert``). Each delivery mints its own
credential where it is consumed (``delivery_credentials``), through
``gh_token_factory.mint_installation_token``. Without the GitHub App in the
environment the mint fell back to Mode B and copied the ambient ``GH_TOKEN``
— the ``ARIA_GH_TOKEN`` PAT or, on a runner without one, the job token. A PR
opened with the job token leaves its workflows in ``action_required``, so
aria-merge-authority, the readiness claim and the merge runner never start.

The lanes now hand the delivery the App (id, installation id and a private
key file in ``$RUNNER_TEMP``) and set ``ARIA_REQUIRE_MODE_A``, so the mint is
Mode A or refuses by name; the ambient ``GH_TOKEN`` can no longer become a
PR's author.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parents[2]

# (workflow file, job id, the step that runs the delivering kernel command,
#  the kernel command the key must exist before)
_DELIVERING_STEPS: tuple[tuple[str, str, str, str], ...] = (
    ("aria-auto-cycle.yml", "cycle", "Run the nightly cycle under the resolved profile",
     "python3 -m aria_kernel autonomy run"),
    ("aria-agent-executor.yml", "executor", "Run CI executor", "tools/aria-poc/ci_executor.py"),
)


def _step(workflow: str, job: str, name: str) -> dict[str, Any]:
    import yaml  # type: ignore[import-untyped]

    parsed = yaml.safe_load((_REPO / ".github" / "workflows" / workflow).read_text(encoding="utf-8"))
    steps = [step for step in parsed["jobs"][job]["steps"] if step.get("name") == name]
    assert len(steps) == 1, f"{workflow}: expected one step named {name!r}"
    return steps[0]


class DeliveryIsModeAOnly(unittest.TestCase):
    def test_the_app_reaches_the_delivering_step(self) -> None:
        for workflow, job, name, _command in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                env = _step(workflow, job, name)["env"]
                self.assertEqual(env["ARIA_REQUIRE_MODE_A"], "true")
                for var in ("ARIA_GH_APP_ID", "ARIA_GH_APP_INSTALLATION_ID", "ARIA_GH_APP_PRIVATE_KEY"):
                    self.assertEqual(env[var], f"${{{{ secrets.{var} }}}}")

    def test_the_key_is_a_private_file_outside_the_workspace_removed_on_exit(self) -> None:
        for workflow, job, name, command in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                run = _step(workflow, job, name)["run"]
                self.assertIn('KEY_FILE="$RUNNER_TEMP/', run)
                self.assertIn("umask 077", run)
                self.assertIn('export ARIA_GH_APP_PRIVATE_KEY_PATH="$KEY_FILE"', run)
                # The PEM content leaves the environment before any child
                # process starts; only the path is inherited.
                self.assertIn("unset ARIA_GH_APP_PRIVATE_KEY", run)
                self.assertIn("trap", run)
                self.assertIn('rm -f "$KEY_FILE"', run)
                self.assertLess(run.index('export ARIA_GH_APP_PRIVATE_KEY_PATH="$KEY_FILE"'), run.index(command))

    def test_no_fallback_identity_is_announced_for_delivery(self) -> None:
        # The job token must never be described as, or become, the PR
        # author: ARIA_REQUIRE_MODE_A makes the mint refuse Mode B.
        for workflow, job, name, _command in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                run = _step(workflow, job, name)["run"]
                self.assertNotIn("job token fallback", run)


if __name__ == "__main__":
    unittest.main()
