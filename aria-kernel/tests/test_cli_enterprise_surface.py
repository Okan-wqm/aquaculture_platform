from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from tests._helpers.declared_fixtures import append_declared_fixture


CLI_SOURCE = Path(__file__).resolve().parents[1] / "aria_kernel" / "cli.py"


class EnterpriseCliSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        set_profile("standard", operator_approval_ref="test-cli-enterprise", base_dir=self.tools)
        (self.tools / "registry.json").write_text('{"tools": []}', encoding="utf-8")
        # ARIA-AUDIT-015: promotion approval references must resolve to
        # recorded operator action; seed the governance event the CLI
        # fixture's gov: ref names.
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(
            self.tools,
            "operator_action",
            {"event_id": "evt-cli-enterprise-approval", "action": "approve"},
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_source_declares_enterprise_public_commands(self) -> None:
        source = CLI_SOURCE.read_text(encoding="utf-8")
        for required in (
            'add_subparser(runtime_sub, "verify-artifacts")',
            'runtime_verify.add_argument("--cycle-id"',
            'runtime_verify.add_argument("--workspace-root"',
            'runtime_verify.add_argument("--require-artifact-bearing"',
            'add_subparser(runtime_promotion_sub, "approve-v2")',
            'runtime_approve_v2.add_argument("--workspace-root", required=True)',
            'runtime_retention_apply.add_argument("--reason", required=True, type=_validate_reason)',
            'runtime_restore.add_argument("--operator-approval-ref", required=True)',
            'runtime_rollback.add_argument("--workspace-root", required=True)',
            'add_subparser(autonomy_sub, "project-queue")',
            '"--output", choices=["summary", "full"]',
            'add_subparser(plan_sub, "advance-rounds")',
            'add_subparser(plan_sub, "promote-to-dispatch")',
            'plan_promote.add_argument("--cycle-id", required=True)',
            'plan_promote.add_argument("--base-sha", default=None)',
            'plan_promote.add_argument("--impact-ref", required=True)',
            'plan_promote.add_argument("--validation-ref", required=True)',
            'add_subparser(agent_genesis_sub, "approve")',
            'add_subparser(agent_genesis_sub, "prepare-pr-lane")',
            'add_subparser(skill_genesis_sub, "approve")',
            'worker_result_submit.add_argument("--lease-token"',
            'worker_result_submit.add_argument("--allow-legacy-no-token"',
        ):
            self.assertIn(required, source)

    def test_runtime_verify_requires_artifact_bearing_cycle(self) -> None:
        append_declared_fixture(
            self.tools / "cycles.jsonl",
            {"cycle_id": "cyc-cli", "event": "started", "status": "started"},
            expected_surface="cycles",
        )
        append_declared_fixture(
            self.tools / "cycles.jsonl",
            {"cycle_id": "cyc-cli", "event": "completed", "status": "completed"},
            expected_surface="cycles",
        )

        with redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.tools),
                "runtime", "verify-artifacts",
                "--cycle-id", "cyc-cli",
                "--require-artifact-bearing",
            ])
        payload = json.loads(buf.getvalue())
        self.assertEqual(rc, 4)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["cycle_evidence"]["cycle_evidence_class"], "lifecycle_only")
        self.assertIn("cycle_not_artifact_bearing", {i.get("code") for i in payload["issues"]})

    def test_runtime_promotion_approve_v2_persists_bound_record(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        target_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo_root, text=True).strip()
        bundle = self.tools / "runtime" / "promotion-evidence.json"
        bundle.parent.mkdir(parents=True, exist_ok=True)
        bundle.write_text(json.dumps({"operator_approval_ref": "gov:evt-cli-enterprise-approval", "target_sha": target_sha}), encoding="utf-8")

        with redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.tools),
                "runtime", "promotion", "approve-v2",
                "--evidence-bundle", str(bundle),
                "--workspace-root", str(repo_root),
                "--operator-approval-ref", "gov:evt-cli-enterprise-approval",
            ])
        payload = json.loads(buf.getvalue())
        self.assertEqual(rc, 0)
        self.assertEqual(payload["schema_version"], 2)
        self.assertEqual(payload["target_sha"], target_sha)
        self.assertEqual(payload["artifact_verifier_version"], "runtime-artifact-graph-v2")
        rows = load_jsonl(self.tools / "runtime" / "v2-promotions.jsonl")
        self.assertEqual(rows[-1]["operator_approval_ref"], "gov:evt-cli-enterprise-approval")

    def test_autonomy_project_queue_prints_pending_rows(self) -> None:
        with redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.tools),
                "autonomy", "project-queue",
                "--limit", "2",
            ])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(buf.getvalue()), [])


if __name__ == "__main__":
    unittest.main()
