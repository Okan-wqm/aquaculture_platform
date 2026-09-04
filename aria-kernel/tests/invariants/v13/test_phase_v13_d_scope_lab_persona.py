"""Plan 033 Faz 033d — scope policy, ephemeral lab contracts, persona broker.

Invariants:
  I-V13-SCOPE-01   risk classes + ceilings are closed; production hosts, metadata,
                   loopback, out-of-lab addresses are R4_FORBIDDEN; IPv4-mapped IPv6
                   is canonicalised; an incomplete deny inventory caps auto risk at R0.
  I-V13-SCOPE-02   the budget is atomic and enforces the R2 mutation ceiling; R0/R4
                   consume nothing.
  I-V13-LAB-01     floating image tags, untrusted provisioners and <2 tenants are refused;
                   there is no arbitrary-target path (CLI exposes no register command).
  I-V13-LAB-02     attestation binds spec digest and refuses lab/production overlap;
                   dry-run leases are honest (never qualifying).
  I-V13-TEARDOWN-01 no receipt / leaked resources → teardown not verified.
  I-V13-PERSONA-01 secrets never reach the ledger or repr; leak tripwire fires;
                   revocation is per campaign and final.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.cli import build_parser
from aria_kernel.security import lab as L
from aria_kernel.security import persona as P
from aria_kernel.security import scope_policy as SP
from aria_kernel.tool_registry import ensure_tools_dir

WS = Path(__file__).resolve().parents[4]


def _spec() -> L.LabSpec:
    return L.LabSpec(template="aqua-two-tenant-v1", image_digests={"api": "sha256:" + "a" * 64},
                     migration_digest="sha256:m", seed_digest="sha256:s", network_cidr="10.99.0.0/24")


class Scope(unittest.TestCase):
    def test_I_V13_SCOPE_01_forbidden_targets(self) -> None:
        inv = SP.load_deny_inventory(WS)
        self.assertEqual(SP.RISK_CLASSES[-1], "R4_FORBIDDEN")
        self.assertEqual(set(SP.CEILINGS), set(SP.RISK_CLASSES))
        lab = "10.99.0.0/24"
        cases = {
            ("api.aquaculture.io", ("1.2.3.4",)): "R4_FORBIDDEN",
            ("app.suderra.com", ("10.99.0.9",)): "R4_FORBIDDEN",
            ("api.lab.internal", ("169.254.169.254",)): "R4_FORBIDDEN",
            ("api.lab.internal", ("127.0.0.1",)): "R4_FORBIDDEN",
            ("api.lab.internal", ("8.8.8.8",)): "R4_FORBIDDEN",
            ("api.lab.internal", ("10.1.0.5",)): "R4_FORBIDDEN",
            ("api.lab.internal", ()): "R4_FORBIDDEN",
            ("api.lab.internal", ("10.99.0.5", "10.99.0.6")): "R1_BOUNDED_READ",
            ("api.lab.internal", ("::ffff:10.99.0.5",)): "R1_BOUNDED_READ",
        }
        for (host, ips), want in cases.items():
            got, _ = SP.classify_target(host=host, resolved_ips=ips, inventory=inv, lab_network=lab)
            self.assertEqual(got, want, (host, ips))
        # a host that resolves partly outside the lab is forbidden as a whole (rebinding)
        got, _ = SP.classify_target(host="api.lab.internal", resolved_ips=("10.99.0.5", "1.1.1.1"), inventory=inv, lab_network=lab)
        self.assertEqual(got, "R4_FORBIDDEN")
        policy = SP.load_policy(WS)
        if not inv.complete:
            self.assertEqual(policy.max_auto_risk(), "R0_PASSIVE", "incomplete inventory must cap automatic risk")
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(SP.DenyInventoryUnavailable):
                SP.load_deny_inventory(t)

    def test_I_V13_SCOPE_02_atomic_budget(self) -> None:
        b = SP.Budget("R2_SYNTHETIC_MUTATION")
        allowed = sum(b.try_consume(mutation=True)[0] for _ in range(SP.CEILINGS["R2_SYNTHETIC_MUTATION"].max_mutations + 5))
        self.assertEqual(allowed, SP.CEILINGS["R2_SYNTHETIC_MUTATION"].max_mutations)
        self.assertFalse(SP.Budget("R0_PASSIVE").try_consume()[0])
        self.assertFalse(SP.Budget("R4_FORBIDDEN").try_consume()[0])
        self.assertFalse(SP.Budget("R1_BOUNDED_READ").try_consume(bytes_out=SP.MAX_BODY_BYTES + 1)[0])
        with self.assertRaises(ValueError):
            SP.Budget("R9")


class Lab(unittest.TestCase):
    def test_I_V13_LAB_01_refusals_and_no_register_cli(self) -> None:
        with self.assertRaises(L.LabError):
            L.LabSpec(template="aqua-two-tenant-v1", image_digests={"api": "nginx:latest"}, migration_digest="m",
                      seed_digest="s", network_cidr="10.99.0.0/24").validate()
        with self.assertRaises(L.LabError):
            L.LabSpec(template="aqua-two-tenant-v1", image_digests={}, migration_digest="m", seed_digest="s",
                      network_cidr="10.99.0.0/24", tenants=("only-one",)).validate()
        with self.assertRaises(L.LabError):
            L.LabSpec(template="prod-mirror", image_digests={}, migration_digest="m", seed_digest="s", network_cidr="10.99.0.0/24").validate()
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(L.LabError):
                L.record_lease(_spec(), campaign_run_id="r", provisioner_kind="operator_cli", target_hosts=("x",),
                               expires_at="2030-01-01T00:00:00Z", base_dir=ensure_tools_dir(Path(t) / "tools"))
        parser = build_parser()
        for argv in (["security", "lab", "register"], ["security", "target", "add"], ["security", "campaign", "run", "--target", "https://x"]):
            with self.assertRaises(SystemExit):
                parser.parse_args(argv)

    def test_I_V13_LAB_02_attestation_overlap_and_dry_run(self) -> None:
        inv = SP.load_deny_inventory(WS)
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            spec = _spec()
            lease = L.dry_run_provision(spec, campaign_run_id="run-1", expires_at="2030-01-01T00:00:00Z", base_dir=tools)
            self.assertFalse(lease.qualifying, "dry-run is never a qualifying cycle")
            att = L.attest_lab(spec, lease, inv)
            self.assertEqual(att.spec_digest, spec.digest)
            self.assertFalse(att.qualifying)
            overlap = SP.DenyInventory(hostname_suffixes=(), cidrs=("10.99.0.0/16",), labels=(), complete=True, digest="d")
            with self.assertRaisesRegex(L.LabError, "overlaps"):
                L.attest_lab(spec, lease, overlap)
            bad = SP.DenyInventory(hostname_suffixes=(), cidrs=("not-a-cidr",), labels=(), complete=True, digest="d")
            with self.assertRaisesRegex(L.LabError, "unparseable"):
                L.attest_lab(spec, lease, bad)
            prod_host = SP.DenyInventory(hostname_suffixes=("lab.internal",), cidrs=(), labels=(), complete=True, digest="d")
            with self.assertRaisesRegex(L.LabError, "production deny inventory"):
                L.attest_lab(spec, lease, prod_host)


class Teardown(unittest.TestCase):
    def test_I_V13_TEARDOWN_01_receipt_required(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            self.assertFalse(L.teardown_verified("lease-x", base_dir=tools))
            L.record_teardown(lease_id="lease-x", campaign_run_id="r", ok=True, leaked_resources=("vol-1",), base_dir=tools)
            self.assertFalse(L.teardown_verified("lease-x", base_dir=tools), "leaked resources are not a clean teardown")
            L.record_teardown(lease_id="lease-x", campaign_run_id="r", ok=True, base_dir=tools)
            self.assertTrue(L.teardown_verified("lease-x", base_dir=tools))


class Persona(unittest.TestCase):
    def test_I_V13_PERSONA_01_no_leak_and_revoke(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            broker = P.PersonaBroker(base_dir=tools)
            with self.assertRaises(P.PersonaError):
                broker.issue(campaign_run_id="r1", role="root", tenant="t")
            h = broker.issue(campaign_run_id="r1", role="tenant_user", tenant="tenant-a")
            other = broker.issue(campaign_run_id="r2", role="tenant_admin", tenant="tenant-b")
            secret = broker.secret_for(h.handle)
            self.assertNotIn(secret, (tools / "security" / "personas.jsonl").read_text(encoding="utf-8"))
            self.assertNotIn(secret, repr(broker))
            with self.assertRaises(P.PersonaError):
                broker.assert_no_leak(f"Authorization: Bearer {secret}")
            broker.assert_no_leak("clean text")
            self.assertEqual(broker.revoke_campaign("r1"), 1)
            self.assertFalse(broker.is_active(h.handle))
            self.assertTrue(broker.is_active(other.handle), "revocation is per campaign")
            with self.assertRaises(P.PersonaError):
                broker.secret_for(h.handle)


if __name__ == "__main__":
    unittest.main()
