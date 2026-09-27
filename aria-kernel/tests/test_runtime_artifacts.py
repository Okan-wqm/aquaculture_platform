from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.feedback_store import raw_findings_path
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_jsonl, load_jsonl
from aria_kernel.runtime_artifacts import (
    approve_runtime_v2_promotion,
    resolve_artifact_payload,
    resolve_finding_from_artifact,
    restore_artifact,
    retention_apply,
    retention_dry_run,
    verify_artifacts,
)
from aria_kernel.tool_health import record_run, runs_path
from aria_kernel.tool_registry import ensure_tools_binding, register_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _tool() -> dict:
    return {
        "tool_id": "runtime-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/farm-service/src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/runtime-adapter",
        "health_thresholds": {"max_cost_units": 50},
        "allowed_read_globs": ["apps/farm-service/src/**/*.ts"],
        "forbidden_read_globs": ["dist/**"],
        "claim_types": ["schema_drift"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix()],
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def _run(**overrides) -> dict:
    finding = {
        "id": "finding-1",
        "rule": "runtime-test",
        "severity": "high",
        "path": "apps/farm-service/src/app.module.ts",
        "message": "runtime artifact test",
        "evidence": [{"path": "apps/farm-service/src/app.module.ts"}],
    }
    run = {
        "run_id": "run-1",
        "tool_id": "runtime-adapter",
        "cycle_id": "cycle-1",
        "status": "ok",
        "input_hash": "sha256:input",
        "output_hash": "sha256:output",
        "read_paths": ["apps/farm-service/src/app.module.ts"],
        "emitted_observations": [],
        "emitted_findings": [],
        "raw_findings": [finding],
        "evidence_validation": {"evidence_sources": ["apps/farm-service/src/app.module.ts"]},
        "operator_feedback_refs": [],
        "duration_ms": 25,
        "cost_units": 1,
        "schema_version": 1,
        "runner": {"raw_findings_count": 1, "raw_findings_sample": [finding]},
        "_runtime_artifact_payload": {
            "stdout": "{\"findings\":[]}",
            "stderr": "",
            "parsed_output": {},
            "raw_findings": [finding],
            "raw_observations": [],
        },
    }
    run.update(overrides)
    return run


_APPROVAL_EVENT = "evt-test-operator-approval"
_APPROVAL_REF = f"gov:{_APPROVAL_EVENT}"


def _record_test_approval(root) -> None:
    """Provision the governance-recorded operator approval fixtures use."""
    from aria_kernel.tool_registry import append_tools_governance

    append_tools_governance(
        root, "operator_action", {"event_id": _APPROVAL_EVENT, "action": "approve"},
    )


def _fixture_git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    ).stdout.strip()


def _tree_bytes_and_modes(root: Path) -> dict:
    """Include directory membership as well as complete ordinary fixture bytes."""
    result = {}
    for path in sorted(root.rglob("*")):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            content = None
        else:
            assert stat.S_ISREG(mode), path
            content = path.read_bytes()
        result[path.relative_to(root).as_posix()] = (stat.S_IMODE(mode), content)
    return result


