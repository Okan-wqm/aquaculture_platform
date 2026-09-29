"""ARIA-HIGH-244 — a runner `.env` secret is never read through the `env` expression context.

The self-hosted runner loads ``<runner>/.env`` into the PROCESS environment of
every job step. GitHub's ``${{ env.X }}`` expression context holds only what a
workflow declares in its own ``env:`` blocks or writes to ``$GITHUB_ENV``, so
an expression naming a runner-``.env`` variable is always empty. The executor's
chain edge read ``${{ env.ARIA_GH_TOKEN || github.token }}``: the token it got
was the job token, which holds ``actions: read``, and every next-cycle dispatch
the rhythm allowed was refused 403 and only warned (ORPHAN-HIGH-740's edge never
fired). The dispatch now runs in a hosted ``chain-next-cycle`` job whose token
holds ``actions: write`` alone.

The names come from ``scripts/aria/provision_runner.sh``, the script that
checks the runner ``.env`` carries them; a name added there is governed here
without editing this file.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PROVISIONER = _REPO_ROOT / "scripts/aria/provision_runner.sh"
_EXECUTOR = _REPO_ROOT / ".github/workflows/aria-agent-executor.yml"
_ENV_EXPRESSION = re.compile(r"\$\{\{[^}]*?\benv\.([A-Za-z_][A-Za-z0-9_]*)")


def runner_env_names() -> tuple[str, ...]:
    """The keys the provisioner requires in the runner's `.env`."""
    text = _PROVISIONER.read_text(encoding="utf-8")
    section = text[text.index('env_file="${RUNNER_ROOT}/.env"'):]
    match = re.search(r"^for key in ([A-Z0-9_ ]+); do$", section, re.MULTILINE)
    if match is None:
        raise AssertionError("provision_runner.sh no longer lists the runner .env keys")
    return tuple(match.group(1).split())


def _executable(text: str) -> str:
    # Comments are prose about expressions, not expressions.
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _ci_files() -> list[Path]:
    workflows = sorted((_REPO_ROOT / ".github/workflows").glob("*.y*ml"))
    actions = sorted((_REPO_ROOT / ".github/actions").glob("*/action.y*ml"))
    return workflows + actions


class NoWorkflowReadsARunnerEnvSecretAsAnExpression(unittest.TestCase):
    def test_the_provisioner_names_the_runner_env_keys(self) -> None:
        self.assertIn("ARIA_GH_TOKEN", runner_env_names())

    def test_no_ci_file_names_a_runner_env_key_in_an_env_expression(self) -> None:
        forbidden = set(runner_env_names())
        offenders = [
            (path.relative_to(_REPO_ROOT).as_posix(), name)
            for path in _ci_files()
            for name in _ENV_EXPRESSION.findall(_executable(path.read_text(encoding="utf-8")))
            if name in forbidden
        ]
        self.assertEqual(offenders, [])


def _executor_jobs() -> dict[str, Any]:
    return yaml.safe_load(_EXECUTOR.read_text(encoding="utf-8"))["jobs"]


class TheChainEdgeDispatchesFromAHostedActionsWriteJob(unittest.TestCase):
    def test_the_executor_decides_and_hands_the_verdict_over(self) -> None:
        executor = _executor_jobs()["executor"]
        self.assertEqual(executor["outputs"]["chain_dispatch"], "${{ steps.chain.outputs.dispatch }}")
        decide = next(step for step in executor["steps"] if step.get("id") == "chain")
        self.assertEqual(decide["env"]["GH_TOKEN"], "${{ github.token }}")
        self.assertIn("tools/aria/chain_next_cycle.py", decide["run"])
        self.assertIn('echo "dispatch=true" >> "$GITHUB_OUTPUT"', decide["run"])

    def test_the_self_hosted_job_dispatches_nothing(self) -> None:
        for step in _executor_jobs()["executor"]["steps"]:
            self.assertNotIn("gh workflow run", step.get("run", ""), step.get("name"))

    def test_the_dispatch_job_holds_actions_write_and_nothing_else(self) -> None:
        job = _executor_jobs()["chain-next-cycle"]
        self.assertEqual(job["needs"], "executor")
        self.assertIn("needs.executor.outputs.chain_dispatch == 'true'", job["if"])
        self.assertEqual(job["runs-on"], "ubuntu-latest")
        self.assertEqual(job["permissions"], {"actions": "write"})
        runs = [step["run"] for step in job["steps"] if "run" in step]
        self.assertEqual(len(runs), 1)
        self.assertIn("gh workflow run aria-auto-cycle.yml --ref main", runs[0])
        self.assertIn("set -euo pipefail", runs[0])
        self.assertEqual(job["steps"][0]["env"]["GH_TOKEN"], "${{ github.token }}")


if __name__ == "__main__":
    unittest.main()
