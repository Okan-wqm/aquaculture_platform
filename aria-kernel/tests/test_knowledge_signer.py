"""B7 — the cycle knowledge signer seam (`cycle_phases.knowledge_signer`).

What each test proves:

* `test_permitted_profiles_follow_the_table` — the seam derives its
  verdict from `ACTION_PERMISSIONS["knowledge_record"]`; narrowing the
  table narrows the seam without any edit here.
* `test_unpermitted_profile_mints_nothing` — no key, no files, no
  governance row under a profile that lacks the cell.
* `test_permitted_profile_holds_a_real_key_for_the_body_only` — the
  fingerprint is the real ed25519 key's; the private key exists inside
  the body and is gone after it, on the success AND the exception path.
* `test_v9_style_revoke_inside_the_body_is_harmless` — the V9 runner
  revokes the shared identity in its own `finally`; the seam's second
  revoke finds nothing and does not fail.
* `test_mint_failure_is_recorded_and_yields_no_signer` — a documented
  mint failure becomes a `knowledge_signer_mint_failed` governance row
  and a signer with no fingerprint; a defect class outside that set
  propagates.
* `test_public_key_is_registered_so_the_fingerprint_verifies_after_revoke`
  — the seam registers the cycle's PUBLIC key in
  `knowledge-graph/signers.jsonl` before yielding; after the key files
  are gone a reader still resolves the fingerprint to a real key.
* `test_registration_failure_yields_no_signer_and_revokes_the_key` — a
  fingerprint whose key could not be registered is never handed out.
* `SignerRegistryTests` — the registry's own contract: pure-Python
  fingerprint equals ssh-keygen's, idempotent re-registration, conflict
  on a different key, refusal of a fingerprint that is not the key's.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import gh_token_factory, knowledge_graph
from aria_kernel.cycle_phases.knowledge_signer import (
    KNOWLEDGE_RECORD_ACTION_KIND,
    KnowledgeSigner,
    cycle_knowledge_signer,
    knowledge_record_permitted,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import ACTION_PERMISSIONS, PROFILES
from aria_kernel.tool_registry import ensure_tools_dir


class KnowledgeSignerSeamTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="knowledge-signer-")).resolve()
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()
        self.base = ensure_tools_dir(self.tmp / "aria-tools")
        self.cycle_id = "cyc-knowledge-signer"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _key_files(self) -> list[Path]:
        keys = self.workspace / "aria-debts" / "keys"
        return sorted(keys.iterdir()) if keys.is_dir() else []

    def _signer_governance_kinds(self) -> list[str]:
        """Rows the seam itself wrote; the tools-dir bootstrap row is not one."""
        path = self.base / "governance.jsonl"
        rows = load_jsonl(path) if path.exists() else []
        return [row.get("kind") for row in rows if str(row.get("kind")).startswith("knowledge_signer")]

    def test_permitted_profiles_follow_the_table(self) -> None:
        self.assertEqual(KNOWLEDGE_RECORD_ACTION_KIND, "knowledge_record")
        permitted = ACTION_PERMISSIONS[KNOWLEDGE_RECORD_ACTION_KIND]
        self.assertEqual(permitted, frozenset({"standard", "strict", "autonomous"}))
        for profile in PROFILES:
            self.assertEqual(knowledge_record_permitted(profile=profile), profile in permitted, profile)
        narrowed = dict(ACTION_PERMISSIONS)
        narrowed[KNOWLEDGE_RECORD_ACTION_KIND] = frozenset({"autonomous"})
        with patch("aria_kernel.runtime_profile.ACTION_PERMISSIONS", narrowed):
            self.assertFalse(knowledge_record_permitted(profile="standard"))
            self.assertFalse(knowledge_record_permitted(profile="strict"))
            self.assertTrue(knowledge_record_permitted(profile="autonomous"))

    def test_unpermitted_profile_mints_nothing(self) -> None:
        for profile in ("observe", "frozen"):
            with self.subTest(profile=profile), patch.object(
                gh_token_factory, "mint_signing_key",
                side_effect=AssertionError("must not mint without knowledge_record"),
            ):
                with cycle_knowledge_signer(
                    profile=profile, cycle_id=self.cycle_id,
                    workspace_root=self.workspace, base_dir=self.base,
                ) as signer:
                    self.assertEqual(signer, KnowledgeSigner(
                        cycle_id=self.cycle_id, status="not_permitted", fingerprint=None,
                    ))
                    self.assertEqual(signer.receipt(), {
                        "status": "not_permitted", "signer_cycle_id": None,
                        "signer_key_fp": None, "error_class": None,
                    })
        self.assertEqual(self._key_files(), [])
        self.assertEqual(self._signer_governance_kinds(), [])

    def test_permitted_profile_holds_a_real_key_for_the_body_only(self) -> None:
        private = self.workspace / "aria-debts" / "keys" / self.cycle_id
        for raise_in_body in (False, True):
            with self.subTest(raise_in_body=raise_in_body):
                seen: dict[str, object] = {}
                try:
                    with cycle_knowledge_signer(
                        profile="standard", cycle_id=self.cycle_id,
                        workspace_root=self.workspace, base_dir=self.base,
                    ) as signer:
                        seen["signer"] = signer
                        seen["private_exists"] = private.is_file()
                        seen["mode"] = private.stat().st_mode & 0o777
                        # The fingerprint is the real key's, recomputed
                        # from the public half on disk, not a label.
                        seen["recomputed"] = gh_token_factory._compute_fingerprint(
                            private.with_suffix(".pub"),
                        )
                        if raise_in_body:
                            raise RuntimeError("fixture body failure")
                except RuntimeError as exc:
                    self.assertTrue(raise_in_body)
                    self.assertEqual(str(exc), "fixture body failure")
                signer = seen["signer"]
                self.assertIsInstance(signer, KnowledgeSigner)
                self.assertEqual(signer.status, "minted")
                self.assertEqual(signer.cycle_id, self.cycle_id)
                self.assertTrue(str(signer.fingerprint).startswith("SHA256:"))
                self.assertEqual(signer.fingerprint, seen["recomputed"])
                self.assertTrue(seen["private_exists"])
                self.assertEqual(seen["mode"], 0o600)
                self.assertEqual(signer.receipt()["signer_cycle_id"], self.cycle_id)
                self.assertEqual(signer.receipt()["signer_key_fp"], signer.fingerprint)
                # The key cannot outlive the phase, however the body ended.
                self.assertEqual(self._key_files(), [])
        self.assertEqual(self._signer_governance_kinds(), [])

    def test_v9_style_revoke_inside_the_body_is_harmless(self) -> None:
        with cycle_knowledge_signer(
            profile="strict", cycle_id=self.cycle_id,
            workspace_root=self.workspace, base_dir=self.base,
        ) as signer:
            # The V9 runner's idempotent re-mint returns the SAME identity
            # (one key per cycle), then revokes it in its own finally.
            again = gh_token_factory.mint_signing_key(
                cycle_id=self.cycle_id, workspace_root=self.workspace,
            )
            self.assertEqual(again.fingerprint, signer.fingerprint)
            revoked = gh_token_factory.revoke_signing_key(
                cycle_id=self.cycle_id, workspace_root=self.workspace,
            )
            self.assertEqual(sorted(revoked["removed"]), [self.cycle_id, f"{self.cycle_id}.pub"])
        self.assertEqual(self._key_files(), [])

    def test_mint_failure_is_recorded_and_yields_no_signer(self) -> None:
        with patch.object(
            gh_token_factory, "mint_signing_key",
            side_effect=RuntimeError("ssh-keygen not on PATH; fixture"),
        ):
            with cycle_knowledge_signer(
                profile="standard", cycle_id=self.cycle_id,
                workspace_root=self.workspace, base_dir=self.base,
            ) as signer:
                self.assertEqual(signer.status, "mint_failed")
                self.assertIsNone(signer.fingerprint)
                self.assertEqual(signer.error_class, "RuntimeError")
                self.assertEqual(signer.receipt()["signer_cycle_id"], None)
        rows = [row for row in load_jsonl(self.base / "governance.jsonl")
                if row.get("kind") == "knowledge_signer_mint_failed"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["cycle_id"], self.cycle_id)
        self.assertEqual(rows[0]["details"]["profile"], "standard")
        self.assertEqual(rows[0]["details"]["stage"], "mint_key")
        self.assertEqual(rows[0]["details"]["error_class"], "RuntimeError")
        self.assertEqual(self._key_files(), [])
        self.assertFalse((self.base / "knowledge-graph" / "signers.jsonl").exists())
        # A defect outside the factory's documented failure modes is not a
        # "no signer" outcome; it reaches the caller like any phase fault.
        with patch.object(gh_token_factory, "mint_signing_key", side_effect=TypeError("fixture defect")):
            with self.assertRaisesRegex(TypeError, "fixture defect"):
                with cycle_knowledge_signer(
                    profile="standard", cycle_id=self.cycle_id,
                    workspace_root=self.workspace, base_dir=self.base,
                ):
                    self.fail("the body must not run without a verdict")

    def test_public_key_is_registered_so_the_fingerprint_verifies_after_revoke(self) -> None:
        registry = self.base / "knowledge-graph" / "signers.jsonl"
        with cycle_knowledge_signer(
            profile="standard", cycle_id=self.cycle_id,
            workspace_root=self.workspace, base_dir=self.base,
        ) as signer:
            rows = load_jsonl(registry)
            self.assertEqual([(row["cycle_id"], row["signer_key_fp"]) for row in rows],
                             [(self.cycle_id, signer.fingerprint)])
            self.assertEqual(rows[0]["key_type"], "ssh-ed25519")
            # The identity fields only: no comment, never the private half.
            public_line = (self.workspace / "aria-debts" / "keys" / f"{self.cycle_id}.pub").read_text(encoding="utf-8")
            self.assertEqual(rows[0]["public_key"], public_line.split()[1])
            self.assertNotIn("PRIVATE", registry.read_text(encoding="utf-8"))
            # A row recorded under this signer, the way the memory hook does it.
            from aria_kernel.knowledge_graph import Pattern, record_convention
            record_convention(Pattern(
                pattern_id="conv_registry_probe", pattern_type="convention", confidence=0.5,
                evidence_refs=("x.py:1",), discovered_by_cycle_id=self.cycle_id,
                observed_at="2026-09-12T00:00:00Z", outcome_status="hypothesis", plan_id="plan-x",
            ), base_dir=self.base, signer_key_fp=signer.fingerprint)
        # The key files are gone; the row's fingerprint still resolves to
        # a real key, and re-deriving it from that key gives the same value.
        self.assertEqual(self._key_files(), [])
        convention = load_jsonl(self.base / "knowledge-graph" / "conventions.jsonl")[0]
        self.assertEqual(convention["signer_key_fp"], signer.fingerprint)
        self.assertTrue(knowledge_graph.verify_convention_signer(convention, base_dir=self.base))
        registered = knowledge_graph.lookup_convention_signer(signer.fingerprint, base_dir=self.base)
        self.assertEqual(
            knowledge_graph.fingerprint_of_public_key(f"{registered['key_type']} {registered['public_key']}"),
            signer.fingerprint,
        )
        self.assertFalse(knowledge_graph.verify_convention_signer({"signer_key_fp": "SHA256:unregistered"}, base_dir=self.base))
        self.assertFalse(knowledge_graph.verify_convention_signer({"signer_key_fp": None}, base_dir=self.base))
        # The V9 runner's idempotent re-mint registers nothing new.
        with cycle_knowledge_signer(
            profile="strict", cycle_id="cyc-knowledge-signer-2",
            workspace_root=self.workspace, base_dir=self.base,
        ) as second:
            gh_token_factory.mint_signing_key(cycle_id="cyc-knowledge-signer-2", workspace_root=self.workspace)
            knowledge_graph.register_convention_signer(
                cycle_id="cyc-knowledge-signer-2", signer_key_fp=second.fingerprint,
                public_key=(self.workspace / "aria-debts" / "keys" / "cyc-knowledge-signer-2.pub").read_text(encoding="utf-8"),
                base_dir=self.base,
            )
        self.assertEqual([row["signer_key_fp"] for row in load_jsonl(registry)],
                         [signer.fingerprint, second.fingerprint])

    def test_registration_failure_yields_no_signer_and_revokes_the_key(self) -> None:
        from aria_kernel.ledger import LedgerIntegrityError

        with patch.object(
            knowledge_graph, "register_convention_signer",
            side_effect=LedgerIntegrityError("fixture: registry refused"),
        ):
            with cycle_knowledge_signer(
                profile="standard", cycle_id=self.cycle_id,
                workspace_root=self.workspace, base_dir=self.base,
            ) as signer:
                self.assertEqual(signer.status, "mint_failed")
                self.assertIsNone(signer.fingerprint)
                self.assertEqual(signer.error_class, "LedgerIntegrityError")
                # Revoked on the spot, not at the end of the body.
                self.assertEqual(self._key_files(), [])
        rows = [row for row in load_jsonl(self.base / "governance.jsonl")
                if row.get("kind") == "knowledge_signer_mint_failed"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["stage"], "register_public_key")
        self.assertEqual(rows[0]["details"]["error_class"], "LedgerIntegrityError")
        self.assertFalse((self.base / "knowledge-graph" / "signers.jsonl").exists())


class SignerRegistryTests(unittest.TestCase):
    """`knowledge_graph` signer registry — the public key behind a fingerprint."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="signer-registry-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.base = ensure_tools_dir(self.tmp / "aria-tools")
        self.workspace = self.tmp / "workspace"
        self.workspace.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _real_key(self, cycle_id: str) -> tuple[str, str]:
        key = gh_token_factory.mint_signing_key(cycle_id=cycle_id, workspace_root=self.workspace)
        self.addCleanup(gh_token_factory.revoke_signing_key, cycle_id=cycle_id, workspace_root=self.workspace)
        return key.fingerprint, key.public_key_path.read_text(encoding="utf-8")

    def test_pure_python_fingerprint_matches_ssh_keygen(self) -> None:
        fingerprint, public_key = self._real_key("cyc-registry-fp")
        self.assertEqual(knowledge_graph.fingerprint_of_public_key(public_key), fingerprint)
        for bad in ("", "ssh-rsa AAAA", "ssh-ed25519", "ssh-ed25519 not*base64", 42):
            with self.subTest(bad=bad), self.assertRaises(knowledge_graph.KnowledgeGraphSchemaError):
                knowledge_graph.fingerprint_of_public_key(bad)

    def test_registration_is_idempotent_and_refuses_a_foreign_fingerprint(self) -> None:
        fingerprint, public_key = self._real_key("cyc-registry-a")
        other_fingerprint, other_public_key = self._real_key("cyc-registry-b")
        path = knowledge_graph.register_convention_signer(
            cycle_id="cyc-registry-a", signer_key_fp=fingerprint, public_key=public_key, base_dir=self.base,
        )
        self.assertEqual(path, self.base / "knowledge-graph" / "signers.jsonl")
        self.assertEqual(knowledge_graph.register_convention_signer(
            cycle_id="cyc-registry-a", signer_key_fp=fingerprint, public_key=public_key, base_dir=self.base,
        ), path)
        self.assertEqual(len(load_jsonl(path)), 1)
        # Tier-1 at the registry: a fingerprint that is not the key's own.
        with self.assertRaisesRegex(knowledge_graph.KnowledgeGraphSchemaError, "not the fingerprint"):
            knowledge_graph.register_convention_signer(
                cycle_id="cyc-registry-b", signer_key_fp=fingerprint, public_key=other_public_key, base_dir=self.base,
            )
        with self.assertRaises(knowledge_graph.KnowledgeGraphSchemaError):
            knowledge_graph.register_convention_signer(
                cycle_id="cyc-registry-b", signer_key_fp="fp-without-prefix", public_key=other_public_key, base_dir=self.base,
            )
        self.assertEqual(len(load_jsonl(path)), 1)
        self.assertIsNone(knowledge_graph.lookup_convention_signer(other_fingerprint, base_dir=self.base))
        knowledge_graph.register_convention_signer(
            cycle_id="cyc-registry-b", signer_key_fp=other_fingerprint, public_key=other_public_key, base_dir=self.base,
        )
        self.assertEqual([row["cycle_id"] for row in load_jsonl(path)], ["cyc-registry-a", "cyc-registry-b"])
        self.assertTrue(knowledge_graph.verify_convention_signer({"signer_key_fp": other_fingerprint}, base_dir=self.base))

    def test_a_registered_key_that_does_not_hash_to_its_fingerprint_is_not_verified(self) -> None:
        """The ledger is hash-chained, so this cannot happen by append; the
        verifier still re-derives rather than trusting the lookup."""
        fingerprint, public_key = self._real_key("cyc-registry-c")
        _other, other_public_key = self._real_key("cyc-registry-d")
        with patch.object(knowledge_graph, "lookup_convention_signer", return_value={
            "signer_key_fp": fingerprint, "key_type": "ssh-ed25519", "public_key": other_public_key.split()[1],
        }):
            self.assertFalse(knowledge_graph.verify_convention_signer({"signer_key_fp": fingerprint}, base_dir=self.base))
        with patch.object(knowledge_graph, "lookup_convention_signer", return_value={
            "signer_key_fp": fingerprint, "key_type": "ssh-ed25519", "public_key": public_key.split()[1],
        }):
            self.assertTrue(knowledge_graph.verify_convention_signer({"signer_key_fp": fingerprint}, base_dir=self.base))



if __name__ == "__main__":
    unittest.main()
