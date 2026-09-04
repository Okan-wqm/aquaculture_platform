"""Plan 033 Faz 033e — CampaignGrant (EdDSA JWS), Evidence Vault, campaign lifecycle.

Invariants:
  I-V13-GRANT-01   forged / wrong-alg / tampered / expired / mismatched / R4 / un-approved R3
                   grants are refused; the private key must live outside the workspace.
  I-V13-GRANT-02   a JTI is single-use per campaign_run_id (same run may re-activate).
  I-V13-VAULT-01   raw evidence never reaches the ledger in clear (redacted preview only),
                   objects are encrypted on disk (0600 in a 0700 dir outside workspace/tools),
                   oversized evidence is stored truncated AND flagged, seal is write-once,
                   purge leaves a deletion receipt.
  I-V13-CAMPAIGN-01 states/transitions are closed and ordered; inputs are write-once;
                   a stale or non-latest graph digest cannot be attested; cleanup without a
                   teardown receipt quarantines; CLOSED only after CLEANUP_VERIFIED.
  I-V13-CAMPAIGN-02 the kill switch runs the fixed sequence and a failed teardown ends in
                   QUARANTINED; a security mission binds campaign_run_ids + grant_jtis.
"""
from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel import mission
from aria_kernel.security import attack_graph as AG
from aria_kernel.security import campaign as C
from aria_kernel.security import grant as G
from aria_kernel.security import lab as L
from aria_kernel.security import vault as V
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir

HAVE_CRYPTO = G.backend_available()
DIG = {k: "sha256:" + c * 64 for k, c in (("att", "a"), ("prof", "b"), ("pack", "c"), ("graph", "d"), ("pol", "e"))}


def _claims(**over):
    base = dict(campaign_run_id="run-1", lease_id="lease-1", lab_attestation_digest=DIG["att"], profile_digest=DIG["prof"],
                pack_digests=(DIG["pack"],), graph_digest=DIG["graph"], policy_digest=DIG["pol"],
                risk_class="R2_SYNTHETIC_MUTATION", lab_network="10.99.0.0/24", allowed_hosts=("api.lab.internal",))
    base.update(over)
    return G.new_claims(**base)