@contextmanager
def _cold_runtime_fixture(case: unittest.TestCase, root: Path, *, legacy: bool):
    """Native state fixture, not an invocation of the registered tool/model."""
    from aria_kernel.ledger import load_declared_jsonl
    from aria_kernel.runtime_artifacts import verify_runtime_artifacts
    from aria_kernel.state_compact import compact_state
    from aria_kernel.tools_binding import bind_tools_root
    from aria_kernel.workspace import canonical_identity, canonical_identity_source
    from tests._helpers.hermetic_git import hermetic_git_env_is_active

    root.mkdir(parents=True)
    source = root / "source"
    tools = root / "store" / "tools"
    environment = {
        "ARIA_TOOLS_DIR": str(tools),
        "ARIA_STATE_STORE_ROOT": str(tools.parent),
        "ARIA_REPO_STATE_ROOT": str(root / "repo-state"),
        "ARIA_WORKSPACE_BASE": str(root / "workspaces"),
        "ARIA_RUN_LEDGER_FORMAT": "v2",
    }
    with mock.patch.dict(os.environ, environment):
        case.assertTrue(hermetic_git_env_is_active())
        if legacy:
            frozen = Path(__file__).parent / "fixtures" / "runtime_archive_legacy"
            manifest_bytes = (frozen / "capture-manifest.json").read_bytes()
            case.assertEqual(
                hashlib.sha256(manifest_bytes).hexdigest(),
                "011959fc331420caa0bca42432656d1bcce39132bd4300b0b4ee73d0b25c0d86",
            )
            manifest = json.loads(manifest_bytes)
            for line in (frozen / "SHA256SUMS").read_text().splitlines():
                expected, relative = line.split("  ", 1)
                case.assertEqual(hashlib.sha256((frozen / relative).read_bytes()).hexdigest(), expected)
            packaged_before = _tree_bytes_and_modes(frozen)
            _fixture_git(root, "clone", str(frozen / "source.bundle"), str(source))
            # Local bundle clone installs its own origin; the captured repository had none.
            _fixture_git(source, "remote", "remove", "origin")
            case.assertEqual(_fixture_git(source, "remote"), "")
            case.assertEqual(_fixture_git(source, "rev-parse", "HEAD"), manifest["source_commit"])
            case.assertEqual(canonical_identity_source(source), manifest["source_canonical_identity_source"])
            case.assertEqual(canonical_identity(source), manifest["source_canonical_identity"])
            shutil.copytree(frozen / "cold-tools", tools)
            for relative, details in manifest["cold_tools_inventory"]["files"].items():
                working = tools / relative
                case.assertEqual(hashlib.sha256(working.read_bytes()).hexdigest(), details["sha256"])
                working.chmod(int(details["source_mode"], 8))
                case.assertEqual(stat.S_IMODE(working.stat().st_mode), int(details["source_mode"], 8))
            # Binding refreshes host metadata; original native evidence is not migrated.
            evidence_before = {
                relative: (tools / relative).read_bytes()
                for relative in manifest["cold_tools_inventory"]["files"]
                if relative.endswith(".jsonl") and relative != "governance.jsonl"
            }
            governance_before = (tools / "governance.jsonl").read_bytes()
            bound = bind_tools_root(
                tools_dir=tools, workspace_root=source, reason="relocate genuine cold fixture",
            )
            case.assertEqual(bound["status"], "bound")
            case.assertFalse(bound["migrated"])
            case.assertTrue((tools / "governance.jsonl").read_bytes().startswith(governance_before))
            case.assertEqual(
                {relative: (tools / relative).read_bytes() for relative in evidence_before},
                evidence_before,
            )
            ref = manifest["artifact_ref"]
            original = (frozen / "original-artifact.json").read_bytes()
            archived = manifest["native_archive"]
            detail = manifest["detail"]
        else:
            source.mkdir()
            _fixture_git(source, "init", "--initial-branch=main", ".")
            _fixture_git(source, "config", "user.name", "ARIA Retention Fixture")
            _fixture_git(source, "config", "user.email", "aria-retention@example.invalid")
            _fixture_git(source, "config", "commit.gpgsign", "false")
            file = source / "apps/farm-service/src/app.module.ts"
            file.parent.mkdir(parents=True)
            file.write_text("export const fixtureValue = 1;\n", encoding="utf-8")
            _fixture_git(source, "add", file.relative_to(source).as_posix())
            _fixture_git(source, "commit", "--no-gpg-sign", "-m", "current retention fixture")
            ensure_tools_binding(tools, workspace_root=source)
            _record_test_approval(tools)
            register_tool(_tool(), base_dir=tools)
            bundle = tools / "runtime/v2-promotion-evidence.json"
            bundle.parent.mkdir(parents=True, exist_ok=True)
            bundle.write_text(json.dumps({
                "operator_approval_ref": _APPROVAL_REF,
                "target_sha": _fixture_git(source, "rev-parse", "HEAD"),
            }), encoding="utf-8")
            approve_runtime_v2_promotion(
                evidence_bundle=bundle, base_dir=tools, workspace_root=source,
                operator_approval_ref=_APPROVAL_REF,
            )
            detail = "Current native cold payload detail absent from the thin summary."
            run = _run(run_id="run-current-retention", cycle_id="cyc-20200101T000000Z-current")
            run["_runtime_artifact_payload"]["stdout"] = detail
            record_run(run, base_dir=tools)
            native_runs = load_declared_jsonl(tools / "runs.jsonl", expected_surface="runs")
            case.assertEqual(len(native_runs), 1)
            ref = native_runs[0]["artifact_ref"]
            original = (tools / ref["uri"]).read_bytes()
            case.assertEqual(
                verify_runtime_artifacts(base_dir=tools, workspace_root=source)["status"], "ok",
            )
            applied = retention_apply(
                base_dir=tools, retain_hot_cycles=0, acknowledge=True,
                workspace_root=source, reason="ordinary sequential cold fixture",
                operator_approval_ref=_APPROVAL_REF,
            )
            case.assertEqual(applied["archived_count"], 1)
            archives = load_declared_jsonl(tools / "retention/events.jsonl", expected_surface="retention_events")
            case.assertEqual(len(archives), 1)
            archived = archives[0]
            compacted = compact_state(base_dir=tools, retain_days=7, dry_run=False)
            case.assertEqual(compacted["hot_artifacts_removed"], 1)  # Removed cycle directory.
            case.assertEqual(compacted["artifact_index_rows_dropped"], 1)

        case.assertEqual(ref["sha256"], "sha256:" + hashlib.sha256(original).hexdigest())
        case.assertEqual(archived["artifact_id"], ref["artifact_id"])
        case.assertEqual(archived["original_path"], ref["uri"])
        case.assertEqual(archived["sha256"], ref["sha256"])
        case.assertFalse((tools / ref["uri"]).exists())
        case.assertEqual((tools / archived["new_path"]).read_bytes(), original)
        case.assertEqual(load_declared_jsonl(
            tools / "run-artifacts/artifact-index.jsonl", expected_surface="runtime_artifact_index",
        ), [])
        case.assertIn(detail.encode(), original)
        case.assertNotIn(detail.encode(), (tools / "runs.jsonl").read_bytes())
        native_runs = load_declared_jsonl(tools / "runs.jsonl", expected_surface="runs")
        case.assertEqual(len(native_runs), 1)
        case.assertEqual(native_runs[0]["artifact_ref"], ref)
        raw = load_declared_jsonl(tools / "raw-findings.jsonl", expected_surface="raw_findings")
        case.assertEqual(len(raw), 1)
        case.assertEqual(raw[0]["artifact_ref"], ref)
        try:
            yield {"source": source, "tools": tools, "ref": ref, "original": original,
                   "archived": archived, "raw": raw[0], "run": native_runs[0]}
        finally:
            if legacy:
                case.assertEqual(_tree_bytes_and_modes(frozen), packaged_before)


class RuntimeArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-runtime-artifacts-"))
        self.tools = self.tmp / "aria-tools"
        self.old_format = os.environ.get("ARIA_RUN_LEDGER_FORMAT")
        os.environ["ARIA_RUN_LEDGER_FORMAT"] = "v2"
        self.repo_root = Path(__file__).resolve().parents[2]
        ensure_tools_binding(self.tools, workspace_root=self.repo_root)
        _record_test_approval(self.tools)
        register_tool(_tool(), base_dir=self.tools)
        target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo_root,
            text=True,
        ).strip()
        evidence_bundle = self.tools / "runtime" / "v2-promotion-evidence.json"
        evidence_bundle.parent.mkdir(parents=True, exist_ok=True)
        evidence_bundle.write_text(
            json.dumps({"operator_approval_ref": _APPROVAL_REF, "target_sha": target_sha}),
            encoding="utf-8",
        )
        approve_runtime_v2_promotion(
            evidence_bundle=evidence_bundle,
            base_dir=self.tools,
            workspace_root=self.repo_root,
            operator_approval_ref=_APPROVAL_REF,
        )

    def tearDown(self) -> None:
        import shutil
        if self.old_format is None:
            os.environ.pop("ARIA_RUN_LEDGER_FORMAT", None)
        else:
            os.environ["ARIA_RUN_LEDGER_FORMAT"] = self.old_format
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_run_writes_artifact_backed_v2_rows(self) -> None:
        record_run(_run(), base_dir=self.tools)

        run_row = load_jsonl(runs_path(self.tools))[-1]
        self.assertEqual(run_row["schema_version"], 2)
        self.assertEqual(run_row["artifact_status"], "present")
        self.assertIsInstance(run_row["artifact_ref"], dict)
        self.assertEqual(verify_artifacts(base_dir=self.tools)["status"], "ok")

        raw_row = load_jsonl(raw_findings_path(self.tools))[-1]
        self.assertEqual(raw_row["schema_version"], 2)
        self.assertNotIn("finding", raw_row)
        self.assertEqual(raw_row["json_pointer"], "/payload/raw_findings/0")
        resolved = resolve_finding_from_artifact(raw_row, base_dir=self.tools)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["id"], "finding-1")

    def test_missing_artifact_fails_integrity(self) -> None:
        record_run(_run(), base_dir=self.tools)
        run_row = load_jsonl(runs_path(self.tools))[-1]
        artifact_path = self.tools / run_row["artifact_ref"]["uri"]
        artifact_path.unlink()

        artifact_result = verify_artifacts(base_dir=self.tools)
        self.assertEqual(artifact_result["status"], "drift")
        self.assertEqual(artifact_result["issues"][0]["code"], "run_artifact_missing")
        integrity = verify_integrity(tools_dir=self.tools)
        self.assertEqual(integrity["status"], "drift")

    def test_resolve_artifact_payload_requires_strict_v2_ref(self) -> None:
        record_run(_run(), base_dir=self.tools)
        run_row = load_jsonl(runs_path(self.tools))[-1]
        artifact_ref = dict(run_row["artifact_ref"])

        self.assertIsNotNone(resolve_artifact_payload(artifact_ref, base_dir=self.tools))
        self.assertIsNone(resolve_artifact_payload({**artifact_ref, "hash": artifact_ref["sha256"]}, base_dir=self.tools))
        self.assertIsNone(resolve_artifact_payload({**artifact_ref, "source_surface": ["runtime_artifact"]}, base_dir=self.tools))

    def test_retention_requires_acknowledge_and_restores_archive(self) -> None:
        record_run(_run(cycle_id="cycle-old"), base_dir=self.tools)
        plan = retention_dry_run(base_dir=self.tools, retain_hot_cycles=0)
        self.assertEqual(plan["candidate_count"], 1)
        with self.assertRaises(Exception):
            retention_apply(base_dir=self.tools, retain_hot_cycles=0)
        applied = retention_apply(
            base_dir=self.tools,
            retain_hot_cycles=0,
            acknowledge=True,
            workspace_root=self.repo_root,
            reason="unit-test-retention",
            operator_approval_ref=_APPROVAL_REF,
        )
        self.assertEqual(applied["archived_count"], 1)
        artifact_id = applied["archived"][0]["artifact_id"]
        restored = restore_artifact(
            base_dir=self.tools,
            artifact_ref=artifact_id,
            workspace_root=self.repo_root,
            reason="unit-test-restore",
            operator_approval_ref=_APPROVAL_REF,
        )
        self.assertEqual(restored["status"], "restored")

    def test_cold_reference_resolves_after_normal_compaction(self) -> None:
        from aria_kernel.runtime_artifacts import autonomy_output_summary, verify_runtime_artifacts

        for legacy in (False, True):
            with self.subTest(origin="legacy" if legacy else "current"):
                with _cold_runtime_fixture(self, self.tmp / str(legacy), legacy=legacy) as fixture:
                    tools, ref = fixture["tools"], fixture["ref"]
                    before = _tree_bytes_and_modes(tools)
                    original = json.loads(fixture["original"])
                    for _ in range(2):
                        payload = resolve_artifact_payload(ref, base_dir=tools)
                        self.assertIsNotNone(payload, "the complete archived payload must remain resolvable")
                        self.assertEqual(payload, original)
                        self.assertEqual(
                            resolve_finding_from_artifact(fixture["raw"], base_dir=tools),
                            original["payload"]["raw_findings"][0],
                        )
                    verification = verify_runtime_artifacts(base_dir=tools, workspace_root=fixture["source"])
                    self.assertEqual(verification["status"], "ok", verification)
                    self.assertGreater(verification["verified_artifact_count"], 0)
                    summary = autonomy_output_summary({"per_cycle": [{"cycle": {
                        "cycle_id": fixture["run"]["cycle_id"], "runtime_status": "ok",
                        "artifact_refs": [ref],
                    }}]}, base_dir=tools, workspace_root=fixture["source"])
                    self.assertEqual(summary["artifact_hash_status"], "ok")
                    self.assertNotIn("artifact_hash_drift", [row["code"] for row in summary["warnings"]])
                    self.assertFalse((tools / ref["uri"]).exists())
                    self.assertEqual(_tree_bytes_and_modes(tools), before)
                    if legacy:
                        self.assertNotIn("source_descriptor", fixture["archived"])
                    else:
                        self.assertEqual(fixture["archived"]["source_descriptor"], {
                            "schema_version": 1, "artifact_ref": ref,
                        })
                        self.assertEqual(fixture["archived"]["new_path"],
                            f".archive/runtime/{ref['sha256'].removeprefix('sha256:')}/"
                            f"{ref['artifact_id']}/tool_run.json")
                    absent = self.tmp / ("absent-legacy" if legacy else "absent-current")
                    self.assertIsNone(resolve_artifact_payload(ref, base_dir=absent))
                    self.assertFalse(absent.exists())

    def test_restore_rehydrates_after_live_index_compaction(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.runtime_artifacts import verify_runtime_artifacts

        for legacy in (False, True):
            for query_key in ("artifact_id", "uri"):
                with self.subTest(origin="legacy" if legacy else "current", query=query_key):
                    root = self.tmp / f"restore-{legacy}-{query_key}"
                    with _cold_runtime_fixture(self, root, legacy=legacy) as fixture:
                        tools, ref = fixture["tools"], fixture["ref"]
                        retained = tools / "retention/events.jsonl"
                        old_events = retained.read_bytes()
                        old_rows = load_declared_jsonl(retained, expected_surface="retention_events")
                        original_ledger_bytes = {
                            name: (tools / name).read_bytes() for name in (
                                "runs.jsonl", "raw-findings.jsonl", "run-artifacts/manifest.jsonl",
                                "run-artifacts/artifact-index.jsonl",
                            )
                        }
                        result = restore_artifact(
                            base_dir=tools, artifact_ref=ref[query_key], workspace_root=fixture["source"],
                            reason="restore ordinary cold fixture", operator_approval_ref=_APPROVAL_REF,
                        )
                        self.assertEqual(result["status"], "restored")
                        self.assertEqual(result["artifact_id"], ref["artifact_id"])
                        self.assertEqual(result["path"], ref["uri"])
                        self.assertEqual(result["sha256"], ref["sha256"])
                        self.assertEqual((tools / ref["uri"]).read_bytes(), fixture["original"])
                        self.assertEqual((tools / fixture["archived"]["new_path"]).read_bytes(), fixture["original"])
                        self.assertTrue(retained.read_bytes().startswith(old_events))
                        rows = load_declared_jsonl(retained, expected_surface="retention_events")
                        self.assertEqual(rows[:-1], old_rows)
                        self.assertEqual(rows[-1]["event"], "artifact_restored")
                        self.assertIs(rows[-1]["restored_from_archive"], True)
                        self.assertEqual(rows[-1]["artifact_id"], ref["artifact_id"])
                        self.assertEqual(rows[-1]["path"], ref["uri"])
                        self.assertEqual(rows[-1]["sha256"], ref["sha256"])
                        self.assertEqual(rows[-1].get("event_id"), result["retention_event_id"])
                        self.assertIsNone(result["retention_event_id"])
                        self.assertEqual(rows[-1]["previous_ledger_hash"], old_rows[-1]["ledger_hash"])
                        self.assertRegex(rows[-1]["ledger_hash"], r"^sha256:[0-9a-f]{64}$")
                        self.assertNotEqual(rows[-1]["ledger_hash"], old_rows[-1]["ledger_hash"])
                        self.assertEqual({key: value for key, value in rows[-1].items()
                                          if key not in {"ledger_hash", "previous_ledger_hash", "recorded_at"}}, {
                            "schema_version": 1, "event": "artifact_restored",
                            "artifact_id": ref["artifact_id"], "path": ref["uri"],
                            "sha256": ref["sha256"], "restored_from_archive": True,
                            "reason": "restore ordinary cold fixture",
                            "operator_approval_ref": _APPROVAL_REF,
                        })
                        self.assertEqual({name: (tools / name).read_bytes() for name in original_ledger_bytes}, original_ledger_bytes)
                        after_restore = _tree_bytes_and_modes(tools)
                        for _ in range(2):
                            self.assertEqual(resolve_artifact_payload(ref, base_dir=tools), json.loads(fixture["original"]))
                        verification = verify_runtime_artifacts(base_dir=tools, workspace_root=fixture["source"])
                        self.assertEqual(verification["status"], "ok", verification)
                        self.assertGreater(verification["verified_artifact_count"], 0)
                        self.assertEqual({name: (tools / name).read_bytes() for name in original_ledger_bytes}, original_ledger_bytes)
                        self.assertEqual(_tree_bytes_and_modes(tools), after_restore)

    def test_retained_version_survives_native_republication_at_same_uri(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.runtime_artifacts import (
            _resolve_artifact_bytes, verify_runtime_artifacts, write_run_artifact,
        )
        from aria_kernel.tool_registry import GovernanceError

        with _cold_runtime_fixture(self, self.tmp / "versions", legacy=False) as fixture:
            tools, first_ref = fixture["tools"], fixture["ref"]
            first_bytes = fixture["original"]
            first_payload = json.loads(first_bytes)
            retained_path = tools / fixture["archived"]["new_path"]
            history_before = {
                path.relative_to(tools).as_posix(): path.read_bytes()
                for path in tools.rglob("*.jsonl")
            }
            second_detail = dict(first_payload["payload"], stdout="Ordinary second native publication.")
            published = write_run_artifact(
                base_dir=tools, run_id=fixture["run"]["run_id"],
                cycle_uid=fixture["run"]["cycle_id"], tool_id="runtime-adapter",
                kind="tool_run", payload=second_detail, run_status="ok",
            )
            self.assertEqual(published["artifact_status"], "present")
            second_ref = published["artifact_ref"]
            self.assertEqual(second_ref["artifact_id"], first_ref["artifact_id"])
            self.assertEqual(second_ref["uri"], first_ref["uri"])
            self.assertNotEqual(second_ref["sha256"], first_ref["sha256"])
            hot_path = tools / second_ref["uri"]
            second_bytes = hot_path.read_bytes()
            self.assertEqual(second_ref["sha256"], "sha256:" + hashlib.sha256(second_bytes).hexdigest())
            self.assertEqual(json.loads(second_bytes)["payload"], second_detail)
            self.assertEqual(retained_path.read_bytes(), first_bytes)
            for relative, prefix in history_before.items():
                self.assertTrue((tools / relative).read_bytes().startswith(prefix), relative)
            created = load_declared_jsonl(
                tools / "run-artifacts/manifest.jsonl", expected_surface="runtime_artifact_manifest",
            )
            self.assertEqual(len(created), 2)
            for row, ref in zip(created, (first_ref, second_ref)):
                self.assertEqual(row["event"], "artifact_created")
                self.assertEqual(row["artifact_id"], ref["artifact_id"])
                self.assertEqual(row["current_uri"], ref["uri"])
                self.assertEqual(row["sha256"], ref["sha256"])
                self.assertEqual(row["run_id"], ref["produced_by_workflow_run_id"])
            # Republishing the artifact does not record another tool execution.
            # The real verifier below consumes A's original native run reference.
            runs = load_declared_jsonl(tools / "runs.jsonl", expected_surface="runs")
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["artifact_ref"], first_ref)

            before_reads = _tree_bytes_and_modes(tools)
            resolved_first = resolve_artifact_payload(first_ref, base_dir=tools)
            self.assertIsNotNone(resolved_first, "the exact retained version must survive a newer hot publication")
            self.assertEqual(resolved_first, first_payload)
            self.assertEqual(resolve_artifact_payload(second_ref, base_dir=tools), json.loads(second_bytes))
            for ref, expected_bytes, tier in (
                (first_ref, first_bytes, "archive"), (second_ref, second_bytes, "hot"),
            ):
                resolved = _resolve_artifact_bytes(ref, base_dir=tools, max_bytes=2 * 1024 * 1024)
                self.assertEqual(resolved["status"], "resolved", resolved)
                self.assertEqual(resolved["source_tier"], tier)
                self.assertEqual(resolved["sha256"], ref["sha256"])
                self.assertEqual(resolved["content"], expected_bytes)
            verification = verify_runtime_artifacts(base_dir=tools, workspace_root=fixture["source"])
            self.assertEqual(verification["status"], "ok", verification)
            self.assertGreater(verification["verified_artifact_count"], 0)
            self.assertEqual(_tree_bytes_and_modes(tools), before_reads)

            native_before_restore = {
                path.relative_to(tools).as_posix(): path.read_bytes()
                for path in tools.rglob("*.jsonl")
            }
            for query in (first_ref["artifact_id"], first_ref["uri"]):
                with self.assertRaisesRegex(GovernanceError, "^artifact_ambiguous:"):
                    restore_artifact(
                        base_dir=tools, artifact_ref=query, workspace_root=fixture["source"],
                        reason="ordinary ambiguous version lookup", operator_approval_ref=_APPROVAL_REF,
                    )
            self.assertEqual({
                path.relative_to(tools).as_posix(): path.read_bytes()
                for path in tools.rglob("*.jsonl")
            }, native_before_restore)
            self.assertEqual(retained_path.read_bytes(), first_bytes)
            self.assertEqual(hot_path.read_bytes(), second_bytes)

    def test_hot_payload_keeps_large_reads_and_revalidates_native_republication(self) -> None:
        from aria_kernel.runtime_artifacts import write_run_artifact

        detail = "ordinary public runtime sample " * 75000
        common = dict(base_dir=self.tools, run_id="run-hot-compatibility",
                      cycle_uid="cyc-hot-compatibility", tool_id="runtime-adapter",
                      kind="tool_run", run_status="ok")
        first = write_run_artifact(**common, payload={"detail": detail, "revision": "one"})
        self.assertEqual(first["artifact_status"], "present")
        ref = first["artifact_ref"]
        target = self.tools / ref["uri"]
        raw = target.read_bytes()
        self.assertGreater(len(raw), 2 * 1024 * 1024)
        self.assertEqual(ref["sha256"], "sha256:" + hashlib.sha256(raw).hexdigest())
        expected = json.loads(raw)
        reads = []
        real_open = Path.open

        def observed_open(path, *args, **kwargs):
            if path == target:
                reads.append((args, kwargs))
            return real_open(path, *args, **kwargs)

        with mock.patch.object(Path, "open", new=observed_open):
            for _ in range(3):
                resolved = resolve_artifact_payload(ref, base_dir=self.tools)
                self.assertIsNotNone(resolved, "the public hot reader must preserve existing large-artifact admission")
                self.assertEqual(resolved, expected)
        self.assertEqual(len(reads), 1, "unchanged public hot payload must not be reread for every sample")
        self.assertEqual(target.read_bytes(), raw)

        # A second legitimate publication replaces the native file; no ledger
        # or envelope is rewritten by the test. The old ref must not hit stale cache.
        second = write_run_artifact(**common, payload={"detail": detail, "revision": "two"})
        self.assertEqual(second["artifact_status"], "present")
        self.assertEqual(second["artifact_ref"]["uri"], ref["uri"])
        self.assertNotEqual(second["artifact_ref"]["sha256"], ref["sha256"])
        self.assertIsNone(resolve_artifact_payload(ref, base_dir=self.tools))
        current = resolve_artifact_payload(second["artifact_ref"], base_dir=self.tools)
        self.assertEqual(current["payload"], {"detail": detail, "revision": "two"})



class AutonomySummaryDerivedCountersTests(unittest.TestCase):
    """ORPHAN-HIGH-424 — the operator-facing counters must be derived.

    ``incomplete_lifecycle_count`` was pinned to 0 in ``cycle.py`` and then
    summed here, and ``warning_count``/``suppressed_count``/
    ``truncated_count`` were locals initialised to 0 that nothing ever
    incremented. Four fields reached the operator incapable of being
    non-zero, which is how a run could report ``overall_status: ok`` with
    ``warning_count: 0`` on top of an abandoned cycle. No test covered
    this function before, which is how the pinned zeros survived.
    """

    def setUp(self) -> None:
        # autonomy_output_summary now RE-HASHES every artifact ref, so the
        # tests need a real store root rather than a bare dict.
        self._store = tempfile.TemporaryDirectory()
        self.addCleanup(self._store.cleanup)
        self.base_dir = Path(self._store.name)

    def _summary(self, result: dict, **kwargs: object) -> dict:
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        return autonomy_output_summary(result, base_dir=self.base_dir, **kwargs)

    @staticmethod
    def _result(**cycle_overrides: object) -> dict:
        cycle: dict = {
            "cycle_id": "cyc-1",
            "runtime_status": "ok",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {"valid": True, "incomplete_count": 0},
            "tool_run_summary": [{"tool_id": "t", "status": "ok"}],
        }
        cycle.update(cycle_overrides)
        return {"per_cycle": [{"cycle": cycle}]}

    def test_clean_cycle_reports_no_warnings(self) -> None:
        summary = self._summary(self._result())
        self.assertEqual(summary["overall_status"], "ok")
        self.assertEqual(summary["warning_count"], 0)
        self.assertEqual(summary["warnings"], [])
        self.assertEqual(summary["incomplete_lifecycle_count"], 0)

    def test_abandoned_cycle_surfaces_in_count_and_warnings(self) -> None:
        summary = self._summary(self._result(
            incomplete_lifecycle_count=2,
            cycle_lifecycle={"valid": False, "incomplete_count": 2},
        ))
        self.assertEqual(summary["incomplete_lifecycle_count"], 2)
        self.assertGreaterEqual(summary["warning_count"], 1)
        self.assertIn(
            "incomplete_cycle_lifecycle",
            [w["code"] for w in summary["warnings"]],
        )

    def test_unreadable_cycle_ledger_is_its_own_warning(self) -> None:
        """A 0 count with valid=False must not read as "no incomplete cycles"."""
        summary = self._summary(self._result(
            cycle_lifecycle={
                "valid": False,
                "incomplete_count": 0,
                "ledger_integrity_error": "Invalid JSONL at cycles.jsonl:7",
            },
        ))
        self.assertEqual(summary["incomplete_lifecycle_count"], 0)
        codes = [w["code"] for w in summary["warnings"]]
        self.assertIn("cycle_lifecycle_unreadable", codes)

    def _write_artifact(self, relative_uri: str, body: bytes) -> str:
        target = self.base_dir / relative_uri
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        return "sha256:" + hashlib.sha256(body).hexdigest()

    @staticmethod
    def _ref(uri: str, sha256: str) -> dict:
        return {
            "schema_version": 2,
            "artifact_id": "cyc-1.run-1.tool_run",
            "uri": uri,
            "sha256": sha256,
            "content_type": "application/json",
            "produced_by_workflow_run_id": "run-1",
            "source_surface": "runtime_artifact",
        }

    def test_a_matching_artifact_is_not_drift(self) -> None:
        """ORPHAN-HIGH-800 — the verdict used to read `verification_status`,
        a key no writer in the kernel sets, so EVERY cycle with an artifact
        reported drift. A ref whose stored bytes hash to its recorded sha256
        is not an anomaly and must not warn."""
        uri = "run-artifacts/hot/cyc-1/run-1/tool_run.json"
        digest = self._write_artifact(uri, b'{"tool_id": "t"}')
        summary = self._summary(self._result(artifact_refs=[self._ref(uri, digest)]))
        self.assertEqual(summary["artifact_hash_status"], "ok")
        self.assertEqual(summary["warning_count"], 0)

    def test_a_tampered_artifact_is_drift_and_is_named(self) -> None:
        uri = "run-artifacts/hot/cyc-1/run-1/tool_run.json"
        self._write_artifact(uri, b'{"tool_id": "t"}')
        stale = "sha256:" + hashlib.sha256(b"what the ref remembers").hexdigest()
        summary = self._summary(self._result(artifact_refs=[self._ref(uri, stale)]))
        self.assertEqual(summary["artifact_hash_status"], "drift")
        warning = next(w for w in summary["warnings"] if w["code"] == "artifact_hash_drift")
        self.assertEqual(warning["issue_count"], 1)
        self.assertEqual(warning["issues"][0]["code"], "artifact_hash_mismatch")
        self.assertEqual(warning["issues"][0]["path"], uri)

    def test_a_missing_artifact_is_drift(self) -> None:
        uri = "run-artifacts/hot/cyc-1/run-1/absent.json"
        digest = "sha256:" + hashlib.sha256(b"never written").hexdigest()
        summary = self._summary(self._result(artifact_refs=[self._ref(uri, digest)]))
        self.assertEqual(summary["artifact_hash_status"], "drift")
        codes = [i["code"] for w in summary["warnings"] if w["code"] == "artifact_hash_drift" for i in w["issues"]]
        self.assertEqual(codes, ["artifact_ref_missing"])

    def test_budget_projection_derives_utilisation_once(self) -> None:
        """ORPHAN-HIGH-801 — the ratio is derived at write time so every
        reader sees the same number instead of recomputing it."""
        from aria_kernel.runtime_artifacts import budget_projection

        self.assertEqual(
            budget_projection({"duration_ms": 90000, "timeout_ms": 180000}),
            {"duration_ms": 90000, "timeout_ms": 180000, "budget_utilisation": 0.5},
        )
        # A run with no budget recorded reports no ratio rather than a fake one.
        self.assertIsNone(budget_projection({"duration_ms": 90000})["budget_utilisation"])
        self.assertIsNone(
            budget_projection({"duration_ms": 5, "timeout_ms": 0})["budget_utilisation"],
        )

    def test_a_run_close_to_its_budget_is_announced(self) -> None:
        """The night BEFORE the timeout, not the morning after."""
        summary = self._summary(self._result(tool_run_summary=[{
            "tool_id": "test-gap-adapter",
            "status": "ok",
            "duration_ms": 174000,
            "timeout_ms": 180000,
            "budget_utilisation": 0.9667,
        }]))
        # A run that finished, finished: pressure never changes the status.
        self.assertEqual(summary["overall_status"], "ok")
        pressure = next(w for w in summary["warnings"] if w["code"] == "tool_budget_pressure")
        self.assertEqual(pressure["tool_count"], 1)
        self.assertEqual(pressure["tools"][0]["tool_id"], "test-gap-adapter")
        self.assertEqual(pressure["tools"][0]["duration_ms"], 174000)

    def test_a_run_with_headroom_is_not_announced(self) -> None:
        summary = self._summary(self._result(tool_run_summary=[{
            "tool_id": "doc-staleness-adapter",
            "status": "ok",
            "duration_ms": 18000,
            "timeout_ms": 180000,
            "budget_utilisation": 0.1,
        }]))
        self.assertEqual(summary["warning_count"], 0)

    def test_absent_refs_are_not_an_anomaly(self) -> None:
        summary = self._summary(self._result())
        self.assertEqual(summary["artifact_hash_status"], "none")
        self.assertEqual(summary["warning_count"], 0)

    def test_suppressed_and_truncated_markers_are_summed(self) -> None:
        summary = self._summary(self._result(
            findings_suppressed=4,
            tool_run_summary=[
                {"tool_id": "t", "status": "ok", "prompt_truncated": True},
                {"tool_id": "u", "status": "ok", "truncated_count": 3},
            ],
        ))
        self.assertEqual(summary["suppressed_count"], 4)
        # True counts as one truncation, plus the reported 3.
        self.assertEqual(summary["truncated_count"], 4)


class CycleLifecycleStatusTests(unittest.TestCase):
    """ORPHAN-HIGH-424 — the count cycle.py reports must be real."""

    def test_started_without_terminal_is_counted(self) -> None:
        from aria_kernel.integrity import cycle_lifecycle_status

        with tempfile.TemporaryDirectory(prefix="aria-lifecycle-") as tmp:
            base = Path(tmp) / "aria-tools"
            base.mkdir(parents=True, exist_ok=True)
            cycles = base / "cycles.jsonl"
            append_jsonl(cycles, {"cycle_id": "cyc-open", "event": "started", "at": "2026-07-01T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-done", "event": "started", "at": "2026-07-02T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-done", "event": "completed", "at": "2026-07-02T00:05:00Z"})
            status = cycle_lifecycle_status(base)
            self.assertFalse(status["valid"])
            self.assertEqual(status["incomplete_count"], 1)
            self.assertEqual(
                [row["cycle_id"] for row in status["incomplete_cycles"]], ["cyc-open"],
            )

    def test_all_terminal_is_valid(self) -> None:
        from aria_kernel.integrity import cycle_lifecycle_status

        with tempfile.TemporaryDirectory(prefix="aria-lifecycle-ok-") as tmp:
            base = Path(tmp) / "aria-tools"
            base.mkdir(parents=True, exist_ok=True)
            cycles = base / "cycles.jsonl"
            append_jsonl(cycles, {"cycle_id": "cyc-1", "event": "started", "at": "2026-07-02T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-1", "event": "failed", "at": "2026-07-02T00:05:00Z"})
            status = cycle_lifecycle_status(base)
            self.assertTrue(status["valid"])
            self.assertEqual(status["incomplete_count"], 0)


class MemoryLearningSummaryTests(unittest.TestCase):
    """Public reporting distinguishes receipts from batch and merge outcomes."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def _summary(self, *cycles: dict, **result_fields: object) -> dict:
        from aria_kernel.runtime_artifacts import autonomy_output_summary
        return autonomy_output_summary(
            {"per_cycle": list(cycles), **result_fields}, base_dir=self.base,
        )

    @staticmethod
    def _pending(**overrides: object) -> dict:
        return {
            "cycle_id": "discovery", "convergence": {"plan_id": "reviewed-plan"},
            "memory_hook": {
                "status": "needs_signing", "convention_recorded": False,
                "chain_verified": None, "plan_revision_id": "rev-original",
                "plan_content_hash": "sha256:" + "1" * 64,
            },
            "memory_completion": {"status": "not_attempted"}, **overrides,
        }

    def test_missing_and_noop_inputs_are_not_successful_empty_memory(self) -> None:
        self.assertNotIn("memory_learning", self._summary({"cycle_id": "legacy"}))
        projection = self._summary({
            "cycle_id": "noop", "memory_hook": {"status": "no_op_memory_hook", "convention_recorded": False},
        }, {"cycle_id": "missing"})["memory_learning"]
        noop, missing = projection["cycles"]
        self.assertEqual(noop["initial"]["status"], "no_op_memory_hook")
        self.assertEqual(noop["completion"]["input_status"], "missing")
        self.assertEqual(missing["initial"]["input_status"], "missing")
        self.assertIsNone(missing["initial"]["convention_recorded"])

    def test_initial_identity_uses_supplied_plan_and_never_signer_cycle(self) -> None:
        cycle = self._pending(memory_completion={"status": "completed", "attempted": 1, "observations": [{
            "cycle_id": "older-discovery", "signer_cycle_id": "discovery",
            "plan_id": "older-plan", "plan_revision_id": "older-revision",
            "plan_content_hash": "sha256:" + "2" * 64, "status": "memory_hook_recorded",
            "convention_recorded": True, "chain_verified": True, "append_attempted": True,
        }]})
        receipt = self._summary(cycle)["memory_learning"]["cycles"][0]
        self.assertEqual(receipt["initial"]["plan_id"], "reviewed-plan")
        self.assertEqual(receipt["initial"]["cycle_id"], "discovery")
        observation = receipt["completion"]["observations"][0]
        self.assertEqual(observation["cycle_id"], "older-discovery")
        self.assertEqual(observation["signer_cycle_id"], "discovery")
        missing = self._summary(self._pending(convergence={}))
        self.assertIsNone(missing["memory_learning"]["cycles"][0]["initial"]["plan_id"])

    def test_completed_batch_keeps_individual_failure_and_recorded_audit_truth(self) -> None:
        cycle = self._pending(memory_completion={
            "status": "completed", "attempted": 2, "already_recorded": 1,
            "observations": [
                {"status": "convention_record_failed", "convention_recorded": False,
                 "chain_verified": None, "error_class": "OSError"},
                {"status": "convention_audit_failed", "convention_recorded": True,
                 "chain_verified": None, "error_class": "OSError", "audit_error_class": "OSError"},
                {"status": "already_recorded", "convention_recorded": True,
                 "chain_verified": True, "append_attempted": False},
            ],
        })
        summary = self._summary(cycle)
        projection = summary["memory_learning"]
        self.assertEqual(projection["completion_status_counts"], {"completed": 1})
        self.assertEqual(projection["reported_observation_counts"], {
            "items": 3, "recorded_receipts": 2, "already_recorded_receipts": 1,
            "item_errors": 2, "audit_errors": 1, "unverified_recorded_receipts": 1,
        })
        self.assertEqual(projection["cycles"][0]["completion"]["attempted"], 2)
        self.assertEqual(summary["overall_status"], "ok")
        self.assertEqual(summary["error_count"], 0)

    def test_present_but_unavailable_input_does_not_invent_zero_attempts(self) -> None:
        receipt = self._summary({"cycle_id": "cyc", "memory_hook": None,
                                 "memory_completion": {"status": "callback_error", "error_class": "OSError"}})["memory_learning"]["cycles"][0]
        self.assertEqual(receipt["initial"]["input_status"], "unavailable")
        self.assertIsNone(receipt["completion"]["attempted"])
        self.assertEqual(receipt["completion"]["error_class"], "OSError")

    def test_projection_bounds_details_but_counts_supplied_receipts(self) -> None:
        cycles = [self._pending(cycle_id=f"cyc-{i}", memory_completion={
            "status": "completed", "attempted": 0, "already_recorded": 20,
            "observations": [{"status": "already_recorded", "convention_recorded": True,
                              "chain_verified": True, "cycle_id": f"origin-{j}"} for j in range(20)],
            "private_path": "/fixture/do-not-publish", "error_message": "do-not-publish",
        }) for i in range(10)]
        projection = self._summary(*cycles)["memory_learning"]
        self.assertEqual(projection["input_cycle_count"], 10)
        self.assertEqual(projection["reported_observation_counts"]["items"], 200)
        self.assertLessEqual(len(projection["cycles"]), 4)
        retained = sum(len(c["completion"]["observations"]) for c in projection["cycles"])
        self.assertLessEqual(retained, 8)
        self.assertEqual(projection["omitted_observation_count"], 200 - retained)
        encoded = json.dumps(projection, indent=2, sort_keys=True)
        self.assertLessEqual(len(encoded.encode()), 8 * 1024)
        self.assertNotIn("do-not-publish", encoded)
        self.assertTrue(projection["truncated"])

    def test_near_ceiling_summary_drops_receipts_without_losing_counts(self) -> None:
        from aria_kernel.runtime_artifacts import SUMMARY_STDOUT_MAX_BYTES
        legacy = self._summary(exit_reason="")
        padding = SUMMARY_STDOUT_MAX_BYTES - len(json.dumps(legacy, indent=2, sort_keys=True).encode()) - 1000
        summary = self._summary(self._pending(), exit_reason="x" * padding)
        self.assertLessEqual(len(json.dumps(summary, indent=2, sort_keys=True).encode()), SUMMARY_STDOUT_MAX_BYTES)
        projection = summary["memory_learning"]
        self.assertEqual(projection["initial_status_counts"], {"needs_signing": 1})
        self.assertTrue(projection["truncated"])

    def test_global_observation_budget_keeps_later_errors_before_replays(self) -> None:
        def receipt(name: str, failed: bool) -> dict:
            return {"cycle_id": name, "status": "convention_record_failed" if failed else "already_recorded",
                    "error_class": "OSError" if failed else None,
                    "convention_recorded": not failed, "chain_verified": None if failed else True}

        early = [receipt("early-error", True), *[receipt(f"replay-{i}", False) for i in range(7)]]
        later = [receipt(f"later-error-{i}", True) for i in range(8)]
        cycles = [self._pending(cycle_id=name, memory_completion={"status": "completed", "observations": rows})
                  for name, rows in (("early", early), ("later", later))]
        projection = self._summary(*cycles)["memory_learning"]
        retained = [row for cycle in projection["cycles"] for row in cycle["completion"]["observations"]]
        self.assertTrue(retained)
        self.assertTrue(all(row["status"] == "convention_record_failed" for row in retained))
        self.assertIn("later-error-0", [row["cycle_id"] for row in retained])
        self.assertEqual(projection["reported_observation_counts"]["items"], 16)
        self.assertEqual(projection["reported_observation_counts"]["item_errors"], 9)
        self.assertEqual(projection["omitted_observation_count"], 16 - len(retained))
        self.assertEqual(projection, self._summary(*cycles)["memory_learning"])

    def test_byte_trimming_keeps_later_errors_before_earlier_replays(self) -> None:
        def receipt(name: str, failed: bool) -> dict:
            return {"cycle_id": name, "status": "convention_record_failed" if failed else "already_recorded",
                    "error_class": "OSError" if failed else None,
                    "plan_id": "plan-" + "x" * 395, "plan_revision_id": "revision-" + "y" * 390,
                    "pending_event_hash": "sha256:" + "a" * 64,
                    "convention_recorded": not failed, "chain_verified": None if failed else True}

        cycles = [self._pending(cycle_id="early", memory_completion={"status": "completed", "observations": [
            receipt("early-error", True), receipt("replay-1", False), receipt("replay-2", False),
        ]}), self._pending(cycle_id="later", memory_completion={"status": "completed", "observations": [
            receipt("later-error", True),
        ]})]
        projection = self._summary(*cycles)["memory_learning"]
        retained = [row for cycle in projection["cycles"] for row in cycle["completion"]["observations"]]
        self.assertTrue(projection["truncated"])
        self.assertIn("later-error", [row["cycle_id"] for row in retained])
        self.assertIn("early-error", [row["cycle_id"] for row in retained])
        self.assertEqual(projection["omitted_observation_count"], 4 - len(retained))
        self.assertEqual(projection["reported_observation_counts"]["item_errors"], 2)
        self.assertLessEqual(len(json.dumps(projection, indent=2, sort_keys=True).encode()), 8192)

    def test_overlong_identity_has_explicit_omission_without_false_linkage(self) -> None:
        cycle = self._pending(cycle_id="cycle-" + "x" * 600,
            memory_hook={"status": "needs_signing", "plan_id": "original-" + "p" * 600},
            memory_completion={"status": "completed", "observations": [{
                "status": "already_recorded", "plan_id": "plan-" + "q" * 600,
                "plan_content_hash": "sha256:" + "a" * 64,
            }]})
        displayed = self._summary(cycle)["memory_learning"]["cycles"][0]
        self.assertEqual(displayed.get("identity_omissions"), {"cycle_id": "display_length_exceeded"})
        self.assertIsNone(displayed["initial"]["plan_id"])
        self.assertEqual(displayed["initial"]["identity_omissions"], {
            "cycle_id": "display_length_exceeded", "plan_id": "display_length_exceeded",
        })
        receipt = displayed["completion"]["observations"][0]
        self.assertIsNone(receipt["plan_id"])
        self.assertEqual(receipt["identity_omissions"], {"plan_id": "display_length_exceeded"})
        self.assertEqual(receipt["plan_content_hash"], "sha256:" + "a" * 64)
        self.assertIsNone(receipt["plan_revision_id"])
        self.assertNotIn("plan_revision_id", receipt["identity_omissions"])

    def test_equal_receipt_priority_keeps_original_source_order(self) -> None:
        def replay(name: str) -> dict:
            return {"cycle_id": name, "status": "already_recorded",
                    "convention_recorded": True, "chain_verified": True}

        early = self._pending(cycle_id="early", memory_completion={"status": "completed", "observations": [
            replay(f"early-{i}") for i in range(8)
        ]})
        later = self._pending(cycle_id="later", memory_completion={"status": "completed", "observations": [
            {"cycle_id": "later-error", "status": "convention_record_failed", "error_class": "OSError"},
            *[replay(f"later-{i}") for i in range(7)],
        ]})
        projection = self._summary(early, later)["memory_learning"]
        retained = [row for cycle in projection["cycles"] for row in cycle["completion"]["observations"]]
        self.assertIn("later-error", [row["cycle_id"] for row in retained])
        replays = [row["cycle_id"] for row in retained if row["status"] == "already_recorded"]
        self.assertTrue(replays)
        self.assertEqual(replays, [f"early-{i}" for i in range(len(replays))])
        self.assertEqual(projection["omitted_observation_count"], 16 - len(retained))


if __name__ == "__main__":
    unittest.main()
