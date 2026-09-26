"""ARIA-HIGH-218 — rollback and retention evidence is published and verified by download.

The claim lane wrote the rollback bundle and its retention copy under the
tools root (``enterprise/rollback-artifacts/*.bundle``,
``.archive/rollback/**``). No state surface declares those paths, so they
never reached aria/state, and the merge verifier — another runner — re-hashed
files that did not exist on its host.

A bundle of ``main`` is the repository's whole history: too large for the
state branch. The bundle is published as a GitHub Actions artifact instead,
both proofs name it by reference (``actions-artifact:<repo>/<id>`` and
``...#<bundle>``) with the digests of the zip and of the bundle, and the
verifier downloads the artifact and re-hashes both.
"""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml  # type: ignore[import-untyped]

from aria_kernel.actions_artifacts import (
    actions_artifact_uri,
    parse_actions_artifact_uri,
)
from aria_kernel.enterprise_readiness import (
    evaluate_enterprise_readiness_claim,
    verify_enterprise_readiness,
)
from aria_kernel.gh_token_factory import MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS
from aria_kernel.readiness_proofs import (
    DEFAULT_ROLLBACK_RETENTION_DAYS,
    build_rollback_bundle,
    load_published_artifact,
    produce_rollback_and_retention_proofs,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workflow_contracts import UPLOAD_ARTIFACT_ACTION
from tests._helpers.published_artifacts import PublishedArtifacts
from tests.test_readiness_claim_durability import _HEAD, _Adapter, _ClaimFixture

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _git_workspace(root: Path) -> Path:
    workspace = root / "workspace"
    workspace.mkdir()
    (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")
    for argv in (
        ["init", "-q", "-b", "main"],
        ["config", "user.email", "t@example.invalid"],
        ["config", "user.name", "T"],
        ["add", "."],
        ["commit", "-q", "-m", "init"],
    ):
        subprocess.run(["git", *argv], cwd=workspace, check=True)
    return workspace


class RollbackPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self.workspace = _git_workspace(root)
        self.output = root / "rollback"
        self.artifacts = PublishedArtifacts(repo="okan/aqua")
        self.binding = dict(
            pr_number=77, repo="okan/aqua", target_ref="main", head_ref="feat/x",
            head_sha=_HEAD, readiness_claim_id="claim:77:aaaaaaaaaaaa",
            workspace_root=self.workspace, base_dir=self.tools,
        )

    def _built_and_published(self) -> tuple[dict, object]:
        built = build_rollback_bundle(
            target_ref="main", head_sha=_HEAD, workspace_root=self.workspace, output_dir=self.output,
        )
        artifact_id = self.artifacts.publish_files(Path(built["bundle_path"]))
        return built, self.artifacts.fetch(repo="okan/aqua", artifact_id=artifact_id)

    def test_the_bundle_is_built_outside_the_store(self) -> None:
        built = build_rollback_bundle(
            target_ref="main", head_sha=_HEAD, workspace_root=self.workspace, output_dir=self.output,
        )
        path = Path(built["bundle_path"])
        self.assertEqual(path.parent, self.output.resolve())
        self.assertEqual(path.name, "rollback-aaaaaaaaaaaa.bundle")
        self.assertTrue(built["bundle_sha256"].startswith("sha256:"))

    def test_both_proofs_name_the_published_artifact_and_nothing_lands_in_the_store(self) -> None:
        built, published = self._built_and_published()
        report = produce_rollback_and_retention_proofs(**self.binding, bundle=built, published=published)
        for proof in (report["rollback_proof"], report["retention_proof"]):
            self.assertEqual(proof["archive_uri"], actions_artifact_uri("okan/aqua", published.artifact_id))
            self.assertEqual(
                proof["source_uri"],
                actions_artifact_uri("okan/aqua", published.artifact_id, "rollback-aaaaaaaaaaaa.bundle"),
            )
            self.assertEqual(proof["archive_sha256"], published.zip_sha256)
            self.assertEqual(proof["source_sha256"], built["bundle_sha256"])
            self.assertEqual(proof["artifact_id"], published.artifact_id)
        self.assertFalse((self.tools / "enterprise" / "rollback-artifacts").exists())
        self.assertFalse((self.tools / ".archive").exists())
        self.assertEqual([path for path in self.tools.rglob("*.bundle")], [])

    def test_a_published_member_that_is_not_the_built_bundle_is_refused(self) -> None:
        built, _ = self._built_and_published()
        other = self.artifacts.publish({built["bundle_name"]: b"not the bundle"})
        with self.assertRaisesRegex(GovernanceError, "rollback_artifact_member_mismatch"):
            produce_rollback_and_retention_proofs(
                **self.binding, bundle=built,
                published=self.artifacts.fetch(repo="okan/aqua", artifact_id=other),
            )

    def test_a_retention_shorter_than_declared_is_refused(self) -> None:
        short = PublishedArtifacts(repo="okan/aqua", retention_days=7)
        built = build_rollback_bundle(
            target_ref="main", head_sha=_HEAD, workspace_root=self.workspace, output_dir=self.output,
        )
        artifact_id = short.publish_files(Path(built["bundle_path"]))
        with self.assertRaisesRegex(GovernanceError, "rollback_artifact_retention_short"):
            produce_rollback_and_retention_proofs(
                **self.binding, bundle=built,
                published=short.fetch(repo="okan/aqua", artifact_id=artifact_id),
            )

    def test_a_proof_naming_a_store_path_is_not_a_publication(self) -> None:
        for uri in ("enterprise/rollback-artifacts/rollback-aaaaaaaaaaaa.bundle", "/abs/path", ""):
            with self.assertRaisesRegex(GovernanceError, "not_published|malformed"):
                parse_actions_artifact_uri(uri)

    def test_the_download_is_recorded_and_read_back_unchanged(self) -> None:
        from aria_kernel.cli import main as cli_main

        built, published = self._built_and_published()
        out = Path(self.tmp.name) / "download"
        with self.artifacts.serve(), contextlib.redirect_stdout(io.StringIO()) as stdout:
            rc = cli_main([
                "--tools-dir", str(self.tools), "readiness", "fetch-artifact",
                "--repo", "okan/aqua", "--artifact-id", published.artifact_id,
                "--output-dir", str(out),
            ])
        self.assertEqual(rc, 0)
        record = json.loads(stdout.getvalue())
        self.assertEqual(record["zip_sha256"], published.zip_sha256)
        self.assertEqual(load_published_artifact(record).zip_sha256, published.zip_sha256)
        Path(record["zip_path"]).write_bytes(b"changed after download")
        with self.assertRaisesRegex(GovernanceError, "published_artifact_zip_changed"):
            load_published_artifact(record)


class VerifiedByDownloadTests(_ClaimFixture):
    def _verify(self, claim_id: str):
        return verify_enterprise_readiness(
            pr_number=77, adapter=_Adapter(_HEAD), readiness_claim_id=claim_id, base_dir=self.tools,
        )

    def test_the_merge_verifier_downloads_the_published_artifact(self) -> None:
        report = self._produce()
        self.artifacts.fetches.clear()
        verdict = self._verify(report["readiness_claim_id"])
        self.assertTrue(verdict.valid, verdict.reasons)
        artifact_id = report["claim"]["rollback_proof"]["artifact_id"]
        # One download serves both proofs of the claim.
        self.assertEqual(self.artifacts.fetches, [("okan/aqua", artifact_id)])

    def test_published_bytes_that_changed_are_refused(self) -> None:
        report = self._produce()
        artifact_id = report["claim"]["rollback_proof"]["artifact_id"]
        self.artifacts.replace_bytes(artifact_id, b"PK\x05\x06" + b"\x00" * 18)
        verdict = self._verify(report["readiness_claim_id"])
        self.assertFalse(verdict.valid)
        self.assertIn("rollback_proof_archive_sha256_byte_mismatch", verdict.reasons)
        self.assertIn("retention_proof_archive_sha256_byte_mismatch", verdict.reasons)

    def test_an_artifact_that_is_gone_is_refused(self) -> None:
        report = self._produce()
        self.artifacts.expire(report["claim"]["rollback_proof"]["artifact_id"])
        verdict = self._verify(report["readiness_claim_id"])
        self.assertFalse(verdict.valid)
        self.assertTrue(any(reason.startswith("rollback_proof_archive_uri_unreadable") for reason in verdict.reasons))
        self.assertIn("rollback_proof_required", verdict.failure_classes)

    def test_a_claim_whose_proofs_name_store_paths_is_refused(self) -> None:
        claim = dict(self._produce()["claim"])
        for name in ("rollback_proof", "retention_proof"):
            proof = dict(claim[name])
            proof["source_uri"] = "enterprise/rollback-artifacts/rollback-aaaaaaaaaaaa.bundle"
            proof["archive_uri"] = ".archive/rollback/claim-77/rollback-aaaaaaaaaaaa.bundle"
            claim[name] = proof
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertIn("rollback_proof_uri_not_published", verdict.reasons)
        self.assertIn("retention_proof_uri_not_published", verdict.reasons)


class LaneWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        workflow = yaml.safe_load(
            (_REPO_ROOT / ".github" / "workflows" / "aria-readiness-claim.yml").read_text(encoding="utf-8"),
        )
        self.steps = workflow["jobs"]["claim"]["steps"]
        self.by_name = {step.get("name"): step for step in self.steps}
        self.order = [step.get("name") for step in self.steps]

    def test_the_claim_lane_publishes_then_downloads_the_bundle(self) -> None:
        upload = self.by_name["Publish the rollback bundle"]
        self.assertEqual(upload["uses"], UPLOAD_ARTIFACT_ACTION)
        self.assertEqual(upload["with"]["if-no-files-found"], "error")
        self.assertGreaterEqual(int(upload["with"]["retention-days"]), DEFAULT_ROLLBACK_RETENTION_DAYS)
        self.assertIn("${{ runner.temp }}/rollback", upload["with"]["path"])
        download = self.by_name["Download the published rollback bundle"]
        self.assertIn("readiness fetch-artifact", download["run"])
        self.assertEqual(download["env"]["ARTIFACT_ID"], "${{ steps.rollback_upload.outputs.artifact-id }}")
        # The job token reads Actions; the App token the claim step mints does not.
        self.assertEqual(download["env"]["GH_TOKEN"], "${{ github.token }}")
        assemble = self.by_name["Assemble the readiness claim"]["run"]
        self.assertIn("--rollback-bundle-file", assemble)
        self.assertIn("--rollback-artifact-file", assemble)
        self.assertLess(self.order.index("Build the rollback bundle"), self.order.index("Publish the rollback bundle"))
        self.assertLess(
            self.order.index("Publish the rollback bundle"),
            self.order.index("Download the published rollback bundle"),
        )
        self.assertLess(
            self.order.index("Download the published rollback bundle"),
            self.order.index("Assemble the readiness claim"),
        )

    def test_the_bundle_is_built_outside_the_store(self) -> None:
        run = self.by_name["Build the rollback bundle"]["run"]
        self.assertIn('--output-dir "${RUNNER_TEMP}/rollback"', run)

    def test_the_merge_token_can_download_the_published_evidence(self) -> None:
        self.assertEqual(MERGE_LANE_INSTALLATION_TOKEN_PERMISSIONS.get("actions"), "read")


if __name__ == "__main__":
    unittest.main()
