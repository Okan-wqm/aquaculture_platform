"""ARIA-HIGH-122 — a condition the kernel can NAME is a condition it can plan against.

CONFIRMED at 62c9864ae: `scan_signals` read capability gaps, funnel stalls,
delivery gaps, MCP quarantine, doctor organs and deadlines. A recurring
harness-class release (`native_runtime_provider_undecided`), an open
HUMAN_REQUIRED class (`lease_lifecycle`) and a lapsed dated waiver were no
self-improvement source at all, so a changed environment waited for an
operator instead of becoming a `propose_self_change` mission.

These pins drive the real producers (request → claim → release, the
HUMAN_REQUIRED recorder, the waiver manifest the gates read) and hold:
* one signal per CLASS, never one per record, with a bounded evidence list;
* a class the kernel can adapt to is a self-change signal the opener mints;
* a credential, subscription or vendor class — and a class the routing
  table does not know — is announced and never minted (fail closed);
* the loop's own adjudications never feed back into it;
* every harness release code and every waiver manifest has a routing
  decision written down, so a new one is caught here, not defaulted.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import adaptation_signals as adaptation
from aria_kernel import deadlines, self_improvement as si
from aria_kernel import doctor as doctor_module
from aria_kernel.agent_invocations import claim_request, create_agent_invocation_request, release_claim
from aria_kernel.doctor import DoctorReport
from aria_kernel.human_required import record_human_required
from aria_kernel.request_admission import admit_request
from aria_kernel.surface_waivers import DORMANT_CONTROL_MANIFEST, WAIVER_MANIFESTS, waiver_manifest_path
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.hermetic_git import apply_hermetic_git_env
from tests._helpers.registry_projection import project_registry_as_stored


def _git_env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    apply_hermetic_git_env(env)
    return env


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        project_registry_as_stored(self)
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True, env=_git_env())
        self.tools = ensure_tools_dir(root / "aria-tools")
        for manifest in WAIVER_MANIFESTS:
            self.write_waivers(manifest, {})
        registry = self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH)
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text("", encoding="utf-8")
        # The doctor reads the host; its organs are not what this file reasons about.
        report = DoctorReport(checks=(), tools_dir=str(self.tools), workspace_root=str(self.ws))
        patcher = mock.patch.object(doctor_module, "run_doctor", lambda **_kwargs: report)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_waivers(self, manifest, payload: dict) -> None:
        path = waiver_manifest_path(self.ws, manifest)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def release(self, reason: str, *, times: int) -> list[str]:
        """`times` requests, each claimed and released by the real lease primitives."""
        ids: list[str] = []
        for index in range(times):
            request = create_agent_invocation_request(
                target_agent="aria-primary-planner", role="primary_plan", suggested_prompt=f"{reason} {index}",
                must_satisfy=[{"id": "adaptation-fixture", "description": "a request the executor released"}],
                allowed_scope=["aria-kernel/**"], base_dir=self.tools,
                admission=admit_request("operator_cli.request", "primary_plan", base_dir=self.tools),
            )
            claim = claim_request(request_id=request["request_id"], agent_id="worker-1", base_dir=self.tools)
            release_claim(claim_id=claim["claim_id"], agent_id="worker-1", lease_token=claim["lease_token"],
                          reason=reason, base_dir=self.tools)
            ids.append(str(request["request_id"]))
        return ids

    def escalate(self, kind: str | None, *, times: int, reason: str = "an escalation") -> list[str]:
        ids = [f"AIR-{(kind or 'none').replace('_', '-')}-{index:03d}" for index in range(times)]
        for request_id in ids:
            record_human_required(request_id=request_id, severity="MEDIUM", reason=reason,
                                  context=None if kind is None else {"kind": kind}, base_dir=self.tools)
        return ids

    def scan(self) -> si.SignalScan:
        return si.scan_signals(base_dir=self.tools, workspace_root=self.ws)

    def adaptation_signals(self) -> dict[str, si.Signal]:
        return {s.key: s for s in self.scan().signals if s.kind in si.ADAPTATION_KINDS}

    def open(self) -> list[tuple[str, str]]:
        opening = si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=5)
        return [(o["signal"], o["key"]) for o in opening.opened]


class ARecurringHarnessReleaseIsAPlan(_Store):
    def test_a_recurring_provider_undecided_release_becomes_a_self_change_mission(self) -> None:
        released = self.release("native_runtime_provider_undecided", times=3)

        [signal] = self.adaptation_signals().values()

        self.assertEqual((signal.kind, signal.key), ("adaptation_due", "release:NATIVE_RUNTIME_PROVIDER_UNDECIDED"))
        self.assertEqual(signal.remedy, si.SELF_CHANGE_REMEDY)
        self.assertEqual(signal.evidence["count"], 3)
        self.assertEqual(sorted(signal.evidence["evidence_ids"]), sorted(released))
        self.assertEqual(self.open(), [("adaptation_due", "release:NATIVE_RUNTIME_PROVIDER_UNDECIDED")])

    def test_two_releases_in_the_window_are_a_blip_the_retry_absorbs(self) -> None:
        self.release("native_runtime_provider_undecided", times=2)
        self.assertEqual(self.adaptation_signals(), {})

    def test_a_release_outside_the_window_is_not_counted(self) -> None:
        self.release("native_runtime_task_binding_unavailable", times=3)
        later = datetime.now(timezone.utc) + timedelta(days=adaptation.RELEASE_WINDOW_DAYS + 1)
        self.assertEqual(adaptation.release_classes(base_dir=self.tools, now=later), [])
        [cls] = adaptation.release_classes(base_dir=self.tools, now=datetime.now(timezone.utc))
        self.assertEqual((cls.key, cls.count), ("release:NATIVE_RUNTIME_TASK_BINDING_UNAVAILABLE", 3))

    def test_a_request_class_release_says_nothing_about_the_environment(self) -> None:
        self.release("agent_refused:evidence", times=3)
        self.assertEqual(self.adaptation_signals(), {})

    def test_a_credential_class_is_announced_and_never_minted(self) -> None:
        self.release("claude_cli_auth_failure", times=3)

        [signal] = self.adaptation_signals().values()

        self.assertEqual((signal.kind, signal.key), ("operator_condition", "release:CLAUDE_CLI_AUTH_FAILURE"))
        self.assertEqual(signal.remedy, si.ANNOUNCE_REMEDY)
        self.assertEqual(self.open(), [])


class AHumanRequiredClassIsOneSignal(_Store):
    def test_fifty_records_of_one_class_make_one_signal_with_bounded_evidence(self) -> None:
        ids = self.escalate("lease_lifecycle", times=50)

        signals = self.adaptation_signals()

        self.assertEqual(list(signals), ["human_required:lease_lifecycle"])
        signal = signals["human_required:lease_lifecycle"]
        self.assertEqual((signal.kind, signal.evidence["count"]), ("adaptation_due", 50))
        self.assertEqual(len(signal.evidence["evidence_ids"]), adaptation.ADAPTATION_EVIDENCE_IDS_MAX)
        self.assertTrue(set(signal.evidence["evidence_ids"]) <= set(ids))
        self.assertEqual(self.open(), [("adaptation_due", "human_required:lease_lifecycle")])
        self.assertEqual(self.open(), [("adaptation_due", "human_required:lease_lifecycle")], "the class re-sighted is idempotent")

    def test_a_class_the_table_does_not_know_fails_closed_to_an_announcement(self) -> None:
        self.escalate("a_kind_nobody_routed", times=2)
        self.escalate(None, times=1, reason="a sentence about something; not a class")

        signals = self.adaptation_signals()

        self.assertEqual({key: s.kind for key, s in signals.items()}, {
            "human_required:a_kind_nobody_routed": "operator_condition",
            "human_required:unclassified": "operator_condition",
        })
        self.assertNotIn("a sentence", json.dumps([s.to_dict() for s in signals.values()]))
        self.assertEqual(self.open(), [])

    def test_the_loops_own_adjudication_never_feeds_back_into_it(self) -> None:
        self.escalate(None, times=1, reason="self_change_adjudication")
        [signal] = self.adaptation_signals().values()
        self.assertEqual((signal.kind, signal.key), ("operator_condition", "human_required:self_change_adjudication"))
        self.assertEqual(self.open(), [])

    def test_a_degraded_tool_is_announced_until_its_answer_is_inside_the_proposal_scope(self) -> None:
        """Its answer lies in tools/aria-adapters/, outside SELF_CHANGE_ALLOWED_PREFIXES:
        a mission for it could only be refused at accept time (ARIA-MEDIUM-417)."""
        self.escalate("tool_degradation", times=1)
        self.assertEqual(self.adaptation_signals()["human_required:tool_degradation"].kind, "operator_condition")
        self.assertFalse(any(prefix.startswith("tools/aria-adapters") for prefix in si.SELF_CHANGE_ALLOWED_PREFIXES))


class ALapsedWaiverIsAPlan(_Store):
    def test_a_lapsed_dormant_control_waiver_becomes_a_self_change_mission(self) -> None:
        lapsed = (datetime.now(timezone.utc) - timedelta(days=3)).date().isoformat()
        self.write_waivers(DORMANT_CONTROL_MANIFEST, {"verify_branch_tip": {
            "owner": "okan", "reason": "r", "expires_on": lapsed, "finding_id": "ORPHAN-HIGH-573"}})

        scan = self.scan()

        keys = {(s.kind, s.key) for s in scan.signals}
        self.assertIn(("adaptation_due", "waiver:control_waiver"), keys)
        self.assertIn(("deadline_due", "control_waiver:verify_branch_tip"), keys, "the row is still announced")
        self.assertEqual(self.open(), [("adaptation_due", "waiver:control_waiver")])


class AnUnreadableSourceIsNamed(_Store):
    def test_a_corrupt_claims_ledger_is_named_and_the_other_sources_are_still_read(self) -> None:
        self.escalate("lease_lifecycle", times=1)
        claims = self.tools / "agent-invocations" / "claims.jsonl"
        claims.parent.mkdir(parents=True, exist_ok=True)
        claims.write_text("{not json\n", encoding="utf-8")

        scan = self.scan()

        self.assertEqual([u.to_dict() for u in scan.unreadable], [{"family": "adaptation", "fault": "release:LedgerIntegrityError"}])
        self.assertIn("human_required:lease_lifecycle", {s.key for s in scan.signals})

    def test_a_defect_in_a_reader_raises(self) -> None:
        with mock.patch.object(adaptation, "human_required_classes", side_effect=TypeError("reader_defect")):
            with self.assertRaises(TypeError):
                self.scan()


class EveryClassHasAWrittenDecision(unittest.TestCase):
    """Detectable, not defaulted: a harness release code or a waiver manifest
    added without a routing decision fails here."""

    def test_every_harness_release_code_is_routed_by_name(self) -> None:
        from aria_kernel.release_reason import RELEASE_REASON_CODES, parse_release_reason
        from aria_kernel import release_reason

        harness = {parse_release_reason(literal).reason_code for literal, (_code, domain) in release_reason._LITERALS.items()
                   if domain == "harness"}
        harness |= {code for _prefix, code, domain in release_reason._PREFIXES if domain == "harness"}
        self.assertTrue(harness <= set(RELEASE_REASON_CODES))
        routed = {key.split(":", 1)[1] for key in si.ADAPTATION_SIGNAL_KINDS if key.startswith("release:")}
        self.assertEqual(harness - routed, set())

    def test_every_waiver_manifest_is_routed_by_name(self) -> None:
        routed = {key.split(":", 1)[1] for key in si.ADAPTATION_SIGNAL_KINDS if key.startswith("waiver:")}
        self.assertEqual({manifest.kind for manifest in WAIVER_MANIFESTS}, routed)

    def test_every_routing_decision_is_one_of_the_two_adaptation_kinds(self) -> None:
        self.assertEqual(set(si.ADAPTATION_SIGNAL_KINDS.values()) - {"adaptation_due", "operator_condition"}, set())
        self.assertEqual(si.SIGNAL_REMEDIES["adaptation_due"], si.SELF_CHANGE_REMEDY)
        self.assertEqual(si.SIGNAL_REMEDIES["operator_condition"], si.ANNOUNCE_REMEDY)
        self.assertEqual(si.adaptation_signal_kind("release:NOT_A_CODE_ANYONE_ROUTED"), "operator_condition")

    def test_a_self_change_class_names_an_answer_inside_the_proposal_scope(self) -> None:
        """The table is an authority surface: ARIA cannot re-route a class."""
        self.assertIn("aria-kernel/aria_kernel/self_improvement.py", si.AUTHORITY_SURFACES)
        self.assertNotIn("aria-kernel/aria_kernel/adaptation_signals.py", si.AUTHORITY_SURFACES,
                         "the READER is ordinary kernel code; only the routing is authority")


if __name__ == "__main__":
    unittest.main()
