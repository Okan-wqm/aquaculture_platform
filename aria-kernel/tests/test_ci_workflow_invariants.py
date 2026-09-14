"""Plan ARIA-V2 §3.7 + I-25 — CI workflow hygiene invariants.

Six clauses locked here:

  1. No push block has a `paths:` filter (ARIA-V-007: push-on-snowball
     re-runs MUST re-evaluate the kernel regardless of changed paths;
     `paths-ignore` is allowed because it's the opt-out form for the
     INFRA-MED-001 doc-only fanout case).
  2. Every `uses: actions/*` SHA-pinned with a comment tag.
  3. `aria-kernel.yml` is THE kernel lane, on PR and on every main push.
     aria-kernel-full.yml was deleted (ORPHAN-MEDIUM-769: a strict subset
     of aria-kernel.yml, never a required context) and so was
     aria-kernel-fast.yml (ARIA-MEDIUM-135: it ran the identical full
     suite — aria-suite-run.sh takes no mode — with less provisioning
     under a 60-minute budget the 48-minute suite plus setup cannot meet
     on a hosted runner, so every kernel PR carried a duplicate lane that
     ended cancelled). Neither may return.
  4. Every `npm ci` invocation carries `--ignore-scripts`
     (INFRA-CRITICAL-001 supply-chain).
  5. Every `actions/checkout` carries `persist-credentials: false`
     (INFRA-HIGH-004) — single allowlisted exception:
     ``aria-daily-report.yml`` `commit-report` job needs
     `persist-credentials: true` to inject the bot token at clone time.
  6. Every workflow file declares a top-level `permissions:` block
     (INFRA-HIGH-003).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"

# Plan ARIA-V2 §3.7 — kernel-owned ARIA workflows are under the §3.7
# invariant; the broader repo has many workflows owned by other teams
# that this plan does not gate.
#
# Plan ARIA-V3 §B1 INFRA-HIGH-007 — aria-agent-executor.yml added to
# the governed set; it is kernel-owned (executes the CI-side
# ci_executor.py + worker_executor.py) and must satisfy all six §3.7
# clauses (paths filter, SHA-pinning, npm-ci --ignore-scripts,
# checkout persist-credentials false, top-level permissions, etc.).
_GOVERNED_WORKFLOWS: frozenset[str] = frozenset({
    "aria-kernel.yml",
    "aria-daily-report.yml",
    "aria-agent-executor.yml",
    "aria-agent-eval.yml",
    "aria-operational-proof.yml",
    "finding-state-sweep.yml",
    "rule-health-report.yml",
})

# Plan ARIA-V2 §3.7 + INFRA-HIGH-004 allowlist — the daily-report
# commit-report job MUST inject the bot token via checkout's
# token + persist-credentials:true. This is the documented exception.
_PERSIST_CREDENTIALS_TRUE_ALLOWLIST: frozenset[tuple[str, str]] = frozenset({
    ("aria-daily-report.yml", "commit-report"),
})

_MUTATING_ARIA_WORKFLOWS: frozenset[str] = frozenset({
    "aria-agent-eval.yml",
    "aria-agent-executor.yml",
    "aria-daily-report.yml",
    "aria-operational-proof.yml",
    "finding-state-sweep.yml",
    "rule-health-report.yml",
})

_SHA_PATTERN = re.compile(r"uses:\s*actions/[\w-]+@([0-9a-f]{40})\s*#\s*\S+")
_USES_TARGET = re.compile(r"uses:\s*(\S+)")


def _uses_target(line: str) -> str:
    """The reference a `uses:` line points at, or '' if the line is malformed."""
    match = _USES_TARGET.search(line)
    return match.group(1) if match else ""


def _load_yaml(path: Path) -> dict[str, Any]:
    import yaml  # type: ignore[import-untyped]

    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _walk_steps(workflow: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Yield (job_name, step_dict) pairs."""
    out: list[tuple[str, dict[str, Any]]] = []
    jobs = workflow.get("jobs") or {}
    if not isinstance(jobs, dict):
        return out
    for job_name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps") or []
        if not isinstance(steps, list):
            continue
        for step in steps:
            if isinstance(step, dict):
                out.append((job_name, step))
    return out


