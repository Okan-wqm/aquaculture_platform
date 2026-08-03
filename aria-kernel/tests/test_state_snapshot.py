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

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.state_manifest import iter_surfaces
from aria_kernel.state_snapshot import (
    SIGNATURE_NAMESPACE,
    STORAGE_POLICY,
    SnapshotError,
    build_snapshot,
    compute_manifest_root,
    sign_snapshot,
    snapshot_continuity,
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

    def test_a_snapshot_records_present_surfaces_with_chain_tips(self) -> None:
        manifest = self._build()
        self.assertEqual(manifest["$schema"], "aria/state-snapshot/v1")
        beliefs = manifest["surfaces"]["memory_beliefs"]
        self.assertEqual(beliefs["storage"], "carried")
        self.assertEqual(beliefs["row_count"], 1)
        self.assertTrue(beliefs["tail_ledger_hash"].startswith("sha256:"))
        self.assertEqual(beliefs["segments"], ["memory/beliefs.jsonl"])
        self.assertTrue(verify_manifest_root(manifest))

    def test_a_broken_chain_is_recorded_not_given_plausible_counts(self) -> None:
        """Attesting a tip for a chain that does not verify is worse than none.

        The builder routes through the kernel's one strict reader, so a
        tampered ledger cannot yield a count-and-tip that looks like
        evidence of a state that never existed.
        """
        path = self.tools / "memory" / "beliefs.jsonl"
        path.write_text(
            path.read_text(encoding="utf-8").replace("B-snap", "B-forged"),
            encoding="utf-8",
        )
        entry = self._build()["surfaces"]["memory_beliefs"]
        self.assertFalse(entry["chain_valid"])
        self.assertIsNone(entry["row_count"])
        self.assertIsNone(entry["tail_ledger_hash"])
        self.assertTrue(entry["sha256"], "the bytes are still identified")

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
        )
        self.assertTrue(report["valid"], report)
        self.assertEqual(report["snapshot_id"], "snap-sig-2")


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
