"""Plan 033 Faz 033f — typed probes, the policy proxy (single egress), ZAP under policy.

Invariants:
  I-V13-PROBE-01   recipe steps are closed and typed; shell/script material, a mutation
                   above its risk floor, a missing positive control or a hostless HTTP
                   step are refused; the verdict fold never reads a broken harness or an
                   unreachable target as clean.
  I-V13-NETGATE-01 the policy engine allows only grant hosts/scheme, enforces the atomic
                   budget and redirect depth, forbids credential cross-origin forwarding,
                   and denies everything after the kill switch.
  I-V13-SSRF-01    DNS rebinding, metadata/loopback/out-of-lab IPs and a redirect toward a
                   production host are denied; an in-lab redirect hop is allowed (proven
                   against a loopback target through the real forward proxy).
  I-V13-ZAP-01     ZAP runs only from a sha256-pinned image (floating tag / missing pin
                   fails closed) with an Automation-Framework-allowlisted plan scoped to
                   grant hosts; alerts become UNVERIFIED leads, never findings.
  I-V13-CANCEL-01  stopping the proxy engages the kill switch (engine stopped, decisions deny).
"""
from __future__ import annotations

import http.client
import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import grant as G
from aria_kernel.security import policy_proxy as PP
from aria_kernel.security import probe as P
from aria_kernel.security import scope_policy as SP
from aria_kernel.security import zap as Z

WS = Path(__file__).resolve().parents[4]
HOST = "api.lab.internal"


def _claims(risk="R2_SYNTHETIC_MUTATION"):
    D = "sha256:" + "a" * 64
    return G.new_claims(campaign_run_id="run-1", lease_id="l", lab_attestation_digest=D, profile_digest=D,
                        pack_digests=(D,), graph_digest=D, policy_digest=D, risk_class=risk,
                        lab_network="10.99.0.0/24", allowed_hosts=(HOST,))


def _inv():
    return SP.DenyInventory(hostname_suffixes=("aquaculture.io", "suderra.com"), cidrs=(), labels=(), complete=True, digest="d")


class Probe(unittest.TestCase):
    def _recipe(self, **kw):
        steps = kw.pop("steps", (P.Step("http_request", {"host": HOST, "method": "GET", "path": "/x"}),
                                  P.Step("positive_control", {}), P.Step("assertion", {"expect": "403"})))
        base = dict(recipe_id="r", claim_type="idor", risk_class="R1_BOUNDED_READ", steps=steps)
        base.update(kw)
        return P.AttackRecipe(**base)

    def test_I_V13_PROBE_01_typed_recipe_and_fold(self) -> None:
        self._recipe().validate()
        with self.assertRaisesRegex(P.RecipeError, "forbidden"):
            self._recipe(steps=(P.Step("http_request", {"host": HOST, "shell": "curl evil"}), P.Step("positive_control", {}), P.Step("assertion", {}))).validate()
        with self.assertRaisesRegex(P.RecipeError, "R2"):
            self._recipe(steps=(P.Step("http_request", {"host": HOST, "method": "POST"}), P.Step("positive_control", {}), P.Step("assertion", {}), P.Step("cleanup", {}))).validate()
        with self.assertRaisesRegex(P.RecipeError, "positive_control"):
            self._recipe(steps=(P.Step("http_request", {"host": HOST}), P.Step("assertion", {}))).validate()
        with self.assertRaisesRegex(P.RecipeError, "host"):
            self._recipe(steps=(P.Step("http_request", {"method": "GET"}), P.Step("positive_control", {}), P.Step("assertion", {}))).validate()
        with self.assertRaisesRegex(P.RecipeError, "risk class"):
            self._recipe(risk_class="R4_FORBIDDEN").validate()
        with self.assertRaisesRegex(P.RecipeError, "cleanup"):
            self._recipe(risk_class="R2_SYNTHETIC_MUTATION", claim_type="idor",
                         steps=(P.Step("auth_token_mutation", {}), P.Step("positive_control", {}), P.Step("assertion", {}))).validate()
        with self.assertRaisesRegex(P.RecipeError, "claim type"):
            self._recipe(claim_type="mind_control").validate()
        pc = P.StepResult("positive_control", True, observed_violation=True)
        self.assertEqual(P.evaluate([P.StepResult("positive_control", True, observed_violation=False), P.StepResult("assertion", True)])[0], "HARNESS_ERROR")
        self.assertEqual(P.evaluate([])[0], "HARNESS_ERROR")
        self.assertEqual(P.evaluate([pc, P.StepResult("assertion", True, observed_violation=True)])[0], "VIOLATION_OBSERVED")
        self.assertEqual(P.evaluate([pc, P.StepResult("assertion", True)])[0], "NO_VIOLATION_OBSERVED")
        self.assertEqual(P.evaluate([pc, P.StepResult("http_request", True, truncated=True), P.StepResult("assertion", True)])[0], "INCONCLUSIVE")
        self.assertEqual(P.evaluate([pc, P.StepResult("http_request", False, target_unavailable=True)])[0], "TARGET_UNAVAILABLE")
        self.assertEqual(set(P.PROBE_VERDICTS), {"VIOLATION_OBSERVED", "NO_VIOLATION_OBSERVED", "INCONCLUSIVE", "HARNESS_ERROR", "TARGET_UNAVAILABLE"})


