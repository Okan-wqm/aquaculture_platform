"""ARIA-LOW-267 / INFRA-MEDIUM-197 / ADR-0023 — ARIA (T2) cannot write what it is verified against.

Three pins:

* every operator trust anchor and arbiter record the kernel reads sits under
  ``implementation_safety.READONLY_PATHS`` (the implementer's PR-open gate
  and sandbox), and the merge authority refuses an ARIA-authored change to
  any READONLY path at pre-merge, so a branch changed after it opened cannot
  carry one to main;
* the request terms (audience, lifetime) come from the anchor commit, not
  the working tree a runner-uid process can edit;
* the runner habitat in the repository pins T2: the runner service runs as
  gharunner with no supplementary group (docker), no privilege gain (sudo)
  and no view of /root, where the operator key lives.
"""
from __future__ import annotations

import configparser
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as safety
from aria_kernel import operator_request_signature as ors
from aria_kernel.operator_approval import OPERATORS_POLICY_RELPATH
from tests._helpers.operator_requests import OperatorRequestFixture

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HABITAT = _REPO_ROOT / "scripts" / "aria" / "runner-habitat" / "systemd"
_TRUST_ANCHORS = (
    ors.ALLOWED_SIGNERS_PATH, ors.NAMESPACE_REGISTRY_PATH, ors.ENROLMENTS_PATH, OPERATORS_POLICY_RELPATH,
    "docs/aria/policy/autonomy-unlock.json",
    "docs/recommendations/architectural-arbiter/2026-10-02-adr-0023-signature-namespace-registry.md",
    # ARIA-HIGH-260 — report_ingestion mints "external" findings from it.
    "docs/reviews/_registry/findings.jsonl",
    "packs/software-repo/critical-journeys.json", "tools/aria-labels/x", "tools/runtime-truth/x",
    "libs/journey-pins/x",
)


def _bound_evidence() -> safety._PreMergeEvidence:
    """Every native identity the pre-merge predicates require, present."""
    fields = ("repo_identity", "snapshot_hash", "pr_row_hash", "planned_row_hash", "committed_row_hash",
              "request_id", "claim_id", "request_row_hash", "claim_row_hash", "result_row_hash",
              "implementation_event_hash")
    return safety._PreMergeEvidence((), **{field: f"{field}-x" for field in fields})


class ReadOnlyTrustAnchorTests(unittest.TestCase):
    def test_every_trust_anchor_is_read_only_to_the_implementer(self) -> None:
        for path in _TRUST_ANCHORS:
            with self.subTest(path=path):
                self.assertIsNotNone(safety._readonly_prefix(path))
        with tempfile.TemporaryDirectory() as tmp:
            for path in (OPERATORS_POLICY_RELPATH, "docs/reviews/_registry/findings.jsonl"):
                report = safety.run_hard_fail_checks(
                    safety.HardFailContext(workspace_root=Path(tmp), affected_paths=(path,)),
                    gate=safety.GATE_PRE_PR_OPEN)
                refusal = {r.name: r.reason for r in report.failures}["forbidden_scope_normalized"]
                self.assertEqual(refusal, f"readonly_path_write:{path}")

    def test_the_merge_authority_refuses_an_aria_change_to_a_read_only_path(self) -> None:
        def judge(*paths: str) -> safety.HardFailResult:
            context = safety.HardFailContext(affected_paths=paths, pre_merge_evidence=_bound_evidence())
            return safety._check_readonly_paths_untouched_at_merge(context)

        for path in (ors.ALLOWED_SIGNERS_PATH, ors.ENROLMENTS_PATH, OPERATORS_POLICY_RELPATH,
                     "docs/reviews/_registry/findings.jsonl", "aria-kernel/aria_kernel/mcp_server.py"):
            with self.subTest(path=path):
                result = judge("apps/farm-service/src/a.ts", path)
                self.assertEqual((result.passed, result.reason), (False, f"readonly_path_change:{path}"))
        self.assertEqual(judge("apps/../.github/manifests/x").reason, "readonly_path_change:.github/manifests/x")
        self.assertEqual(judge("../outside").reason, "path_escape:../outside")
        self.assertTrue(judge("apps/farm-service/src/a.ts", "docs/reviews/claude/note.md").passed)
        unbound = safety._check_readonly_paths_untouched_at_merge(
            safety.HardFailContext(affected_paths=("apps/x.ts",)))
        self.assertEqual(unbound.reason, "native_implementation_binding_unavailable")
        entry = {check.name: check for check in safety.HARD_FAIL_CHECKS}["readonly_paths_untouched_at_merge"]
        self.assertEqual(entry.gate, safety.GATE_PRE_MERGE)


