"""Persisted digest bytes the digest-owner migration must not move (ARIA-LOW-517, E11-4).

WHY THIS EXISTS. E11-4 moves every ``sha256:`` producer onto the one owner,
``aria_kernel.digest`` (hand-migrated sites, then a codemod over about 150
mechanical producers). Each value below is persisted or compared across runs:
an outbox dedup signature, a plan-obligation id, a curation proposal id, an
inbox payload id, a spine baseline, a context pack id, a ledger chain hash, a
settings identity on attempt rows, a stored lease-token hash. A migration that
changes how the label is composed must leave every one of these bytes as it
was, or dedup, chains and lease checks break silently.

WHAT IS PINNED. The golden values were captured on 965e37a9a, before
``digest.py`` existed, by calling each producer on a clean ``git archive`` of
that commit, and cross-checked against a direct ``hashlib`` computation. The
test calls the producers by their current names; when the migration deletes a
pass-through helper (the lease-token hashers), the pin moves to the owner
callable that replaces it and keeps the golden value.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import zai_runtime  # noqa: E402
from aria_kernel import (  # noqa: E402
    architecture_spine_gate,
    claude_settings,
    context_compiler,
    digest,
    ledger,
    must_satisfy,
    notify,
    semantic_memory,
    skill_curator,
)
from aria_kernel.gateway import normalize  # noqa: E402
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402

_LEASE_TOKEN = "lease-token-0001"
_LEASE_TOKEN_HASH = "sha256:d05d82c58700ab4194ffd8bdd0cd49786f514574d5ba69e5b18edaf87b2bde41"


class TruncatedLabelPins(unittest.TestCase):
    """Fingerprints: a truncated hex under the ``sha256:`` label (never a digest)."""

    def test_notify_outbox_signature(self) -> None:
        self.assertEqual(notify.signature_for("ci_failure", "run-42", "ignored title"), "sha256:e8fe6f589653d48e60af1184")
        self.assertEqual(notify.signature_for("ci_failure", None, "Kernel lane red"), "sha256:ce656247e6854eea93c9c028")

    def test_observed_plan_failure_obligation_id(self) -> None:
        obligation = must_satisfy.observed_plan_failure_obligation(
            failure_mode="The plan abandoned: free text, not a token.", episodes=3, plan_ids=["p-1"],
        )
        self.assertEqual(obligation["id"], "observed_plan_failure:sha256:eaf02503e4dde808")
        self.assertEqual(
            obligation["failure_mode_sha256"],
            "sha256:eaf02503e4dde80852805ecafc51de457489065665fd607fbe34ca31edf6b699",
        )

    def test_skill_curation_signature(self) -> None:
        self.assertEqual(skill_curator._signature("merge", ["beta", "alpha"]), "sha256:bafdfcaafc295212ee47")

    def test_gateway_payload_digest(self) -> None:
        self.assertEqual(
            normalize.payload_digest({"b": [1, 2], "a": "x", "when": None}),
            "sha256:fae42b4895db6ce4a54a10de367c33e9",
        )

    def test_spine_baseline_hash(self) -> None:
        # ARIA-HIGH-045 moved the persisted measurement to the v2 shape (the
        # violation set plus coverage and provenance); the count-only input
        # the 965e37a9a golden was captured on can no longer be built. The
        # composition is unchanged: the same canonical bytes, hashed directly
        # below, give the pinned value.
        identity = "apps/x/src/a.service.ts::tenant_unscoped_repository_call::0123456789ab#0"
        measurements = [
            architecture_spine_gate.InvariantMeasurement(
                invariant="tenant_scoping",
                measured_at="2026-10-15T00:00:00Z",
                measurements={"violation_count": 1, "violation_identities": [identity]},
                source="adapter:tenant-scoping-adapter@1.0.0",
            ),
        ]
        canonical = {"tenant_scoping": {
            "invariant": "tenant_scoping", "measured_at": "2026-10-15T00:00:00Z",
            "measurements": {"violation_count": 1, "violation_identities": [identity]},
            "source": "adapter:tenant-scoping-adapter@1.0.0",
            "coverage": "measured", "coverage_reason": None, "provenance": {},
        }}
        direct = "sha256:" + hashlib.sha256(
            json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ).hexdigest()[:16]
        self.assertEqual(direct, "sha256:c9af6a50ca68d0f0")
        self.assertEqual(architecture_spine_gate._baseline_hash(measurements), direct)

    def test_context_pack_hash(self) -> None:
        decision = context_compiler.DecisionRecord(
            source="control", ref="AIR-1", when="2026-10-01T00:00:00Z", what="cancel AIR-1",
            why="tenant isolation plan superseded", ledger_hash="sha256:" + "cd" * 32,
        )
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {semantic_memory.EMBEDDER_CMD_ENV: ""}):
            pack = context_compiler.compile_context(
                request={"request_id": "r", "suggested_prompt": "tenant isolation plan"},
                base_dir=ensure_tools_dir(Path(tmp) / "aria-tools"),
                budget_tokens=500,
                decisions=[decision],
                record=False,
            )
        self.assertEqual(len(pack.decisions), 1)
        self.assertEqual(pack.pack_hash, "sha256:88dd54a7152aa0191dafb611e141a9e6")


class LedgerDigestPins(unittest.TestCase):
    def test_record_hash(self) -> None:
        self.assertEqual(
            ledger._record_hash({"event": "pin", "n": 1, "ledger_hash": "x", "previous_ledger_hash": "y"}, None),
            "sha256:74204c1c65dc16dc05f6c6753b6c7ca7a0272971b26b6be136e5f4db43451c4e",
        )
        self.assertEqual(
            ledger._record_hash({"event": "pin", "n": 2}, "sha256:" + "ab" * 32),
            "sha256:1ab79a715ff93fdfeb9f9381bcf72145439efe27e14148aa2a38388ef9f769fc",
        )

    def test_replay_transport_identities(self) -> None:
        payload = {"schema_version": 1, "event": "cost_observed", "z": [True, None]}
        row = ledger._make_replay_transport_row(
            payload,
            expected_surface="cost_attribution",
            surface_instance="cost-attribution/2026-08.jsonl",
            producer_event_id=ledger._record_hash(payload, None),
            producer_previous_ledger_hash=None,
            replay_transaction_id="g006-pin",
        )
        self.assertEqual(
            row["payload_sha256"], "sha256:285c567f1d3135767e0d84c94a3b9ca069aee62efb521d8fc870753076489759",
        )
        self.assertEqual(
            row["producer_event_id"], "sha256:d73ae0af05cfd340b7aa27b192ed36cbf9236eff3a6b441d32f6278be3b13f81",
        )

    def test_bare_hex_digests(self) -> None:
        self.assertEqual(
            ledger.sha256_of_canonical_json({"b": 1, "a": [2, "é"]}),
            "a912e39b23effbe7b1e005a7b6ef3ab7c9e13858293d1668cb992dab91acbb51",
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "f.bin"
            path.write_bytes(b"pinned file bytes\n")
            self.assertEqual(ledger.file_hash(path), "e1e2f35b079b4347087a1ca77d08891967a0ab8bb9890bcca64ba60049abbf7e")
            # The integrity index's missing-file policy: the empty-bytes hash.
            self.assertEqual(
                ledger.file_hash(Path(tmp) / "absent"),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            )


class SettingsIdentityPins(unittest.TestCase):
    def test_claude_settings_hash(self) -> None:
        self.assertEqual(
            claude_settings.settings_hash({"permissions": {"deny": ["Bash(rm:*)"]}, "env": {"A": "1"}}),
            "sha256:af91bbf157d3e2d35e54b3d6750f6bc0e21d794a596360c7d91544507698d9e3",
        )

    def test_zai_settings_hash(self) -> None:
        self.assertEqual(
            zai_runtime.zai_settings_hash(
                endpoint="https://example.invalid/v1", base_url="https://example.invalid", model="glm-4.6",
            ),
            "sha256:6ec2102b0405a761a499068221402da312fe1074fccba45318c5027ea840b2fa",
        )


class LeaseTokenHashPins(unittest.TestCase):
    """The stored ``lease_token_hash`` / ``secret_sha256`` of one token (ARIA-LOW-517).

    The four byte-identical pass-through hashers (state_writer_lease.token_digest,
    verification_gate/worker_dispatch/agent_invocations._hash_lease_token) were
    collapsed into the digest owner; the pin moves to the owner callable that
    replaced them and keeps the golden value, per this file's contract.
    """

    def test_the_owner_mints_the_stored_bytes(self) -> None:
        self.assertEqual(digest.sha256_digest_text(_LEASE_TOKEN), _LEASE_TOKEN_HASH)

    def test_the_owner_comparison_matches_the_stored_bytes(self) -> None:
        self.assertTrue(digest.secret_matches_sha256_digest(_LEASE_TOKEN, _LEASE_TOKEN_HASH))
        self.assertFalse(digest.secret_matches_sha256_digest("lease-token-9999", _LEASE_TOKEN_HASH))
        self.assertFalse(digest.secret_matches_sha256_digest(_LEASE_TOKEN, None))


if __name__ == "__main__":
    unittest.main()