class NetGate(unittest.TestCase):
    def _engine(self, dns=None, effects=("mutation:updateFarm",)):
        dns = dns or {HOST: ("10.99.0.5",)}
        return PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: tuple(dns.get(h, ())), allowed_graphql_effects=effects), dns

    def test_I_V13_NETGATE_01_grant_bound_decisions(self) -> None:
        eng, _ = self._engine()
        self.assertTrue(eng.decide(method="GET", url=f"http://{HOST}/x").allow)
        self.assertFalse(eng.decide(method="GET", url="http://api.aquaculture.io/x").allow)
        self.assertFalse(eng.decide(method="GET", url=f"ftp://{HOST}/x").allow)
        self.assertFalse(eng.decide(method="GET", url=f"http://user:pw@{HOST}/x").allow)
        self.assertIn("cross-origin", eng.decide(method="GET", url=f"http://{HOST}/x", origin_host="other.lab.internal", headers={"Authorization": "Bearer x"}).reason)
        self.assertIn("body", eng.decide(method="POST", url=f"http://{HOST}/x", body=b"y" * (SP.MAX_BODY_BYTES + 1)).reason)
        self.assertIn("redirect depth", eng.decide(method="GET", url=f"http://{HOST}/x", hop=4).reason)
        eng.stop()
        self.assertFalse(eng.decide(method="GET", url=f"http://{HOST}/x").allow)

    @unittest.skipUnless(G.backend_available(), "cryptography (Ed25519) not installed — grant lane is fail-closed here")
    def test_I_V13_NETGATE_02_engine_only_from_verified_token(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as t:
            ws = Path(t) / "ws"
            ws.mkdir()
            priv, pub = G.generate_keypair(Path(t) / "keys", workspace_root=ws)
            token = G.GrantSigner(priv, workspace_root=ws).sign(_claims())
            eng = PP.PolicyEngine.from_token(token, pub.read_bytes(), inventory=_inv(), resolver=lambda h: ("10.99.0.5",),
                                             expected={"campaign_run_id": "run-1"})
            self.assertTrue(eng.decide(method="GET", url=f"http://{HOST}/x").allow)
            h, p, s = token.split(".")
            with self.assertRaises(G.GrantError):
                PP.PolicyEngine.from_token(f"{h}.{p}.{s[:-4]}AAAA", pub.read_bytes(), inventory=_inv(), resolver=lambda h: ("10.99.0.5",))
            with self.assertRaises(G.GrantError):
                PP.PolicyEngine.from_token(token, pub.read_bytes(), inventory=_inv(), resolver=lambda h: ("10.99.0.5",),
                                           expected={"campaign_run_id": "run-2"})

    def test_I_V13_NETGATE_01_graphql_effect_catalog(self) -> None:
        eng, _ = self._engine()
        self.assertTrue(eng.decide(method="POST", url=f"http://{HOST}/graphql", body=b'{"query":"mutation { updateFarm(id:1){id} }"}').allow)
        self.assertIn("not in the grant effect catalog", eng.decide(method="POST", url=f"http://{HOST}/graphql", body=b'{"query":"mutation { deleteTenant(id:1) }"}').reason)
        self.assertIn("persisted", eng.decide(method="POST", url=f"http://{HOST}/graphql", body=b'{"extensions":{"persistedQuery":{"sha256Hash":"x"}}}').reason)
        self.assertTrue(eng.decide(method="POST", url=f"http://{HOST}/graphql", body=b'{"query":"{ farms { id } }"}').allow)

    def test_I_V13_NETGATE_01_atomic_budget(self) -> None:
        eng = PP.PolicyEngine(grant=_claims("R1_BOUNDED_READ"), inventory=_inv(), resolver=lambda h: ("10.99.0.5",))
        allowed = sum(eng.decide(method="GET", url=f"http://{HOST}/x").allow for _ in range(SP.CEILINGS["R1_BOUNDED_READ"].max_requests + 5))
        self.assertEqual(allowed, SP.CEILINGS["R1_BOUNDED_READ"].max_requests)


class Ssrf(unittest.TestCase):
    def test_I_V13_SSRF_01_engine_denies_escapes(self) -> None:
        dns = {HOST: ("10.99.0.5",)}
        eng = PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: tuple(dns.get(h, ())))
        self.assertTrue(eng.decide(method="GET", url=f"http://{HOST}/x").allow)
        dns[HOST] = ("10.99.0.5", "1.1.1.1")
        self.assertIn("rebinding", eng.decide(method="GET", url=f"http://{HOST}/x").reason)
        meta = PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: ("169.254.169.254",))
        self.assertFalse(meta.decide(method="GET", url=f"http://{HOST}/x").allow)
        out = PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: ("10.1.2.3",))
        self.assertFalse(out.decide(method="GET", url=f"http://{HOST}/x").allow)

    def test_I_V13_SSRF_01_forward_proxy_redirect(self) -> None:
        class Target(BaseHTTPRequestHandler):
            def log_message(self, *a):
                return

            def do_GET(self):
                if self.path == "/to-prod":
                    self.send_response(302); self.send_header("Location", "http://api.aquaculture.io/steal"); self.send_header("Content-Length", "0"); self.end_headers(); return
                if self.path == "/to-lab":
                    self.send_response(302); self.send_header("Location", f"http://{HOST}/final"); self.send_header("Content-Length", "0"); self.end_headers(); return
                body = json.dumps({"path": self.path}).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        target = HTTPServer(("127.0.0.1", 0), Target)
        threading.Thread(target=target.serve_forever, daemon=True).start()
        self.addCleanup(target.shutdown)
        eng = PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: ("10.99.0.5",))
        proxy = PP.ProxyServer(eng, dialer=lambda ip, port: socket.create_connection(target.server_address, timeout=5))
        proxy.start()
        self.addCleanup(proxy.stop)

        def via(url):
            c = http.client.HTTPConnection(*proxy.address, timeout=5)  # allowlist-external-network: loopback only — connects to the in-test ProxyServer on 127.0.0.1, whose dialer targets the in-test HTTPServer
            c.request("GET", url)
            r = c.getresponse()
            return r.status, r.read()

        self.assertEqual(via(f"http://{HOST}/ok")[0], 200)
        self.assertEqual(via("http://api.aquaculture.io/x")[0], 403)
        status, body = via(f"http://{HOST}/to-prod")
        self.assertEqual(status, 403)
        self.assertIn(b"aquaculture.io", body)
        status, body = via(f"http://{HOST}/to-lab")
        self.assertEqual(status, 200)
        self.assertIn(b"/final", body)

    def test_I_V13_CANCEL_01_proxy_stop_is_kill_switch(self) -> None:
        eng = PP.PolicyEngine(grant=_claims(), inventory=_inv(), resolver=lambda h: ("10.99.0.5",))
        proxy = PP.ProxyServer(eng)
        proxy.start()
        proxy.stop()
        self.assertTrue(eng.stopped)
        self.assertFalse(eng.decide(method="GET", url=f"http://{HOST}/x").allow)