class TermsFromTheAnchorTests(unittest.TestCase):
    """ARIA-LOW-267 — the request audience is the committed policy's, not the working tree's."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-terms-")
        self.addCleanup(self.tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")

    def test_a_working_tree_policy_edit_moves_nothing(self) -> None:
        policy = self.fx.repo / OPERATORS_POLICY_RELPATH
        committed = json.loads(policy.read_text(encoding="utf-8"))
        policy.write_text(json.dumps(dict(committed, repository="intruder/repo")), encoding="utf-8")
        anchor = ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)[0]
        self.assertEqual(anchor.audience, committed["repository"])
        self.assertEqual(anchor.namespaces[ors.SIGNATURE_NAMESPACE].expiry_hours, 168)

    def test_a_committed_policy_that_is_not_one_leaves_no_anchor(self) -> None:
        self.fx.commit_files({OPERATORS_POLICY_RELPATH: "{}"}, message="chore(test): break the policy")
        self.assertEqual(ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools), (None, ors.OPERATORS_POLICY_UNAVAILABLE))


class RunnerHabitatT2BoundaryTests(unittest.TestCase):
    """The repository's runner habitat declares T2 and grants it nothing that reaches the operator key."""

    def _service_settings(self, path: Path) -> dict[str, str]:
        parser = configparser.ConfigParser(strict=False, interpolation=None, allow_no_value=True)
        parser.optionxform = str  # systemd keys are case-sensitive
        parser.read_string(path.read_text(encoding="utf-8"))
        return dict(parser["Service"]) if parser.has_section("Service") else {}

    def test_the_runner_service_runs_as_gharunner_without_groups_sudo_or_root(self) -> None:
        drop_ins = sorted(_HABITAT.glob("actions-runner.*.conf"))
        self.assertTrue(drop_ins, "the runner service drop-ins live in the habitat")
        service: dict[str, str] = {}
        for drop_in in drop_ins:
            service.update(self._service_settings(drop_in))
        self.assertEqual(service.get("User"), "gharunner")
        self.assertEqual(service.get("Group"), "gharunner")
        self.assertEqual(service.get("SupplementaryGroups"), "", "no extra group: docker is root by another name")
        self.assertEqual(service.get("NoNewPrivileges"), "yes", "sudo and setuid stay inert")
        self.assertIn("/root", (service.get("InaccessiblePaths") or "").split())

    def test_no_habitat_file_grants_t2_a_path_to_the_operator(self) -> None:
        granting = ("SupplementaryGroups", "BindPaths", "BindReadOnlyPaths", "ReadWritePaths", "ReadOnlyPaths")
        for path in sorted(p for p in _HABITAT.rglob("*") if p.is_file()):
            settings = self._service_settings(path)
            with self.subTest(file=path.relative_to(_REPO_ROOT).as_posix()):
                self.assertNotIn(settings.get("User"), {"root", "0"})
                for key in granting:
                    value = settings.get(key) or ""
                    self.assertNotIn("docker", value)
                    self.assertNotIn("sudo", value)
                    self.assertNotIn("/root", value)
                self.assertNotEqual(settings.get("NoNewPrivileges"), "no")

    def test_the_provisioner_installs_and_checks_the_identity_drop_in(self) -> None:
        script = (_REPO_ROOT / "scripts" / "aria" / "provision_runner.sh").read_text(encoding="utf-8")
        self.assertIn("${HABITAT_SYSTEMD}/actions-runner.identity.conf|/etc/systemd/system/${SERVICE_NAME}.d/identity.conf",
                      script)
        self.assertIn('"${SERVICE_NAME}|User|gharunner"', script)
        self.assertIn('"${SERVICE_NAME}|NoNewPrivileges|yes"', script)


if __name__ == "__main__":
    unittest.main()
