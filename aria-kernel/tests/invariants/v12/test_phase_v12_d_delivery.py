"""Plan 032 Faz 032d — single-worker delivery closure.

Invariants:
  I-V12-DLV-01  exactly one runtime profile (implementer) holds `external_writes`;
                the Claude permission projection for it allows the aria-impl push
                and still denies force-push / gh api.
  I-V12-DLV-02  `issue_delivery_credentials` returns None without the grant; with
                it the env carries GH_TOKEN + an env-only git credential helper,
                the governance ledger names the env keys and mode but NEVER the
                token value, PAT mode fires `installation_token_fallback_active`,
                and a mint failure is a refusal (governance row + error).
  I-V12-DLV-03  the built spawn env accepts executor extras verbatim (GH_TOKEN is
                secret-shaped and would otherwise be dropped); `run_claude_exec`
                exposes `extra_env`; the executor issues before the spawn, exports
                ARIA_REQUEST_ID, and revokes in `finally` (source-level pins).
  I-V12-DLV-04  `pr_manager` keys intents on ARIA_REQUEST_ID inside a spawn and on
                `proposal:<id>` outside it; postconditions carry proposal_id.
  I-V12-DLV-05  delivery closure derives the closed state vocabulary from real
                ledger rows: accepted-without-PR is false success, two PRs for one
                request is a duplicate, own_pr_ci `cleared` is the verified state,
                and the SLO cannot be met by anything but ≥3 verified PRs.
  I-V12-DLV-06  `doctor` carries the `delivery_closure` organ (fail on duplicates,
                warn on false success) and the CLI exposes `delivery status`.
  I-V12-DLV-07  the implementer agent file is back under the 200-line cap.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import delivery_closure as dc
from aria_kernel import delivery_credentials as dcred
from aria_kernel import recovery
from aria_kernel.agent_env import build_agent_env
from aria_kernel.command_policy import claude_permission_rules, claude_rule_matches
from aria_kernel.doctor import run_doctor
from aria_kernel.gh_token_factory import InstallationTokenLease
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.runtime_profiles import load_runtime_profiles
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


def _lease(tmp: Path, token: str, *, fallback: bool) -> InstallationTokenLease:
    path = tmp / "lease.token"
    path.write_text(token, encoding="utf-8")
    return InstallationTokenLease(
        cycle_id="cyc-test-1", token_file=path, ttl_seconds=600,
        gh_app_installation_id=None if fallback else "42", fallback_active=fallback,
        minted_at_utc=datetime.now(timezone.utc).isoformat(),
    )


class TheGrantIsSingular(unittest.TestCase):
    def test_I_V12_DLV_01_only_the_implementer_writes_externally(self) -> None:
        profiles = load_runtime_profiles()
        holders = [pid for pid, p in profiles.items() if p.external_writes]
        self.assertEqual(holders, ["implementer"])
        allow, deny = claude_permission_rules(external_writes=True)
        self.assertTrue(any(claude_rule_matches(r, "git push origin aria-impl-0abc12") for r in allow), allow)
        # The Claude-rule layer carries no force-push deny (allow rules do not restrict
        # under bypass); the HOOK layer's allowlist is what refuses it — assert there.
        from aria_kernel.implementation_safety import verify_bash_command_allowed

        verify_bash_command_allowed(["git", "push", "origin", "aria-impl-0abc12"])
        with self.assertRaises(Exception):
            verify_bash_command_allowed(["git", "push", "--force", "origin", "main"])
        self.assertTrue(any(claude_rule_matches(r, "gh api repos/x/y -X DELETE") for r in deny), deny)


class CredentialsAreScoped(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _governance_text(self) -> str:
        return (self.tools / "governance.jsonl").read_text(encoding="utf-8")

    def test_I_V12_DLV_02_none_without_grant_scoped_with_it(self) -> None:
        closed = SimpleNamespace(external_writes=False, profile_id="worker")
        self.assertIsNone(dcred.issue_delivery_credentials(
            profile=closed, request_id="AIR-1", cycle_id="cyc-1", workspace_root=self.root, base_dir=self.tools,
            mint=lambda **kw: self.fail("mint must not run without the grant"),
        ))
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        seen: dict[str, object] = {}

        def mint(**kw):
            seen.update(kw)
            return _lease(self.root, "ghs_secretvalue_123", fallback=False)

        cred = dcred.issue_delivery_credentials(
            profile=granted, request_id="AIR-1", cycle_id="x", workspace_root=self.root, base_dir=self.tools,
            ttl_seconds=60, mint=mint,
        )
        self.assertIsNotNone(cred)
        assert cred is not None
        self.assertEqual(cred.env["GH_TOKEN"], "ghs_secretvalue_123")
        self.assertEqual(cred.env["GIT_CONFIG_VALUE_0"], "!gh auth git-credential")
        self.assertEqual(cred.mode, "installation")
        self.assertEqual(seen["ttl_seconds"], dcred.MIN_DELIVERY_TTL_SECONDS, "TTL floor binds")
        self.assertRegex(str(seen["cycle_id"]), r"^[A-Za-z0-9_-]{6,64}$")
        text = self._governance_text()
        self.assertIn(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT, text)
        self.assertIn('"GH_TOKEN"', text, "env NAMES are recorded")
        self.assertNotIn("ghs_secretvalue_123", text, "the value never lands on a ledger")
        self.assertNotIn(dcred.INSTALLATION_TOKEN_FALLBACK_EVENT, text)

        revoked: list[str] = []
        dcred.revoke_delivery_credentials(cred, request_id="AIR-1", base_dir=self.tools,
                                          revoke=lambda *, lease: revoked.append(lease.cycle_id))
        self.assertEqual(revoked, ["cyc-test-1"])
        self.assertFalse(cred.lease.token_file.exists())
        self.assertIn(dcred.DELIVERY_CREDENTIAL_REVOKED_EVENT, self._governance_text())

    def test_I_V12_DLV_02_pat_fallback_and_refusal_are_visible(self) -> None:
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        cred = dcred.issue_delivery_credentials(
            profile=granted, request_id="AIR-2", cycle_id="cyc-2", workspace_root=self.root, base_dir=self.tools,
            mint=lambda **kw: _lease(self.root, "ghp_operatorpat", fallback=True),
        )
        assert cred is not None
        self.assertEqual(cred.mode, "pat_fallback")
        self.assertIn(dcred.INSTALLATION_TOKEN_FALLBACK_EVENT, self._governance_text())
        with self.assertRaises(dcred.DeliveryCredentialError):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-3", cycle_id="cyc-3", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: (_ for _ in ()).throw(RuntimeError("no app")),
            )
        self.assertIn(dcred.DELIVERY_CREDENTIAL_REFUSED_EVENT, self._governance_text())
        with self.assertRaises(dcred.DeliveryCredentialError):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-4", cycle_id="cyc-4", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: _lease(self.root, "", fallback=False),
            )

    def test_I_V12_DLV_03_extras_reach_the_built_env_and_the_executor_brackets_the_spawn(self) -> None:
        built = build_agent_env({"PATH": "/usr/bin", "GH_TOKEN": "ambient"}, profile_passthrough=(),
                                extra={"GH_TOKEN": "scoped", "ARIA_REQUEST_ID": "AIR-9"}, home=self.root / "home")
        self.assertEqual(built.env["GH_TOKEN"], "scoped", "the executor's scoped value, never the ambient one")
        self.assertIn("GH_TOKEN", built.report.passed)
        self.assertEqual(built.env["ARIA_REQUEST_ID"], "AIR-9")
        dropped = build_agent_env({"PATH": "/usr/bin", "GH_TOKEN": "ambient"}, profile_passthrough=(), home=self.root / "home2")
        self.assertNotIn("GH_TOKEN", dropped.env, "without the executor's extra the ambient token is dropped")
        import claude_runtime

        self.assertIn("extra_env", inspect.signature(claude_runtime.run_claude_exec).parameters)
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        issue = executor.index("issue_delivery_credentials(")
        spawn = executor.index("extra_env=spawn_extra_env")
        revoke = executor.index("revoke_delivery_credentials(")
        self.assertLess(issue, spawn)
        self.assertLess(spawn, revoke)
        self.assertIn('"ARIA_REQUEST_ID": str(request_id)', executor)
        self.assertIn("    finally:\n        # Plan 032 Faz 032d", executor)
        self.assertIn("return DELIVERY_CREDENTIAL_EXIT", executor)


class IntentsAreKeyedOnTheRequest(unittest.TestCase):
    def test_I_V12_DLV_04_request_id_from_env(self) -> None:
        self.assertEqual(dcred.request_id_from_env("proposal:p1", environ={}), "proposal:p1")
        self.assertEqual(dcred.request_id_from_env("proposal:p1", environ={"ARIA_REQUEST_ID": "AIR-7"}), "AIR-7")
        from aria_kernel import pr_manager

        with mock.patch.dict(os.environ, {"ARIA_REQUEST_ID": "AIR-7"}):
            self.assertEqual(pr_manager._effect_request_id("p1"), "AIR-7")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_REQUEST_ID", None)
            self.assertEqual(pr_manager._effect_request_id("p1"), "proposal:p1")
        source = (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "pr_manager.py").read_text(encoding="utf-8")
        self.assertNotIn('request_id=f"proposal:{proposal_id}"', source)
        self.assertEqual(source.count('"proposal_id": proposal_id}'), 2, "both postconditions carry the proposal")


class ClosureIsDerived(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _row(self, rel: tuple[str, ...], surface: str, row: dict) -> None:
        path = self.tools.joinpath(*rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {"schema_version": 1, "recorded_at": "2026-09-03T00:00:00+00:00", **row}, expected_surface=surface)

    def _request(self, rid: str, role: str = "implementation") -> None:
        self._row(("agent-invocations", "requests.jsonl"), "agent_invocation_requests",
                  {"row_id": f"request:{rid}", "row_type": "request", "request_id": rid, "role": role,
                   "target_agent": "aria-implementer", "state": "PENDING", "created_at": f"2026-09-03T00:00:0{rid[-1]}+00:00"})

    def _claim(self, rid: str, cid: str, *, release: str | None = None) -> None:
        self._row(("agent-invocations", "claims.jsonl"), "agent_invocation_claims",
                  {"row_type": "claim", "event": "claimed", "claim_id": cid, "request_id": rid, "agent_id": "aria-implementer"})
        if release:
            self._row(("agent-invocations", "claims.jsonl"), "agent_invocation_claims",
                      {"row_type": "claim", "event": "released", "claim_id": cid, "request_id": rid, "reason": release})

    def _accept(self, rid: str, cid: str) -> None:
        self._row(("agent-invocations", "results.jsonl"), "agent_invocation_results",
                  {"row_id": f"result:{cid}", "row_type": "result", "claim_id": cid, "request_id": rid, "status": "accepted", "role": "implementation"})

    def _pr(self, rid: str, number: int, *, proposal: str) -> None:
        push = recovery.record_intent(request_id=rid, effect_kind="git_push", target=f"origin/aria-impl-{number}",
                                      intended_postcondition={"branch": f"aria-impl-{number}", "proposal_id": proposal}, base_dir=self.tools)
        recovery.record_receipt(operation_id=push["operation_id"], request_id=rid, observed={"branch": f"aria-impl-{number}"}, base_dir=self.tools)
        intent = recovery.record_intent(request_id=rid, effect_kind="pr_create", target=f"main<-aria-impl-{number}",
                                        intended_postcondition={"head_ref": f"aria-impl-{number}", "proposal_id": proposal}, base_dir=self.tools)
        recovery.record_receipt(operation_id=intent["operation_id"], request_id=rid,
                                observed={"pr_number": number, "url": f"https://github.com/o/r/pull/{number}"}, base_dir=self.tools)

    def _ci(self, number: int, status: str, red: list[str] | None = None) -> None:
        self._row(("ci", "own-pr-checks.jsonl"), "own_pr_checks",
                  {"cycle_id": "cyc", "pr_number": number, "head_ref": f"aria-impl-{number}", "head_sha": "a" * 40,
                   "red_jobs": red or [], "status": status})

    def test_I_V12_DLV_05_states_and_slo_from_rows(self) -> None:
        self._request("AIR-1"); self._request("AIR-2"); self._request("AIR-3"); self._request("AIR-4"); self._request("AIR-5")
        self._request("AIR-6", role="challenger_plan")
        # AIR-1: accepted, nothing delivered → false success
        self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        # AIR-2: delivered + verified
        self._claim("AIR-2", "c2"); self._accept("AIR-2", "c2"); self._pr("AIR-2", 20, proposal="p2"); self._ci(20, "cleared")
        # AIR-3: PR red
        self._claim("AIR-3", "c3"); self._accept("AIR-3", "c3"); self._pr("AIR-3", 30, proposal="p3"); self._ci(30, "open", ["aria-kernel"])
        # AIR-4: two PRs for one request → duplicate
        self._claim("AIR-4", "c4"); self._accept("AIR-4", "c4"); self._pr("AIR-4", 40, proposal="p4"); self._pr("AIR-4", 41, proposal="p4")
        # AIR-5: released twice, nothing else
        self._claim("AIR-5", "c5a", release="claude_cli_exit_1"); self._claim("AIR-5", "c5b", release="submit_timeout_120s")
        report = dc.compute_delivery_closure(base_dir=self.tools)
        states = {r.request_id: r.state for r in report.records}
        self.assertEqual(states, {"AIR-1": "result_accepted", "AIR-2": "ci_green", "AIR-3": "ci_red",
                                  "AIR-4": "duplicate", "AIR-5": "released"})
        self.assertNotIn("AIR-6", states, "only implementation requests are delivery requests")
        rec = {r.request_id: r for r in report.records}
        self.assertTrue(rec["AIR-2"].delivered)
        self.assertEqual(rec["AIR-2"].pr_numbers, [20])
        self.assertEqual(rec["AIR-3"].red_jobs, ["aria-kernel"])
        self.assertEqual(rec["AIR-5"].last_release_reason, "submit_timeout_120s")
        self.assertEqual(rec["AIR-4"].proposal_ids, ["p4"])
        s = report.summary
        self.assertEqual((s["verified_prs"], s["false_success"], s["duplicate_prs"], s["red_prs"]), (1, 1, 1, 1))
        self.assertFalse(s["slo"]["met"])
        self.assertEqual(s["slo"]["gaps"], ["verified_prs<3", "false_success>0", "duplicate_prs>0"])
        self.assertEqual(set(s["by_state"]), set(dc.DELIVERY_STATES))
        for state in states.values():
            self.assertIn(state, dc.DELIVERY_STATES)

    def test_I_V12_DLV_05_pending_intents_merge_and_lifecycle_link(self) -> None:
        self._request("AIR-1"); self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        recovery.record_intent(request_id="AIR-1", effect_kind="git_push", target="origin/aria-impl-9",
                               intended_postcondition={"branch": "aria-impl-9", "proposal_id": "p9"}, base_dir=self.tools)
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual(report.records[0].state, "push_pending")
        self.assertEqual(report.summary["unresolved_intents"], 1)
        # a lifecycle `opened` row for the same proposal links the PR even without a receipt
        self._row(("pr-lifecycle.jsonl",), "pr_lifecycle", {"cycle_id": "cyc", "event": "opened", "pr_number": 9, "proposal_id": "p9"})
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual((report.records[0].state, report.records[0].pr_numbers), ("pr_opened", [9]))
        self._row(("ci", "merge-outcomes.jsonl"), "merge_outcomes",
                  {"cycle_id": "cyc", "pr_number": 9, "head_ref": "aria-impl-9", "merge_sha": "b" * 40, "red_jobs": [], "pending_jobs": [], "status": "green"})
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual(report.records[0].state, "merged")
        self.assertTrue(report.records[0].delivered)
        text = dc.render_delivery_text(report)
        self.assertIn("AIR-1", text)
        self.assertIn("SLO met: false", text)

    def test_I_V12_DLV_06_doctor_organ_and_cli(self) -> None:
        healthy = run_doctor(base_dir=self.tools, workspace_root=self.root)
        organ = next(c for c in healthy.checks if c.name == "delivery_closure")
        self.assertEqual((organ.status, organ.reason), ("ok", "no_implementation_requests"))
        self._request("AIR-1"); self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks if c.name == "delivery_closure")
        self.assertEqual(organ.status, "warn")
        self._pr("AIR-1", 1, proposal="p1"); self._pr("AIR-1", 2, proposal="p1")
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks if c.name == "delivery_closure")
        self.assertEqual((organ.status, organ.reason), ("fail", "duplicate_prs"))
        from aria_kernel.cli import build_parser

        args = build_parser().parse_args(["delivery", "status", "--json"])
        self.assertEqual((args.command, args.delivery_command, args.json), ("delivery", "status", True))

    def test_I_V12_DLV_07_implementer_agent_file_within_cap(self) -> None:
        text = (_REPO_ROOT / ".claude" / "agents" / "aria-implementer.md").read_text(encoding="utf-8")
        self.assertLessEqual(text.count("\n"), 200)
        self.assertIn("runtime_profile: implementer", text)


if __name__ == "__main__":
    unittest.main()
