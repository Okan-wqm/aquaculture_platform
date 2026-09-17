"""Every lane that runs the kernel checks the code repository out WHOLE.

The kernel reads the checkout's history, not only its tree: the twin's churn
and co-change layers replay ``git log -n400``, the incremental map refresh
asks whether the prior map's anchor commit exists, the executor's anchor gate
asks the same of a previous run's commit, and intent context reads per-file
logs. ``actions/checkout`` defaults to ``fetch-depth: 1``, and on the
self-hosted persistent workspace a depth-1 fetch re-shallows a full clone.

What that cost, confirmed live on 2026-09-12: the run that wrote the live map
saw one commit, so churn and co-change never reached their recurrence
thresholds and an empty history layer was published as a healthy map; every
refresh was a full rebuild (``refresh.reason=unknown_anchor``); and the
executor's anchor gate had been softened with a shallow-clone probe to keep
cross-run requests alive on a clone that could not hold them. The kernel now
REFUSES a shallow checkout by name — the twin at both publishers
(``twin.SHALLOW_CHECKOUT_REFUSAL``), the anchor gate where an absent anchor
would otherwise be recorded as a terminal guess
(``agent_invocations.ANCHOR_HISTORY_UNAVAILABLE``), one shared probe
(``git_probe``); this test is the other half — the lanes never present one.

The governed set is derived, not listed, across EVERY workflow file: a job
runs the kernel when it provisions it (a ``uses:`` of the local
``.github/actions/setup-aria-kernel`` action, under whatever checkout path
it lives — the dataflow watchdog checks out into ``watchdog-checkout/``) or
invokes it in a ``run:`` step. The rule is "a kernel workspace is a whole
clone", and four of the lanes that run the kernel are not named ``aria-*``
(``dataflow-integrity-watchdog``, ``finding-closure-reconcile``,
``finding-state-sweep``, ``rule-health-report``); a name filter would have
left them ungoverned. ``aria-external-watchdog.yml`` falls outside by
construction — its own contract
(``tests/invariants/aria-external-watchdog-contract.spec.ts``) forbids it
from reaching the kernel, and it reads one manifest at depth 1 on purpose.
The ``aria/state`` store is not this checkout either: the restore action
materialises it through the kernel's own fetch (no depth) into a sibling
worktree, and its history length is governed by ``aria-state-maintenance``.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# The provisioning action's identity is its PATH SUFFIX under a local (`./`)
# checkout, not one spelling of the checkout root: `./watchdog-checkout/.github/
# actions/setup-aria-kernel` is the same action. Same rule as
# tests/invariants/aria-kernel-workflow-setup.spec.ts, which governs the
# provisioning order of the same jobs.
_KERNEL_SETUP_ACTION_SUFFIX = ".github/actions/setup-aria-kernel"
_KERNEL_INVOCATION_MARKER = "aria_kernel"
_CHECKOUT_PREFIX = "actions/checkout@"
_FULL_HISTORY = (0, "0")

# The lanes the 2026-09-12 finding named, plus the kernel-running lanes that
# are not named `aria-*` — the ones a name filter would have missed. The
# detector below DERIVES the governed set from the YAML; this is the floor
# that keeps it from passing vacuously if the derivation ever stops matching
# anything.
_LANES_THAT_READ_HISTORY_LIVE: frozenset[str] = frozenset({
    "aria-auto-cycle.yml",
    "aria-agent-executor.yml",
    "aria-state-maintenance.yml",
    "dataflow-integrity-watchdog.yml",
    "finding-closure-reconcile.yml",
    "finding-state-sweep.yml",
    "rule-health-report.yml",
})


def _is_kernel_setup_action(uses: str) -> bool:
    return uses.startswith("./") and uses.endswith(_KERNEL_SETUP_ACTION_SUFFIX)


def _workflow_files(workflows_dir: Path) -> list[Path]:
    """Every workflow file. Not `aria-*`: the rule governs whoever runs the kernel."""
    return sorted(workflows_dir.glob("*.yml"))


def _steps(job: Any) -> list[dict[str, Any]]:
    steps = job.get("steps") if isinstance(job, dict) else None
    return [step for step in (steps or []) if isinstance(step, dict)]


def job_runs_kernel(job: Any) -> bool:
    """A job runs the kernel when it provisions it or invokes it directly."""
    for step in _steps(job):
        if _is_kernel_setup_action(str(step.get("uses") or "").strip()):
            return True
        if _KERNEL_INVOCATION_MARKER in str(step.get("run") or ""):
            return True
    return False


def shallow_checkout_violations(name: str, workflow: dict[str, Any]) -> list[str]:
    """Checkout steps in kernel-running jobs that do not declare full history."""
    violations: list[str] = []
    jobs = workflow.get("jobs") or {}
    if not isinstance(jobs, dict):
        return violations
    for job_name, job in jobs.items():
        if not job_runs_kernel(job):
            continue
        for step in _steps(job):
            if not str(step.get("uses") or "").startswith(_CHECKOUT_PREFIX):
                continue
            with_block = step.get("with") if isinstance(step.get("with"), dict) else {}
            depth = with_block.get("fetch-depth")
            if depth not in _FULL_HISTORY:
                violations.append(
                    f"{name}:{job_name}: actions/checkout fetch-depth={depth!r} "
                    "(a kernel lane must declare fetch-depth: 0 — the kernel "
                    "refuses a shallow checkout by name)"
                )
    return violations


def governed_jobs(workflows_dir: Path) -> dict[str, list[str]]:
    """{workflow file: [job names that run the kernel]} across every workflow."""
    governed: dict[str, list[str]] = {}
    for path in _workflow_files(workflows_dir):
        workflow = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        jobs = workflow.get("jobs") or {}
        names = [job_name for job_name, job in jobs.items() if job_runs_kernel(job)]
        if names:
            governed[path.name] = names
    return governed


def all_violations(workflows_dir: Path) -> list[str]:
    violations: list[str] = []
    for path in _workflow_files(workflows_dir):
        workflow = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        violations.extend(shallow_checkout_violations(path.name, workflow))
    return violations


class KernelLanesCheckOutFullHistory(unittest.TestCase):
    def test_every_kernel_lane_checks_out_full_history(self) -> None:
        violations = all_violations(_WORKFLOWS)
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_the_governed_set_is_not_vacuous(self) -> None:
        governed = governed_jobs(_WORKFLOWS)
        missing = sorted(_LANES_THAT_READ_HISTORY_LIVE - set(governed))
        self.assertEqual(
            missing, [],
            msg=f"lanes that read history live are not detected as kernel lanes: {missing}",
        )
        # A kernel lane with no checkout at all would have nothing for the
        # kernel to read; every governed job checks the repository out.
        for name, job_names in governed.items():
            workflow = yaml.safe_load((_WORKFLOWS / name).read_text(encoding="utf-8"))
            for job_name in job_names:
                checkouts = [
                    step for step in _steps(workflow["jobs"][job_name])
                    if str(step.get("uses") or "").startswith(_CHECKOUT_PREFIX)
                ]
                self.assertTrue(checkouts, f"{name}:{job_name} runs the kernel without a checkout")

    def test_the_watchdog_is_outside_the_governed_set_by_construction(self) -> None:
        # Not an allowlist: the watchdog is ungoverned because it does not
        # run the kernel, and its own contract spec keeps it that way. If
        # someone teaches it the kernel, THIS test starts governing it and
        # that spec goes red — two gates, one fact.
        self.assertNotIn("aria-external-watchdog.yml", governed_jobs(_WORKFLOWS))

    def test_detector_flags_the_default_depth_and_accepts_zero(self) -> None:
        # The detector proven on both shapes, independent of the live YAML.
        def lane(with_block: dict[str, Any] | None) -> dict[str, Any]:
            checkout: dict[str, Any] = {"uses": "actions/checkout@abc"}
            if with_block is not None:
                checkout["with"] = with_block
            return {"jobs": {"cycle": {"steps": [checkout, {"uses": "./" + _KERNEL_SETUP_ACTION_SUFFIX}]}}}

        self.assertEqual(len(shallow_checkout_violations("x.yml", lane(None))), 1)
        self.assertEqual(len(shallow_checkout_violations("x.yml", lane({"persist-credentials": False}))), 1)
        self.assertEqual(len(shallow_checkout_violations("x.yml", lane({"fetch-depth": 1}))), 1)
        self.assertEqual(shallow_checkout_violations("x.yml", lane({"fetch-depth": 0})), [])
        self.assertEqual(shallow_checkout_violations("x.yml", lane({"fetch-depth": "0"})), [])

    def test_detector_governs_a_run_step_invocation_without_the_setup_action(self) -> None:
        workflow = {"jobs": {"probe": {"steps": [
            {"uses": "actions/checkout@abc", "with": {"persist-credentials": False}},
            {"run": "PYTHONPATH=aria-kernel python3 -m aria_kernel state checkout --repo-root ."},
        ]}}}
        self.assertEqual(len(shallow_checkout_violations("x.yml", workflow)), 1)

    def test_detector_governs_the_setup_action_under_a_subdirectory_checkout(self) -> None:
        # The dataflow watchdog checks out into `watchdog-checkout/` (Z1,
        # ORPHAN-712) and references the local action through that path.
        # Same action, same rule; an exact-string match on the root spelling
        # left that lane ungoverned.
        workflow = {"jobs": {"probe": {"steps": [
            {"uses": "actions/checkout@abc", "with": {"path": "watchdog-checkout"}},
            {"uses": "./watchdog-checkout/.github/actions/setup-aria-kernel"},
        ]}}}
        self.assertTrue(job_runs_kernel(workflow["jobs"]["probe"]))
        self.assertEqual(len(shallow_checkout_violations("x.yml", workflow)), 1)
        # A remote action that merely ends in the same words is not ours.
        foreign = {"jobs": {"probe": {"steps": [
            {"uses": "actions/checkout@abc", "with": {"fetch-depth": 1}},
            {"uses": "someone/.github/actions/setup-aria-kernel@v1"},
        ]}}}
        self.assertFalse(job_runs_kernel(foreign["jobs"]["probe"]))

    def test_detector_ignores_a_job_that_never_runs_the_kernel(self) -> None:
        workflow = {"jobs": {"watch": {"steps": [
            {"uses": "actions/checkout@abc", "with": {"fetch-depth": 1}},
            {"uses": "actions/github-script@abc", "with": {"script": "core.setFailed('x')"}},
        ]}}}
        self.assertEqual(shallow_checkout_violations("x.yml", workflow), [])
        self.assertFalse(job_runs_kernel(workflow["jobs"]["watch"]))


if __name__ == "__main__":
    unittest.main()
