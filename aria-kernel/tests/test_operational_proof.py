from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import state_store
from aria_kernel import operational_proof as operational_proof_module
from aria_kernel.burn_in import run_observe_burn_in
from aria_kernel.burn_in import (
    _bundle_content_hash,
    _stable_hash,
    verify_burn_in_artifact_bundle,
)
from aria_kernel.cycle import _complete_event, _started_cycle_row
from aria_kernel.ledger import append_declared_jsonl, append_jsonl
from aria_kernel.operational_proof import (
    SUCCESS_FILES,
    capture_operational_state,
    scan_operational_proof_for_secrets,
    verify_operational_proof_bundle,
    write_operational_proof_manifest,
)
from aria_kernel.preflight import verify_workflow_preflight
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    build_publishable_snapshot,
    checkout_state_store,
    open_state_store,
    publish_state,
    state_writer_attestation_path,
    tools_root,
)
from aria_kernel.secure_artifact_io import normalized_relative_posix, secure_directory_fd
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace import canonical_identity

from tests._helpers.git_fixtures import make_repo_with_initial_commit


TARGET_RUN_ID = "424242"
TARGET_ATTEMPT = 3


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=True
    ).stdout.strip()


def _make_state_fixture(base: Path) -> tuple[Path, str]:
    base.mkdir(parents=True, exist_ok=True)
    remote = base / "remote.git"
    subprocess.run(
        ["git", "init", "--bare", "--initial-branch=main", str(remote)],
        check=True,
        capture_output=True,
    )
    repo = make_repo_with_initial_commit(
        base,
        {"README.md": "proof fixture\n"},
        name="repo",
        remote_url=str(remote),
    )
    (repo / ".gitignore").write_text(
        ".aria-state-store/\n.aria-state-store.writers.jsonl\n",
        encoding="utf-8",
    )
    _git(repo, "add", ".gitignore")
    _git(repo, "commit", "-q", "-m", "fixture: ignore restored state")
    _git(repo, "push", "-q", "origin", "HEAD:main")
    with patch.dict(
        os.environ,
        {BOOTSTRAP_ACK_ENV: state_store._repository_identity(repo)},
    ):
        store = checkout_state_store(repo)
    append_jsonl(
        tools_root(store) / "runs.jsonl",
        {"run_id": "published-proof", "status": "completed"},
        test_fixture=True,
    )
    (tools_root(store) / "runs.jsonl.lock").unlink(missing_ok=True)
    identity = canonical_identity(repo)
    snapshot = build_publishable_snapshot(
        store,
        snapshot_id="operational-proof-snapshot",
        cycle_id="operational-proof-snapshot",
        lane="test",
        repo_hash=identity,
    )
    publish_state(
        store,
        snapshot=snapshot,
        cycle_id="operational-proof-snapshot",
        repo_hash=identity,
    )
    return repo, _git(repo, "rev-parse", "HEAD")


def _completed_cycle(**kwargs):
    root = Path(kwargs["base_dir"])
    cycle_id = str(kwargs["cycle_id"])
    head = _git(Path(kwargs["workspace_root"]), "rev-parse", "HEAD")
    append_declared_jsonl(
        root / "cycles.jsonl",
        _started_cycle_row(cycle_id=cycle_id),
        expected_surface="cycles",
    )
    _complete_event(root, cycle_id, 0, git_head_sha_at_cycle=head)
    return {
        "status": "completed",
        "state_continuity": {
            "status": "ok",
            "reference_kind": "state_branch",
            "blocks_action": False,
            "recovery": None,
        },
        "discovery": {"completion_proof": {"complete": True, "fated_file_count": 1}},
        "cycle_diff": {"changed_count": 0},
        "memory": {"observations_written": 0, "beliefs_written": 0, "noop_proof": True},
        "pressure": {"pressures": []},
        "triage": {"triaged_count": 0, "decisions": []},
    }


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _build_valid_proof(base: Path) -> tuple[Path, Path, str]:
    repo, target_sha = _make_state_fixture(base)
    proof = base / "aria-operational-proof"
    proof.mkdir(parents=True)
    source_root = Path(__file__).resolve().parents[2]
    with patch("aria_kernel.preflight._git_worktree_clean", return_value=True):
        preflight = verify_workflow_preflight(
            workflow_id="aria-operational-proof",
            job_id="proof",
            profile="strict",
            workspace_root=source_root,
            allowed_write_roots=[
                str(source_root / ".aria-state-store"),
                str(source_root / ".aria-state-store.writers.jsonl"),
                str(base / "aria-state-checkout.json"),
                str(base / "aria-state-checkout.json.err"),
                str(proof),
                str(base / "aria-operational-proof-tools"),
                str(base / "aria-operational-proof-workspaces"),
            ],
            path_allowlist=[
                str(source_root / ".aria-state-store"),
                str(source_root / ".aria-state-store.writers.jsonl"),
                str(base / "aria-state-checkout.json"),
                str(base / "aria-state-checkout.json.err"),
                str(proof),
                str(base / "aria-operational-proof-tools"),
                str(base / "aria-operational-proof-workspaces"),
            ],
            external_root_allowlist=[str(base)],
            network_policy=["github_artifact", "github_git"],
            network_enforcement_evidence=(
                "canonical aria/state restore and final artifact upload"
            ),
            token_provenance="github_actions_artifact_token",
            require_github_app=False,
            dlp_mode="fail_closed",
            dlp_scan_clean=True,
            audit_reason="persist ARIA observe burn-in proof artifact",
            audit_artifact_path=proof / "workflow-preflight.json",
        )
    if not preflight.valid:
        raise AssertionError(preflight.reasons)
    initial = capture_operational_state(
        repo,
        stage="initial",
        target_sha=target_sha,
        workflow_run_id=TARGET_RUN_ID,
        workflow_run_attempt=TARGET_ATTEMPT,
    )
    _write_json(proof / "state-store-verification.json", initial)
    with (
        patch("aria_kernel.burn_in.run_enterprise_cycle", side_effect=_completed_cycle),
        patch.dict(
            os.environ,
            {
                "GITHUB_RUN_ID": TARGET_RUN_ID,
                "GITHUB_RUN_ATTEMPT": str(TARGET_ATTEMPT),
            },
        ),
    ):
        burn_output = base / "tools" / "burn-in" / "operational-proof"
        run_observe_burn_in(
            workspace_root=repo,
            workspace_base=base / "workspaces",
            base_dir=base / "tools",
            target_ref=target_sha,
            cycles=30,
            min_valid_cycles=20,
            output_dir=burn_output,
        )
    shutil.copytree(burn_output, proof, dirs_exist_ok=True)
    final = capture_operational_state(
        repo,
        stage="final",
        target_sha=target_sha,
        workflow_run_id=TARGET_RUN_ID,
        workflow_run_attempt=TARGET_ATTEMPT,
    )
    _write_json(proof / "postflight-verification.json", final)
    write_operational_proof_manifest(
        proof,
        target_sha=target_sha,
        workflow_run_id=TARGET_RUN_ID,
        workflow_run_attempt=TARGET_ATTEMPT,
    )
    return repo, proof, target_sha


class OperationalProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._fixture_tmp = tempfile.TemporaryDirectory(prefix="aria-operational-proof-valid-")
        cls.fixture_base = Path(cls._fixture_tmp.name)
        cls.fixture_repo, cls.fixture_proof, cls.target_sha = _build_valid_proof(
            cls.fixture_base
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls._fixture_tmp.cleanup()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-operational-proof-test-")
        self.tmp = Path(self._tmp.name)
        self._proof_copy_index = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _copy_proof(self) -> Path:
        self._proof_copy_index += 1
        target = self.tmp / f"proof-{self._proof_copy_index}"
        shutil.copytree(self.fixture_proof, target)
        return target

    def _verdict(self, proof: Path, **overrides):
        return verify_operational_proof_bundle(
            proof,
            expected_target_sha=overrides.get("target_sha", self.target_sha),
            expected_workflow_run_id=overrides.get("run_id", TARGET_RUN_ID),
            expected_workflow_run_attempt=overrides.get("attempt", TARGET_ATTEMPT),
        )

    def _rebind_inner_and_outer(
        self,
        proof: Path,
        mutate,
    ) -> None:
        report_path = proof / "autonomy-burn-in-report.json"
        bundle_path = proof / "evidence-bundle.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        mutate(report, bundle)
        report["evidence_bundle_hash"] = _bundle_content_hash(bundle)
        _write_json(report_path, report)
        bundle["burn_in_report_hash"] = (
            "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
        _write_json(bundle_path, bundle)

        self._rebind_outer_manifest(proof)

    def _rebind_outer_manifest(self, proof: Path) -> None:
        manifest_path = proof / "operational-proof-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for record in manifest["files"]:
            path = proof / record["path"]
            record["sha256"] = (
                "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
            )
            record["size_bytes"] = path.stat().st_size
        for field, name in (
            ("state_store_verification_hash", "state-store-verification.json"),
            ("postflight_verification_hash", "postflight-verification.json"),
            ("burn_in_report_hash", "autonomy-burn-in-report.json"),
        ):
            manifest[field] = (
                "sha256:"
                + hashlib.sha256((proof / name).read_bytes()).hexdigest()
            )
        _write_json(manifest_path, manifest)

    def _mutate_hashed_artifact_and_rebind(
        self,
        proof: Path,
        relative: str,
        mutate_artifact,
        mutate_report,
    ) -> None:
        artifact_path = proof / relative
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        mutate_artifact(artifact)
        _write_json(artifact_path, artifact)
        report_path = proof / "autonomy-burn-in-report.json"
        bundle_path = proof / "evidence-bundle.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        mutate_report(report, artifact)
        digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        report["artifact_hashes"][relative] = digest
        record = next(item for item in bundle["artifacts"] if item["path"] == relative)
        record["sha256"] = digest
        record["size_bytes"] = artifact_path.stat().st_size
        report["evidence_bundle_hash"] = _bundle_content_hash(bundle)
        _write_json(report_path, report)
        bundle["burn_in_report_hash"] = (
            "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
        _write_json(bundle_path, bundle)
        self._rebind_outer_manifest(proof)

    def _mutate_hashed_artifacts_and_rebind(
        self,
        proof: Path,
        mutations: dict[str, object],
        mutate_report,
    ) -> None:
        report_path = proof / "autonomy-burn-in-report.json"
        bundle_path = proof / "evidence-bundle.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        artifacts: dict[str, dict[str, object]] = {}
        for relative, mutate in mutations.items():
            artifact_path = proof / relative
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            mutate(artifact)
            _write_json(artifact_path, artifact)
            artifacts[relative] = artifact
            digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
            report["artifact_hashes"][relative] = digest
            record = next(
                item for item in bundle["artifacts"] if item["path"] == relative
            )
            record["sha256"] = digest
            record["size_bytes"] = artifact_path.stat().st_size
        mutate_report(report, artifacts)
        report["evidence_bundle_hash"] = _bundle_content_hash(bundle)
        _write_json(report_path, report)
        bundle["burn_in_report_hash"] = (
            "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
        _write_json(bundle_path, bundle)
        self._rebind_outer_manifest(proof)

    def _replace_hashed_artifact_bytes_and_rebind(
        self,
        proof: Path,
        relative: str,
        encoded: bytes,
        mutate_report,
    ) -> None:
        artifact_path = proof / relative
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_bytes(encoded)
        report_path = proof / "autonomy-burn-in-report.json"
        bundle_path = proof / "evidence-bundle.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        mutate_report(report)
        digest = hashlib.sha256(encoded).hexdigest()
        report["artifact_hashes"][relative] = digest
        record = next(
            (item for item in bundle["artifacts"] if item["path"] == relative),
            None,
        )
        if record is None:
            record = {"path": relative, "sha256": digest, "size_bytes": len(encoded)}
            bundle["artifacts"].append(record)
        else:
            record["sha256"] = digest
            record["size_bytes"] = len(encoded)
        report["evidence_bundle_hash"] = _bundle_content_hash(bundle)
        _write_json(report_path, report)
        bundle["burn_in_report_hash"] = (
            "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
        _write_json(bundle_path, bundle)
        self._rebind_outer_manifest(proof)

    def test_initial_capture_binds_exact_published_tip_and_writer_measurement(self) -> None:
        record = json.loads(
            (self.fixture_proof / "state-store-verification.json").read_text(encoding="utf-8")
        )
        writer = state_writer_attestation_path(open_state_store(self.fixture_repo))
        self.assertTrue(record["valid"], record["failure_classes"])
        self.assertEqual(record["source"], {"head": self.target_sha, "clean": True})
        self.assertEqual(record["state"]["reference_kind"], "state_branch")
        self.assertEqual(record["state"]["store_head"], record["state"]["remote_tip"])
        self.assertEqual(record["writer_attestation"]["size_bytes"], writer.stat().st_size)
        self.assertEqual(
            record["writer_attestation"]["sha256"],
            "sha256:" + hashlib.sha256(writer.read_bytes()).hexdigest(),
        )

    def test_initial_capture_rejects_genesis_anchor_or_unreadable_tip(self) -> None:
        base = self.tmp / "genesis"
        remote = base / "remote.git"
        base.mkdir()
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        repo = make_repo_with_initial_commit(base, {"x": "x"}, remote_url=str(remote))
        with patch.dict(os.environ, {BOOTSTRAP_ACK_ENV: state_store._repository_identity(repo)}):
            checkout_state_store(repo)
        genesis = capture_operational_state(
            repo,
            stage="initial",
            target_sha=_git(repo, "rev-parse", "HEAD"),
            workflow_run_id=TARGET_RUN_ID,
            workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertFalse(genesis["valid"])
        self.assertIn("state_reference_not_published", genesis["failure_classes"])

        repo, target = _make_state_fixture(self.tmp / "unreadable")
        remote_path = Path(_git(repo, "config", "--get", "remote.origin.url"))
        remote_path.rename(remote_path.with_suffix(".offline"))
        unreadable = capture_operational_state(
            repo,
            stage="initial",
            target_sha=target,
            workflow_run_id=TARGET_RUN_ID,
            workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertFalse(unreadable["valid"])
        self.assertIn("state_remote_tip_unreadable", unreadable["failure_classes"])

    def test_capture_rejects_dirty_source_or_store(self) -> None:
        repo, target = _make_state_fixture(self.tmp / "dirty")
        (repo / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        source_dirty = capture_operational_state(
            repo, stage="initial", target_sha=target,
            workflow_run_id=TARGET_RUN_ID, workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertIn("source_not_clean", source_dirty["failure_classes"])
        (repo / "dirty.txt").unlink()
        store = open_state_store(repo)
        (store.root / "unexpected.txt").write_text("dirty\n", encoding="utf-8")
        store_dirty = capture_operational_state(
            repo, stage="initial", target_sha=target,
            workflow_run_id=TARGET_RUN_ID, workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertIn("state_store_not_clean", store_dirty["failure_classes"])

    def test_capture_rejects_host_identity_in_restored_tools(self) -> None:
        repo, target = _make_state_fixture(self.tmp / "identity")
        identity = tools_root(open_state_store(repo)) / "repo_identity.json"
        identity.write_text("{}\n", encoding="utf-8")
        record = capture_operational_state(
            repo, stage="initial", target_sha=target,
            workflow_run_id=TARGET_RUN_ID, workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertIn("state_host_identity_present", record["failure_classes"])

    def test_capture_rejects_broken_host_identity_symlink(self) -> None:
        repo, target = _make_state_fixture(self.tmp / "broken-identity")
        identity = tools_root(open_state_store(repo)) / "repo_identity.json"
        identity.symlink_to("missing-host-identity.json")
        record = capture_operational_state(
            repo, stage="initial", target_sha=target,
            workflow_run_id=TARGET_RUN_ID, workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertIn("state_host_identity_present", record["failure_classes"])

    def test_success_manifest_binds_sha_run_attempt_and_initial_final_state(self) -> None:
        manifest = json.loads(
            (self.fixture_proof / "operational-proof-manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["status"], "passed")
        self.assertEqual(manifest["target_sha"], self.target_sha)
        self.assertEqual(manifest["workflow_run_id"], TARGET_RUN_ID)
        self.assertEqual(manifest["workflow_run_attempt"], TARGET_ATTEMPT)
        verdict = self._verdict(self.fixture_proof)
        self.assertTrue(verdict.valid, verdict.status)

    def test_success_verifier_rejects_missing_or_unexpected_file(self) -> None:
        missing = self._copy_proof()
        (missing / "cycles.json").unlink()
        self.assertFalse(self._verdict(missing).valid)
        unexpected = self._copy_proof()
        (unexpected / "unexpected.json").write_text("{}\n", encoding="utf-8")
        self.assertFalse(self._verdict(unexpected).valid)

    def test_success_verifier_rejects_symlink_or_non_regular_file(self) -> None:
        symlinked = self._copy_proof()
        target = symlinked / "cycles.json"
        target.unlink()
        target.symlink_to("cycle-ledger-summary.json")
        self.assertFalse(self._verdict(symlinked).valid)
        non_regular = self._copy_proof()
        target = non_regular / "cycles.json"
        target.unlink()
        target.mkdir()
        self.assertFalse(self._verdict(non_regular).valid)

    def test_proof_root_symlink_is_rejected(self) -> None:
        proof = self._copy_proof()
        linked = self.tmp / "linked-proof"
        linked.symlink_to(proof, target_is_directory=True)
        verdict = self._verdict(linked)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "invalid_file_world")

    def test_secure_root_rejects_dot_or_dotdot_components(self) -> None:
        safe = self.tmp / "safe-root"
        child = safe / "child"
        escape = self.tmp / "escape-root"
        child.mkdir(parents=True)
        escape.mkdir()
        for raw in (
            f"{safe}/./child",
            f"{safe}/../escape-root",
        ):
            with self.subTest(raw=raw), self.assertRaisesRegex(
                GovernanceError,
                "secure_artifact_root_path_invalid",
            ):
                with secure_directory_fd(raw):
                    pass

    def test_relative_artifact_path_rejects_dot_empty_or_nul_components(self) -> None:
        for raw in (".", "", "cycles\x00.json"):
            with self.subTest(raw=raw), self.assertRaisesRegex(
                GovernanceError,
                "secure_artifact_relative_path_invalid",
            ):
                normalized_relative_posix(raw)

    def test_proof_hardlink_to_external_inode_is_rejected(self) -> None:
        proof = self._copy_proof()
        artifact = proof / "cycles.json"
        outside = self.tmp / "external-cycles.json"
        outside.write_bytes(artifact.read_bytes())
        artifact.unlink()
        os.link(outside, artifact)
        self.assertGreater(artifact.stat().st_nlink, 1)
        self.assertFalse(self._verdict(proof).valid)

    def test_bundle_swap_between_stat_and_open_is_rejected(self) -> None:
        proof = self._copy_proof()
        target = proof / "cycles.json"
        outside = self.tmp / "outside-cycles.json"
        outside.write_bytes(target.read_bytes())
        real_lstat = os.lstat
        real_read_bytes = Path.read_bytes
        original = target.read_bytes()
        swapped = False

        def swap_after_stat(path, *args, **kwargs):
            nonlocal swapped
            result = real_lstat(path, *args, **kwargs)
            if not swapped and str(path).endswith("cycles.json"):
                target.unlink()
                target.symlink_to(outside)
                swapped = True
            return result

        def read_then_restore(path: Path) -> bytes:
            data = real_read_bytes(path)
            if path == target and path.is_symlink():
                path.unlink()
                path.write_bytes(original)
            return data

        with patch.object(
            os,
            "lstat",
            side_effect=swap_after_stat,
        ), patch.object(Path, "read_bytes", read_then_restore):
            verdict = self._verdict(proof)
        self.assertTrue(swapped)
        self.assertFalse(verdict.valid)

    def test_json_outputs_refuse_planted_symlinks(self) -> None:
        root = self.tmp / "outputs"
        root.mkdir()
        outside = self.tmp / "outside.json"
        outside.write_text("sentinel\n", encoding="utf-8")
        output = root / "postflight-verification.json"
        output.symlink_to(outside)
        with self.assertRaises(GovernanceError):
            operational_proof_module._write_json(output, {"valid": False})
        self.assertEqual(outside.read_text(encoding="utf-8"), "sentinel\n")

        proof = self._copy_proof()
        manifest = proof / "operational-proof-manifest.json"
        manifest.unlink()
        manifest.symlink_to(outside)
        with self.assertRaises(GovernanceError):
            write_operational_proof_manifest(
                proof,
                target_sha=self.target_sha,
                workflow_run_id=TARGET_RUN_ID,
                workflow_run_attempt=TARGET_ATTEMPT,
            )
        self.assertEqual(outside.read_text(encoding="utf-8"), "sentinel\n")

    def test_success_verifier_rejects_file_hash_or_size_drift(self) -> None:
        drifted = self._copy_proof()
        with (drifted / "cycles.json").open("a", encoding="utf-8") as handle:
            handle.write(" \n")
        self.assertFalse(self._verdict(drifted).valid)

    def test_success_verifier_rejects_target_sha_run_id_or_attempt_mismatch(self) -> None:
        proof = self._copy_proof()
        self.assertFalse(self._verdict(proof, target_sha="0" * 40).valid)
        self.assertFalse(self._verdict(proof, run_id="999").valid)
        self.assertFalse(self._verdict(proof, attempt=99).valid)

    def test_success_verifier_rejects_rehashed_inner_target_ref_mismatch(self) -> None:
        proof = self._copy_proof()
        self._rebind_inner_and_outer(
            proof,
            lambda report, bundle: (
                report.__setitem__("target_ref", "refs/heads/main"),
                bundle.__setitem__("target_ref", "refs/heads/main"),
            ),
        )
        verdict = self._verdict(proof)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "inner_target_ref_mismatch")

    def test_burn_in_artifact_hashes_reject_traversal_and_wrong_exact_set(self) -> None:
        for relative in ("../escaped.json", str((self.tmp / "absolute.json").resolve())):
            with self.subTest(relative=relative):
                proof = self._copy_proof()
                escaped = (
                    self.tmp / "escaped.json"
                    if relative.startswith("..")
                    else Path(relative)
                )
                escaped.write_text("outside\n", encoding="utf-8")
                digest = hashlib.sha256(escaped.read_bytes()).hexdigest()
                self._rebind_inner_and_outer(
                    proof,
                    lambda report, _bundle, key=relative, value=digest:
                    report["artifact_hashes"].__setitem__(key, value),
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_artifact_hash_path_invalid",
                ):
                    verify_burn_in_artifact_bundle(proof)

        proof = self._copy_proof()
        self._rebind_inner_and_outer(
            proof,
            lambda report, _bundle: report["artifact_hashes"].pop("cycles.json"),
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_artifact_hash_set_mismatch",
        ):
            verify_burn_in_artifact_bundle(proof)

    def test_burn_in_artifact_hash_rejects_symlink_even_with_identical_bytes(self) -> None:
        proof = self._copy_proof()
        artifact = proof / "cycles.json"
        outside = self.tmp / "identical-cycles.json"
        outside.write_bytes(artifact.read_bytes())
        artifact.unlink()
        artifact.symlink_to(outside)
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_artifact_not_regular",
        ):
            verify_burn_in_artifact_bundle(proof)

    def test_evidence_bundle_artifact_records_bind_exact_file_set_hash_and_size(self) -> None:
        mutations = (
            lambda artifacts: artifacts.pop(),
            lambda artifacts: artifacts.append(copy.deepcopy(artifacts[0])),
            lambda artifacts: artifacts[0].__setitem__("path", "."),
            lambda artifacts: artifacts[0].__setitem__("sha256", "0" * 64),
            lambda artifacts: artifacts[0].__setitem__("sha256", int("1" * 64)),
            lambda artifacts: artifacts[0].__setitem__("size_bytes", True),
            lambda artifacts: artifacts[0].__setitem__("size_bytes", artifacts[0]["size_bytes"] + 1),
        )
        for mutate in mutations:
            with self.subTest(mutation=repr(mutate)):
                proof = self._copy_proof()
                self._rebind_inner_and_outer(
                    proof,
                    lambda _report, bundle, operation=mutate: operation(bundle["artifacts"]),
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_bundle_artifact",
                ):
                    verify_burn_in_artifact_bundle(proof)

    def test_passed_burn_in_rederives_acceptance_from_cycle_status_and_evidence(self) -> None:
        proof = self._copy_proof()
        self._mutate_hashed_artifact_and_rebind(
            proof,
            "cycles.json",
            lambda artifact: artifact["cycles"][0].__setitem__("status", "failed"),
            lambda report, artifact: (
                report.__setitem__("cycles", artifact["cycles"]),
                report.__setitem__("failed_cycles", 1),
            ),
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_cycle_record_invalid",
        ):
            verify_burn_in_artifact_bundle(proof)

    def test_passed_burn_in_rederives_disallowed_and_terminal_ledger_facts(self) -> None:
        disallowed = self._copy_proof()
        fake = {"surface": "state_writer", "change": "created"}
        self._mutate_hashed_artifact_and_rebind(
            disallowed,
            "disallowed-actions.json",
            lambda artifact: artifact["deltas"].append(fake),
            lambda report, _artifact: report["disallowed_actions_observed"].append(fake),
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_disallowed_snapshot_invalid",
        ):
            verify_burn_in_artifact_bundle(disallowed)

        ledger = self._copy_proof()
        self._mutate_hashed_artifact_and_rebind(
            ledger,
            "cycle-ledger-summary.json",
            lambda artifact: artifact["terminal_cycle_ids"].pop(),
            lambda _report, _artifact: None,
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_report_acceptance_facts_mismatch",
        ):
            verify_burn_in_artifact_bundle(ledger)

        duplicate = self._copy_proof()
        self._mutate_hashed_artifact_and_rebind(
            duplicate,
            "cycle-ledger-summary.json",
            lambda artifact: artifact["terminal_cycle_ids"].append(
                artifact["terminal_cycle_ids"][0]
            ),
            lambda _report, _artifact: None,
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_report_acceptance_facts_mismatch",
        ):
            verify_burn_in_artifact_bundle(duplicate)

    def test_disallowed_and_cycle_evidence_are_cross_bound_to_manifest_tail(self) -> None:
        contradiction = self._copy_proof()

        def contradict_disallowed_world(manifest):
            aggregate = manifest["after"]["worker_dispatch"]
            record = {
                "path": "dispatch/forged.jsonl",
                "exists": True,
                "row_count": 0,
                "file_hash": "a" * 64,
                "tail_hash": None,
            }
            aggregate.update(
                {
                    "file_count": 1,
                    "row_count": 0,
                    "files": [record],
                    "aggregate_hash": _stable_hash([record]),
                }
            )
            before = manifest["before"]["worker_dispatch"]
            manifest["deltas"] = sorted(
                [
                    delta
                    for delta in manifest["deltas"]
                    if delta["surface"] != "worker_dispatch"
                ]
                + [
                    {
                        "surface": "worker_dispatch",
                        "before_hash": before["aggregate_hash"],
                        "after_hash": aggregate["aggregate_hash"],
                        "before_rows": before["row_count"],
                        "after_rows": aggregate["row_count"],
                    }
                ],
                key=lambda delta: delta["surface"],
            )

        self._mutate_hashed_artifact_and_rebind(
            contradiction,
            "manifest-tail-hashes.json",
            contradict_disallowed_world,
            lambda _report, _artifact: None,
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_disallowed_manifest_binding_mismatch",
        ):
            verify_burn_in_artifact_bundle(contradiction)

        for field, mutate in (
            (
                "tail_hash",
                lambda summary: summary.__setitem__(
                    "tail_hash", "sha256:" + "b" * 64
                ),
            ),
            (
                "global_row_count",
                lambda summary: summary.__setitem__(
                    "started_row_count", summary["started_row_count"] + 1
                ),
            ),
        ):
            with self.subTest(field=field):
                proof = self._copy_proof()
                summary = json.loads(
                    (proof / "cycle-ledger-summary.json").read_text(
                        encoding="utf-8"
                    )
                )
                manifest = json.loads(
                    (proof / "manifest-tail-hashes.json").read_text(
                        encoding="utf-8"
                    )
                )
                cycles_after = manifest["after"]["cycles"]
                self.assertEqual(len(cycles_after["files"]), 1)
                self.assertEqual(
                    summary["tail_hash"], cycles_after["files"][0]["tail_hash"]
                )
                self.assertEqual(
                    summary["started_row_count"] + summary["terminal_row_count"],
                    cycles_after["row_count"],
                )
                self._mutate_hashed_artifact_and_rebind(
                    proof,
                    "cycle-ledger-summary.json",
                    mutate,
                    lambda _report, _artifact: None,
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_cycle_ledger_manifest_binding_mismatch",
                ):
                    verify_burn_in_artifact_bundle(proof)

    def test_disallowed_snapshot_rejects_vacuous_or_malformed_rebound_worlds(self) -> None:
        mutations = (
            lambda artifact: artifact.update({"before": {}, "after": {}, "deltas": []}),
            lambda artifact: artifact["before"].update(
                {
                    key: {
                        **value,
                        "path_pattern": "wrong/*.jsonl",
                    }
                    for key, value in artifact["before"].items()
                }
            ) or artifact.__setitem__("after", copy.deepcopy(artifact["before"])),
            lambda artifact: next(iter(artifact["before"].values())).__setitem__(
                "file_count", True
            ) or artifact.__setitem__("after", copy.deepcopy(artifact["before"])),
        )
        for mutate in mutations:
            with self.subTest(mutation=repr(mutate)):
                proof = self._copy_proof()
                self._mutate_hashed_artifact_and_rebind(
                    proof,
                    "disallowed-actions.json",
                    mutate,
                    lambda report, artifact: report.__setitem__(
                        "disallowed_actions_observed", artifact["deltas"]
                    ),
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_disallowed_snapshot_invalid",
                ):
                    verify_burn_in_artifact_bundle(proof)

    def test_disallowed_snapshot_rejects_prefixed_glob_path_and_noncanonical_file_record(self) -> None:
        def install_record(artifact, *, path, file_hash, rows, tail_hash, duplicate=False):
            aggregate = artifact["before"]["worker_dispatch"]
            records = [
                {
                    "path": path,
                    "exists": True,
                    "row_count": rows,
                    "file_hash": file_hash,
                    "tail_hash": tail_hash,
                }
            ]
            if duplicate:
                records.insert(
                    0,
                    {
                        "path": "dispatch/z-last.jsonl",
                        "exists": True,
                        "row_count": 0,
                        "file_hash": "1" * 64,
                        "tail_hash": None,
                    },
                )
            aggregate.update(
                {
                    "file_count": len(records),
                    "row_count": sum(record["row_count"] for record in records),
                    "files": records,
                    "aggregate_hash": _stable_hash(records),
                }
            )
            artifact["after"] = copy.deepcopy(artifact["before"])
            artifact["deltas"] = []

        mutations = (
            lambda artifact: install_record(
                artifact,
                path="shadow/dispatch/forged.jsonl",
                file_hash="0" * 64,
                rows=0,
                tail_hash=None,
            ),
            lambda artifact: install_record(
                artifact,
                path="dispatch/forged.jsonl",
                file_hash="sha256:" + "0" * 64,
                rows=0,
                tail_hash=None,
            ),
            lambda artifact: install_record(
                artifact,
                path="dispatch/forged.jsonl",
                file_hash="0" * 64,
                rows=0,
                tail_hash="sha256:" + "0" * 64,
            ),
            lambda artifact: install_record(
                artifact,
                path="dispatch/a-first.jsonl",
                file_hash="0" * 64,
                rows=0,
                tail_hash=None,
                duplicate=True,
            ),
        )
        for mutate in mutations:
            with self.subTest(mutation=repr(mutate)):
                proof = self._copy_proof()
                self._mutate_hashed_artifact_and_rebind(
                    proof,
                    "disallowed-actions.json",
                    mutate,
                    lambda report, artifact: report.__setitem__(
                        "disallowed_actions_observed", artifact["deltas"]
                    ),
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_disallowed_snapshot_invalid",
                ):
                    verify_burn_in_artifact_bundle(proof)

    def test_passed_burn_in_rejects_malformed_cycle_and_summary_counters_even_with_noop(self) -> None:
        cycle_mutations = (
            lambda row: row["memory_evidence"].__setitem__("observations_written", -1),
            lambda row: row["pressure_evidence"].__setitem__("pressure_count", True),
            lambda row: row.__setitem__("pressure_count", "0"),
            lambda row: row["triage_evidence"].__setitem__("decision_count", -1),
            lambda row: row.__setitem__("fated_file_count", -1),
            lambda row: row.__setitem__("diff_changed_count", "0"),
        )
        for mutate in cycle_mutations:
            with self.subTest(cycle_mutation=repr(mutate)):
                proof = self._copy_proof()
                self._mutate_hashed_artifact_and_rebind(
                    proof,
                    "cycles.json",
                    lambda artifact, operation=mutate: operation(artifact["cycles"][0]),
                    lambda report, artifact: report.__setitem__(
                        "cycles", artifact["cycles"]
                    ),
                )
                with self.assertRaisesRegex(GovernanceError, "burn_in_cycle_record_invalid"):
                    verify_burn_in_artifact_bundle(proof)

        for summary, field, value in (
            ("discovery_summary", "completed_cycles", True),
            ("memory_summary", "observation_rows", -1),
            ("pressure_summary", "latest_pressure_count", "0"),
            ("finding_summary", "raw_findings_rows", False),
            ("triage_summary", "cycle_triaged_count", -1),
        ):
            with self.subTest(summary=summary, field=field):
                proof = self._copy_proof()
                self._rebind_inner_and_outer(
                    proof,
                    lambda report, _bundle, s=summary, f=field, v=value: report[s].__setitem__(f, v),
                )
                with self.assertRaisesRegex(GovernanceError, "burn_in_report_summary_invalid"):
                    verify_burn_in_artifact_bundle(proof)

        cycle_id = self._copy_proof()
        cycles_path = cycle_id / "cycles.json"
        old_id = json.loads(cycles_path.read_text(encoding="utf-8"))["cycles"][0]["cycle_id"]
        self._mutate_hashed_artifacts_and_rebind(
            cycle_id,
            {
                "cycles.json": lambda artifact: artifact["cycles"][0].__setitem__("cycle_id", 7),
                "cycle-ledger-summary.json": lambda artifact: [
                    artifact[key].__setitem__(
                        index,
                        "7",
                    )
                    for key in (
                        "attempted_cycle_ids",
                        "terminal_cycle_ids",
                        "valid_cycle_ids",
                    )
                    for index, value in enumerate(artifact[key])
                    if value == old_id
                ],
            },
            lambda report, artifacts: report.__setitem__(
                "cycles", artifacts["cycles.json"]["cycles"]
            ),
        )
        with self.assertRaisesRegex(GovernanceError, "burn_in_cycle_record_invalid"):
            verify_burn_in_artifact_bundle(cycle_id)

    def test_no_op_proof_is_derived_exactly_from_zero_work(self) -> None:
        def mutate_positive_memory(cycles_artifact):
            memory = cycles_artifact["cycles"][0]["memory_evidence"]
            memory["observations_written"] = 1
            memory["no_op_proof"] = True

        def mutate_positive_triage(cycles_artifact):
            row = cycles_artifact["cycles"][0]
            row["triaged_count"] = 1
            row["triage_evidence"]["decision_count"] = 1
            row["triage_evidence"]["no_op_proof"] = True

        for evidence, mutate_cycles, mutate_report in (
            (
                "memory_positive_true",
                mutate_positive_memory,
                lambda report, artifacts: report.__setitem__(
                    "cycles", artifacts["cycles.json"]["cycles"]
                ),
            ),
            (
                "triage_positive_true",
                mutate_positive_triage,
                lambda report, artifacts: (
                    report.__setitem__(
                        "cycles", artifacts["cycles.json"]["cycles"]
                    ),
                    report["triage_summary"].__setitem__(
                        "cycle_triaged_count", 1
                    ),
                ),
            ),
        ):
            with self.subTest(evidence=evidence):
                proof = self._copy_proof()
                self._mutate_hashed_artifacts_and_rebind(
                    proof,
                    {"cycles.json": mutate_cycles},
                    mutate_report,
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_cycle_record_invalid",
                ):
                    verify_burn_in_artifact_bundle(proof)

        for evidence, field, reason in (
            ("memory_zero_false", "memory_evidence", "memory_evidence_missing"),
            (
                "triage_zero_false",
                "triage_evidence",
                "triage_or_noop_proof_missing",
            ),
        ):
            with self.subTest(evidence=evidence):
                proof = self._copy_proof()
                cycle_id = json.loads(
                    (proof / "cycles.json").read_text(encoding="utf-8")
                )["cycles"][0]["cycle_id"]

                def mutate_cycle(cycles_artifact, *, target=field, why=reason):
                    row = cycles_artifact["cycles"][0]
                    row[target]["no_op_proof"] = False
                    row["valid_cycle"] = False
                    row["validity_reasons"] = [why]

                def mutate_ledger(summary, *, target_id=cycle_id):
                    summary["valid_cycle_ids"].remove(target_id)
                    summary["invalid_cycle_ids"] = [target_id]

                def rebind_claims(report, artifacts):
                    report["cycles"] = artifacts["cycles.json"]["cycles"]
                    report["valid_cycles"] = 29
                    report["acceptance_conditions"]["valid_cycles"] = 29

                self._mutate_hashed_artifacts_and_rebind(
                    proof,
                    {
                        "cycles.json": mutate_cycle,
                        "cycle-ledger-summary.json": mutate_ledger,
                    },
                    rebind_claims,
                )
                with self.assertRaisesRegex(
                    GovernanceError,
                    "burn_in_cycle_record_invalid",
                ):
                    verify_burn_in_artifact_bundle(proof)

    def test_every_hashed_burn_json_artifact_rejects_nested_duplicates_and_semantic_rebind(self) -> None:
        duplicate_cases = {
            "manifest-tail-hashes.json": b'{"schema_version":"aria/manifest-tail-hashes/v1","nested":{"x":1,"x":1}}\n',
            "candidate-detection.json": b'{"schema_version":"aria/candidate-detection/v1","candidate_observations":{"schema_version":"aria/candidate-observations/v1","skill_gap_candidates":[],"skill_gap_candidates":[],"agent_gap_candidates":[]}}\n',
        }
        for relative, encoded in duplicate_cases.items():
            with self.subTest(relative=relative):
                proof = self._copy_proof()
                self._replace_hashed_artifact_bytes_and_rebind(
                    proof,
                    relative,
                    encoded,
                    lambda _report: None,
                )
                with self.assertRaisesRegex(GovernanceError, "secure_artifact_json_duplicate_key"):
                    verify_burn_in_artifact_bundle(proof)

        for relative in ("manifest-tail-hashes.json", "candidate-detection.json"):
            with self.subTest(empty_semantic_artifact=relative):
                proof = self._copy_proof()
                self._replace_hashed_artifact_bytes_and_rebind(
                    proof,
                    relative,
                    b"{}\n",
                    lambda report, name=relative: (
                        report.__setitem__("candidate_observations", {})
                        if name == "candidate-detection.json"
                        else None
                    ),
                )
                with self.assertRaisesRegex(GovernanceError, "burn_in_.*_invalid"):
                    verify_burn_in_artifact_bundle(proof)

        failed_id = "burnin-observe-20990101T000000Z-999"
        nested = self._copy_proof()
        nested_bytes = (
            b'{"schema_version":"aria/burn-in-failure/v1","generated_at":"now",'
            b'"phase":"postflight","cycle_id":null,"exception_class":"Error",'
            b'"message":"failed","current_head":null,"worktree_status":null,'
            b'"details":{"x":1,"x":1}}\n'
        )
        self._replace_hashed_artifact_bytes_and_rebind(
            nested,
            "failure-report.json",
            nested_bytes,
            lambda report: (
                report.__setitem__("failure_reports", ["failure-report.json"]),
                report.__setitem__("acceptance_verdict", "failed"),
            ),
        )
        with self.assertRaisesRegex(GovernanceError, "secure_artifact_json_duplicate_key"):
            verify_burn_in_artifact_bundle(nested)

        valid_failure = {
            "schema_version": "aria/burn-in-failure/v1",
            "generated_at": "2099-01-01T00:00:00Z",
            "phase": "cycle",
            "cycle_id": failed_id,
            "exception_class": "Error",
            "message": "failed",
            "current_head": None,
            "worktree_status": None,
        }
        orphan = self._copy_proof()
        orphan_relative = f"failures/{failed_id}.json"
        self._replace_hashed_artifact_bytes_and_rebind(
            orphan,
            orphan_relative,
            (json.dumps(valid_failure, sort_keys=True) + "\n").encode(),
            lambda report: report.__setitem__("failure_reports", [orphan_relative]),
        )
        with self.assertRaisesRegex(GovernanceError, "burn_in_failure_reports_invalid"):
            verify_burn_in_artifact_bundle(orphan)

        mismatched = self._copy_proof()
        mismatched_payload = {
            **valid_failure,
            "phase": "cycle",
            "cycle_id": failed_id,
        }
        self._replace_hashed_artifact_bytes_and_rebind(
            mismatched,
            "failure-report.json",
            (json.dumps(mismatched_payload, sort_keys=True) + "\n").encode(),
            lambda report: (
                report.__setitem__("failure_reports", ["failure-report.json"]),
                report.__setitem__("acceptance_verdict", "failed"),
            ),
        )
        with self.assertRaisesRegex(GovernanceError, "burn_in_failure_report_invalid"):
            verify_burn_in_artifact_bundle(mismatched)

        duplicate = self._copy_proof()
        postflight_payload = {
            **valid_failure,
            "phase": "postflight",
            "cycle_id": None,
        }
        self._replace_hashed_artifact_bytes_and_rebind(
            duplicate,
            "failure-report.json",
            (json.dumps(postflight_payload, sort_keys=True) + "\n").encode(),
            lambda report: (
                report.__setitem__(
                    "failure_reports",
                    ["failure-report.json", "failure-report.json"],
                ),
                report.__setitem__("acceptance_verdict", "failed"),
            ),
        )
        with self.assertRaisesRegex(GovernanceError, "burn_in_failure_reports_invalid"):
            verify_burn_in_artifact_bundle(duplicate)

    def test_outer_and_inner_attempts_and_counts_reject_bool_aliases(self) -> None:
        self.assertFalse(self._verdict(self._copy_proof(), attempt=True).valid)

        state = self._copy_proof()
        state_path = state / "state-store-verification.json"
        state_record = json.loads(state_path.read_text(encoding="utf-8"))
        state_record["workflow_run_attempt"] = True
        _write_json(state_path, state_record)
        self._rebind_outer_manifest(state)
        self.assertEqual(self._verdict(state).status, "state_record_invalid")

        report = self._copy_proof()
        self._rebind_inner_and_outer(
            report,
            lambda payload, bundle: (
                payload.__setitem__("workflow_run_attempt", True),
                bundle.__setitem__("workflow_run_attempt", True),
                payload.__setitem__("cycle_attempts", True),
            ),
        )
        with self.assertRaisesRegex(GovernanceError, "burn_in_report_"):
            verify_burn_in_artifact_bundle(report)

        evidence = self._copy_proof()
        self._mutate_hashed_artifact_and_rebind(
            evidence,
            "cycles.json",
            lambda artifact: (
                artifact["cycles"][0]["memory_evidence"].__setitem__(
                    "observations_written", True
                ),
                artifact["cycles"][0]["memory_evidence"].__setitem__(
                    "beliefs_written", 0
                ),
                artifact["cycles"][0]["memory_evidence"].__setitem__(
                    "no_op_proof", False
                ),
            ),
            lambda payload, artifact: payload.__setitem__(
                "cycles", artifact["cycles"]
            ),
        )
        with self.assertRaisesRegex(
            GovernanceError,
            "burn_in_cycle_record_invalid",
        ):
            verify_burn_in_artifact_bundle(evidence)

    def test_all_attempt_bindings_reject_bool_alias_when_expected_is_one(self) -> None:
        proof = self._copy_proof()
        for relative in (
            "state-store-verification.json",
            "postflight-verification.json",
        ):
            path = proof / relative
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["workflow_run_attempt"] = True
            _write_json(path, payload)
        report_path = proof / "autonomy-burn-in-report.json"
        bundle_path = proof / "evidence-bundle.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        report["workflow_run_attempt"] = True
        bundle["workflow_run_attempt"] = True
        report["evidence_bundle_hash"] = _bundle_content_hash(bundle)
        _write_json(report_path, report)
        bundle["burn_in_report_hash"] = (
            "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
        )
        _write_json(bundle_path, bundle)
        manifest_path = proof / "operational-proof-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["workflow_run_attempt"] = True
        _write_json(manifest_path, manifest)
        self._rebind_outer_manifest(proof)
        verdict = verify_operational_proof_bundle(
            proof,
            expected_target_sha=self.target_sha,
            expected_workflow_run_id=TARGET_RUN_ID,
            expected_workflow_run_attempt=1,
        )
        self.assertFalse(verdict.valid)

    def test_nested_duplicate_json_keys_are_rejected_across_proof_artifacts(self) -> None:
        for relative, key in (
            ("state-store-verification.json", "valid"),
            ("autonomy-burn-in-report.json", "acceptance_verdict"),
            ("evidence-bundle.json", "schema_version"),
            ("cycles.json", "schema_version"),
            ("cycle-ledger-summary.json", "schema_version"),
            ("disallowed-actions.json", "schema_version"),
        ):
            with self.subTest(relative=relative):
                proof = self._copy_proof()
                path = proof / relative
                payload = json.loads(path.read_text(encoding="utf-8"))
                encoded = json.dumps(payload, sort_keys=True)
                marker = json.dumps(key) + ": "
                start = encoded.index(marker) + len(marker)
                decoder = json.JSONDecoder()
                _, length = decoder.raw_decode(encoded[start:])
                value = encoded[start:start + length]
                path.write_text(
                    encoded[:start + length]
                    + ", " + json.dumps(key) + ": " + value
                    + encoded[start + length:] + "\n",
                    encoding="utf-8",
                )
                if relative in {
                    "cycles.json", "cycle-ledger-summary.json", "disallowed-actions.json",
                }:
                    report_path = proof / "autonomy-burn-in-report.json"
                    bundle_path = proof / "evidence-bundle.json"
                    report_payload = json.loads(report_path.read_text(encoding="utf-8"))
                    bundle_payload = json.loads(bundle_path.read_text(encoding="utf-8"))
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    report_payload["artifact_hashes"][relative] = digest
                    record = next(
                        item for item in bundle_payload["artifacts"]
                        if item["path"] == relative
                    )
                    record["sha256"] = digest
                    record["size_bytes"] = path.stat().st_size
                    report_payload["evidence_bundle_hash"] = _bundle_content_hash(bundle_payload)
                    _write_json(report_path, report_payload)
                    bundle_payload["burn_in_report_hash"] = (
                        "sha256:" + hashlib.sha256(report_path.read_bytes()).hexdigest()
                    )
                    _write_json(bundle_path, bundle_payload)
                elif relative == "autonomy-burn-in-report.json":
                    bundle_path = proof / "evidence-bundle.json"
                    bundle_payload = json.loads(bundle_path.read_text(encoding="utf-8"))
                    bundle_payload["burn_in_report_hash"] = (
                        "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
                    )
                    _write_json(bundle_path, bundle_payload)
                self._rebind_outer_manifest(proof)
                self.assertFalse(self._verdict(proof).valid)

        manifest = self._copy_proof()
        manifest_path = manifest / "operational-proof-manifest.json"
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        encoded = json.dumps(payload, sort_keys=True)
        marker = '"schema_version": '
        start = encoded.index(marker) + len(marker)
        _, length = json.JSONDecoder().raw_decode(encoded[start:])
        value = encoded[start:start + length]
        manifest_path.write_text(
            encoded[:start + length]
            + ', "schema_version": ' + value
            + encoded[start + length:] + "\n",
            encoding="utf-8",
        )
        self.assertFalse(self._verdict(manifest).valid)

    def test_success_verifier_rejects_fully_rebound_invalid_workflow_preflight(self) -> None:
        for mutation in ("network", "network_type", "bool_schema", "duplicate_key"):
            with self.subTest(mutation=mutation):
                proof = self._copy_proof()
                preflight_path = proof / "workflow-preflight.json"
                preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
                if mutation == "network":
                    preflight["network_policy"] = ["github_artifact"]
                    _write_json(preflight_path, preflight)
                elif mutation == "network_type":
                    preflight["network_policy"] = [1, "github_git"]
                    _write_json(preflight_path, preflight)
                elif mutation == "bool_schema":
                    preflight["schema_version"] = True
                    _write_json(preflight_path, preflight)
                else:
                    encoded = json.dumps(preflight, sort_keys=True)
                    preflight_path.write_text(
                        encoded.replace(
                            '"valid": true',
                            '"valid": true, "valid": true',
                            1,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
                self._rebind_outer_manifest(proof)
                verdict = self._verdict(proof)
                self.assertFalse(verdict.valid)
                self.assertEqual(verdict.status, "workflow_preflight_invalid")

    def test_success_verifier_rejects_store_head_or_remote_tip_drift(self) -> None:
        proof = self._copy_proof()
        final = json.loads((proof / "postflight-verification.json").read_text())
        final["state"]["store_head"] = "0" * 40
        final["state"]["remote_tip"] = "0" * 40
        _write_json(proof / "postflight-verification.json", final)
        self._rebind_outer_manifest(proof)
        verdict = self._verdict(proof)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "state_immutability_mismatch")

    def test_success_verifier_rejects_writer_hash_or_size_drift(self) -> None:
        proof = self._copy_proof()
        final = json.loads((proof / "postflight-verification.json").read_text())
        final["writer_attestation"]["size_bytes"] += 1
        _write_json(proof / "postflight-verification.json", final)
        self._rebind_outer_manifest(proof)
        verdict = self._verdict(proof)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "state_immutability_mismatch")

    def test_success_verifier_rejects_dirty_final_source_or_store(self) -> None:
        proof = self._copy_proof()
        final = json.loads((proof / "postflight-verification.json").read_text())
        final["source"]["clean"] = False
        final["state"]["clean"] = False
        _write_json(proof / "postflight-verification.json", final)
        self._rebind_outer_manifest(proof)
        verdict = self._verdict(proof)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "state_record_invalid")

    def test_success_verifier_rejects_initial_or_final_host_identity(self) -> None:
        for name in ("state-store-verification.json", "postflight-verification.json"):
            with self.subTest(name=name):
                proof = self._copy_proof()
                record = json.loads((proof / name).read_text())
                record["state"]["host_identity_present"] = True
                _write_json(proof / name, record)
                self._rebind_outer_manifest(proof)
                verdict = self._verdict(proof)
                self.assertFalse(verdict.valid)
                self.assertEqual(verdict.status, "state_record_invalid")

    def test_success_verifier_rejects_nonpassing_inner_bundle(self) -> None:
        proof = self._copy_proof()
        self._rebind_inner_and_outer(
            proof,
            lambda report, _bundle: report.__setitem__(
                "acceptance_verdict", "failed"
            ),
        )
        verdict = self._verdict(proof)
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.status, "inner_verdict_not_passed")

    def test_final_dlp_reuses_scan_paths_for_secrets_and_rejects_a_secret(self) -> None:
        proof = self._copy_proof()
        with patch(
            "aria_kernel.operational_proof.scan_paths_for_secrets",
            return_value=[{"pattern": "fixture", "path": "x", "line": 1}],
        ) as scan:
            with self.assertRaisesRegex(GovernanceError, "operational_proof_dlp"):
                scan_operational_proof_for_secrets(proof)
        self.assertEqual(scan.call_count, 1)
        (proof / "workflow-preflight.json").write_text(
            '{"token":"ghp_abcdefghijklmnopqrstuvwxyz123456"}\n', encoding="utf-8"
        )
        with self.assertRaisesRegex(GovernanceError, "operational_proof_dlp"):
            scan_operational_proof_for_secrets(proof)

    def test_final_dlp_rejects_unexpected_regular_file(self) -> None:
        proof = self._copy_proof()
        (proof / "unexpected.txt").write_text("not secret\n", encoding="utf-8")
        with self.assertRaisesRegex(
            GovernanceError,
            "operational_proof_dlp:invalid_file_world",
        ):
            scan_operational_proof_for_secrets(proof)

    def test_final_dlp_accepts_exact_success_or_bounded_failure_world(self) -> None:
        success = self._copy_proof()
        self.assertEqual(
            {path.relative_to(success).as_posix()
             for path in scan_operational_proof_for_secrets(success)},
            set(SUCCESS_FILES),
        )

        failed = self._copy_proof()
        (failed / "cycles.json").unlink()
        _write_json(failed / "proof-failure-summary.json", {"status": "failed"})
        diagnostic = failed / "failures" / "burnin-observe-20260828T123456Z-001.json"
        diagnostic.parent.mkdir()
        _write_json(diagnostic, {"status": "failed"})
        manifest = write_operational_proof_manifest(
            failed,
            target_sha=self.target_sha,
            workflow_run_id=TARGET_RUN_ID,
            workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertEqual(manifest["status"], "failed")
        scanned = {
            path.relative_to(failed).as_posix()
            for path in scan_operational_proof_for_secrets(failed)
        }
        self.assertIn("proof-failure-summary.json", scanned)
        self.assertIn(diagnostic.relative_to(failed).as_posix(), scanned)

    def test_manifest_writer_materializes_bounded_diagnostic_for_incomplete_preburn_world(self) -> None:
        proof = self.tmp / "incomplete-preburn"
        proof.mkdir()
        _write_json(proof / "workflow-preflight.json", {"valid": True})
        manifest = write_operational_proof_manifest(
            proof,
            target_sha=self.target_sha,
            workflow_run_id=TARGET_RUN_ID,
            workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertEqual(manifest["status"], "failed")
        summary = json.loads(
            (proof / "proof-failure-summary.json").read_text(encoding="utf-8")
        )
        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["phase"], "incomplete_preburn_world")
        self.assertIn(
            "proof-failure-summary.json",
            {path.relative_to(proof).as_posix() for path in scan_operational_proof_for_secrets(proof)},
        )

    def test_failure_summary_refuses_copied_symlink_and_preserves_external_target(self) -> None:
        proof = self.tmp / "failure-summary-symlink"
        proof.mkdir()
        outside = self.tmp / "outside-failure-summary.json"
        outside.write_text("sentinel\n", encoding="utf-8")
        (proof / "proof-failure-summary.json").symlink_to(outside)
        with self.assertRaisesRegex(
            GovernanceError,
            "secure_artifact_output_not_regular",
        ):
            operational_proof_module.write_operational_proof_failure_summary(
                proof,
                phase="burn_in",
                exit_status=1,
            )
        self.assertEqual(outside.read_text(encoding="utf-8"), "sentinel\n")

    def test_failed_diagnostic_manifest_never_verifies_as_success(self) -> None:
        proof = self._copy_proof()
        (proof / "cycles.json").unlink()
        _write_json(proof / "proof-failure-summary.json", {"status": "failed"})
        manifest = write_operational_proof_manifest(
            proof, target_sha=self.target_sha, workflow_run_id=TARGET_RUN_ID,
            workflow_run_attempt=TARGET_ATTEMPT,
        )
        self.assertEqual(manifest["status"], "failed")
        self.assertFalse(self._verdict(proof).valid)

    def test_local_cli_verifies_the_same_downloaded_bundle(self) -> None:
        proof = self._copy_proof()
        proc = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel.operational_proof", "verify",
                "--proof-root", str(proof),
                "--expected-target-sha", self.target_sha,
                "--expected-workflow-run-id", TARGET_RUN_ID,
                "--expected-workflow-run-attempt", str(TARGET_ATTEMPT),
            ],
            cwd=Path(__file__).resolve().parents[2],
            env={**os.environ, "PYTHONPATH": "aria-kernel:.", "PYTHONDONTWRITEBYTECODE": "1"},
            text=True,
            capture_output=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])


if __name__ == "__main__":
    unittest.main()
