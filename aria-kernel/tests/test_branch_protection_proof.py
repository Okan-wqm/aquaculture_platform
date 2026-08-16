"""F5-b (ORPHAN-694) — branch-protection proof producer.

The proof family the claim verifier demands had no production caller and
no resolvable source row. Battery: measured fields (never asserted), the
honest weak-protection path, fail-closed probe, source-ref resolution,
and the single-probe İ1 pin (verify_branch_protection is a projection of
probe_branch_protection).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.enterprise_readiness import REQUIRED_MERGE_STATUS_CHECKS
from aria_kernel.ledger_refs import find_row_by_source_ledger_ref
from aria_kernel.readiness_proofs import (
    BP_SNAPSHOTS_LEDGER_PATH,
    produce_branch_protection_proof,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _strong_payload() -> dict:
    return {
        "required_status_checks": {"contexts": list(REQUIRED_MERGE_STATUS_CHECKS)},
        "required_signatures": {"enabled": True},
        "required_pull_request_reviews": {"required_approving_review_count": 1},
        "required_conversation_resolution": {"enabled": True},
        "allow_force_pushes": {"enabled": False},
        "allow_deletions": {"enabled": False},
        "enforce_admins": {"enabled": True},
    }


def _probe_for(payload, ok=True, reasons=()):
    def probe(*, branch, repo):
        return ok, tuple(reasons), payload

    return probe


def _rules(ruleset_ids=(101,), bypass_actors=()):
    def rules_probe(*, repo, branch):
        return list(ruleset_ids), list(bypass_actors)

    return rules_probe


class BranchProtectionProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.binding = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40, base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_strong_protection_yields_valid_proof_with_resolvable_source(self) -> None:
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(_strong_payload()),
            rules_probe=_rules(),
        )
        proof = report["proof"]
        self.assertTrue(proof["valid"])
        self.assertEqual(sorted(proof["required_checks"]), sorted(REQUIRED_MERGE_STATUS_CHECKS))
        self.assertTrue(proof["signed_commits_required"])
        self.assertTrue(proof["force_push_disabled"])
        self.assertEqual(proof["bypass_actors"], [])
        self.assertEqual(proof["ruleset_ids"], [101])
        # the source ref RESOLVES to the snapshot row
        resolved = find_row_by_source_ledger_ref(
            self.tools, proof["source_ledger_ref"],
        )
        self.assertEqual(resolved["payload_hash"], proof["snapshot_hash"])
        # the claim gate's digest format is a hard structural requirement
        self.assertTrue(proof["snapshot_hash"].startswith("sha256:"))
        self.assertTrue((self.tools / BP_SNAPSHOTS_LEDGER_PATH).exists())

    def test_weak_protection_is_recorded_honestly_not_hidden(self) -> None:
        weak = _strong_payload()
        weak["allow_force_pushes"] = {"enabled": True}
        weak["required_status_checks"] = {"contexts": ["merge-gate"]}
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(weak, ok=False, reasons=("force_pushes_enabled",)),
            rules_probe=_rules(),
        )
        proof = report["proof"]
        self.assertFalse(proof["valid"])
        self.assertFalse(proof["force_push_disabled"])
        self.assertEqual(proof["required_checks"], ["merge-gate"])
        self.assertIn("force_pushes_enabled", proof["probe_reasons"])

    def test_bypass_actors_are_recorded_verbatim(self) -> None:
        report = produce_branch_protection_proof(
            **self.binding,
            probe=_probe_for(_strong_payload()),
            rules_probe=_rules(bypass_actors=({"actor_id": 9, "actor_type": "Team"},)),
        )
        self.assertEqual(report["proof"]["bypass_actors"], [{"actor_id": 9, "actor_type": "Team"}])

    def test_probe_without_payload_fails_closed(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "probe_no_payload"):
            produce_branch_protection_proof(
                **self.binding,
                probe=_probe_for(None, ok=False, reasons=("gh_token_absent",)),
                rules_probe=_rules(),
            )

    def test_binding_fields_are_required(self) -> None:
        bad = dict(self.binding)
        bad["head_sha"] = " "
        with self.assertRaisesRegex(GovernanceError, "binding_required:head_sha"):
            produce_branch_protection_proof(
                **bad, probe=_probe_for(_strong_payload()), rules_probe=_rules(),
            )

    def test_single_probe_invariant(self) -> None:
        # İ1 — verify_branch_protection must be a projection of
        # probe_branch_protection, not a second gh-api implementation.
        import inspect

        from aria_kernel import preflight

        source = inspect.getsource(preflight.verify_branch_protection)
        self.assertIn("probe_branch_protection", source)
        self.assertNotIn("subprocess.run", source)


if __name__ == "__main__":
    unittest.main()


class RemoteCasProofTests(unittest.TestCase):
    """F5-d — the lease mechanism's first production caller."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.binding = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40, base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_lease_acquisition_becomes_a_resolvable_proof(self) -> None:
        from aria_kernel.readiness_proofs import produce_remote_cas_proof

        report = produce_remote_cas_proof(**self.binding, owner="runner-a")
        proof = report["proof"]
        self.assertEqual(proof["state"], "fresh")
        self.assertEqual(proof["owner"], "runner-a")
        self.assertGreaterEqual(proof["epoch"], 0)
        resolved = find_row_by_source_ledger_ref(self.tools, proof["source_ledger_ref"])
        self.assertEqual(resolved["lease_id"], proof["lease_id"])

    def test_foreign_fresh_lease_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_remote_cas_proof

        produce_remote_cas_proof(**self.binding, owner="runner-a")
        with self.assertRaisesRegex(GovernanceError, "remote_cas_lease_blocked"):
            produce_remote_cas_proof(**self.binding, owner="runner-b")

    def test_same_owner_refresh_advances_the_epoch_fence(self) -> None:
        # Same-owner refresh is a RE-ACQUIRE by design: epoch+1, new
        # lease_id — the fence is what makes a stale heartbeat unable to
        # carry a lease across commits. The proof follows the fence.
        from aria_kernel.readiness_proofs import produce_remote_cas_proof

        first = produce_remote_cas_proof(**self.binding, owner="runner-a")
        second = produce_remote_cas_proof(**self.binding, owner="runner-a")
        self.assertEqual(second["epoch"], first["epoch"] + 1)
        self.assertNotEqual(first["lease_id"], second["lease_id"])
        self.assertEqual(second["proof"]["owner"], "runner-a")


