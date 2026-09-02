"""Wave 1 §2.2 — the state snapshot's continuity properties.

The defect this closes has no per-file symptom: every ledger already
carries a hash chain, so a tree that lost an entire surface — or every
surface, which is what a lost 30-day CI artifact does — still verifies
file by file. Only a root ABOVE the files can tell "fresh bootstrap"
from "amnesia", so these tests are written against that root rather than
against any one surface.

WHAT IS ASSERTED HERE, and why each one is not obvious:

  1. storage policy IS the manifest's ``state_class`` — no second
     inventory, and an unclassified class is an error rather than a
     silent omission (the way surfaces go missing);
  2. ``manifest_root`` reacts to content, and the predecessor links are
     INSIDE the hashed payload, so a forged continuous history cannot be
     assembled from otherwise genuine snapshots;
  3. a lost surface is reported as lost — the property no per-file check
     can produce;
  4. an amnesic tree does NOT reproduce its predecessor's root, which is
     what makes "we lost everything" detectable at all;
  5. signing REFUSES when its tooling is absent instead of emitting an
     unsigned manifest that reads as signed (checked without needing
     ssh-keygen present, because the refusal is the load-bearing part);
  6. real sign→verify→tamper round-trip, skipped only where the binary
     is genuinely missing (CI runs it).
"""

from __future__ import annotations

from dataclasses import replace
import errno
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import aria_kernel.state_snapshot as state_snapshot_module
import aria_kernel.ledger as ledger_module
from aria_kernel.state_manifest import iter_surfaces
from aria_kernel.state_snapshot import (
    SIGNATURE_NAMESPACE,
    STORAGE_POLICY,
    SnapshotError,
    build_snapshot,
    compute_manifest_root,
    sign_snapshot,
    snapshot_continuity,
    validate_snapshot_manifest,
    verify_manifest_root,
    verify_snapshot_signature,
)
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

HAS_SSH_KEYGEN = shutil.which("ssh-keygen") is not None


class SnapshotPolicyTests(unittest.TestCase):
    def test_every_declared_state_class_has_a_storage_policy(self) -> None:
        """An unclassified class must not fall out of the snapshot quietly."""
        declared = {surface.state_class for surface in iter_surfaces()}
        self.assertEqual(
            declared - set(STORAGE_POLICY), set(),
            "a state_class exists that the snapshot has no policy for — it would "
            "be silently absent from every snapshot",
        )

    def test_locks_are_excluded_and_artifacts_are_pinned_not_carried(self) -> None:
        self.assertEqual(STORAGE_POLICY["lock"], "excluded")
        self.assertEqual(STORAGE_POLICY["artifact"], "artifact_only")
        for carried in ("ledger", "index", "runtime_state"):
            with self.subTest(state_class=carried):
                self.assertEqual(STORAGE_POLICY[carried], "carried")


class SnapshotBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-snap-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        append_declared_fixture(
            self.tools / "memory" / "beliefs.jsonl",
            {"schema_version": 1, "belief_id": "B-snap"},
            expected_surface="memory_beliefs",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _build(self, **kwargs):
        params = {
            "snapshot_id": "snap-001",
            "cycle_id": "cyc-snap",
            "lane": "test",
            "roots": {"tools": self.tools},
        }
        params.update(kwargs)
        return build_snapshot(**params)

    def _surface(self, name: str):
        return next(surface for surface in iter_surfaces() if surface.name == name)

    def test_a_snapshot_records_present_surfaces_with_chain_tips(self) -> None:
        manifest = self._build()
        self.assertEqual(manifest["$schema"], "aria/state-snapshot/v1")
        beliefs = manifest["surfaces"]["memory_beliefs"]
        self.assertEqual(beliefs["storage"], "carried")
        self.assertEqual(beliefs["row_count"], 1)
        self.assertTrue(beliefs["tail_ledger_hash"].startswith("sha256:"))
        self.assertEqual(beliefs["segments"], ["memory/beliefs.jsonl"])
        self.assertTrue(verify_manifest_root(manifest))

    def test_snapshot_json_budget_uses_exact_written_bytes(self) -> None:
        limit = 4 * 1024 * 1024
        baseline = self._build(lane="x")
        baseline_bytes = (
            state_snapshot_module.canonical_json(baseline) + "\n"
        ).encode("utf-8")
        exact_lane = "x" + ("p" * (limit - len(baseline_bytes)))

        exact = self._build(lane=exact_lane)
        exact_bytes = (
            state_snapshot_module.canonical_json(exact) + "\n"
        ).encode("utf-8")
        self.assertEqual(len(exact_bytes), limit)

        with self.assertRaisesRegex(
            SnapshotError,
            "state_snapshot_json_too_large",
        ):
            self._build(lane=exact_lane + "p")
        self.assertEqual(
            state_snapshot_module.MAX_SNAPSHOT_JSON_BYTES,
            limit,
        )

    def test_a_broken_chain_is_rejected_instead_of_snapshotted(self) -> None:
        path = self.tools / "memory" / "beliefs.jsonl"
        path.write_text(
            path.read_text(encoding="utf-8").replace("B-snap", "B-forged"),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(SnapshotError, "snapshot_ledger_invalid"):
            self._build()

    def test_matching_symlink_directory_and_fifo_are_rejected_not_omitted(self) -> None:
        path = self.tools / "memory" / "beliefs.jsonl"
        original = path.read_bytes()
        path.unlink()
        external = self.tmp / "external.jsonl"
        external.write_bytes(original)
        path.symlink_to(external)
        with self.assertRaisesRegex(SnapshotError, "snapshot_surface_not_regular"):
            self._build()

        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(SnapshotError, "snapshot_surface_not_regular"):
            self._build()

        path.rmdir()
        if os.name == "posix":
            os.mkfifo(path)
            with self.assertRaisesRegex(SnapshotError, "snapshot_surface_not_regular"):
                self._build()

    def test_glob_surface_nonregular_match_is_rejected(self) -> None:
        path = self.tools / "dispatch" / "not-a-ledger.jsonl"
        path.mkdir(parents=True)
        with self.assertRaisesRegex(SnapshotError, "snapshot_surface_not_regular"):
            self._build()

    def test_glob_snapshot_binds_replay_transport_to_concrete_path(self) -> None:
        august = "cost-attribution/2026-08.jsonl"
        september = "cost-attribution/2026-09.jsonl"
        payload = {"schema_version": 1, "event": "cost_observed"}
        append_declared_fixture(
            self.tools / september,
            ledger_module._make_replay_transport_row(
                payload,
                expected_surface="cost_attribution",
                surface_instance=august,
                producer_event_id=ledger_module._record_hash(payload, None),
                producer_previous_ledger_hash=None,
                replay_transaction_id="snapshot-producer-instance-binding",
            ),
            expected_surface="cost_attribution",
        )

        with mock.patch.object(
            ledger_module,
            "_surface_instance_for_path",
            return_value=None,
        ), self.assertRaisesRegex(SnapshotError, "snapshot_ledger_invalid"):
            self._build()

    def test_glob_parent_symlink_is_rejected_before_external_discovery_or_read(self) -> None:
        source = self.tools / "memory" / "beliefs.jsonl"
        external = self.tmp / "external-ledgers"
        external.mkdir()
        outside = external / "outside.jsonl"
        outside.write_bytes(source.read_bytes())
        source.unlink()
        seeded = self.tools / "operator-feedback-seeding"
        seeded.mkdir()
        (seeded / "escape").symlink_to(external, target_is_directory=True)

        real_scandir = os.scandir
        real_read = os.read
        external_identity = (external.stat().st_dev, external.stat().st_ino)
        outside_identity = (outside.stat().st_dev, outside.stat().st_ino)

        def guarded_scandir(target):
            if isinstance(target, int):
                opened = os.fstat(target)
                identity = (opened.st_dev, opened.st_ino)
            else:
                opened = os.stat(target)
                identity = (opened.st_dev, opened.st_ino)
            if identity == external_identity:
                raise AssertionError("snapshot discovery entered the external tree")
            return real_scandir(target)

        def guarded_read(descriptor, size):
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) == outside_identity:
                raise AssertionError("snapshot read external bytes")
            return real_read(descriptor, size)

        with mock.patch.object(
            state_snapshot_module.os,
            "scandir",
            side_effect=guarded_scandir,
        ), mock.patch.object(
            state_snapshot_module.os,
            "read",
            side_effect=guarded_read,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_ancestry_not_directory",
        ):
            self._build()

    def test_snapshot_discovery_has_an_explicit_aggregate_work_budget(self) -> None:
        with mock.patch.object(
            state_snapshot_module,
            "SNAPSHOT_MAX_DISCOVERY_WORK",
            0,
            create=True,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_discovery_budget_exceeded",
        ):
            self._build()

    def test_exact_surface_created_after_pass_one_is_rejected(self) -> None:
        requests = self._surface("agent_invocation_requests")
        beliefs = self._surface("memory_beliefs")
        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        original_surface_entry = state_snapshot_module._surface_entry
        created = False

        def create_after_first_read(*args, **kwargs):
            nonlocal created
            entry = original_surface_entry(*args, **kwargs)
            if not created:
                append_declared_fixture(
                    requests_path,
                    {"schema_version": 1, "request_id": "req-created-after-p1"},
                    expected_surface="agent_invocation_requests",
                )
                created = True
            return entry

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(requests, beliefs),
        ), mock.patch.object(
            state_snapshot_module,
            "_surface_entry",
            side_effect=create_after_first_read,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_changed",
        ):
            self._build()
        self.assertTrue(created, "fixture must create the exact surface after pass one")

    def test_nested_glob_add_remove_and_rename_after_pass_one_are_rejected(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        original_surface_entry = state_snapshot_module._surface_entry

        for operation in ("add", "remove", "rename"):
            with self.subTest(operation=operation):
                operation_root = self.tools / "agent-invocations" / "outputs" / operation
                case_dir = operation_root / "nested"
                case_dir.mkdir(parents=True)
                source = case_dir / "result.md"
                source.write_text("original", encoding="utf-8")
                source_relative = source.relative_to(self.tools).as_posix()
                mutated = False

                def mutate_after_read(*args, **kwargs):
                    nonlocal mutated
                    entry = original_surface_entry(*args, **kwargs)
                    if not mutated and args[1] == source_relative:
                        if operation == "add":
                            (case_dir / "added.md").write_text("added", encoding="utf-8")
                        elif operation == "remove":
                            source.unlink()
                        else:
                            source.rename(case_dir / "renamed.md")
                        mutated = True
                    return entry

                try:
                    with mock.patch.object(
                        state_snapshot_module,
                        "iter_surfaces",
                        return_value=(artifact,),
                    ), mock.patch.object(
                        state_snapshot_module,
                        "_surface_entry",
                        side_effect=mutate_after_read,
                    ), self.assertRaisesRegex(
                        SnapshotError,
                        "snapshot_surface_changed",
                    ):
                        self._build()
                    self.assertTrue(mutated, "fixture must mutate a discovered glob leaf")
                finally:
                    shutil.rmtree(operation_root, ignore_errors=True)

    def test_leaf_replace_between_projection_and_open_is_rejected(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        target = self.tools / "agent-invocations" / "outputs" / "replace" / "result.md"
        target.parent.mkdir(parents=True)
        target.write_text("old", encoding="utf-8")
        replacement = self.tmp / "replacement.md"
        replacement.write_text("new", encoding="utf-8")
        original_surface_entry = state_snapshot_module._surface_entry
        replaced = False

        def replace_before_open(*args, **kwargs):
            nonlocal replaced
            if not replaced:
                os.replace(replacement, target)
                replaced = True
            return original_surface_entry(*args, **kwargs)

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ), mock.patch.object(
            state_snapshot_module,
            "_surface_entry",
            side_effect=replace_before_open,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_changed",
        ):
            self._build()
        self.assertTrue(replaced, "fixture must replace the projected leaf before open")

    def test_post_pass_two_nested_directory_mutation_is_rejected(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        nested = self.tools / "agent-invocations" / "outputs" / "post-p2" / "nested"
        nested.mkdir(parents=True)
        (nested / "result.md").write_text("stable", encoding="utf-8")
        original_matches = state_snapshot_module._secure_surface_matches
        calls = 0

        def mutate_after_second_projection(*args, **kwargs):
            nonlocal calls
            matches = original_matches(*args, **kwargs)
            calls += 1
            if calls == 2:
                (nested / "nonmatching.tmp").write_text("changed", encoding="utf-8")
            return matches

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ), mock.patch.object(
            state_snapshot_module,
            "_secure_surface_matches",
            side_effect=mutate_after_second_projection,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_changed",
        ):
            self._build()

    def test_two_pass_projection_is_stable_and_deterministic(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        nested = self.tools / "agent-invocations" / "outputs" / "stable" / "nested"
        nested.mkdir(parents=True)
        (nested / "b.md").write_text("b", encoding="utf-8")
        (nested / "a.md").write_text("a", encoding="utf-8")

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ):
            first = self._build()
            second = self._build()
        self.assertEqual(first, second)

    def test_pass_two_spends_the_same_aggregate_discovery_budget(self) -> None:
        beliefs = self._surface("memory_beliefs")
        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(beliefs,),
        ), mock.patch.object(
            state_snapshot_module,
            "SNAPSHOT_MAX_DISCOVERY_WORK",
            4,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_discovery_budget_exceeded",
        ):
            self._build()

    def test_final_directory_revalidation_keeps_live_fds_depth_bounded(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        broad = self.tools / "agent-invocations" / "outputs" / "broad"
        for index in range(256):
            leaf = broad / f"branch-{index:03d}" / "result.md"
            leaf.parent.mkdir(parents=True)
            leaf.write_text(str(index), encoding="utf-8")

        real_open = os.open
        real_close = os.close
        live: set[int] = set()
        max_live = 0

        def tracked_open(*args, **kwargs):
            nonlocal max_live
            descriptor = real_open(*args, **kwargs)
            live.add(descriptor)
            max_live = max(max_live, len(live))
            return descriptor

        def tracked_close(descriptor: int) -> None:
            live.discard(descriptor)
            real_close(descriptor)

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ), mock.patch.object(
            state_snapshot_module.os,
            "open",
            side_effect=tracked_open,
        ), mock.patch.object(
            state_snapshot_module.os,
            "close",
            side_effect=tracked_close,
        ), mock.patch.object(
            state_snapshot_module,
            "_require_nofollow_dirfd_support",
            return_value=None,
        ):
            self._build()

        self.assertEqual(live, set(), "snapshot leaked a descriptor")
        self.assertLessEqual(
            max_live,
            state_snapshot_module.MAX_SURFACE_PATH_COMPONENTS + 8,
            "final revalidation retained one descriptor per sibling directory",
        )

    def test_final_directory_fd_exhaustion_is_named_as_unavailable(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        leaf = self.tools / "agent-invocations" / "outputs" / "emfile" / "result.md"
        leaf.parent.mkdir(parents=True)
        leaf.write_text("fixture", encoding="utf-8")
        real_matches = state_snapshot_module._secure_surface_matches
        real_open = os.open
        projections = 0
        final_revalidation = False

        def mark_second_projection(*args, **kwargs):
            nonlocal projections, final_revalidation
            matches = real_matches(*args, **kwargs)
            projections += 1
            if projections == 2:
                final_revalidation = True
            return matches

        def exhaust_only_during_final(*args, **kwargs):
            if final_revalidation and kwargs.get("dir_fd") is not None:
                raise OSError(errno.EMFILE, "too many open files")
            return real_open(*args, **kwargs)

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ), mock.patch.object(
            state_snapshot_module,
            "_secure_surface_matches",
            side_effect=mark_second_projection,
        ), mock.patch.object(
            state_snapshot_module.os,
            "open",
            side_effect=exhaust_only_during_final,
        ), mock.patch.object(
            state_snapshot_module,
            "_require_nofollow_dirfd_support",
            return_value=None,
        ), self.assertRaisesRegex(
            SnapshotError,
            r"snapshot_surface_revalidation_unavailable:.*errno=24",
        ):
            self._build()

    def test_root_inode_stability_does_not_hide_child_content_mutation(self) -> None:
        artifact = self._surface("agent_output_artifacts")
        target = self.tools / "agent-invocations" / "outputs" / "same-root" / "result.md"
        target.parent.mkdir(parents=True)
        target.write_text("alpha", encoding="utf-8")
        root_before = os.stat(self.tools, follow_symlinks=False)
        root_identity = (root_before.st_dev, root_before.st_ino, root_before.st_mode)
        original_surface_entry = state_snapshot_module._surface_entry
        mutated = False

        def mutate_child_after_read(*args, **kwargs):
            nonlocal mutated
            entry = original_surface_entry(*args, **kwargs)
            if not mutated:
                target.write_text("omega", encoding="utf-8")
                mutated = True
                root_after = os.stat(self.tools, follow_symlinks=False)
                self.assertEqual(
                    (root_after.st_dev, root_after.st_ino, root_after.st_mode),
                    root_identity,
                    "the root anchor stays on the same inode while its child changes",
                )
            return entry

        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(artifact,),
        ), mock.patch.object(
            state_snapshot_module,
            "_surface_entry",
            side_effect=mutate_child_after_read,
        ), self.assertRaisesRegex(
            SnapshotError,
            "snapshot_surface_changed",
        ):
            self._build()
        self.assertTrue(mutated, "fixture must mutate a child without replacing the root")

    def test_snapshot_path_normalization_errors_are_named(self) -> None:
        path = self.tools / "dispatch" / "artifacts"
        for _ in range(128):
            path /= "d"
        path.mkdir(parents=True)
        (path / "result.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(SnapshotError, "snapshot_surface_path_invalid"):
            self._build()

    def test_root_swap_during_build_is_rejected_not_mixed_into_one_manifest(self) -> None:
        replacement = self.tmp / "replacement-tools"
        shutil.copytree(self.tools, replacement)
        append_declared_fixture(
            replacement / "cycles.jsonl",
            {"schema_version": 1, "cycle_id": "replacement-root"},
            expected_surface="cycles",
        )
        displaced = self.tmp / "displaced-tools"
        original_surface_entry = state_snapshot_module._surface_entry
        swapped = False

        def swap_after_first_read(*args, **kwargs):
            nonlocal swapped
            entry = original_surface_entry(*args, **kwargs)
            if not swapped:
                self.tools.rename(displaced)
                replacement.rename(self.tools)
                swapped = True
            return entry

        with mock.patch.object(
            state_snapshot_module,
            "_surface_entry",
            side_effect=swap_after_first_read,
        ), self.assertRaisesRegex(SnapshotError, "snapshot_root_changed"):
            self._build()
        self.assertTrue(swapped, "fixture must swap after a real surface read")

    def test_manifest_validation_caps_claim_count_before_iteration(self) -> None:
        manifest = self._build()
        with mock.patch.object(
            state_snapshot_module,
            "SNAPSHOT_MAX_SURFACE_ENTRIES",
            0,
        ), self.assertRaisesRegex(
            SnapshotError,
            "surface_claim_budget_exceeded",
        ):
            validate_snapshot_manifest(manifest)

    def test_snapshot_surface_reads_are_bounded_and_streaming(self) -> None:
        registry = self.tools / "registry.json"
        registry.write_bytes(b"x" * 9)
        with mock.patch.object(
            state_snapshot_module,
            "SNAPSHOT_MAX_SURFACE_BLOB_BYTES",
            8,
            create=True,
        ), self.assertRaisesRegex(SnapshotError, "snapshot_surface_too_large"):
            self._build()

        registry.unlink()
        with mock.patch.object(
            state_snapshot_module,
            "file_hash",
            side_effect=AssertionError("legacy whole-buffer hash is forbidden"),
            create=True,
        ), mock.patch.object(
            state_snapshot_module,
            "load_jsonl_verified",
            side_effect=AssertionError("legacy whole-buffer ledger load is forbidden"),
            create=True,
        ):
            manifest = self._build()
        self.assertIn("memory_beliefs", manifest["surfaces"])

    def test_one_actual_path_cannot_be_owned_by_two_snapshot_surfaces(self) -> None:
        beliefs = next(
            surface for surface in iter_surfaces()
            if surface.name == "memory_beliefs"
        )
        duplicate = replace(beliefs, name="duplicate_memory_beliefs")
        with mock.patch.object(
            state_snapshot_module,
            "iter_surfaces",
            return_value=(beliefs, duplicate),
        ), self.assertRaisesRegex(SnapshotError, "snapshot_surface_ambiguous"):
            self._build()

    def test_no_lock_surface_is_ever_carried(self) -> None:
        (self.tools / "locks").mkdir(parents=True, exist_ok=True)
        (self.tools / "locks" / "probe.lock").write_text("", encoding="utf-8")
        manifest = self._build()
        for name, entry in manifest["surfaces"].items():
            with self.subTest(surface=name):
                self.assertNotEqual(entry["state_class"], "lock")

    def test_root_kinds_record_what_was_in_scope(self) -> None:
        """"This root held nothing" and "we never looked" must differ."""
        manifest = self._build()
        self.assertEqual(manifest["root_kinds"], ["tools"])
        with self.assertRaises(SnapshotError):
            self._build(roots={})
        with self.assertRaises(SnapshotError):
            self._build(roots={"nonsense": self.tools})

    def test_the_root_reacts_to_content_and_to_the_predecessor_link(self) -> None:
        first = self._build()
        append_declared_fixture(
            self.tools / "memory" / "beliefs.jsonl",
            {"schema_version": 1, "belief_id": "B-snap-2"},
            expected_surface="memory_beliefs",
        )
        second = self._build(snapshot_id="snap-002", previous=first)
        self.assertNotEqual(second["manifest_root"], first["manifest_root"])
        self.assertEqual(second["prev_manifest_root"], first["manifest_root"])

        # Re-pointing the chain at a different parent must change the root,
        # or a continuous-looking history could be assembled from genuine
        # snapshots by editing links alone.
        forged = dict(second)
        forged["prev_snapshot_id"] = "snap-999"
        self.assertNotEqual(compute_manifest_root(forged), second["manifest_root"])
        self.assertFalse(verify_manifest_root(forged))

    def test_a_lost_surface_is_reported_as_lost(self) -> None:
        """The property no per-file verification can produce."""
        first = self._build()
        (self.tools / "memory" / "beliefs.jsonl").unlink()
        second = self._build(snapshot_id="snap-002", previous=first)
        verdict = snapshot_continuity(second, first)
        self.assertEqual(verdict["status"], "surfaces_lost")
        self.assertIn("memory_beliefs", verdict["lost_surfaces"])

    def test_an_amnesic_tree_cannot_reproduce_its_predecessor_root(self) -> None:
        """Fresh-bootstrap-vs-amnesia, the failure the snapshot exists for."""
        first = self._build()
        fresh_tools = self.tmp / "fresh" / "aria-tools"
        ensure_tools_dir(fresh_tools)
        amnesic = build_snapshot(
            snapshot_id="snap-002", cycle_id="cyc-snap", lane="test",
            roots={"tools": fresh_tools},
        )
        self.assertNotEqual(amnesic["manifest_root"], first["manifest_root"])
        verdict = snapshot_continuity(amnesic, first)
        self.assertEqual(verdict["status"], "chain_broken")
        self.assertIn("memory_beliefs", verdict["lost_surfaces"])

    def test_genesis_is_named_rather_than_implied(self) -> None:
        verdict = snapshot_continuity(self._build(), None)
        self.assertEqual(verdict["status"], "genesis")
        self.assertEqual(verdict["lost_surfaces"], [])

    def test_signing_refuses_when_its_tooling_is_absent(self) -> None:
        """A missing signer must not become an unsigned-but-shipped manifest."""
        manifest = self._build()
        with mock.patch("aria_kernel.state_snapshot.shutil.which", return_value=None):
            with self.assertRaises(SnapshotError) as ctx:
                sign_snapshot(
                    manifest,
                    out_dir=self.tmp / "out",
                    private_key_path=self.tmp / "key",
                    public_key_path=self.tmp / "key.pub",
                    signer_fingerprint="SHA256:absent",
                )
        self.assertIn("snapshot_signing_unavailable", str(ctx.exception))
        self.assertFalse((self.tmp / "out" / "snapshot.json").exists())

    def test_signing_refuses_a_manifest_whose_root_is_stale(self) -> None:
        manifest = self._build()
        manifest["lane"] = "tampered-after-hashing"
        with mock.patch("aria_kernel.state_snapshot.shutil.which", return_value="/usr/bin/ssh-keygen"):
            with self.assertRaises(SnapshotError) as ctx:
                sign_snapshot(
                    manifest,
                    out_dir=self.tmp / "out",
                    private_key_path=self.tmp / "key",
                    public_key_path=self.tmp / "key.pub",
                    signer_fingerprint="SHA256:x",
                )
        self.assertIn("snapshot_", str(ctx.exception))


@unittest.skipUnless(HAS_SSH_KEYGEN, "ssh-keygen not on PATH (CI runs this)")
class SnapshotSignatureRoundTripTests(unittest.TestCase):
    """The real thing: sign, verify, then prove tampering is caught."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-snap-sig-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.key = self.tmp / "cyc-key"
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "aria-test", "-f", str(self.key)],
            check=True, capture_output=True,
        )
        self.manifest = build_snapshot(
            snapshot_id="snap-sig", cycle_id="cyc-sig", lane="test",
            roots={"tools": self.tools},
        )

        # Operator provisioning (ARIA-AUDIT-014): the verifier's trust is
        # a PINNED allowlist, written once by the operator from the keys
        # they chose to trust — never derived from whatever key a
        # snapshot happens to carry next to its signature.
        self.trust_store = self.tmp / "trust" / "allowed_signers"
        self.trust_store.parent.mkdir(parents=True, exist_ok=True)
        pub_text = self.key.with_suffix(".pub").read_text(encoding="utf-8").strip()
        self.trust_store.write_text(f"aria-state {pub_text}\n", encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _sign(self):
        return sign_snapshot(
            self.manifest,
            out_dir=self.tmp / "store",
            private_key_path=self.key,
            public_key_path=self.key.with_suffix(".pub"),
            signer_fingerprint="SHA256:test",
        )

    def test_sign_then_verify_round_trips(self) -> None:
        signed = self._sign()
        self.assertEqual(signed.namespace, SIGNATURE_NAMESPACE)
        self.assertTrue(signed.public_key_path.exists(), "the pubkey travels with the snapshot")
        report = verify_snapshot_signature(
            manifest_path=signed.manifest_path,
            signature_path=signed.signature_path,
            public_key_path=signed.public_key_path,
            trust_store=self.trust_store,
        )
        self.assertTrue(report["valid"], report)
        self.assertEqual(report["manifest_root"], self.manifest["manifest_root"])

    def test_tampering_the_signed_manifest_fails_verification(self) -> None:
        signed = self._sign()
        payload = json.loads(signed.manifest_path.read_text(encoding="utf-8"))
        payload["surfaces"].pop(next(iter(payload["surfaces"])), None)
        signed.manifest_path.write_text(json.dumps(payload), encoding="utf-8")
        report = verify_snapshot_signature(
            manifest_path=signed.manifest_path,
            signature_path=signed.signature_path,
            public_key_path=signed.public_key_path,
            trust_store=self.trust_store,
        )
        self.assertFalse(report["valid"])
        self.assertFalse(report["signature_valid"])
        self.assertFalse(report["manifest_root_valid"])

    def test_a_signature_from_another_namespace_does_not_verify(self) -> None:
        """Namespacing keeps a commit signature from passing as a snapshot.

        The foreign signature is minted over a COPY of the manifest, because
        signing in place would hit exactly the stale-signature hazard this
        module guards against — and an earlier draft of this test did, which
        is how that hazard was found: ``ssh-keygen -Y sign`` refuses to
        clobber an existing ``.sig`` and asks, so the old signature survived
        and the test "passed" a signature it had never replaced.
        """
        signed = self._sign()
        foreign_manifest = self.tmp / "foreign.json"
        foreign_manifest.write_bytes(signed.manifest_path.read_bytes())
        subprocess.run(
            [
                "ssh-keygen", "-Y", "sign", "-f", str(self.key),
                "-n", "git", str(foreign_manifest),
            ],
            check=True, capture_output=True, stdin=subprocess.DEVNULL,
        )
        foreign_sig = Path(str(foreign_manifest) + ".sig")
        self.assertTrue(foreign_sig.exists(), "fixture precondition: foreign sig minted")
        report = verify_snapshot_signature(
            manifest_path=signed.manifest_path,
            signature_path=foreign_sig,
            public_key_path=signed.public_key_path,
            trust_store=self.trust_store,
        )
        self.assertFalse(
            report["signature_valid"],
            "a `git`-namespace signature must not verify as a state attestation",
        )

    def test_re_signing_replaces_the_previous_attestation(self) -> None:
        """Every publish re-signs the same store — the normal case.

        Pre-fix, ``ssh-keygen`` refused to overwrite the existing ``.sig``
        and asked interactively: with a tty the publish hangs, without one
        the PREVIOUS signature stays beside the NEW manifest and verifies
        against nothing that exists. Both are unreachable now.
        """
        first = self._sign()
        first_sig = first.signature_path.read_bytes()

        moved = build_snapshot(
            snapshot_id="snap-sig-2", cycle_id="cyc-sig", lane="test",
            roots={"tools": self.tools}, previous=self.manifest,
        )
        second = sign_snapshot(
            moved,
            out_dir=self.tmp / "store",
            private_key_path=self.key,
            public_key_path=self.key.with_suffix(".pub"),
            signer_fingerprint="SHA256:test",
        )
        self.assertNotEqual(
            second.signature_path.read_bytes(), first_sig,
            "the store still carries the previous cycle's signature",
        )
        report = verify_snapshot_signature(
            manifest_path=second.manifest_path,
            signature_path=second.signature_path,
            public_key_path=second.public_key_path,
            trust_store=self.trust_store,
        )
        self.assertTrue(report["valid"], report)
        self.assertEqual(report["snapshot_id"], "snap-sig-2")


    def test_attacker_key_is_refused_even_with_a_valid_self_signature(self) -> None:
        """ARIA-AUDIT-014: a snapshot carrying its own key is self-trust.

        The attacker signs a manifest with THEIR key and presents THEIR
        public key next to the signature. Pre-fix, the verifier built its
        allowlist from exactly that presented key, so the forgery
        verified. Now the presented key must match the operator-pinned
        trust store or verification refuses.
        """
        attacker_key = self.tmp / "attacker"
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "attacker", "-f", str(attacker_key)],
            check=True, capture_output=True,
        )
        forged = sign_snapshot(
            self.manifest,
            out_dir=self.tmp / "forged-store",
            private_key_path=attacker_key,
            public_key_path=attacker_key.with_suffix(".pub"),
            signer_fingerprint="attacker",
        )
        with self.assertRaises(SnapshotError) as ctx:
            verify_snapshot_signature(
                manifest_path=forged.manifest_path,
                signature_path=forged.signature_path,
                public_key_path=forged.public_key_path,
                trust_store=self.trust_store,
            )
        self.assertIn("snapshot_trust_key_not_pinned", str(ctx.exception))

    def test_missing_trust_store_refuses_rather_than_self_trusting(self) -> None:
        signed = self._sign()
        with self.assertRaises(SnapshotError) as ctx:
            verify_snapshot_signature(
                manifest_path=signed.manifest_path,
                signature_path=signed.signature_path,
                public_key_path=signed.public_key_path,
                trust_store=self.tmp / "trust" / "does-not-exist",
            )
        self.assertIn("snapshot_trust_store_missing", str(ctx.exception))


class SnapshotAnchorTests(unittest.TestCase):
    """The anchor is where tree-level continuity gets a witness in git.

    A snapshot that lives only in the store it describes proves nothing
    against an actor who can rewrite the store; the daily anchor commits
    the root where the state branch cannot reach it.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-snap-anchor-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_anchor_carries_the_snapshot_id_and_root(self) -> None:
        from aria_kernel.report import build_daily_anchor

        manifest = build_snapshot(
            snapshot_id="snap-anchor", cycle_id="cyc-anchor", lane="nightly",
            roots={"tools": self.tools},
        )
        path = self.tmp / "snapshot.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        anchor = build_daily_anchor(
            date="2026-08-03",
            workspace_root=self.tmp,
            tools_root=self.tools,
            state_snapshot_path=path,
        )
        self.assertEqual(anchor["state_snapshot_id"], "snap-anchor")
        self.assertEqual(anchor["state_manifest_root"], manifest["manifest_root"])

    def test_no_snapshot_reads_as_none_not_as_a_zero(self) -> None:
        """Best-effort like every other anchor field — never a fake value."""
        from aria_kernel.report import build_daily_anchor

        anchor = build_daily_anchor(
            date="2026-08-03", workspace_root=self.tmp, tools_root=self.tools,
        )
        self.assertIsNone(anchor["state_snapshot_id"])
        self.assertIsNone(anchor["state_manifest_root"])
        # And an unreadable snapshot file is the same answer, not a crash:
        # the anchor is emitted on a schedule and must not die on junk.
        junk = self.tmp / "junk.json"
        junk.write_text("{not json", encoding="utf-8")
        anchor = build_daily_anchor(
            date="2026-08-03", workspace_root=self.tmp, tools_root=self.tools,
            state_snapshot_path=junk,
        )
        self.assertIsNone(anchor["state_manifest_root"])


if __name__ == "__main__":
    unittest.main()