def _npm_ci_violations(name: str, text: str) -> list[str]:
    """Lines that run `npm ci` without --ignore-scripts (INFRA-CRITICAL-001).

    A line whose first non-space character is `#` is a comment in BOTH layers
    that can hold this text — the workflow YAML and the shell inside a `run:`
    block — so nothing on it executes and nothing on it can be a supply-chain
    risk. Skipping those is not a loosening of the gate; it is the difference
    between reading code and reading prose about code.
    """
    violations: list[str] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if "npm ci" not in stripped:
            continue
        if "--ignore-scripts" not in stripped:
            violations.append(f"{name}:{line_no}: npm ci without --ignore-scripts → {stripped}")
    return violations


class CIWorkflowInvariants(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflows: dict[str, dict[str, Any]] = {}
        for name in _GOVERNED_WORKFLOWS:
            path = _WORKFLOWS / name
            if path.exists():
                cls.workflows[name] = _load_yaml(path)

    def test_governed_workflows_present(self) -> None:
        missing = sorted(_GOVERNED_WORKFLOWS - set(self.workflows))
        self.assertEqual(missing, [], msg=f"Governed workflows missing: {missing}")

    def test_no_paths_filter_on_push_block(self) -> None:
        # Clause 1 — ARIA-V-007 fix.
        violations: list[str] = []
        for name, wf in self.workflows.items():
            # PyYAML parses YAML key ``on`` as Python ``True`` because
            # the YAML 1.1 boolean spec treats ``on`` / ``off`` as
            # booleans; fall back to either key for robustness.
            on = wf.get("on") if "on" in wf else wf.get(True)
            if not isinstance(on, dict):
                continue
            push = on.get("push")
            if not isinstance(push, dict):
                continue
            if "paths" in push:
                violations.append(f"{name}: push.paths present (use paths-ignore or remove)")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_every_actions_use_is_sha_pinned(self) -> None:
        # Clause 2.
        violations: list[str] = []
        for name in self.workflows:
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped.startswith("- uses:") and not stripped.startswith("uses:"):
                    continue
                if "actions/" not in stripped:
                    continue
                # A local composite action (`uses: ./.github/actions/x`) is
                # this repository's own code, reviewed in the same pull
                # request and moving with the same commit. There is no
                # third-party ref to pin — the clause this invariant
                # enforces is supply-chain provenance for actions fetched
                # from elsewhere, and demanding a SHA for a path that has
                # none would make extracting a shared step impossible.
                if _uses_target(stripped).startswith("./"):
                    continue
                if not _SHA_PATTERN.search(stripped):
                    violations.append(f"{name}: not SHA-pinned: {stripped}")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_the_kernel_lane_fires_on_pr_and_on_every_main_push(self) -> None:
        # Clause 3 — the one kernel lane. Its PR trigger carries the suite's
        # own inputs (ARIA-HIGH-098: an adapters-only PR must run the
        # registry contract; ARIA-MEDIUM-135: docs/adr/** came over from
        # the retired fast lane so a SPEC/ADR amendment fires it on the PR)
        # and its push trigger is unfiltered (ARIA-V-007).
        kernel = self.workflows.get("aria-kernel.yml")
        self.assertIsNotNone(kernel, "aria-kernel.yml missing")
        on = kernel.get("on") if "on" in kernel else kernel.get(True)
        self.assertIsInstance(on, dict, msg="aria-kernel.yml has no `on:` block")
        paths = (on.get("pull_request") or {}).get("paths") or []
        for required in ("aria-kernel/**", "scripts/ci/aria-suite-run.sh", "docs/aria/**", "docs/adr/**",
                         "tools/aria-adapters/**"):
            self.assertIn(required, paths, f"aria-kernel.yml: pull_request.paths lacks {required}")
        self.assertIn("push", on, msg="aria-kernel.yml must run on every main push")

    def test_deleted_kernel_fast_stays_deleted(self) -> None:
        # ARIA-MEDIUM-135 — aria-kernel-fast.yml ran the identical full suite
        # (aria-suite-run.sh has no mode) with no npm ci and no sandbox
        # backend under a 60-minute budget the suite cannot meet on a hosted
        # runner: PR #1553 run 34853938795 was cancelled by its own timeout
        # while aria-kernel finished the same 6,484 tests inside 75. Its
        # return would re-introduce a duplicate lane that only ever ends
        # cancelled.
        self.assertFalse(
            (_WORKFLOWS / "aria-kernel-fast.yml").exists(),
            "aria-kernel-fast.yml was deleted for cause (ARIA-MEDIUM-135); do not re-add it",
        )

    def test_deleted_kernel_full_stays_deleted(self) -> None:
        # ORPHAN-MEDIUM-769 — aria-kernel-full.yml ran a strict subset of
        # aria-kernel.yml on the same push and was never a required context.
        # Its return would silently re-introduce the triple fire.
        self.assertFalse(
            (_WORKFLOWS / "aria-kernel-full.yml").exists(),
            "aria-kernel-full.yml was deleted for cause (ORPHAN-MEDIUM-769); do not re-add it",
        )

    def test_every_npm_ci_has_ignore_scripts(self) -> None:
        # Clause 4 — INFRA-CRITICAL-001.
        violations: list[str] = []
        for name in self.workflows:
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            violations.extend(_npm_ci_violations(name, text))
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_a_comment_naming_the_install_is_not_a_violation(self) -> None:
        """ORPHAN-MEDIUM-803 — the scan reads lines, so it used to fire on
        prose. A comment explaining WHY an install is expensive names the
        command without running it, and a gate that cannot tell those apart
        teaches its reader to skip past the real violation."""
        commented = "        # every run: a full `npm ci` (measured 2m50s, ~1.6 GB peak RSS)\n"
        self.assertEqual(_npm_ci_violations("x.yml", commented), [])

    def test_a_real_install_without_the_flag_is_still_a_violation(self) -> None:
        self.assertEqual(len(_npm_ci_violations("x.yml", "          npm ci --no-audit\n")), 1)
        self.assertEqual(_npm_ci_violations("x.yml", "          npm ci --ignore-scripts\n"), [])

    def test_every_checkout_has_persist_credentials_false(self) -> None:
        # Clause 5 — INFRA-HIGH-004 (with allowlist).
        violations: list[str] = []
        for name, wf in self.workflows.items():
            for job_name, step in _walk_steps(wf):
                uses = str(step.get("uses") or "")
                if not uses.startswith("actions/checkout@"):
                    continue
                with_block = step.get("with") or {}
                pc = with_block.get("persist-credentials") if isinstance(with_block, dict) else None
                allowed = (name, job_name) in _PERSIST_CREDENTIALS_TRUE_ALLOWLIST
                if pc is False:
                    continue
                if allowed and pc is True:
                    continue
                violations.append(
                    f"{name}:{job_name}: checkout persist-credentials={pc!r} "
                    f"(expected False; allowlist {(name, job_name) in _PERSIST_CREDENTIALS_TRUE_ALLOWLIST})"
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_every_workflow_declares_top_level_permissions(self) -> None:
        # Clause 6 — INFRA-HIGH-003.
        violations: list[str] = []
        for name, wf in self.workflows.items():
            perms = wf.get("permissions")
            if not isinstance(perms, dict):
                violations.append(f"{name}: top-level permissions block missing or not a dict")
                continue
            if "contents" not in perms:
                violations.append(f"{name}: permissions.contents not declared")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_mutating_aria_workflows_run_enterprise_preflight(self) -> None:
        violations: list[str] = []
        for name in sorted(_MUTATING_ARIA_WORKFLOWS):
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            if "verify_workflow_preflight" not in text:
                violations.append(f"{name}: missing verify_workflow_preflight")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_automation_pr_workflows_use_app_token_source(self) -> None:
        violations: list[str] = []
        for name in sorted(_MUTATING_ARIA_WORKFLOWS):
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            if "open-report-pr.sh" not in text:
                continue
            # ORPHAN-HIGH-798 era: the sweep mints an installation token
            # from the configured App (dynamic, correct — installation
            # tokens expire, you cannot store them as static secrets).
            # Accept either the static secret reference or the dynamic
            # mint step; both are "not the default GITHUB_TOKEN".
            has_app_token = (
                "secrets.ARIA_GITHUB_APP_TOKEN" in text
                or "mint_installation_token" in text
            )
            if not has_app_token:
                violations.append(f"{name}: automation PR does not use App token (static secret or dynamic mint)")
            if "secrets.GITHUB_TOKEN" in text:
                violations.append(f"{name}: automation PR still references default GITHUB_TOKEN")
        self.assertEqual(violations, [], msg="\n".join(violations))


if __name__ == "__main__":
    unittest.main()