class Zap(unittest.TestCase):
    def test_I_V13_ZAP_01_pin_and_allowlist(self) -> None:
        with self.assertRaises(Z.ZapPolicyError):
            Z.load_zap_pin(WS)  # repo pin has an empty digest → fails closed
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "infrastructure" / "aria" / "security-lab"
            p.mkdir(parents=True)
            (p / "zap.pin.json").write_text(json.dumps({"image": "ghcr.io/zaproxy/zaproxy", "digest": "sha256:" + "f" * 64, "pinned_by": "op", "pinned_at": "2026-09-03"}), encoding="utf-8")
            self.assertEqual(Z.load_zap_pin(t)["reference"], "ghcr.io/zaproxy/zaproxy@sha256:" + "f" * 64)
            (p / "zap.pin.json").write_text(json.dumps({"image": "ghcr.io/zaproxy/zaproxy:stable", "digest": "sha256:" + "f" * 64, "pinned_by": "op", "pinned_at": "x"}), encoding="utf-8")
            with self.assertRaisesRegex(Z.ZapPolicyError, "floating tag|bare repository"):
                Z.load_zap_pin(t)
        plan = {"env": {"contexts": [{"name": "lab", "urls": [f"http://{HOST}"]}]},
                "jobs": [{"type": "passiveScan-config"}, {"type": "openapi", "parameters": {"apiUrl": f"http://{HOST}/openapi.json"}}, {"type": "activeScan"}, {"type": "report"}]}
        self.assertEqual(Z.validate_automation_plan(plan, allowed_hosts=(HOST,)), ["passiveScan-config", "openapi", "activeScan", "report"])
        for bad in ({**plan, "jobs": [{"type": "script", "parameters": {"a": "1"}}, {"type": "report"}]},
                    {**plan, "env": {"contexts": [{"name": "x", "urls": ["http://api.aquaculture.io"]}]}},
                    {**plan, "jobs": [{"type": "openapi", "parameters": {"apiUrl": "https://evil.example/x"}}, {"type": "report"}]},
                    {**plan, "jobs": [{"type": "spider"}]}):
            with self.assertRaises(Z.ZapPolicyError):
                Z.validate_automation_plan(bad, allowed_hosts=(HOST,))
        with self.assertRaises(Z.ZapPolicyError):
            Z.build_zap_job(plan, workspace_root=WS, allowed_hosts=(HOST,))  # repo pin empty → no job, ever
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "infrastructure" / "aria" / "security-lab"
            p.mkdir(parents=True)
            (p / "zap.pin.json").write_text(json.dumps({"image": "ghcr.io/zaproxy/zaproxy", "digest": "sha256:" + "f" * 64, "pinned_by": "op", "pinned_at": "2026-09-03"}), encoding="utf-8")
            job = Z.build_zap_job(plan, workspace_root=t, allowed_hosts=(HOST,))
            self.assertEqual(job["image_reference"], "ghcr.io/zaproxy/zaproxy@sha256:" + "f" * 64)
            self.assertEqual(job["jobs"][-1], "report")
            self.assertTrue(job["plan_digest"].startswith("sha256:"))
            with self.assertRaises(Z.ZapPolicyError):
                Z.build_zap_job({**plan, "jobs": [{"type": "script"}, {"type": "report"}]}, workspace_root=t, allowed_hosts=(HOST,))
        leads = Z.alerts_to_leads({"site": [{"alerts": [{"pluginid": "10021", "name": "X missing", "riskdesc": "Low (Medium)", "instances": [{}]}]}]}, service="api")
        self.assertEqual(leads[0]["trust_grade"], "runtime_unverified")
        self.assertEqual(leads[0]["source"], "external_scanner")


if __name__ == "__main__":
    unittest.main()
