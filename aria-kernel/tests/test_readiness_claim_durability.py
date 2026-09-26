"""ARIA-HIGH-219 — a readiness claim is durable; mutual exclusion is taken at merge.

The claim used to carry the remote-CAS lease it was minted under, and the
lease lives five minutes. The claim verifier refused an expired lease, and
the claim id is fixed per (PR, head), so a head whose required checks
finished more than five minutes after the claim could never merge: the
claim was dead and a new one for the same head was refused as a duplicate.

The claim now carries no lease. It stays valid for as long as the PR head
is the head it names (the live-head binding the verifier already applies),
and the CAS lease is taken inside ``merge_pr_if_ready`` immediately before
the merge call, bound to the claim it merges under.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.enterprise_readiness import (
    REQUIRED_MERGE_STATUS_CHECKS,
    REQUIRED_READINESS_FIELDS,
    verify_enterprise_readiness,
)
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.readiness_proofs import (
    build_rollback_bundle,
    produce_readiness_claim,
    produce_remote_cas_proof,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.published_artifacts import PublishedArtifacts

_HEAD = "a" * 40
_NEWER_HEAD = "e" * 40
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _strong_payload() -> dict:
    return {
        "required_status_checks": {"contexts": list(REQUIRED_MERGE_STATUS_CHECKS)},
        "required_signatures": {"enabled": True},
        "required_pull_request_reviews": {
            "required_approving_review_count": 0, "require_code_owner_reviews": True,
        },
        "required_conversation_resolution": {"enabled": True},
        "allow_force_pushes": {"enabled": False},
        "allow_deletions": {"enabled": False},
        "enforce_admins": {"enabled": True},
    }


def _probe(*, branch, repo):
    return True, (), _strong_payload()


def _rules(*, repo, branch):
    return [101], []


class _Lease:
    fallback_active = False
    gh_app_installation_id = "inst-1"
    ttl_seconds = 300


class _AdvancedClock(datetime):
    """``datetime`` whose ``now`` is ten minutes past the real clock: twice
    the CAS lease's life, so anything still gated on the lease's expiry
    reads it as expired."""

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return datetime.now(tz or timezone.utc) + timedelta(minutes=10)


class _Adapter:
    def __init__(self, head_sha: str) -> None:
        self.head_sha = head_sha
        self.merged: list[dict] = []

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number,
            "state": "OPEN",
            "repository": "okan/aqua",
            "base_branch": "main",
            "head_ref": "feat/x",
            "head_sha": self.head_sha,
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.merged.append({"pr_number": pr_number, **kwargs})
        return {"merged": True, "merge_commit_sha": "f" * 40}


def _gates_before_readiness() -> list:
    return [
        patch("aria_kernel.merge_authority.assert_merge_authority_available", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_merge_authorized", return_value="autonomous"),
        patch("aria_kernel.merge_authority.assert_merge_not_watchdog_frozen", return_value=None),
        patch("aria_kernel.merge_authority.assert_self_merge_not_frozen", return_value=None),
        patch(
            "aria_kernel.merge_authority.record_risk_decision_for_pr",
            return_value={"valid": True, "lane": "L1", "policy_hash": "ph"},
        ),
        patch(
            "aria_kernel.merge_authority.assert_autonomy_unlocked",
            return_value=SimpleNamespace(counts={}),
        ),
    ]


def _gates_after_readiness() -> list:
    return [
        patch("aria_kernel.merge_authority.verify_runner_attestation", return_value={}),
        patch("aria_kernel.merge_authority.verify_rollback_bundle", return_value={}),
        patch(
            "aria_kernel.merge_authority.ensure_pre_merge_incident_row",
            return_value={"ledger_hash": "x"},
        ),
        patch(
            "aria_kernel.merge_authority._merge_if_green_with_executor",
            return_value={"decision": "proceed", "eligible": True, "head_sha": _HEAD},
        ),
        patch(
            "aria_kernel.merge_authority._evaluate_triple_gate",
            return_value={"passed": True, "change_id": "c1"},
        ),
        patch("aria_kernel.merge_authority.collect_github_snapshot", return_value={}),
        patch(
            "aria_kernel.merge_authority.evaluate_auto_merge",
            return_value={"eligible": True, "head_sha": _HEAD},
        ),
        patch(
            "aria_kernel.merge_authority.run_hard_fail_checks",
            return_value=SimpleNamespace(passed=True, failures=(), results=()),
        ),
        patch("aria_kernel.expert_review_gate._ensure_implementation_expert_requests", return_value=()),
    ]


class _ClaimFixture(unittest.TestCase):
    """A claim assembled by the production producer from produced evidence."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self.workspace = root / "workspace"
        self.workspace.mkdir()
        (self.workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        for argv in (
            ["init", "-q", "-b", "main"],
            ["config", "user.email", "t@example.invalid"],
            ["config", "user.name", "T"],
            ["add", "."],
            ["commit", "-q", "-m", "init"],
        ):
            subprocess.run(["git", *argv], cwd=self.workspace, check=True)
        workflow = self.workspace / ".github" / "workflows" / "aria-agent-executor.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_REPO_ROOT / ".github" / "workflows" / "aria-agent-executor.yml", workflow)
        append_declared_jsonl(
            self.tools / "ci" / "workflow-runs.jsonl",
            {
                "schema_version": 1,
                "row_id": "ci-workflow-run:123456",
                "row_type": "ci_workflow_run",
                "workflow_run_id": "123456",
                "pr_number": 77,
                "repo": "okan/aqua",
                "target_ref": "main",
                "head_ref": "feat/x",
                "head_sha": _HEAD,
                "conclusion": "success",
            },
            expected_surface="ci_workflow_runs",
        )
        evidence = root / "evidence"
        evidence.mkdir()
        self.surfaces = {}
        for surface in ("diff", "prompt", "transcript", "logs", "artifacts"):
            path = evidence / f"{surface}.txt"
            path.write_text(f"clean {surface}\n", encoding="utf-8")
            self.surfaces[surface] = [path]
        # ARIA-HIGH-218 — the rollback bundle is published as an Actions
        # artifact; the merge gate downloads it back through this store.
        self.artifacts = PublishedArtifacts(repo="okan/aqua")
        serving = self.artifacts.serve()
        serving.start()
        self.addCleanup(serving.stop)

    def _publish_rollback_bundle(self) -> tuple[dict, object]:
        built = build_rollback_bundle(
            target_ref="main", head_sha=_HEAD, workspace_root=self.workspace,
            output_dir=Path(self.tmp.name) / "rollback",
        )
        artifact_id = self.artifacts.publish_files(Path(built["bundle_path"]))
        return built, self.artifacts.fetch(repo="okan/aqua", artifact_id=artifact_id)

    def _produce(self) -> dict:
        built, published = self._publish_rollback_bundle()
        return produce_readiness_claim(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha=_HEAD,
            workflow_id="aria-agent-executor", job_id="executor",
            workflow_run_id="123456", cycle_id="cycle-durable",
            artifact={
                "artifact_id": "artifact-1",
                "uri": "https://api.github.com/artifacts/1",
                "sha256": "sha256:" + "b" * 64,
                "content_type": "application/zip",
            },
            surface_paths=self.surfaces,
            workspace_root=self.workspace,
            rollback_bundle=built,
            rollback_artifact=published,
            base_dir=self.tools,
            probe=_probe,
            rules_probe=_rules,
            mint=lambda **kw: _Lease(),
        )

    def _rows(self, relpath: str, surface: str) -> list[dict]:
        path = self.tools / relpath
        if not path.exists():
            return []
        return load_declared_jsonl(path, expected_surface=surface)


class DurableClaimTests(_ClaimFixture):
    def test_the_claim_carries_no_lease(self) -> None:
        claim = self._produce()["claim"]
        self.assertNotIn("remote_cas_proof", claim)
        self.assertNotIn("remote_cas_proof", REQUIRED_READINESS_FIELDS)
        # Minting a claim takes no lease: exclusion belongs to the merge.
        self.assertEqual(
            self._rows("enterprise/remote-cas-proofs.jsonl", "enterprise_remote_cas_proofs"), [],
        )
        self.assertFalse((self.tools / "locks" / "autonomous-host.cas.json").exists())

    def test_a_claim_outlives_the_lease_while_the_head_is_unchanged(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        with patch("aria_kernel.enterprise_readiness.datetime", _AdvancedClock):
            verdict = verify_enterprise_readiness(
                pr_number=77, adapter=_Adapter(_HEAD), readiness_claim_id=claim_id,
                base_dir=self.tools,
            )
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_a_claim_for_an_older_head_is_refused(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        verdict = verify_enterprise_readiness(
            pr_number=77, adapter=_Adapter(_NEWER_HEAD), readiness_claim_id=claim_id,
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("readiness_live_head_sha_mismatch", verdict.reasons)

    def test_re_producing_a_claim_for_the_same_head_reuses_it(self) -> None:
        first = self._produce()
        before = (self.tools / "enterprise" / "readiness-claims.jsonl").read_bytes()
        rollback_rows = self._rows("enterprise/rollback-proofs.jsonl", "enterprise_rollback_proofs")
        second = self._produce()
        self.assertEqual(second["readiness_claim_id"], first["readiness_claim_id"])
        self.assertTrue(second["already_recorded"])
        self.assertEqual(second["claim"]["ledger_hash"], first["claim"]["ledger_hash"])
        self.assertEqual((self.tools / "enterprise" / "readiness-claims.jsonl").read_bytes(), before)
        self.assertEqual(
            self._rows("enterprise/rollback-proofs.jsonl", "enterprise_rollback_proofs"), rollback_rows,
        )


class LeaseAtMergeTests(_ClaimFixture):
    def _merge(self, adapter: _Adapter, claim_id: str) -> dict:
        patches = [*_gates_before_readiness(), *_gates_after_readiness()]
        for item in patches:
            item.start()
        try:
            with patch("aria_kernel.enterprise_readiness.datetime", _AdvancedClock):
                return merge_pr_if_ready(
                    adapter=adapter, pr_number=77, base_dir=self.tools,
                    readiness_claim_id=claim_id,
                )
        finally:
            for item in reversed(patches):
                item.stop()

    def test_a_claim_older_than_the_lease_merges_at_an_unchanged_head(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        adapter = _Adapter(_HEAD)
        result = self._merge(adapter, claim_id)
        self.assertEqual(result["decision"], "merged", result)
        self.assertEqual(len(adapter.merged), 1)
        # The lease was taken by the merge, bound to the claim it merged under.
        leases = self._rows("enterprise/remote-cas-proofs.jsonl", "enterprise_remote_cas_proofs")
        self.assertEqual([row["readiness_claim_id"] for row in leases], [claim_id])
        self.assertEqual(leases[0]["head_sha"], _HEAD)
        self.assertEqual(leases[0]["state"], "fresh")

    def test_a_claim_for_an_older_head_is_refused_at_merge(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        adapter = _Adapter(_NEWER_HEAD)
        with self.assertRaisesRegex(GovernanceError, "readiness_live_head_sha_mismatch"):
            self._merge(adapter, claim_id)
        self.assertEqual(adapter.merged, [])
        self.assertEqual(
            self._rows("enterprise/remote-cas-proofs.jsonl", "enterprise_remote_cas_proofs"), [],
        )

    def test_a_lease_held_by_another_merger_blocks_the_merge(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        produce_remote_cas_proof(
            pr_number=77, repo="okan/aqua", target_ref="main", head_ref="feat/x",
            head_sha=_HEAD, owner="another-merger", base_dir=self.tools,
        )
        adapter = _Adapter(_HEAD)
        result = self._merge(adapter, claim_id)
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "merge_lease")
        self.assertTrue(any("remote_cas_lease_blocked" in reason for reason in result["reasons"]))
        self.assertEqual(adapter.merged, [])

    def test_a_perimeter_refusal_takes_no_lease(self) -> None:
        claim_id = self._produce()["readiness_claim_id"]
        adapter = _Adapter(_HEAD)
        refused = SimpleNamespace(
            passed=False, results=(),
            failures=(SimpleNamespace(name="branch_tip_lock_and_recheck", reason="fixture"),),
        )
        with patch("aria_kernel.merge_authority.run_hard_fail_checks", return_value=refused):
            patches = [*_gates_before_readiness(), *_gates_after_readiness()[:-2]]
            for item in patches:
                item.start()
            try:
                result = merge_pr_if_ready(
                    adapter=adapter, pr_number=77, base_dir=self.tools,
                    readiness_claim_id=claim_id,
                )
            finally:
                for item in reversed(patches):
                    item.stop()
        self.assertEqual(result["stage"], "pre_merge_perimeter")
        self.assertEqual(
            self._rows("enterprise/remote-cas-proofs.jsonl", "enterprise_remote_cas_proofs"), [],
        )

    def test_the_lease_is_released_when_the_merge_call_returns(self) -> None:
        # Two merges of one run: the second is not refused by the first's
        # lease, and each ran under its own epoch of the fence.
        claim_id = self._produce()["readiness_claim_id"]
        first = self._merge(_Adapter(_HEAD), claim_id)
        second = self._merge(_Adapter(_HEAD), claim_id)
        self.assertEqual([first["decision"], second["decision"]], ["merged", "merged"])
        self.assertEqual(second["merge_lease"]["epoch"], first["merge_lease"]["epoch"] + 1)
        from aria_kernel.autonomous_host_lease import remote_cas_lease_state

        self.assertEqual(remote_cas_lease_state(self.tools)["state"], "stale")


if __name__ == "__main__":
    unittest.main()