class RollbackRetentionProofTests(unittest.TestCase):
    """F5-e — a real git bundle, verified by git, archived byte-identically."""

    def setUp(self) -> None:
        import subprocess

        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.repo = Path(self.tmp.name) / "workspace"
        self.repo.mkdir()
        (self.repo / "seed.txt").write_text("seed\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "T"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=self.repo, check=True)
        self.binding = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40,
            readiness_claim_id="claim:77:aaaaaaaaaaaa",
            workspace_root=self.repo, base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_real_bundle_yields_both_proofs_with_equal_digests(self) -> None:
        from aria_kernel.readiness_proofs import produce_rollback_and_retention_proofs

        report = produce_rollback_and_retention_proofs(**self.binding)
        rollback = report["rollback_proof"]
        retention = report["retention_proof"]
        self.assertTrue(rollback["validated"])
        self.assertEqual(rollback["source_sha256"], rollback["archive_sha256"])
        self.assertTrue(rollback["source_sha256"].startswith("sha256:"))
        self.assertTrue(retention["validated"])
        self.assertEqual(retention["retention_days"], 30)
        # both source refs RESOLVE
        for proof in (rollback, retention):
            resolved = find_row_by_source_ledger_ref(self.tools, proof["source_ledger_ref"])
            self.assertIsInstance(resolved, dict)
        # the archived artifact exists and is byte-identical; uris are
        # RELATIVE to the tools root — exactly what the claim verifier
        # re-reads (absolute/file:// forms are rejected there)
        archive = self.tools / report["archive_uri"]
        source = self.tools / report["bundle_uri"]
        self.assertEqual(archive.read_bytes(), source.read_bytes())

    def test_missing_target_ref_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_rollback_and_retention_proofs

        bad = dict(self.binding)
        bad["target_ref"] = "no-such-branch"
        with self.assertRaisesRegex(GovernanceError, "bundle_create_failed"):
            produce_rollback_and_retention_proofs(**bad)

    def test_claim_id_is_required(self) -> None:
        from aria_kernel.readiness_proofs import produce_rollback_and_retention_proofs

        bad = dict(self.binding)
        bad["readiness_claim_id"] = " "
        with self.assertRaisesRegex(GovernanceError, "claim_id_required"):
            produce_rollback_and_retention_proofs(**bad)

    def test_retention_days_must_be_positive(self) -> None:
        from aria_kernel.readiness_proofs import produce_rollback_and_retention_proofs

        with self.assertRaisesRegex(GovernanceError, "retention_days"):
            produce_rollback_and_retention_proofs(**self.binding, retention_days=0)


class TokenProofTests(unittest.TestCase):
    """F5-c — the scoped-token attestation, measured from the contract SSoT."""

    def setUp(self) -> None:
        import shutil

        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.workspace = Path(self.tmp.name) / "workspace"
        # The producer hashes the REAL workflow file named by the contract.
        target = self.workspace / ".github" / "workflows" / "aria-agent-executor.yml"
        target.parent.mkdir(parents=True, exist_ok=True)
        repo_root = Path(__file__).resolve().parents[2]
        shutil.copy2(repo_root / ".github" / "workflows" / "aria-agent-executor.yml", target)
        self.kwargs = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40,
            readiness_claim_id="claim:77:aaaaaaaaaaaa",
            workflow_id="aria-agent-executor", job_id="executor",
            workflow_run_id="123456", artifact_id="artifact-1",
            artifact_sha256="sha256:" + "b" * 64,
            cycle_id="cycle-t1", workspace_root=self.workspace,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    class _Lease:
        def __init__(self, fallback: bool) -> None:
            self.fallback_active = fallback
            self.gh_app_installation_id = None if fallback else "inst-1"
            self.ttl_seconds = 300

    def test_installation_mode_yields_valid_proof(self) -> None:
        from aria_kernel.readiness_proofs import produce_token_proof

        report = produce_token_proof(
            **self.kwargs, mint=lambda **kw: self._Lease(fallback=False),
        )
        proof = report["proof"]
        self.assertTrue(proof["valid"])
        self.assertEqual(proof["token_mode"], "installation")
        self.assertTrue(proof["workflow_hash"].startswith("sha256:"))
        self.assertTrue(proof["contract_hash"].startswith("sha256:"))
        self.assertIn("github_artifact", proof["network_policy"])
        self.assertTrue(proof["runtime_write_paths"])
        resolved = find_row_by_source_ledger_ref(self.tools, proof["source_ledger_ref"])
        self.assertEqual(resolved["mode"], "installation")

    def test_pat_fallback_is_recorded_invalid(self) -> None:
        from aria_kernel.readiness_proofs import produce_token_proof

        report = produce_token_proof(
            **self.kwargs, mint=lambda **kw: self._Lease(fallback=True),
        )
        self.assertFalse(report["proof"]["valid"])
        self.assertEqual(report["proof"]["token_mode"], "pat_fallback")

    def test_unknown_contract_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_token_proof

        bad = dict(self.kwargs)
        bad["workflow_id"] = "no-such-workflow"
        with self.assertRaisesRegex(GovernanceError, "contract_unknown"):
            produce_token_proof(**bad, mint=lambda **kw: self._Lease(False))

    def test_missing_workflow_file_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_token_proof

        (self.workspace / ".github" / "workflows" / "aria-agent-executor.yml").unlink()
        with self.assertRaisesRegex(GovernanceError, "workflow_file_missing"):
            produce_token_proof(**self.kwargs, mint=lambda **kw: self._Lease(False))


class DlpProofTests(unittest.TestCase):
    """F5-f — the deterministic scanner; a vacuous scan is not a scan."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.evidence = Path(self.tmp.name) / "evidence"
        self.evidence.mkdir()
        self.surfaces = {}
        for surface in ("diff", "prompt", "transcript", "logs", "artifacts"):
            path = self.evidence / f"{surface}.txt"
            path.write_text(f"clean {surface} content\n", encoding="utf-8")
            self.surfaces[surface] = [path]
        self.kwargs = dict(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40,
            readiness_claim_id="claim:77:aaaaaaaaaaaa",
            workflow_run_id="123456", artifact_id="artifact-1",
            artifact_sha256="sha256:" + "b" * 64,
            workflow_hash="sha256:" + "c" * 64,
            contract_hash="sha256:" + "d" * 64,
            network_policy="github_artifact,github_git",
            runtime_write_paths=["^\\.aria-state-store(/.*)?$"],
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_clean_surfaces_pass_with_full_coverage(self) -> None:
        from aria_kernel.readiness_proofs import produce_dlp_proof

        report = produce_dlp_proof(**self.kwargs, surface_paths=self.surfaces)
        self.assertEqual(report["status"], "passed")
        proof = report["proof"]
        self.assertTrue(proof["valid"])
        results = proof["scanner_results"]
        self.assertEqual(results["status"], "passed")
        self.assertEqual(
            sorted(results["scanned_surfaces"]),
            sorted(["diff", "prompt", "transcript", "logs", "artifacts"]),
        )
        self.assertTrue(results["scanner_output_sha256"].startswith("sha256:"))
        resolved = find_row_by_source_ledger_ref(self.tools, proof["source_ledger_ref"])
        self.assertEqual(resolved["finding_count"], 0)

    def test_leaked_github_token_fails_and_names_only_the_pattern(self) -> None:
        from aria_kernel.readiness_proofs import produce_dlp_proof

        secret = "ghp_" + "A1b2C3d4" * 4
        self.surfaces["logs"][0].write_text(f"oops {secret}\n", encoding="utf-8")
        report = produce_dlp_proof(**self.kwargs, surface_paths=self.surfaces)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["proof"]["valid"])
        snapshot_text = str(report["snapshot"])
        self.assertIn("github_token", snapshot_text)
        self.assertNotIn(secret, snapshot_text)

    def test_private_key_block_is_caught(self) -> None:
        from aria_kernel.readiness_proofs import produce_dlp_proof

        self.surfaces["artifacts"][0].write_text(
            "-----BEGIN RSA PRIVATE KEY-----\nxyz\n", encoding="utf-8",
        )
        report = produce_dlp_proof(**self.kwargs, surface_paths=self.surfaces)
        self.assertEqual(report["status"], "failed")

    def test_missing_surface_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_dlp_proof

        del self.surfaces["transcript"]
        with self.assertRaisesRegex(GovernanceError, "surface_unscannable:transcript"):
            produce_dlp_proof(**self.kwargs, surface_paths=self.surfaces)

    def test_nonexistent_file_fails_closed(self) -> None:
        from aria_kernel.readiness_proofs import produce_dlp_proof

        self.surfaces["diff"] = [self.evidence / "no-such.txt"]
        with self.assertRaisesRegex(GovernanceError, "surface_unscannable:diff"):
            produce_dlp_proof(**self.kwargs, surface_paths=self.surfaces)


class ReadinessClaimAssemblyTests(unittest.TestCase):
    """F5-g — the moment the whole chain becomes REAL: a claim the
    verifier's own recorder accepts, assembled entirely from produced
    evidence. This is the structural unblocking of auto-merge's third
    condition."""

    def setUp(self) -> None:
        import shutil
        import subprocess

        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        # git workspace whose target_ref exists (rollback bundle source)
        self.workspace = Path(self.tmp.name) / "workspace"
        self.workspace.mkdir()
        (self.workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.invalid"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.name", "T"], cwd=self.workspace, check=True)
        subprocess.run(["git", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=self.workspace, check=True)
        # the real workflow file the token producer hashes
        target = self.workspace / ".github" / "workflows" / "aria-agent-executor.yml"
        target.parent.mkdir(parents=True, exist_ok=True)
        repo_root = Path(__file__).resolve().parents[2]
        shutil.copy2(repo_root / ".github" / "workflows" / "aria-agent-executor.yml", target)
        self._seed_ci_run("123456", pr_number=77, head_ref="feat/x", head_sha="a" * 40)
        # clean DLP evidence surfaces
        evidence = Path(self.tmp.name) / "evidence"
        evidence.mkdir()
        self.surfaces = {}
        for surface in ("diff", "prompt", "transcript", "logs", "artifacts"):
            path = evidence / f"{surface}.txt"
            path.write_text(f"clean {surface}\n", encoding="utf-8")
            self.surfaces[surface] = [path]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_ci_run(self, run_id: str, *, pr_number: int, head_ref: str, head_sha: str) -> None:
        # a successful ci workflow-run row — the claim only admits
        # LEDGER-PROVEN run ids (F5-a row identity shape)
        from aria_kernel.ledger import append_declared_jsonl as _append

        _append(
            self.tools / "ci" / "workflow-runs.jsonl",
            {
                "schema_version": 1,
                "row_id": f"ci-workflow-run:{run_id}",
                "row_type": "ci_workflow_run",
                "workflow_run_id": run_id,
                "pr_number": pr_number,
                "repo": "okan/aqua",
                "target_ref": "main",
                "head_ref": head_ref,
                "head_sha": head_sha,
                "conclusion": "success",
            },
            expected_surface="ci_workflow_runs",
        )

    class _Lease:
        fallback_active = False
        gh_app_installation_id = "inst-1"
        ttl_seconds = 300

    def test_full_chain_assembles_a_claim_the_recorder_accepts(self) -> None:
        from aria_kernel.enterprise_readiness import verify_enterprise_readiness
        from aria_kernel.readiness_proofs import produce_readiness_claim

        report = produce_readiness_claim(
            pr_number=77, repo="okan/aqua", target_ref="main",
            head_ref="feat/x", head_sha="a" * 40,
            workflow_id="aria-agent-executor", job_id="executor",
            workflow_run_id="123456", cycle_id="cycle-g1",
            artifact={
                "artifact_id": "artifact-1",
                "uri": "https://api.github.com/artifacts/1",
                "sha256": "sha256:" + "b" * 64,
                "content_type": "application/zip",
            },
            surface_paths=self.surfaces,
            workspace_root=self.workspace,
            base_dir=self.tools,
            probe=_probe_for(_strong_payload()),
            rules_probe=_rules(),
            mint=lambda **kw: self._Lease(),
            owner="runner-g",
        )
        self.assertTrue(report["readiness_claim_id"].startswith("claim:77:"))
        claim = report["claim"]
        self.assertEqual(claim["row_type"], "readiness_claim")
        self.assertIn("123456", claim["workflow_run_ids"])

        # the RESOLVER path auto-merge uses: verify against a live adapter
        class _Adapter:
            def get_pr(self, pr_number):
                return {
                    "repository": "okan/aqua",
                    "base_branch": "main",
                    "head_ref": "feat/x",
                    "head_sha": "a" * 40,
                }

        verdict = verify_enterprise_readiness(
            pr_number=77, adapter=_Adapter(),
            readiness_claim_id=report["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertTrue(verdict.valid, msg=str(verdict.reasons))

    def test_pat_fallback_poisons_the_claim_loudly(self) -> None:
        from aria_kernel.readiness_proofs import produce_readiness_claim

        class _FallbackLease:
            fallback_active = True
            gh_app_installation_id = None
            ttl_seconds = 300

        self._seed_ci_run("123457", pr_number=78, head_ref="feat/y", head_sha="c" * 40)
        with self.assertRaisesRegex(GovernanceError, "token_proof"):
            produce_readiness_claim(
                pr_number=78, repo="okan/aqua", target_ref="main",
                head_ref="feat/y", head_sha="c" * 40,
                workflow_id="aria-agent-executor", job_id="executor",
                workflow_run_id="123457", cycle_id="cycle-g2",
                artifact={
                    "artifact_id": "artifact-2",
                    "uri": "https://api.github.com/artifacts/2",
                    "sha256": "sha256:" + "b" * 64,
                    "content_type": "application/zip",
                },
                surface_paths=self.surfaces,
                workspace_root=self.workspace,
                base_dir=self.tools,
                probe=_probe_for(_strong_payload()),
                rules_probe=_rules(),
                mint=lambda **kw: _FallbackLease(),
            )

    def test_leaked_secret_poisons_the_claim_loudly(self) -> None:
        from aria_kernel.readiness_proofs import produce_readiness_claim

        self.surfaces["logs"][0].write_text(
            "ghp_" + "A1b2C3d4" * 4 + "\n", encoding="utf-8",
        )
        self._seed_ci_run("123458", pr_number=79, head_ref="feat/z", head_sha="d" * 40)
        with self.assertRaisesRegex(GovernanceError, "dlp_proof"):
            produce_readiness_claim(
                pr_number=79, repo="okan/aqua", target_ref="main",
                head_ref="feat/z", head_sha="d" * 40,
                workflow_id="aria-agent-executor", job_id="executor",
                workflow_run_id="123458", cycle_id="cycle-g3",
                artifact={
                    "artifact_id": "artifact-3",
                    "uri": "https://api.github.com/artifacts/3",
                    "sha256": "sha256:" + "b" * 64,
                    "content_type": "application/zip",
                },
                surface_paths=self.surfaces,
                workspace_root=self.workspace,
                base_dir=self.tools,
                probe=_probe_for(_strong_payload()),
                rules_probe=_rules(),
                mint=lambda **kw: self._Lease(),
            )