@unittest.skipUnless(HAVE_CRYPTO, "cryptography (Ed25519) not installed — grant lane is fail-closed here")
class Grant(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        t = Path(self._tmp.name)
        self.ws = t / "ws"
        self.ws.mkdir()
        self.tools = ensure_tools_dir(t / "tools")
        self.priv, pub = G.generate_keypair(t / "keys", workspace_root=self.ws)
        self.pub = pub.read_bytes()
        self.signer = G.GrantSigner(self.priv, workspace_root=self.ws)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V13_GRANT_01_refusals(self) -> None:
        with self.assertRaises(G.GrantError):
            G.generate_keypair(self.ws / "keys", workspace_root=self.ws)
        self.assertEqual(self.priv.stat().st_mode & 0o777, 0o600)
        for bad in (dict(risk_class="R4_FORBIDDEN"), dict(risk_class="R3_HUMAN_REQUIRED"), dict(minutes=G.MAX_GRANT_MINUTES + 1),
                    dict(allowed_hosts=()), dict(profile_digest="md5:x")):
            with self.assertRaises(G.GrantError, msg=str(bad)):
                self.signer.sign(_claims(**bad))
        ok = self.signer.sign(_claims(risk_class="R3_HUMAN_REQUIRED", human_approval_ref="review-77", recipe_digest="sha256:" + "f" * 64))
        self.assertEqual(G.verify_grant(ok, self.pub).risk_class, "R3_HUMAN_REQUIRED")
        claims = _claims()
        token = self.signer.sign(claims)
        h, p, s = token.split(".")
        self.assertEqual(G.verify_grant(token, self.pub, expected={"campaign_run_id": "run-1", "pack_digests": claims.pack_digests}).jti, claims.jti)
        with self.assertRaisesRegex(G.GrantError, "signature"):
            G.verify_grant(f"{h}.{p}.{s[:-4]}AAAA", self.pub)
        other_priv, _ = G.generate_keypair(Path(self._tmp.name) / "keys2", workspace_root=self.ws)
        with self.assertRaisesRegex(G.GrantError, "signature"):
            G.verify_grant(G.GrantSigner(other_priv, workspace_root=self.ws).sign(claims), self.pub)
        for alg in ("none", "HS256", "ES256"):
            hdr = base64.urlsafe_b64encode(json.dumps({"alg": alg, "typ": G.GRANT_TYP}).encode()).rstrip(b"=").decode()
            with self.assertRaisesRegex(G.GrantError, "alg"):
                G.verify_grant(f"{hdr}.{p}.{s}", self.pub)
        with self.assertRaisesRegex(G.GrantError, "expired"):
            G.verify_grant(token, self.pub, now=datetime.now(timezone.utc) + timedelta(minutes=G.MAX_GRANT_MINUTES + 1))
        with self.assertRaisesRegex(G.GrantError, "mismatch"):
            G.verify_grant(token, self.pub, expected={"graph_digest": "sha256:" + "0" * 64})
        with self.assertRaises(G.GrantError):
            G.verify_grant("not.a.jws.at.all", self.pub)

    def test_I_V13_GRANT_02_single_use_jti(self) -> None:
        claims = _claims()
        token = self.signer.sign(claims)
        G.activate_grant(claims, token, base_dir=self.tools)
        G.activate_grant(claims, token, base_dir=self.tools)  # same run: crash-recovery re-activation
        stolen = G.GrantClaims(**{**claims.__dict__, "campaign_run_id": "run-2"})
        with self.assertRaisesRegex(G.GrantError, "already activated"):
            G.activate_grant(stolen, token, base_dir=self.tools)


@unittest.skipUnless(HAVE_CRYPTO, "cryptography (AES-GCM) not installed — vault is fail-closed here")
class Vault(unittest.TestCase):
    def test_I_V13_VAULT_01_encrypted_redacted_sealed(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            ws, tools = root / "ws", ensure_tools_dir(root / "tools")
            ws.mkdir()
            r, w = os.pipe()
            os.write(w, os.urandom(32))
            os.close(w)
            kek = V.kek_from_fd(r)
            for inside in (ws / "vault", tools / "vault"):
                with self.assertRaises(V.VaultError):
                    V.EvidenceVault(inside, kek, workspace_root=ws, base_dir=tools)
            vault = V.EvidenceVault(root / "vault", kek, workspace_root=ws, base_dir=tools)
            self.assertEqual((root / "vault").stat().st_mode & 0o777, 0o700)
            secret = "SECRET-TOKEN-XYZ-" + os.urandom(4).hex()
            raw = f"GET /api HTTP/1.1\r\nAuthorization: Bearer {secret}\r\nCookie: sid={secret}\r\n\r\nbody".encode()
            ref = vault.put(campaign_run_id="run-1", kind="http_exchange", data=raw)
            ledger = (tools / "security" / "evidence.jsonl").read_text(encoding="utf-8")
            self.assertNotIn(secret, ledger)
            self.assertIn("[REDACTED]", ledger)
            self.assertIn(ref.ref, ledger)
            obj = next((root / "vault" / "run-1").glob("*.bin"))
            self.assertEqual(obj.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(secret.encode(), obj.read_bytes())
            self.assertEqual(vault.get(ref.ref), raw)
            big = vault.put(campaign_run_id="run-1", kind="probe_log", data=b"x" * (V.MAX_RESPONSE_BYTES + 1))
            self.assertTrue(big.truncated)
            self.assertEqual(big.size, V.MAX_RESPONSE_BYTES)
            self.assertIn('"truncated":true', (tools / "security" / "evidence.jsonl").read_text(encoding="utf-8"))
            with self.assertRaises(V.VaultError):
                vault.put(campaign_run_id="run-1", kind="diary", data=b"x")
            digest = vault.seal("run-1")
            self.assertTrue(digest.startswith("sha256:"))
            with self.assertRaises(V.VaultError):
                vault.put(campaign_run_id="run-1", kind="probe_log", data=b"late")
            with self.assertRaises(FileExistsError):
                vault.seal("run-1")
            purged = vault.purge_expired(now=datetime.now(timezone.utc) + timedelta(days=V.RETENTION_DAYS_DEFAULT + 1))
            self.assertIn(ref.ref, purged)
            self.assertIn("deletion_receipt", (tools / "security" / "evidence.jsonl").read_text(encoding="utf-8"))
            with self.assertRaises(V.VaultError):
                vault.get(ref.ref)


class Campaign(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        t = Path(self._tmp.name)
        self.tools = ensure_tools_dir(t / "tools")
        repo = t / "repo"
        repo.mkdir()
        (repo / "package.json").write_text("{}", encoding="utf-8")
        prof = compile_profile(workspace_root=repo, repo_sha="s").to_row()
        self.graph = AG.build_graph(workspace_root=repo, profile_row=prof)
        AG.record_graph(self.graph, base_dir=self.tools)
        self.base = dict(profile_digest=DIG["prof"], pack_digests=[DIG["pack"]], policy_digest=DIG["pol"],
                         graph_digest=self.graph.graph_digest, lab_attestation_digest=DIG["att"], grant_jti="jti-1", grant_digest="sha256:g")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _drive(self, run, upto):
        order = ("SCOPE_VALIDATED", "LAB_PROVISIONING", "LAB_ATTESTED", "GRANT_ACTIVE", "EXECUTING", "REPLAY_VALIDATING", "EVIDENCE_SEALED")
        for s in order[: order.index(upto) + 1]:
            C.transition(run, s, base_dir=self.tools)

    def test_I_V13_CAMPAIGN_01_ordered_write_once_lifecycle(self) -> None:
        self.assertEqual(set(C.TRANSITIONS), set(C.STATES))
        self.assertEqual(C.TRANSITIONS["CLOSED"], ())
        self.assertEqual(C.TRANSITIONS["QUARANTINED"], ())
        with self.assertRaises(C.CampaignError):
            C.open_campaign(packs=(), base_dir=self.tools)
        run = C.open_campaign(packs=("api",), base_dir=self.tools)
        with self.assertRaisesRegex(C.CampaignError, "requires bound inputs"):
            C.transition(run, "SCOPE_VALIDATED", base_dir=self.tools)
        C.bind_inputs(run, base_dir=self.tools, profile_digest=DIG["prof"], pack_digests=[DIG["pack"]], policy_digest=DIG["pol"])
        with self.assertRaisesRegex(C.CampaignError, "already bound"):
            C.bind_inputs(run, base_dir=self.tools, profile_digest="sha256:" + "9" * 64)
        C.transition(run, "SCOPE_VALIDATED", base_dir=self.tools)
        with self.assertRaisesRegex(C.CampaignError, "not a legal transition"):
            C.transition(run, "EXECUTING", base_dir=self.tools)
        C.transition(run, "LAB_PROVISIONING", base_dir=self.tools)
        C.bind_inputs(run, base_dir=self.tools, graph_digest="sha256:" + "0" * 64, lease_id="lease-1", lab_attestation_digest=DIG["att"])
        with self.assertRaisesRegex(C.CampaignError, "graph"):
            C.transition(run, "LAB_ATTESTED", base_dir=self.tools)
        # cleanup without a teardown receipt quarantines; CLOSED is unreachable from there
        run2 = C.open_campaign(packs=("api",), base_dir=self.tools)
        C.bind_inputs(run2, base_dir=self.tools, lease_id="lease-2", evidence_manifest_digest="sha256:m", **self.base)
        self._drive(run2, "EVIDENCE_SEALED")
        C.transition(run2, "CLEANUP_VERIFIED", base_dir=self.tools)
        self.assertEqual(run2.state, "QUARANTINED")
        with self.assertRaises(C.CampaignError):
            C.transition(run2, "CLOSED", base_dir=self.tools)
        # with the receipt the run closes, and the fold replays the same state
        run3 = C.open_campaign(packs=("api", "multi_tenant"), base_dir=self.tools)
        C.bind_inputs(run3, base_dir=self.tools, lease_id="lease-3", evidence_manifest_digest="sha256:m", **self.base)
        self._drive(run3, "EVIDENCE_SEALED")
        L.record_teardown(lease_id="lease-3", campaign_run_id=run3.campaign_run_id, ok=True, base_dir=self.tools)
        C.transition(run3, "CLEANUP_VERIFIED", base_dir=self.tools)
        C.transition(run3, "CLOSED", base_dir=self.tools)
        folded = C.fold(run3.campaign_run_id, base_dir=self.tools)
        self.assertEqual(folded.state, "CLOSED")
        self.assertEqual(folded.inputs["graph_digest"], self.graph.graph_digest)
        self.assertEqual(folded.packs, ("api", "multi_tenant"))

    def test_I_V13_CAMPAIGN_02_kill_switch_and_mission_binding(self) -> None:
        run = C.open_campaign(packs=("api",), base_dir=self.tools)
        C.bind_inputs(run, base_dir=self.tools, lease_id="lease-k", **self.base)
        self._drive(run, "EXECUTING")
        order: list[str] = []
        steps = C.kill_switch(
            run, stop_traffic=lambda: order.append("stop"), revoke_credentials=lambda: (order.append("revoke"), 2)[1],
            kill_processes=lambda: order.append("kill"), seal_evidence=lambda: (order.append("seal"), "sha256:m")[1],
            reconcile=lambda: (order.append("reconcile"), True)[1], teardown=lambda: (order.append("teardown"), False)[1],
            base_dir=self.tools,
        )
        self.assertEqual(order, ["stop", "revoke", "kill", "seal", "reconcile", "teardown"])
        self.assertEqual(run.state, "QUARANTINED")
        self.assertIn("teardown:False", steps)
        with self.assertRaises(C.CampaignError):
            C.kill_switch(run, stop_traffic=lambda: None, revoke_credentials=lambda: 0, kill_processes=lambda: None,
                          seal_evidence=lambda: "sha256:m", reconcile=lambda: True, teardown=lambda: True, base_dir=self.tools)
        # a mission binds the run + grant (closed binding keys extended, not bypassed)
        self.assertIn("campaign_run_ids", mission.BINDING_KEYS)
        self.assertIn("grant_jtis", mission.BINDING_KEYS)
        opened = mission.open_mission(source_kind="security_hardening", source_id="sec-1", repo_hash="deadbeef", title="tenant isolation",
                                      next_action="run campaign", wake_condition={"kind": "timer", "key": "2030-01-01T00:00:00Z"}, base_dir=self.tools)
        mid = opened.get("mission_id") or opened.get("mission", {}).get("mission_id")
        run_m = C.open_campaign(packs=("api",), mission_id=mid, base_dir=self.tools)
        bound = C.bind_to_mission(run_m, grant_jti="jti-9", base_dir=self.tools)
        self.assertIsNotNone(bound)
        with self.assertRaises(Exception):
            mission.bind_mission(mission_id=mid, bindings={"campaign_targets": ["https://x"]}, step_id="s", base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
