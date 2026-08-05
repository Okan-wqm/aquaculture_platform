"""Plan ARIA-V2 §3.7 + I-25 — CI workflow hygiene invariants.

Six clauses locked here:

  1. No push block has a `paths:` filter (ARIA-V-007: push-on-snowball
     re-runs MUST re-evaluate the kernel regardless of changed paths;
     `paths-ignore` is allowed because it's the opt-out form for the
     INFRA-MED-001 doc-only fanout case).
  2. Every `uses: actions/*` SHA-pinned with a comment tag.
  3. `aria-kernel-fast.yml` covers both pull_request AND push.
  4. Every `npm ci` invocation carries `--ignore-scripts`
     (INFRA-CRITICAL-001 supply-chain).
  5. Every `actions/checkout` carries `persist-credentials: false`
     (INFRA-HIGH-004).
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
    "aria-kernel-full.yml",
    "aria-kernel-fast.yml",
    "aria-daily-report.yml",
    "aria-agent-executor.yml",
    "aria-agent-eval.yml",
    "aria-operational-proof.yml",
    "automation-publication-admission.yml",
    "finding-registry-authority.yml",
    "finding-state-sweep.yml",
    "rule-health-report.yml",
})

_VERIFIED_AUTOMATION_APP_WORKFLOWS: frozenset[str] = frozenset({
    "aria-daily-report.yml",
    "rule-health-report.yml",
})
_REGISTRY_AUTOMATION_WORKFLOWS: frozenset[str] = frozenset({
    "finding-registry-authority.yml",
    "finding-state-sweep.yml",
})
_AUTOMATION_PUBLICATION_WORKFLOWS = (
    _VERIFIED_AUTOMATION_APP_WORKFLOWS | _REGISTRY_AUTOMATION_WORKFLOWS
)

_MUTATING_ARIA_WORKFLOWS: frozenset[str] = frozenset({
    "aria-agent-eval.yml",
    "aria-agent-executor.yml",
    "aria-daily-report.yml",
    "aria-operational-proof.yml",
    "finding-registry-authority.yml",
    "finding-state-sweep.yml",
    "rule-health-report.yml",
})

_SHA_PATTERN = re.compile(r"uses:\s*actions/[\w-]+@([0-9a-f]{40})\s*#\s*\S+")
_AUTOMATION_APP_ACTION = _REPO_ROOT / ".github" / "actions" / "mint-automation-app-token" / "action.yml"
_AUTOMATION_APP_ACTION_USE = "./.github/actions/mint-automation-app-token"
_AUTOMATION_PUBLISHER = (
    _REPO_ROOT / "tools" / "scripts" / "automation" / "publish-automation-pr.ts"
)
_AUTOMATION_PUBLICATION_POLICY = (
    _REPO_ROOT / "tools" / "gates" / "lib" / "automation-publication-policy.ts"
)
_LEGACY_AUTOMATION_PUBLISHER = (
    _REPO_ROOT / "tools" / "scripts" / "automation" / "open-report-pr.sh"
)
_CREATE_APP_TOKEN_ACTION = (
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
)
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
                target = _uses_target(stripped)
                # A local composite action (`uses: ./.github/actions/x`) is
                # this repository's own code, reviewed in the same pull
                # request and moving with the same commit. There is no
                # third-party ref to pin — the clause this invariant
                # enforces is supply-chain provenance for actions fetched
                # from elsewhere, and demanding a SHA for a path that has
                # none would make extracting a shared step impossible.
                if target.startswith("./"):
                    continue
                if not target.startswith("actions/"):
                    continue
                if not _SHA_PATTERN.search(stripped):
                    violations.append(f"{name}: not SHA-pinned: {stripped}")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_fast_workflow_covers_pr_and_push(self) -> None:
        # Clause 3.
        fast = self.workflows.get("aria-kernel-fast.yml")
        self.assertIsNotNone(fast, "aria-kernel-fast.yml missing")
        on = fast.get("on") if "on" in fast else fast.get(True)
        self.assertIsInstance(on, dict, msg="aria-kernel-fast.yml has no `on:` block")
        self.assertIn("pull_request", on, msg="aria-kernel-fast.yml missing pull_request")
        self.assertIn("push", on, msg="aria-kernel-fast.yml missing push trigger")

    def test_every_npm_ci_has_ignore_scripts(self) -> None:
        # Clause 4 — INFRA-CRITICAL-001.
        violations: list[str] = []
        for name in self.workflows:
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            for line_no, line in enumerate(text.splitlines(), start=1):
                if "npm ci" not in line:
                    continue
                if "--ignore-scripts" not in line:
                    violations.append(f"{name}:{line_no}: npm ci without --ignore-scripts → {line.strip()}")
        self.assertEqual(violations, [], msg="\n".join(violations))

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
                if pc is False:
                    continue
                violations.append(
                    f"{name}:{job_name}: checkout persist-credentials={pc!r} (expected False)"
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

    def test_automation_app_token_action_is_least_privilege_and_fail_closed(self) -> None:
        action = _load_yaml(_AUTOMATION_APP_ACTION)
        inputs = action.get("inputs")
        self.assertIsInstance(inputs, dict)
        self.assertEqual(
            set(inputs),
            {
                "client-id",
                "private-key",
                "expected-app-slug",
                "expected-installation-id",
            },
        )
        for contract in inputs.values():
            self.assertIsInstance(contract, dict)
            self.assertIs(contract.get("required"), True)

        runs = action.get("runs")
        self.assertIsInstance(runs, dict)
        steps = runs.get("steps")
        self.assertIsInstance(steps, list)
        mint_steps = [
            step
            for step in steps
            if isinstance(step, dict) and step.get("uses") == _CREATE_APP_TOKEN_ACTION
        ]
        self.assertEqual(len(mint_steps), 1)
        mint_with = mint_steps[0].get("with")
        self.assertIsInstance(mint_with, dict)
        self.assertEqual(
            {
                key: value
                for key, value in mint_with.items()
                if str(key).startswith("permission-")
            },
            {
                "permission-actions": "read",
                "permission-contents": "write",
                "permission-pull-requests": "write",
            },
        )
        self.assertEqual(mint_with.get("owner"), "Okan-wqm")
        self.assertEqual(mint_with.get("repositories"), "aquaculture_platform")
        self.assertNotIn("skip-token-revoke", mint_with)

        action_text = _AUTOMATION_APP_ACTION.read_text(encoding="utf-8")
        for required_proof in (
            "1132698735",
            "Okan-wqm/aquaculture_platform",
            "ACTUAL_APP_SLUG",
            "ACTUAL_INSTALLATION_ID",
            "viewer { login }",
            "/installation/repositories?per_page=2",
            "scope.total_count === 1",
            "repositories.length === 1",
        ):
            self.assertIn(required_proof, action_text)

    def test_report_pr_workflows_use_verified_app_token_action(self) -> None:
        violations: list[str] = []
        expected_inputs = {
            "client-id": "${{ vars.ARIA_GITHUB_APP_CLIENT_ID }}",
            "private-key": "${{ secrets.ARIA_GITHUB_APP_PRIVATE_KEY }}",
            "expected-app-slug": "${{ vars.ARIA_GITHUB_APP_SLUG }}",
            "expected-installation-id": "${{ vars.ARIA_GITHUB_APP_INSTALLATION_ID }}",
        }
        expected_publication_env = {
            "EXPECTED_BASE_SHA": "${{ github.sha }}",
            "GH_APP_INSTALLATION_ID": "${{ steps.automation-app.outputs.installation-id }}",
            "GH_APP_SLUG": "${{ steps.automation-app.outputs.app-slug }}",
            "GH_TOKEN": "${{ steps.automation-app.outputs.token }}",
        }
        for name in sorted(_VERIFIED_AUTOMATION_APP_WORKFLOWS):
            workflow = self.workflows[name]
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            artifact_stem = (
                "aria-daily-report"
                if name == "aria-daily-report.yml"
                else "rule-health-report"
            )
            if "secrets.ARIA_GITHUB_APP_TOKEN" in text:
                violations.append(f"{name}: static ARIA_GITHUB_APP_TOKEN is forbidden")
            if "secrets.GITHUB_TOKEN" in text:
                violations.append(f"{name}: automation PR still references default GITHUB_TOKEN")
            if "AUTOMATION_COMMAND_ID=" not in text:
                violations.append(f"{name}: automation PR lacks a command id")
            if 'AUTOMATION_OPERATION="report"' not in text:
                violations.append(f"{name}: automation PR operation is not report")
            if "AUTOMATION_INPUT_SHA256=" not in text or "sha256sum --" not in text:
                violations.append(f"{name}: automation PR input is not bound to the report digest")
            if "AUTOMATION_RESULT_PATH=" not in text:
                violations.append(f"{name}: automation publication evidence path is missing")
            for evidence_variable in (
                "AUTOMATION_EVIDENCE_ARTIFACT_ID=",
                f'AUTOMATION_EVIDENCE_ARTIFACT="{artifact_stem}-input-',
                "AUTOMATION_EVIDENCE_SHA256=",
            ):
                if evidence_variable not in text:
                    violations.append(f"{name}: immutable input evidence is not commit-bound")
            if "GITHUB_RUN_ID" in next(
                (
                    line
                    for line in text.splitlines()
                    if "export AUTOMATION_COMMAND_ID=" in line
                ),
                "",
            ):
                violations.append(f"{name}: report command id is not retry-stable")

            if workflow.get("permissions") != {"contents": "read"}:
                violations.append(f"{name}: default GITHUB_TOKEN permissions are not exactly contents:read")

            jobs = workflow.get("jobs")
            if not isinstance(jobs, dict):
                violations.append(f"{name}: jobs block missing")
                continue
            expected_job_permissions = (
                {
                    "generate-report": {"actions": "read", "contents": "read"},
                    "commit-report": {"contents": "read"},
                }
                if name == "aria-daily-report.yml"
                else {"generate": {"actions": "read", "contents": "read"}}
            )
            for job_name, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                if job.get("permissions") != expected_job_permissions.get(job_name):
                    violations.append(
                        f"{name}:{job_name}: job permissions differ from the exact "
                        "run-clock/publication contract"
                    )

            steps = _walk_steps(workflow)
            checkout_steps = [
                step
                for _, step in steps
                if str(step.get("uses") or "").startswith("actions/checkout@")
            ]
            if not checkout_steps:
                violations.append(f"{name}: checkout step missing")
            for checkout_step in checkout_steps:
                with_block = checkout_step.get("with")
                if not isinstance(with_block, dict) or with_block.get("ref") != "${{ github.sha }}":
                    violations.append(f"{name}: checkout is not bound to github.sha")

            mint_steps = [
                (job_name, step)
                for job_name, step in steps
                if step.get("uses") == _AUTOMATION_APP_ACTION_USE
            ]
            if len(mint_steps) != 1:
                violations.append(f"{name}: expected exactly one verified app-token action")
            else:
                mint_job_name, mint_step = mint_steps[0]
                if mint_step.get("with") != expected_inputs:
                    violations.append(
                        f"{name}: app-token action inputs do not match the SSoT variables"
                    )
                mint_job = jobs.get(mint_job_name)
                if not isinstance(mint_job, dict) or mint_job.get("environment") != (
                    "automation-publication"
                ):
                    violations.append(
                        f"{name}: App private key is not fenced by automation-publication"
                    )

            publication_steps = [
                step
                for _, step in steps
                if "npm run automation:publish" in str(step.get("run") or "")
            ]
            if len(publication_steps) != 1:
                violations.append(f"{name}: expected exactly one automation PR publication step")
            else:
                publication_env = publication_steps[0].get("env")
                if not isinstance(publication_env, dict):
                    violations.append(f"{name}: automation PR publication env missing")
                else:
                    for key, value in expected_publication_env.items():
                        if publication_env.get(key) != value:
                            violations.append(f"{name}: publication env {key} is not verified")

            artifact_steps = [
                step
                for _, step in steps
                if str(step.get("uses") or "").startswith("actions/upload-artifact@")
            ]
            for artifact_step in artifact_steps:
                with_block = artifact_step.get("with")
                retention = with_block.get("retention-days") if isinstance(with_block, dict) else None
                if not isinstance(retention, int) or not 1 <= retention <= 90:
                    violations.append(f"{name}: public-repository artifact retention exceeds 90 days")
            upload_names = {
                str(step.get("with", {}).get("name") or "")
                for step in artifact_steps
                if isinstance(step.get("with"), dict)
            }
            expected_upload_names = {
                f"{artifact_stem}-input-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}",
                "automation-publication-result-${{ steps.publication.outputs.commit }}",
                "automation-publication-failure-${{ github.run_id }}-${{ github.run_attempt }}",
            }
            if not expected_upload_names.issubset(upload_names):
                violations.append(
                    f"{name}: input/result/failure artifacts are not independently durable"
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_publication_queue_cannot_silently_replace_an_older_request(self) -> None:
        for name in (
            "aria-daily-report.yml",
            "rule-health-report.yml",
            "finding-registry-authority.yml",
            "finding-state-sweep.yml",
        ):
            self.assertNotIn(
                "concurrency",
                self.workflows[name],
                msg=(
                    f"{name} must not use a repository-global concurrency group; "
                    "GitHub replaces older pending runs in the same group"
                ),
            )

    def test_publication_workflows_use_the_exact_immutable_actions_run_clock(self) -> None:
        for name in _AUTOMATION_PUBLICATION_WORKFLOWS:
            steps = [step for _, step in _walk_steps(self.workflows[name])]
            clock_steps = [
                step
                for step in steps
                if step.get("name") == "Resolve immutable Actions run clock"
            ]
            self.assertEqual(len(clock_steps), 1, name)
            self.assertEqual(
                clock_steps[0].get("env"),
                {"GITHUB_TOKEN": "${{ github.token }}"},
                name,
            )
            self.assertEqual(
                str(clock_steps[0].get("run") or ""),
                "npm run automation:resolve-run-clock",
                name,
            )

        daily_text = (_WORKFLOWS / "aria-daily-report.yml").read_text(encoding="utf-8")
        self.assertIn("RUN_DATE: ${{ steps.run-clock.outputs.date }}", daily_text)
        self.assertNotIn("BASE_COMMIT_AT", daily_text)
        self.assertNotIn("git show -s --format=%cI", daily_text)

        workflow = self.workflows["rule-health-report.yml"]
        steps = [step for _, step in _walk_steps(workflow)]
        window_steps = [
            step
            for step in steps
            if step.get("name") == "Compute report window from immutable run clock"
        ]
        self.assertEqual(len(window_steps), 1)
        window_env = window_steps[0].get("env")
        self.assertIsInstance(window_env, dict)
        self.assertEqual(
            window_env.get("RUN_CLOCK_EPOCH"),
            "${{ steps.run-clock.outputs.epoch_seconds }}",
        )
        self.assertEqual(
            window_env.get("RUN_CREATED_AT"),
            "${{ steps.run-clock.outputs.created_at }}",
        )
        window_run = str(window_steps[0].get("run") or "")
        self.assertIn('test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"', window_run)
        self.assertNotIn("git show -s --format=%ct", window_run)
        self.assertIn("generated_at=${generatedAt}", window_run)
        self.assertNotIn("date -u", window_run)
        self.assertNotIn("$(date", window_run)

        generate_steps = [
            step for step in steps if step.get("name") == "Generate report"
        ]
        self.assertEqual(len(generate_steps), 1)
        generate = generate_steps[0]
        generate_env = generate.get("env")
        self.assertIsInstance(generate_env, dict)
        self.assertEqual(generate_env.get("PROTECTED_BASE_SHA"), "${{ github.sha }}")
        self.assertEqual(
            generate_env.get("GENERATED_AT"),
            "${{ steps.window.outputs.generated_at }}",
        )
        generate_run = str(generate.get("run") or "")
        self.assertNotIn("$(date", generate_run)
        self.assertIn(
            "REPORT=\"$REPORT_DIR/${REPORT_STAMP}-rule-health-${MONTH_LABEL}.md\"",
            generate_run,
        )
        self.assertIn(
            "printf '**Generated**: %s\\n' \"${GENERATED_AT}\"",
            generate_run,
        )

        publication_steps = [
            step
            for step in steps
            if "npm run automation:publish" in str(step.get("run") or "")
        ]
        self.assertEqual(len(publication_steps), 1)
        publication_run = str(publication_steps[0].get("run") or "")
        self.assertIn(
            'AUTOMATION_COMMAND_ID="rule-health-report:${MONTH_LABEL}:${EXPECTED_BASE_SHA}"',
            publication_run,
        )
        self.assertNotIn("${{ steps.window.outputs.month_label }}", publication_run)

    def test_rule_health_registry_csv_is_runner_temp_create_only_and_cleaned(self) -> None:
        workflow = self.workflows["rule-health-report.yml"]
        steps = [step for _, step in _walk_steps(workflow)]
        generate_steps = [
            step for step in steps if step.get("name") == "Generate report"
        ]
        self.assertEqual(len(generate_steps), 1)
        generate_run = str(generate_steps[0].get("run") or "")

        create_only_binding = (
            'mktemp "${RUNNER_TEMP:?RUNNER_TEMP is required}/'
            'rule-health-registry.XXXXXX"'
        )
        self.assertEqual(generate_run.count(create_only_binding), 1)
        self.assertEqual(generate_run.count("readonly REGISTRY_CSV"), 1)
        self.assertEqual(generate_run.count("cleanup_registry_csv()"), 1)
        self.assertEqual(
            generate_run.count('rm -f -- "${REGISTRY_CSV}"'),
            1,
        )
        self.assertEqual(generate_run.count("trap cleanup_registry_csv EXIT"), 1)
        self.assertEqual(
            generate_run.count(
                'tools/gates/finding-registry.ts export csv > "${REGISTRY_CSV}"'
            ),
            1,
        )
        self.assertNotIn("/tmp/registry.csv", generate_run)

        awk_consumers = [
            line
            for line in generate_run.splitlines()
            if "awk -F','" in line
        ]
        self.assertEqual(len(awk_consumers), 6)
        self.assertTrue(
            all(line.endswith('"${REGISTRY_CSV}")') for line in awk_consumers)
        )

        workflow_text = (_WORKFLOWS / "rule-health-report.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            'external_root_allowlist=[str(Path(os.environ["RUNNER_TEMP"]).resolve())]',
            workflow_text,
        )

    def test_registry_command_retries_use_one_external_time_and_stable_pr_body(self) -> None:
        workflow = self.workflows["finding-registry-authority.yml"]
        events = workflow.get("on", workflow.get(True))
        self.assertIsInstance(events, dict)
        dispatch = events.get("workflow_dispatch") if isinstance(events, dict) else None
        self.assertIsInstance(dispatch, dict)
        inputs = dispatch.get("inputs") if isinstance(dispatch, dict) else None
        self.assertIsInstance(inputs, dict)
        effective_at = inputs.get("effective_at") if isinstance(inputs, dict) else None
        self.assertEqual(
            effective_at,
            {
                "description": (
                    "Retry-stable canonical UTC command time; reuse the exact value on every retry"
                ),
                "required": True,
                "type": "string",
            },
        )

        steps = [step for _, step in _walk_steps(workflow)]
        request_steps = [
            step for step in steps if step.get("name") == "Validate the typed mutation request"
        ]
        self.assertEqual(len(request_steps), 1)
        request = request_steps[0]
        request_env = request.get("env")
        self.assertIsInstance(request_env, dict)
        self.assertEqual(request_env.get("EFFECTIVE_AT"), "${{ inputs.effective_at }}")
        self.assertEqual(
            request_env.get("RUN_CREATED_AT"),
            "${{ steps.run-clock.outputs.created_at }}",
        )
        request_run = str(request.get("run") or "")
        self.assertIn(
            "retryWindowMilliseconds = 90 * 24 * 60 * 60 * 1000",
            request_run,
        )
        self.assertIn(
            "effectiveAtMilliseconds > runCreatedAtMilliseconds",
            request_run,
        )

        authority_steps = [
            step
            for step in steps
            if step.get("name") == "Bind request to exact protected-main snapshot"
        ]
        self.assertEqual(len(authority_steps), 1)
        authority_env = authority_steps[0].get("env")
        self.assertIsInstance(authority_env, dict)
        self.assertEqual(
            authority_env.get("REQUEST_EFFECTIVE_AT"),
            "${{ steps.request.outputs.effective_at }}",
        )

        publication_steps = [
            step for step in steps if step.get("name") == "Publish idempotent mutation result"
        ]
        self.assertEqual(len(publication_steps), 1)
        publication_run = str(publication_steps[0].get("run") or "")
        self.assertIn('echo "- Command ID: \\`${COMMAND_ID}\\`"', publication_run)
        self.assertIn('echo "- Effective at: \\`${EFFECTIVE_AT}\\`"', publication_run)
        self.assertIn('echo "- Input SHA-256: \\`${INPUT_SHA256}\\`"', publication_run)
        self.assertNotIn(
            'cat "${RUNNER_TEMP}/finding-registry-operation.txt"',
            publication_run,
        )

    def test_registry_workflows_use_oidc_and_verified_app_publication(self) -> None:
        violations: list[str] = []
        expected_inputs = {
            "client-id": "${{ vars.ARIA_GITHUB_APP_CLIENT_ID }}",
            "private-key": "${{ secrets.ARIA_GITHUB_APP_PRIVATE_KEY }}",
            "expected-app-slug": "${{ vars.ARIA_GITHUB_APP_SLUG }}",
            "expected-installation-id": "${{ vars.ARIA_GITHUB_APP_INSTALLATION_ID }}",
        }
        for name in sorted(_REGISTRY_AUTOMATION_WORKFLOWS):
            workflow = self.workflows[name]
            artifact_stem = (
                "finding-registry-authority"
                if name == "finding-registry-authority.yml"
                else "finding-state-sweep"
            )
            if workflow.get("permissions") != {
                "actions": "read",
                "contents": "read",
                "id-token": "write",
            }:
                violations.append(
                    f"{name}: permissions are not exact run-read + OIDC mint authority"
                )
            text = (_WORKFLOWS / name).read_text(encoding="utf-8")
            if "secrets.ARIA_GITHUB_APP_TOKEN" in text or "secrets.GITHUB_TOKEN" in text:
                violations.append(f"{name}: static/default publication token is forbidden")
            if 'export PR_BRANCH="automation/finding-registry-active"' not in text:
                violations.append(f"{name}: repository-global branch fence is missing")
            if "AUTOMATION_RESULT_PATH=" not in text:
                violations.append(f"{name}: publication result evidence is missing")
            if "npm run automation:publish" not in text:
                violations.append(f"{name}: typed shared signed publisher is missing")
            if "open-report-pr.sh" in text:
                violations.append(f"{name}: legacy shell publisher is still reachable")
            for required_evidence_binding in (
                'export AUTOMATION_EVIDENCE_ARTIFACT_ID="${{ steps.mutation-evidence.outputs.artifact-id }}"',
                f'export AUTOMATION_EVIDENCE_ARTIFACT="{artifact_stem}-input-${{GITHUB_RUN_ID}}-${{GITHUB_RUN_ATTEMPT}}"',
                'export AUTOMATION_EVIDENCE_SHA256="${{ steps.mutation-evidence.outputs.artifact-digest }}"',
            ):
                if required_evidence_binding not in text:
                    violations.append(
                        f"{name}: immutable mutation evidence is not bound to the commit"
                    )

            mint_steps = [
                (job_name, step)
                for job_name, step in _walk_steps(workflow)
                if step.get("uses") == _AUTOMATION_APP_ACTION_USE
            ]
            if len(mint_steps) != 1:
                violations.append(f"{name}: expected exactly one verified app-token action")
            else:
                mint_job_name, mint_step = mint_steps[0]
                if mint_step.get("with") != expected_inputs:
                    violations.append(f"{name}: app-token inputs differ from the repository SSoT")
                jobs = workflow.get("jobs")
                mint_job = jobs.get(mint_job_name) if isinstance(jobs, dict) else None
                if not isinstance(mint_job, dict) or mint_job.get("environment") != (
                    "automation-publication"
                ):
                    violations.append(
                        f"{name}: App private key is not fenced by automation-publication"
                    )

            upload_steps = [
                step
                for _, step in _walk_steps(workflow)
                if str(step.get("uses") or "").startswith("actions/upload-artifact@")
            ]
            upload_names = {
                str(step.get("with", {}).get("name") or "")
                for step in upload_steps
                if isinstance(step.get("with"), dict)
            }
            expected_upload_names = {
                f"{artifact_stem}-input-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}",
                "automation-publication-result-${{ steps.publication.outputs.commit }}",
                "automation-publication-failure-${{ github.run_id }}-${{ github.run_attempt }}",
            }
            if not expected_upload_names.issubset(upload_names):
                violations.append(
                    f"{name}: input/result/failure artifacts are not independently durable"
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_automation_publication_admission_executes_only_protected_base_code(self) -> None:
        path = _WORKFLOWS / "automation-publication-admission.yml"
        workflow = _load_yaml(path)
        text = path.read_text(encoding="utf-8")
        self.assertIn("pull_request_target:", text)
        workflow_events = workflow.get("on", workflow.get(True))
        self.assertIsInstance(workflow_events, dict)
        self.assertEqual(
            workflow_events.get("pull_request_target", {}).get("types"),
            ["opened", "synchronize", "reopened", "ready_for_review", "edited"],
        )
        self.assertEqual(
            workflow.get("permissions"),
            {"actions": "read", "contents": "read", "pull-requests": "read"},
        )
        jobs = workflow.get("jobs")
        self.assertIsInstance(jobs, dict)
        job = jobs.get("automation-publication-admission") if isinstance(jobs, dict) else None
        self.assertIsInstance(job, dict)
        steps = job.get("steps") if isinstance(job, dict) else None
        self.assertIsInstance(steps, list)
        checkout_steps = [
            step
            for step in steps or []
            if isinstance(step, dict)
            and str(step.get("uses") or "").startswith("actions/checkout@")
        ]
        self.assertEqual(len(checkout_steps), 1)
        checkout = checkout_steps[0].get("with")
        self.assertEqual(
            checkout,
            {
                "ref": "${{ github.event.pull_request.base.sha }}",
                "fetch-depth": 1,
                "persist-credentials": False,
            },
        )
        self.assertNotIn("github.event.pull_request.head.repo.clone_url", text)
        self.assertNotRegex(
            text,
            r"(?s)actions/checkout@[^\n]+\n(?:[ \t].*\n){0,8}[ \t]+ref:\s*"
            r"\$\{\{\s*github\.event\.pull_request\.head",
        )
        self.assertIn("run: npm run automation:verify-publication", text)
        ci_full = (_WORKFLOWS / "ci-full.yml").read_text(encoding="utf-8")
        self.assertIn(
            "npm run gates:automation-publication-publisher-typecheck",
            ci_full,
        )

    def test_automation_publisher_is_atomic_signed_and_operation_bound(self) -> None:
        self.assertFalse(
            _LEGACY_AUTOMATION_PUBLISHER.exists(),
            "the untyped compatibility publisher must be retired, not retained",
        )
        text = "\n".join(
            (
                _AUTOMATION_PUBLISHER.read_text(encoding="utf-8"),
                _AUTOMATION_PUBLICATION_POLICY.read_text(encoding="utf-8"),
            )
        )
        for required_contract in (
            "createCommitOnBranch",
            "expectedHeadOid",
            "wasSignedByGitHub",
            "Automation-Command-ID",
            "Automation-Operation",
            "Automation-Input-SHA256",
            "Automation-Base-SHA",
            "Automation-Retry-Identity",
            "Automation-Changed-Path",
            "Automation-Changed-Path-SHA256",
            "Automation-Workflow-Ref",
            "Automation-Workflow-SHA",
            "Automation-Workflow-Run-ID",
            "Automation-Workflow-Run-Attempt",
            "Automation-Evidence-Artifact-ID",
            "Automation-Evidence-Artifact",
            "Automation-Evidence-SHA256",
            "automation/finding-registry-active",
            "docs/reviews/_registry/findings.jsonl",
            "aqua/automation-publication-result/v3",
            "O_NOFOLLOW",
            "lstatSync",
        ):
            self.assertIn(required_contract, text)
        for forbidden_contract in (
            "git push",
            "--force",
            "ARIA_GITHUB_APP_TOKEN",
            "GITHUB_TOKEN:-",
        ):
            self.assertNotIn(forbidden_contract, text)


if __name__ == "__main__":
    unittest.main()
