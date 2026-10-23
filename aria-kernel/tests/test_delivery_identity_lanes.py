"""ARIA-HIGH-208 + ARIA-MEDIUM-583 — the identity that opens ARIA's pull
requests.

Both self-hosted lanes deliver: the executor drain pushes the implementer's
branch and opens its PR (``implementation_delivery``), and the nightly cycle
can open a self-revert PR (``self_revert``). Each delivery mints its own
credential where it is consumed (``delivery_credentials``), through
``gh_token_factory.mint_installation_token``. Without the GitHub App in the
environment the mint fell back to Mode B and copied the ambient ``GH_TOKEN``
— the ``ARIA_GH_TOKEN`` PAT or, on a runner without one, the job token. A PR
opened with the job token leaves its workflows in ``action_required``, so
aria-merge-authority, the readiness claim and the merge runner never start.

ARIA-HIGH-208 handed the App to the delivering step itself (id, installation
id and a PEM file in ``$RUNNER_TEMP``). ARIA-MEDIUM-583 closes that hand-off:
the App key can mint repository-write installation tokens, and a process that
runs discovery, planning and agent orchestration for a whole night must not
be able to read it — narrowing the job token (ARIA-MEDIUM-555) could never
take repository write away from the cycle while the cycle held the key. The
key now reaches the lane through a BROKER the lane starts as a sibling step
(``aria_kernel.token_broker``): the broker reads the PEM once, keeps it in
memory behind a private unix socket, mints only the closed allowlist of named
permission sets, and the delivering step holds the socket path alone.
``ARIA_REQUIRE_TOKEN_BROKER`` makes any in-process key mint refuse by name,
so the ambient ``GH_TOKEN`` can no longer become a PR's author AND the key
can no longer become the cycle's to spend.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parents[2]

# (workflow file, job id, the step that runs the delivering kernel command)
_DELIVERING_STEPS: tuple[tuple[str, str, str], ...] = (
    ("aria-auto-cycle.yml", "cycle", "Run the nightly cycle under the resolved profile"),
    ("aria-agent-executor.yml", "executor", "Run CI executor"),
)


def _step(workflow: str, job: str, name: str) -> dict[str, Any]:
    import yaml  # type: ignore[import-untyped]

    parsed = yaml.safe_load((_REPO / ".github" / "workflows" / workflow).read_text(encoding="utf-8"))
    steps = [step for step in parsed["jobs"][job]["steps"] if step.get("name") == name]
    assert len(steps) == 1, f"{workflow}: expected one step named {name!r}"
    return steps[0]


def _doc(workflow: str) -> dict[str, Any]:
    import yaml  # type: ignore[import-untyped]

    return yaml.safe_load((_REPO / ".github" / "workflows" / workflow).read_text(encoding="utf-8"))


def _executable(text: str) -> str:
    # Comments are prose about the key, not reads of it — the discipline of
    # test_no_lane_holds_a_user_credential, whose rule this file extends to
    # the App key.
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


class DeliveryIsModeAOnly(unittest.TestCase):
    def test_the_delivering_step_never_holds_the_app_key(self) -> None:
        # ARIA-MEDIUM-583 — the App (id, installation, PEM) reaches the LANE
        # through the broker step, never the delivering process: no env var
        # for it, no PEM file path exported into the kernel's environment.
        for workflow, job, name in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                step = _step(workflow, job, name)
                env = step["env"]
                self.assertEqual(env["ARIA_REQUIRE_MODE_A"], "true")
                for var in ("ARIA_GH_APP_ID", "ARIA_GH_APP_INSTALLATION_ID", "ARIA_GH_APP_PRIVATE_KEY"):
                    self.assertNotIn(var, env, f"{workflow}: {var} must live in the broker step, not the kernel-run step")
                run = _executable(step["run"])
                self.assertNotIn("ARIA_GH_APP_PRIVATE_KEY", run, f"{workflow}: the key never enters the kernel-run step")
                self.assertNotIn("ARIA_GH_APP_PRIVATE_KEY_PATH", run, f"{workflow}: no PEM file is exported to the kernel process")

    def test_the_delivering_step_requires_the_broker(self) -> None:
        # Even if a key were handed back to the delivering step, the mint
        # refuses the in-process path by name under ARIA_REQUIRE_TOKEN_BROKER.
        for workflow, job, name in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                env = _step(workflow, job, name)["env"]
                self.assertEqual(env["ARIA_REQUIRE_TOKEN_BROKER"], "true")

    def test_no_fallback_identity_is_announced_for_delivery(self) -> None:
        # The job token must never be described as, or become, the PR
        # author: ARIA_REQUIRE_MODE_A makes the mint refuse Mode B.
        for workflow, job, name in _DELIVERING_STEPS:
            with self.subTest(workflow=workflow):
                run = _step(workflow, job, name)["run"]
                self.assertNotIn("job token fallback", run)


class TheBrokerHoldsTheKey(unittest.TestCase):
    """ARIA-MEDIUM-583 — the ONE step per lane that may touch the App key is
    the broker start, and what it exports is the socket, never the key."""

    def _holders(self, workflow: str) -> list[dict[str, Any]]:
        steps: list[dict[str, Any]] = []
        for job in _doc(workflow)["jobs"].values():
            for step in job.get("steps", []):
                text = _executable(step.get("run", "") or "")
                if "ARIA_GH_APP_PRIVATE_KEY" in text or "ARIA_GH_APP_PRIVATE_KEY" in step.get("env", {}):
                    steps.append(step)
        return steps

    def test_exactly_one_broker_step_holds_the_key_and_pipes_it_to_the_broker(self) -> None:
        for workflow in ("aria-auto-cycle.yml", "aria-agent-executor.yml"):
            with self.subTest(workflow=workflow):
                holders = self._holders(workflow)
                self.assertEqual(len(holders), 1, f"{workflow}: exactly one step may touch the App key")
                broker = holders[0]
                # The secret enters this step's env only, on its way to the
                # broker's stdin — the launcher reads it once and exits.
                self.assertIn("ARIA_GH_APP_PRIVATE_KEY", broker.get("env", {}), f"{workflow}: the broker step's env carries the secret")
                run = broker["run"]  # executable text: the holders scan already stripped comments
                self.assertIn("aria_kernel.token_broker start", run, f"{workflow}: the one reader of the key is the broker launcher")
                self.assertIn('"$ARIA_GH_APP_PRIVATE_KEY"', run, f"{workflow}: the key is piped to the broker's stdin")
                self.assertIn("ARIA_GH_TOKEN_BROKER_SOCKET", run, f"{workflow}: the step exports the socket path")

    def test_the_broker_dies_with_the_job_cap(self) -> None:
        # The broker outlives its starting step by design (the delivering
        # step is a sibling, not a descendant); what bounds it is the job's
        # own cap, anchored at job launch — a broker the runner fails to reap
        # cannot hold the key past the job, and no mint's TTL can either.
        for workflow, job_id in (("aria-auto-cycle.yml", "cycle"), ("aria-agent-executor.yml", "executor")):
            with self.subTest(workflow=workflow):
                job = _doc(workflow)["jobs"][job_id]
                cap = int(job["timeout-minutes"])
                broker = self._holders(workflow)[0]
                match = re.search(r"ARIA_JOB_LAUNCH_EPOCH \+ (\d+) \* 60", broker["run"])
                self.assertIsNotNone(match, f"{workflow}: the broker deadline is anchored at job launch")
                self.assertEqual(int(match.group(1)), cap, f"{workflow}: the broker deadline is the job's timeout-minutes ({cap})")


if __name__ == "__main__":
    unittest.main()
