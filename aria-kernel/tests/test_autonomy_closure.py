"""ARIA-HIGH-016 — the derived two-SHA autonomy closure verdict (closure plan Task 20A).

The verdict is derived from two explicit SHAs and the authorities that own
each part: the closure policy and the structured registry as the evidence
target's Git tree holds them, the autonomy evidence status at that target,
and a report commit that is the main tip, descends from the target, changes
only the report documents and carries a payload bound to the target. These
tests build that history in a real Git repository. The autonomy evidence
status (its derivation is pinned by test_autonomy_evidence_status.py) and
the registry owner's verdict are the collaborators answered here; the
registry owner (``finding-registry.ts verify --stdin --closures-at``) runs
for real against this repository's own history in RegistrySnapshotOwnerTests.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = 'the live findings registry docs/reviews/_registry/findings.jsonl'

import dataclasses
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import chdir, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import aria_kernel.autonomy_closure as closure_module
from aria_kernel.autonomy_closure import (
    CLOSURE_REPORT_PATH,
    MAIN_REF,
    PAYLOAD_FENCE_INFO,
    RegistrySnapshotVerdict,
    canonical_payload_digest,
    derive_autonomy_closure_verdict,
    verify_registry_snapshot,
)
from aria_kernel.autonomy_evidence import (
    _MAX_POLICY_BLOB_BYTES,
    CAPABILITY_SPECS,
    AutonomyEvidenceStatus,
    CapabilityEvidence,
    EvidenceRef,
)

_REPO = Path(__file__).resolve().parents[2]
_POLICY = "docs/aria/policy/autonomy-closure-findings.json"
_REGISTRY = "docs/reviews/_registry/findings.jsonl"
_STATE_TIP = "5" * 40


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True,
    ).stdout.strip()


def _payload(evidence: str, *, state_tip: str = _STATE_TIP) -> dict[str, Any]:
    payload: dict[str, Any] = {"evidence_target_sha": evidence, "state_evidence_tip": state_tip,
                               "seven_check_perimeter_pr": 1999}
    payload["report_payload_sha256"] = canonical_payload_digest(payload)
    return payload


def _report_text(payload: dict[str, Any]) -> str:
    return (
        "# ARIA autonomy closure evidence\n\n"
        f"```{PAYLOAD_FENCE_INFO}\n{json.dumps(payload, indent=2, sort_keys=True)}\n```\n"
    )


def _status(target: str, *, state: str = "live_proven", state_tip: str = _STATE_TIP,
            blocker: str | None = None) -> AutonomyEvidenceStatus:
    def ref(capability: str) -> EvidenceRef:
        return EvidenceRef(
            surface=capability, proof_kind="live", schema_id=None, schema_version=1,
            row_id=f"row-{capability}", row_hash="sha256:" + "0" * 64,
            evidence_target_sha=target, evaluated_target_sha=target,
            semantic_authority="sha256:" + "1" * 64, state_commit=state_tip,
        )

    return AutonomyEvidenceStatus(
        target_sha=target, derived_at="2026-10-16T00:00:00Z", overall_state=state, blockers=(),
        capabilities={
            capability: CapabilityEvidence(
                state=state if capability == "enterprise_readiness" else "live_proven",
                counts={"accepted": 1},
                blockers=(blocker,) if blocker and capability == "enterprise_readiness" else (),
                evidence_refs=(ref(capability),),
            )
            for capability in CAPABILITY_SPECS
        },
    )


class ClosureHistory:
    """fix commit -> evidence target (policy, refs, registry) -> report commit = origin/main."""

    def __init__(self, root: Path) -> None:
        self.repo = root / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "commit.gpgsign", "false")
        self.write("apps/farm-service/src/interval.ts", "export const interval = 30;\n")
        self.fix = self.commit("fix the governed findings")
        self.policy = json.loads((_REPO / _POLICY).read_text(encoding="utf-8"))
        self.evidence, self.report = self.publish()

    def publish(self, *, mutate: Any = None, closing_commit: str | None = None,
                drop_ref: str | None = None) -> tuple[str, str]:
        """Commit an evidence target, then its report commit, and make it main."""
        self.write(_POLICY, json.dumps(self.policy))
        headings: dict[str, set[str]] = {}
        for entry in self.policy["entries"]:
            for key in ("review_anchor", "narrative_anchor"):
                anchor = entry.get(key)
                if isinstance(anchor, str):
                    path, finding_id = anchor.split("#", 1)
                    headings.setdefault(path, set()).add(finding_id)
            for ref in entry["regression_test_refs"]:
                self.write(ref, "regression fixture\n")
        for path, finding_ids in headings.items():
            self.write(path, "\n\n".join(f"## {finding_id} fixture" for finding_id in sorted(finding_ids)) + "\n")
        if drop_ref is not None:
            (self.repo / drop_ref).unlink()
        self.write_registry(mutate or (lambda row: row), closing_commit or self.fix)
        evidence = self.commit("evidence target")
        self.write(CLOSURE_REPORT_PATH, _report_text(_payload(evidence)))
        report = self.commit("closure report")
        _git(self.repo, "update-ref", MAIN_REF, report)
        return evidence, report

    def write(self, relative: str, text: str) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def write_registry(self, mutate: Any, closing_commit: str | None = None) -> None:
        # Each finding closed by the commit its policy rule names: a
        # historical one by its last historical fix, a task one by the fix.
        rows = [mutate({"id": entry["finding_id"], "state": "RESOLVED", "closing_commits": [
                    entry["historical_fix_shas"][-1] if entry["closing_sha_rule"] == "last_historical_fix"
                    else closing_commit or self.fix]})
                for entry in self.policy["entries"]]
        self.write(_REGISTRY, "".join(json.dumps(row) + "\n" for row in rows))

    def commit(self, message: str) -> str:
        _git(self.repo, "add", "--all", ".")
        _git(self.repo, "commit", "-q", "-m", message)
        return _git(self.repo, "rev-parse", "HEAD")


class ClosureVerdictTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="aria-closure-")
        self.addCleanup(directory.cleanup)
        self.history = ClosureHistory(Path(directory.name))
        self.tools = Path(directory.name) / "tools"
        # The registry owner's verdict: the chain holds and every named
        # finding is closed, unless a test says what the owner refuses.
        self.owner_refusals: dict[str, tuple[str, ...]] = {}
        self.owner_calls: list[dict[str, Any]] = []

        def owner(repo: Path, raw: bytes, *, at: str, finding_ids: tuple[str, ...]) -> RegistrySnapshotVerdict:
            self.owner_calls.append({"raw": raw, "at": at, "finding_ids": finding_ids})
            return RegistrySnapshotVerdict(
                True, None, {finding_id: self.owner_refusals.get(finding_id, ()) for finding_id in finding_ids},
            )

        registry_owner = mock.patch.object(closure_module, "verify_registry_snapshot", side_effect=owner)
        registry_owner.start()
        self.addCleanup(registry_owner.stop)

    def verdict(self, *, report: str | None = None, evidence: str | None = None,
                status: AutonomyEvidenceStatus | None = None) -> dict[str, Any]:
        evidence = evidence or self.history.evidence
        with mock.patch.object(closure_module, "derive_autonomy_evidence_status",
                               return_value=status or _status(evidence)) as derive:
            result = derive_autonomy_closure_verdict(
                report_commit_sha=report or self.history.report, evidence_target_sha=evidence,
                repo_root=self.history.repo, base_dir=self.tools,
            ).to_dict()
        if derive.called:
            self.assertEqual(derive.call_args.kwargs["target_sha"], evidence)
        return result

    def failed(self, result: dict[str, Any]) -> dict[str, list[str]]:
        return {p["name"]: p["reasons"] for p in result["predicates"] if not p["passed"]}

    def test_every_predicate_green_is_closed(self) -> None:
        result = self.verdict()
        self.assertEqual(self.failed(result), {})
        self.assertEqual(result["verdict"], "closed")
        self.assertEqual(len(result["predicates"]), 8)

    def test_the_report_commit_as_evidence_target_is_refused(self) -> None:
        result = self.verdict(evidence=self.history.report)
        self.assertEqual(result["verdict"], "open")
        failed = self.failed(result)
        self.assertEqual(failed["evidence_target_is_report_ancestor"], ["evidence_target_is_the_report_commit"])
        self.assertEqual(failed["report_payload_binds_evidence_target"],
                         ["closure_payload_names_another_evidence_target"])

    def test_a_report_commit_that_is_not_the_main_tip_is_refused(self) -> None:
        self.history.write("docs/aria/CURRENT_STATE.md", "later\n")
        later = self.history.commit("a later docs commit on main")
        _git(self.history.repo, "update-ref", MAIN_REF, later)
        failed = self.failed(self.verdict())
        self.assertEqual(failed, {"report_commit_is_main_tip": [f"report_commit_is_not_main_tip:{later}"]})

    def test_a_code_or_policy_change_after_the_evidence_target_is_refused(self) -> None:
        self.history.write(_POLICY, json.dumps(self.history.policy, indent=1))
        self.history.write("aria-kernel/aria_kernel/late.py", "LATE = 1\n")
        report = self.history.commit("report commit that also changes code and policy")
        _git(self.history.repo, "update-ref", MAIN_REF, report)
        failed = self.failed(self.verdict(report=report))
        self.assertEqual(failed["report_commit_changes_only_report_documents"], [
            "non_report_path_changed:aria-kernel/aria_kernel/late.py",
            f"non_report_path_changed:{_POLICY}",
        ])

    def test_an_evidence_target_off_the_report_history_is_refused(self) -> None:
        _git(self.history.repo, "checkout", "-q", "-b", "side", self.history.fix)
        self.history.write("apps/farm-service/src/interval.ts", "export const interval = 31;\n")
        side = self.history.commit("an unrelated commit")
        _git(self.history.repo, "checkout", "-q", "main")
        failed = self.failed(self.verdict(evidence=side))
        self.assertEqual(failed["evidence_target_is_report_ancestor"], ["evidence_target_not_report_ancestor"])

    def test_a_report_digest_mismatch_is_refused(self) -> None:
        payload = _payload(self.history.evidence)
        payload["seven_check_perimeter_pr"] = 2000  # changed after the digest was taken
        self.history.write(CLOSURE_REPORT_PATH, _report_text(payload))
        report = self.history.commit("tampered report")
        _git(self.history.repo, "update-ref", MAIN_REF, report)
        failed = self.failed(self.verdict(report=report))
        self.assertEqual(failed["report_payload_binds_evidence_target"], ["closure_payload_digest_mismatch"])
        self.assertIn("closure_payload_unavailable", failed["capabilities_live_proven_at_evidence_target"])

    def test_policy_and_registry_are_read_at_the_evidence_target_only(self) -> None:
        # The checkout (and anything after the target) says every finding is
        # OPEN and holds no policy; the target's tree says RESOLVED. The
        # verdict reads the target, and hands its owner the target's bytes.
        self.history.write_registry(lambda row: {**row, "state": "OPEN", "closing_commits": []})
        (self.history.repo / _POLICY).write_text("not json\n", encoding="utf-8")
        self.assertEqual(self.verdict()["verdict"], "closed")
        [call] = self.owner_calls
        target_bytes = subprocess.run(
            ["git", "-C", str(self.history.repo), "show", f"{self.history.evidence}:{_REGISTRY}"],
            check=True, capture_output=True,
        ).stdout
        self.assertEqual(call["raw"], target_bytes)
        self.assertNotEqual(call["raw"], (self.history.repo / _REGISTRY).read_bytes())
        self.assertEqual(call["at"], self.history.evidence)
        # The findings judged are the target policy's, in its order; no caller names them.
        self.assertEqual(call["finding_ids"],
                         tuple(entry["finding_id"] for entry in self.history.policy["entries"]))

    def test_the_registry_owner_s_closure_refusals_are_named_by_finding(self) -> None:
        self.owner_refusals = {"ARIA-HIGH-016": ("not_resolved:OPEN", "no_closing_commit")}
        failed = self.failed(self.verdict())
        self.assertEqual(failed, {"closure_findings_resolved_at_evidence_target": [
            "ARIA-HIGH-016:not_resolved:OPEN", "ARIA-HIGH-016:no_closing_commit",
        ]})

    def test_a_broken_registry_chain_is_named_and_judges_no_closure(self) -> None:
        with mock.patch.object(closure_module, "verify_registry_snapshot",
                               return_value=RegistrySnapshotVerdict(False, "hash mismatch at entry 1 (X)")):
            failed = self.failed(self.verdict())
        self.assertEqual(failed, {
            "registry_chain_valid_at_evidence_target": ["registry_chain_invalid:hash mismatch at entry 1 (X)"],
            "closure_findings_resolved_at_evidence_target": ["registry_unavailable"],
        })

    def test_a_historical_finding_closed_by_another_commit_than_its_last_fix_is_named(self) -> None:
        # ORPHAN-HIGH-780's policy names three historical fixes; a registry
        # that closes it with the first (as the registry did before the
        # closure plan's reconciliation) is not closed by the rule's commit.
        entry = next(e for e in self.history.policy["entries"] if e["finding_id"] == "ORPHAN-HIGH-780")
        first, last = entry["historical_fix_shas"][0], entry["historical_fix_shas"][-1]

        def first_fix(row: dict[str, Any]) -> dict[str, Any]:
            return {**row, "closing_commits": [first]} if row["id"] == "ORPHAN-HIGH-780" else row

        evidence, report = self.history.publish(mutate=first_fix)
        failed = self.failed(self.verdict(report=report, evidence=evidence))
        self.assertEqual(failed, {"closure_findings_resolved_at_evidence_target": [
            f"ORPHAN-HIGH-780:closing_commit_not_last_historical_fix:{last}",
        ]})

    def test_an_absent_regression_ref_at_the_target_is_named(self) -> None:
        ref = self.history.policy["entries"][0]["regression_test_refs"][0]
        evidence, report = self.history.publish(drop_ref=ref)
        failed = self.failed(self.verdict(report=report, evidence=evidence))
        self.assertEqual(failed, {
            "closure_policy_resolved_at_evidence_target": [f"closure_policy_regression_ref_unresolved:{ref}"],
        })

    def test_an_unreadable_policy_at_the_target_is_named_by_its_reader(self) -> None:
        # The predicate names the target policy reader's own blocker; it has
        # no fallback blocker of its own to supply.
        for label, text, blocker in (
            ("absent", None, "operator_prerequisite_policy_unavailable"),
            ("not_json", "not json\n", "operator_prerequisite_policy_invalid"),
            ("too_large", "x" * (_MAX_POLICY_BLOB_BYTES + 1), "operator_prerequisite_policy_too_large"),
        ):
            with self.subTest(label=label):
                if text is None:
                    (self.history.repo / _POLICY).unlink()
                else:
                    self.history.write(_POLICY, text)
                evidence = self.history.commit(f"policy {label}")
                self.history.write(CLOSURE_REPORT_PATH, _report_text(_payload(evidence)))
                report = self.history.commit("closure report")
                _git(self.history.repo, "update-ref", MAIN_REF, report)
                failed = self.failed(self.verdict(report=report, evidence=evidence))
                self.assertEqual(failed["closure_policy_resolved_at_evidence_target"], [blocker])

    def test_a_capability_short_of_live_proof_or_blocked_is_named(self) -> None:
        status = _status(self.history.evidence, state="operator_blocked",
                         blocker="github_app_mode_a_unconfigured")
        failed = self.failed(self.verdict(status=status))
        self.assertEqual(failed["capabilities_live_proven_at_evidence_target"], [
            "capability_not_live_proven:enterprise_readiness:operator_blocked",
            "capability_blocked:enterprise_readiness:github_app_mode_a_unconfigured",
        ])

    def test_the_report_s_state_tip_must_lie_on_the_state_chain_evidence_is_derived_from(self) -> None:
        # ARIA keeps publishing after the report: the evidence is derived at
        # the store's current tip, and the report's tip must be that tip or
        # an ancestor of it on the store's chain.
        store = Path(self.history.repo.parent) / "state-store"
        store.mkdir()
        _git(store, "init", "-q", "--initial-branch=aria/state", ".")
        _git(store, "config", "user.name", "ARIA Test")
        _git(store, "config", "user.email", "aria@example.invalid")
        _git(store, "commit", "-q", "--allow-empty", "-m", "state at the report")
        reported = _git(store, "rev-parse", "HEAD")
        _git(store, "commit", "-q", "--allow-empty", "-m", "a later publish")
        current = _git(store, "rev-parse", "HEAD")
        _git(store, "checkout", "-q", "-b", "elsewhere", reported)
        _git(store, "commit", "-q", "--allow-empty", "-m", "a tip off the chain")
        off_chain = _git(store, "rev-parse", "HEAD")
        self.tools.mkdir(parents=True)
        (self.tools / "repo_identity.json").write_text("{}\n", encoding="utf-8")
        opened = mock.patch("aria_kernel.state_store.open_state_store", return_value=SimpleNamespace(root=store))
        opened.start()
        self.addCleanup(opened.stop)
        for report_tip, derived_tip, expected in (
            (reported, current, {}),
            (current, current, {}),
            (off_chain, current, {"capabilities_live_proven_at_evidence_target": [
                f"state_evidence_tip_off_chain:{off_chain}"]}),
        ):
            with self.subTest(report_tip=report_tip, derived_tip=derived_tip):
                self.history.write(CLOSURE_REPORT_PATH,
                                   _report_text(_payload(self.history.evidence, state_tip=report_tip)))
                report = self.history.commit(f"closure report at {report_tip[:7]}")
                _git(self.history.repo, "update-ref", MAIN_REF, report)
                failed = self.failed(self.verdict(
                    report=report, status=_status(self.history.evidence, state_tip=derived_tip),
                ))
                self.assertEqual(failed, expected)

    def test_evidence_derived_from_several_state_tips_is_refused(self) -> None:
        status = _status(self.history.evidence)
        enterprise = status.capabilities["enterprise_readiness"]
        other_ref = dataclasses.replace(enterprise.evidence_refs[0], state_commit="6" * 40)
        mixed = AutonomyEvidenceStatus(
            target_sha=status.target_sha, derived_at=status.derived_at, overall_state="live_proven", blockers=(),
            capabilities={**status.capabilities, "enterprise_readiness": CapabilityEvidence(
                state="live_proven", counts={"accepted": 1}, blockers=(),
                evidence_refs=(*enterprise.evidence_refs, other_ref),
            )},
        )
        failed = self.failed(self.verdict(status=mixed))
        self.assertEqual(failed, {"capabilities_live_proven_at_evidence_target": ["derived_state_commits:2"]})

    def test_the_cli_exits_nonzero_unless_closed_and_prints_the_verdict(self) -> None:
        from aria_kernel.cli import main as cli_main

        argv = ["--tools-dir", str(self.tools), "autonomy", "closure", "verify",
                "--report-commit-sha", self.history.report,
                "--evidence-target-sha", self.history.evidence]
        for status, expected_rc, expected_verdict in (
            (_status(self.history.evidence), 0, "closed"),
            (_status(self.history.evidence, state="declared"), 1, "open"),
        ):
            with self.subTest(verdict=expected_verdict), mock.patch.object(
                closure_module, "derive_autonomy_evidence_status", return_value=status,
            ), chdir(self.history.repo), redirect_stdout(io.StringIO()) as out:
                rc = cli_main(argv)
            self.assertEqual(rc, expected_rc)
            self.assertEqual(json.loads(out.getvalue())["verdict"], expected_verdict)


class RegistrySnapshotOwnerTests(unittest.TestCase):
    """The registry owner, run for real on this repository's own history.

    The snapshot is the registry as commit 606169730 holds it, judged as of
    that commit, so the verdict is fixed history: ARIA-HIGH-017 RESOLVED by
    6c9144259 (an ancestor), ARIA-HIGH-006 OPEN.
    """

    _CLOSER = "6c9144259bce182185df860ec8ff6c4bd6ad49e6"

    def setUp(self) -> None:
        if not (_REPO / "node_modules" / ".bin" / "ts-node").is_file():
            self.skipTest("the repository's ts-node is not installed in this checkout")
        self.snapshot = _git(_REPO, "rev-parse", "--verify", "606169730^{commit}")
        self.raw = subprocess.run(
            ["git", "-C", str(_REPO), "show", f"{self.snapshot}:{_REGISTRY}"],
            check=True, capture_output=True,
        ).stdout

    def test_the_owner_judges_the_chain_and_each_named_closure(self) -> None:
        verdict = verify_registry_snapshot(
            _REPO, self.raw, at=self.snapshot, finding_ids=("ARIA-HIGH-017", "ARIA-HIGH-006"),
        )
        self.assertEqual(verdict, RegistrySnapshotVerdict(True, None, {
            "ARIA-HIGH-017": (),
            "ARIA-HIGH-006": ("not_resolved:OPEN", "no_closing_commit"),
        }))

    def test_a_closer_not_reachable_from_the_commit_judged_is_named(self) -> None:
        before = _git(_REPO, "rev-parse", f"{self._CLOSER}~1")
        verdict = verify_registry_snapshot(_REPO, self.raw, at=before, finding_ids=("ARIA-HIGH-017",))
        self.assertEqual(verdict.closures, {"ARIA-HIGH-017": (f"closing_commit_unreachable:{self._CLOSER}",)})

    def test_a_closure_merged_before_the_registry_recorded_it_is_derived(self) -> None:
        """MF-1 (PROC-HIGH-039): closure is derived at the evidence commit.

        a62b291c3 is the merge of #2067, whose 78d38a761 carries
        ``Closes: …#ARIA-HIGH-012``. The registry at that merge still records
        ARIA-HIGH-012 as STALE: the closure-reconcile PR #2075 wrote RESOLVED
        later. Judged at the merge, the finding is closed by the trailer the
        merge brought in; a verdict that waits for a second commit is the drift
        window MF-1 removes.
        """
        merge = _git(_REPO, "rev-parse", "--verify", "a62b291c3a7ea6650c60002d75ac51f53fad08cc^{commit}")
        raw = subprocess.run(
            ["git", "-C", str(_REPO), "show", f"{merge}:{_REGISTRY}"], check=True, capture_output=True,
        ).stdout
        recorded = next(json.loads(line) for line in raw.decode("utf-8").splitlines()
                        if line.strip() and json.loads(line)["id"] == "ARIA-HIGH-012")
        self.assertEqual(recorded["state"], "STALE")
        verdict = verify_registry_snapshot(_REPO, raw, at=merge, finding_ids=("ARIA-HIGH-012",))
        self.assertEqual(verdict, RegistrySnapshotVerdict(True, None, {"ARIA-HIGH-012": ()}))

    def test_a_broken_chain_is_named(self) -> None:
        rows = [json.loads(line) for line in self.raw.decode("utf-8").splitlines()[:3]]
        rows[1]["title"] = rows[1]["title"] + " (edited after the chain was written)"
        tampered = "".join(json.dumps(row) + "\n" for row in rows).encode("utf-8")
        verdict = verify_registry_snapshot(_REPO, tampered, at=self.snapshot, finding_ids=("ARIA-HIGH-017",))
        self.assertFalse(verdict.chain_ok)
        self.assertIn(f"hash mismatch at entry 1 ({rows[1]['id']})", str(verdict.chain_reason))


if __name__ == "__main__":
    unittest.main()
