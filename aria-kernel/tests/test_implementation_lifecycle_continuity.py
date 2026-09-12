"""E2 — the implementation state machine gets a real entry (F1) and plans
survive their cycle (F9).

Pre-fix world, proven by audit + adversarial verification: the three
implementation transitions had ZERO production callers — the envelope
issuer's own error message promised "exactly one escape from CONVERGED"
and never wrote it; every implementer result was refused against an
unreachable IN_FLIGHT precondition; the implementer poll accepted only
MERGED/REJECTED so even success timed out; and plan identity was minted
from the cycle id so each night's answered envelopes landed on a plan
nobody watched.
"""
from __future__ import annotations

import tempfile
import multiprocessing
import traceback
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.implementation_reconciler import (
    _pr_number_from_url,
    reconcile_recorded_implementations,
)
from aria_kernel.plan_convergence import (
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
    request_implementation,
    resume_candidate_plan_id,
    start_plan,
)


class MergedPRReader:
    def readable(self) -> tuple[bool, str]:
        return (True, "ok")

    def pr_merge_state(self, pr_number: int) -> dict:
        assert pr_number == 4242
        return {
            "state": "MERGED", "mergedAt": "2026-09-10T01:00:00Z",
            "mergeCommit": {"oid": "f" * 40},
        }


def _reconcile_in_process(tools: Path, available: bool, barrier, results) -> None:
    from aria_kernel.ledger import state_transaction

    class Reader(MergedPRReader):
        def readable(self) -> tuple[bool, str]:
            # Network boundaries must be reachable with neither ledger locked.
            with state_transaction([
                tools / "plans/events.jsonl",
                tools / "knowledge-graph/conventions.jsonl",
            ], timeout_seconds=0.3):
                pass
            return (available, "ok" if available else "offline")

        def pr_merge_state(self, pr_number: int) -> dict:
            assert available, "persisted merge retry must not query GitHub"
            with state_transaction([
                tools / "plans/events.jsonl",
                tools / "knowledge-graph/conventions.jsonl",
            ], timeout_seconds=0.3):
                pass
            if barrier is not None:
                barrier.wait(timeout=20)
            return super().pr_merge_state(pr_number)

    try:
        results.put(("ok", reconcile_recorded_implementations(base_dir=tools, reader=Reader())))
    except BaseException:
        results.put(("error", traceback.format_exc()))
        raise


def converging_plan_content(title: str = "E2 plan", **fields: object) -> dict:
    """The one plan body every fixture drives to CONVERGED through the real
    gate. Shared on purpose: the plan contract (ARIA-HIGH-103) decides what
    converges, and a private copy in another module stops converging the day
    the contract grows without saying so. ``fields`` override single keys
    for a fixture that needs more than convergence (the memory pillar's
    evidence cardinality, say) without restating the contract."""
    return {
        "schema_version": 1,
        "title": title,
        "summary": "E2 continuity test plan.",
        "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
        "key_changes": ["change"],
        # The plan contract admits the canonical suite and requires the tier
        # claim of every body that converges through the real gate.
        "validation_commands": [{"cmd": "nx affected --target=test"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
        "architectural_tier": 2,
        **fields,
    }


def seed_reviewer_agent(workspace_root: Path) -> None:
    """The one agent `record_critique` resolves the reviewer against."""
    agents = workspace_root / ".claude" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "farm-expert.md").write_text(
        "---\nname: farm-expert\ndescription: Farm reviewer.\n---\n\nBody.\n",
        encoding="utf-8",
    )


def drive_plan_to_converged(
    *, plan_id: str, tools: Path, workspace_root: Path, title: str = "E2 plan",
    plan_content: dict | None = None,
) -> None:
    """CONVERGED via the direct evaluator path (zero-risk round one).

    Module-level, not a TestCase method, because the orphan-reaper suite in
    `tests/test_autonomy_orchestrator.py` needs a plan that is genuinely in
    IMPLEMENTATION_REQUESTED — a synthetic dict would let the reaper's window
    pass against a plan the real transition would have refused.
    """
    from aria_kernel.plan_convergence import evaluate_plan, record_critique, request_critics

    start_plan(
        plan_id=plan_id,
        initial_revision_id="rev-0",
        plan_content=plan_content if plan_content is not None else converging_plan_content(title),
        base_dir=tools,
    )
    content_hash = fold_plan_state(
        plan_id=plan_id, base_dir=tools,
    )["latest_revision"]["content_hash"]
    request_critics(
        plan_id=plan_id,
        request={
            "round_number": 1,
            "target_revision_id": "rev-0",
            "target_plan_content_hash": content_hash,
            "tasks": [{
                "task_id": "t-1",
                "task_packet_hash": "sha256:" + "a" * 64,
                "target_agent": "farm-expert",
                "target_revision_id": "rev-0",
                "target_plan_content_hash": content_hash,
                "sla_deadline": "2099-01-01T00:00:00+00:00",
                "status_after": "PENDING",
            }],
        },
        base_dir=tools,
    )
    record_critique(
        plan_id=plan_id,
        critique={
            "task_packet_hash": "sha256:" + "a" * 64,
            "target_revision_id": "rev-0",
            "target_plan_content_hash": content_hash,
            "reviewer": "farm-expert",
            "risks": [],
            "critique_content_hash": "sha256:" + "b" * 64,
            "status_after": "ANSWERED",
        },
        workspace_root=workspace_root,
        base_dir=tools,
    )
    evaluate_plan(plan_id=plan_id, round_number=1, base_dir=tools)


def drive_plan_to_implementation_requested(
    *, plan_id: str, tools: Path, workspace_root: Path, title: str = "E2 plan",
) -> None:
    drive_plan_to_converged(
        plan_id=plan_id, tools=tools, workspace_root=workspace_root, title=title,
    )
    request_implementation(
        plan_id=plan_id,
        implementer_agent="aria-implementer",
        converged_plan_revision_id="rev-0",
        converged_plan_content_hash=fold_plan_state(
            plan_id=plan_id, base_dir=tools,
        )["latest_revision"]["content_hash"],
        base_dir=tools,
    )


class ImplementationChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.root = Path(self.tmp.name) / "workspace"
        seed_reviewer_agent(self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _converged_plan(self, plan_id: str = "plan-e2") -> None:
        drive_plan_to_converged(
            plan_id=plan_id, tools=self.tools, workspace_root=self.root,
        )
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"], "CONVERGED"
        )

    def _to_recorded(self, plan_id: str = "plan-e2") -> None:
        drive_plan_to_implementation_requested(
            plan_id=plan_id, tools=self.tools, workspace_root=self.root,
        )
        record_implementation_started(
            plan_id=plan_id,
            claim_id="claim-1",
            implementer_agent="aria-implementer",
            started_at="2026-08-12T10:00:00Z",
            base_dir=self.tools,
        )
        record_implementation_outcome(
            plan_id=plan_id,
            claim_id="claim-1",
            pr_url="https://github.com/o/r/pull/4242",
            diff_hash="sha256:" + "c" * 64,
            branch_tip_sha="d" * 40,
            base_branch_sha="e" * 40,
            validation_results=[],
            signer_key_fp="fp-1",
            completed_at="2026-08-12T10:30:00Z",
            base_dir=self.tools,
        )
        self.assertEqual(
            fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_full_chain_reaches_recorded(self) -> None:
        # The chain the arc audit proved unreachable: CONVERGED →
        # REQUESTED → IN_FLIGHT → RECORDED, with the real transition fns.
        self._to_recorded()

    def test_separated_tools_root_carries_observation_promotion_and_prompt(self) -> None:
        from aria_kernel import agent_invocations, knowledge_graph as kg
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tools_binding import bind_tools_root
        from tests._helpers.git_fixtures import make_repo_with_initial_commit
        from tests._helpers.production_shaped import production_converged_plan, production_request_without_anchor

        root = make_repo_with_initial_commit(
            Path(self.tmp.name), name="checkout",
            files={"docs/aria/SPEC.md": "one\ntwo\nthree\nfour\nfive\n"},
        )
        tools = Path(self.tmp.name) / "store/tools"
        bind_tools_root(tools_dir=tools, workspace_root=root, reason="separate-root fixture")
        refs = [f"docs/aria/SPEC.md:{n}" for n in range(1, 6)]
        plan = production_converged_plan(
            tools_dir=tools, workspace_root=root, evidence_refs=refs,
        )
        args = dict(cycle_id="separate-root", plan_id=plan.plan_id, workspace_root=root,
                    base_dir=tools, plan_envelope_metadata={}, profile="standard")
        hook = MemoryHookImpl()
        unsigned = hook.record(**args, signer_key_fp=None)
        self.assertEqual(unsigned["status"], "needs_signing")
        convention = tools / "knowledge-graph/conventions.jsonl"
        self.assertFalse(convention.exists())
        key = mint_signing_key(cycle_id="separate-root", workspace_root=root)
        try:
            observed = hook.record(**args, signer_key_fp=key.fingerprint)
        finally:
            revoke_signing_key(cycle_id="separate-root", workspace_root=root)
        self.assertEqual(observed["status"], "memory_hook_recorded", observed)
        self.assertTrue(convention.exists(), "the real hook must write to the bound tools root")
        rows = load_declared_jsonl(convention, expected_surface="kg_conventions")
        self.assertEqual([r["outcome_status"] for r in rows], ["hypothesis"])
        request_implementation(
            plan_id=plan.plan_id, implementer_agent="aria-implementer",
            converged_plan_revision_id=plan.revision_id,
            converged_plan_content_hash=plan.content_hash, base_dir=tools,
        )
        record_implementation_started(
            plan_id=plan.plan_id, claim_id="bound-claim", implementer_agent="aria-implementer",
            started_at="2026-09-10T00:00:00Z", base_dir=tools,
        )
        record_implementation_outcome(
            plan_id=plan.plan_id, claim_id="bound-claim", pr_url="https://github.com/o/r/pull/4242",
            diff_hash="sha256:" + "c" * 64, branch_tip_sha="d" * 40, base_branch_sha="e" * 40,
            validation_results=[], signer_key_fp=key.fingerprint,
            completed_at="2026-09-10T00:30:00Z", base_dir=tools,
        )
        result = reconcile_recorded_implementations(base_dir=tools, reader=MergedPRReader())
        self.assertEqual(result["promotions"][0]["status"], "promoted", result)
        before = convention.read_bytes()
        retry = reconcile_recorded_implementations(base_dir=tools, reader=MergedPRReader())
        self.assertEqual(retry["promotions"][0]["status"], "already_verified")
        self.assertEqual(convention.read_bytes(), before)
        events = load_declared_jsonl(tools / "plans/events.jsonl", expected_surface="plan_convergence_events")
        self.assertEqual([r["plan_id"] for r in events if r["event_type"] == "implementation_merged"], [plan.plan_id])
        served = kg.conventions_for_paths(base_dir=tools, paths=["docs/aria/SPEC.md"])
        self.assertEqual([r["outcome_status"] for r in served], ["verified"])
        minted = production_request_without_anchor(
            base_dir=tools, context_repo_root=root,
            allowed_scope=["docs/aria/"], evidence_refs=refs,
        )
        conventions = minted["established_knowledge"]["conventions"]
        self.assertIn(served[0]["pattern_id"], [r["pattern_id"] for r in conventions])
        prompt = agent_invocations.render_invocation_prompt(minted)
        self.assertIn(served[0]["pattern_id"], prompt)
        self.assertIn(refs[0], prompt)
        for shadow in (root / "aria-tools", tools.parent / "aria-tools"):
            self.assertFalse(shadow.exists(), shadow)

    def test_reconciler_folds_merged_pr_to_terminal(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                assert pr_number == 4242
                return {
                    "state": "MERGED",
                    "mergedAt": "2026-08-12T11:00:00Z",
                    "mergeCommit": {"oid": "f" * 40},
                }

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual([m["plan_id"] for m in result["merged"]], ["plan-e2"])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_MERGED",
        )
        # Idempotent: a second pass finds a terminal plan and does nothing.
        again = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(again["merged"], [])

    def test_reconciler_retries_failed_promotion_after_merge(self) -> None:
        from aria_kernel import knowledge_graph
        from aria_kernel.ledger import load_declared_jsonl

        self._to_recorded()
        convention_path = knowledge_graph.record_convention(
            knowledge_graph.Pattern(
                pattern_id="conv-promotion-retry", pattern_type="convention",
                confidence=0.5, evidence_refs=("docs/aria/SPEC.md",),
                discovered_by_cycle_id="cycle-promotion-retry",
                observed_at="2026-09-10T00:00:00Z",
                outcome_status="hypothesis", plan_id="plan-e2",
            ),
            workspace_root=self.tools.parent,
            signer_key_fp="SHA256:promotion-retry-fixture",
        )
        self.assertEqual(convention_path, self.tools / "knowledge-graph/conventions.jsonl")
        hypothesis_bytes = convention_path.read_bytes()

        class _Reader:
            def readable(self) -> tuple[bool, str]:
                return (True, "ok")

            def pr_merge_state(self, pr_number: int) -> dict:
                assert pr_number == 4242
                return {
                    "state": "MERGED",
                    "mergedAt": "2026-09-10T01:00:00Z",
                    "mergeCommit": {"oid": "f" * 40},
                }

        def fail_promotion_append(transaction, path: Path, row: dict, surface, previous) -> None:
            self.assertEqual(path, convention_path)
            self.assertEqual(row["plan_id"], "plan-e2")
            self.assertEqual(row["outcome_status"], "verified")
            self.assertEqual(
                fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
                "IMPLEMENTATION_MERGED",
            )
            raise OSError("injected promotion append failure")

        reader = _Reader()
        with patch.object(knowledge_graph, "_append_row_locked", side_effect=fail_promotion_append) as append:
            first = reconcile_recorded_implementations(base_dir=self.tools, reader=reader)
        append.assert_called_once()
        self.assertEqual([row["plan_id"] for row in first["merged"]], ["plan-e2"])
        self.assertEqual(convention_path.read_bytes(), hypothesis_bytes)

        retry = reconcile_recorded_implementations(base_dir=self.tools, reader=reader)
        events = load_declared_jsonl(
            self.tools / "plans/events.jsonl", expected_surface="plan_convergence_events",
        )
        merged = [row for row in events if row["event_type"] == "implementation_merged"]
        self.assertEqual([row["plan_id"] for row in merged], ["plan-e2"])
        served = knowledge_graph.conventions_for_paths(
            workspace_root=self.tools.parent, paths=["docs/aria/SPEC.md"],
        )
        self.assertEqual(
            [(row["plan_id"], row["outcome_status"]) for row in served],
            [("plan-e2", "verified")],
            f"persisted merge lost its promotion retry: {retry!r}",
        )

    def _seed_promotion(self) -> Path:
        from aria_kernel import knowledge_graph as kg
        self._to_recorded()
        return kg.record_convention(
            kg.Pattern(
                pattern_id="conv-recovery", pattern_type="convention", confidence=0.5,
                evidence_refs=("docs/aria/SPEC.md",), discovered_by_cycle_id="cycle-recovery",
                observed_at="2026-09-10T00:00:00Z", outcome_status="hypothesis", plan_id="plan-e2",
            ), workspace_root=self.tools.parent, signer_key_fp="SHA256:recovery-fixture",
        )

    def _process_reconciliations(self, *, count: int, available: bool) -> list[dict]:
        ctx = multiprocessing.get_context("spawn")
        results = ctx.Queue()
        barrier = ctx.Barrier(count) if count > 1 and available else None
        children = [ctx.Process(
            target=_reconcile_in_process, args=(self.tools, available, barrier, results),
        ) for _ in range(count)]
        try:
            for child in children:
                child.start()
            outcomes = [results.get(timeout=35) for _ in children]
            for child in children:
                child.join(timeout=5)
            self.assertTrue(all(child.exitcode == 0 for child in children), outcomes)
            self.assertTrue(all(status == "ok" for status, _ in outcomes), outcomes)
            return [result for _, result in outcomes]
        finally:
            for child in children:
                if child.is_alive():
                    child.terminate()
                    child.join(timeout=5)
            results.close()
            results.join_thread()

    def _assert_one_merge_and_promotion(self) -> None:
        from aria_kernel import knowledge_graph as kg
        from aria_kernel.ledger import load_declared_jsonl
        events = load_declared_jsonl(
            self.tools / "plans/events.jsonl", expected_surface="plan_convergence_events",
        )
        self.assertEqual(
            [r["plan_id"] for r in events if r["event_type"] == "implementation_merged"], ["plan-e2"],
        )
        rows = load_declared_jsonl(
            self.tools / "knowledge-graph/conventions.jsonl", expected_surface="kg_conventions",
        )
        self.assertEqual([r["outcome_status"] for r in rows], ["hypothesis", "verified"])
        self.assertEqual(
            [r["plan_id"] for r in kg.conventions_for_paths(
                workspace_root=self.tools.parent, paths=["docs/aria/SPEC.md"],
            )], ["plan-e2"],
        )
        self.assertEqual(fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")

    def test_repeated_promotion_failure_survives_restart_with_unavailable_reader(self) -> None:
        from aria_kernel import knowledge_graph as kg
        path = self._seed_promotion()
        before = path.read_bytes()
        with patch.object(kg, "_append_row_locked", side_effect=OSError("promotion disk unavailable")) as append:
            attempts = [reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader()) for _ in range(2)]
        self.assertEqual(append.call_count, 2, "terminal merge must retain pending promotion")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual([r["promotions"][0]["status"] for r in attempts], ["retryable_error", "retryable_error"])
        self.assertEqual(attempts[0]["promotions"][0]["error_type"], "OSError")
        retry = self._process_reconciliations(count=1, available=False)[0]
        self.assertEqual(retry["status"], "unreadable")
        self.assertEqual(retry["checked"], 0)
        self.assertEqual(retry["merged"], [])
        self.assertEqual(retry["promotions"][0]["status"], "promoted")
        self._assert_one_merge_and_promotion()

    def test_concurrent_reconcilers_record_one_merge_and_promotion(self) -> None:
        self._seed_promotion()
        results = self._process_reconciliations(count=2, available=True)
        self._assert_one_merge_and_promotion()
        statuses = [p["status"] for result in results for p in result["promotions"]]
        self.assertEqual(statuses.count("promoted"), 1)
        self.assertTrue(set(statuses) <= {"already_verified", "promoted"})

    def test_persisted_promotion_is_not_duplicated_after_report_failure(self) -> None:
        from aria_kernel import knowledge_graph as kg
        self._seed_promotion()
        append = kg._append_row_locked

        def append_then_fail(*args, **kwargs) -> None:
            append(*args, **kwargs)
            raise OSError("append completed before caller observed failure")

        with patch.object(kg, "_append_row_locked", side_effect=append_then_fail):
            first = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        retry = self._process_reconciliations(count=1, available=False)[0]
        self._assert_one_merge_and_promotion()
        self.assertEqual(first["promotions"][0]["status"], "retryable_error")
        self.assertEqual(retry["promotions"][0]["status"], "already_verified")

    def test_missing_hypothesis_is_observable_and_can_arrive_after_merge(self) -> None:
        from aria_kernel import knowledge_graph as kg
        path = self._seed_promotion()
        original = path.read_bytes()
        # A missing hypothesis is not evidence of completed learning.
        path.unlink()
        first = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self.assertFalse(path.exists())
        path.write_bytes(original)
        retry = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self._assert_one_merge_and_promotion()
        self.assertEqual(first["promotions"][0]["status"], "no_hypothesis")
        self.assertEqual(retry["promotions"][0]["status"], "promoted")

    def test_promotion_integrity_failure_is_visible_without_losing_merge(self) -> None:
        import json
        path = self._seed_promotion()
        row = json.loads(path.read_text())
        row["ledger_hash"] = "sha256:broken"
        path.write_text(json.dumps(row) + "\n")
        before = path.read_bytes()
        result = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self.assertEqual(fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(result["promotions"][0]["status"], "integrity_error")
        self.assertFalse(list(path.parent.glob("*.quarantined.*")))

    def test_promotion_schema_rejection_is_observable(self) -> None:
        from aria_kernel import knowledge_graph as kg
        from aria_kernel.ledger import read_jsonl
        path = self._seed_promotion()
        row = read_jsonl(path)[0]
        row["schema_version"] = 2
        kg._append_row(path, row)
        before = path.read_bytes()
        result = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self.assertEqual(result["promotions"][0]["status"], "schema_error")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")

    def test_promotion_read_outage_is_reported_as_retryable_io(self) -> None:
        from aria_kernel import ledger
        path = self._seed_promotion()
        before = path.read_bytes()
        read = ledger.read_jsonl

        def fail_convention_read(target, *args, **kwargs):
            if Path(target) == path:
                raise OSError("convention read unavailable")
            return read(target, *args, **kwargs)

        with patch.object(ledger, "read_jsonl", side_effect=fail_convention_read):
            result = reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self.assertEqual(fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(result["promotions"][0]["status"], "retryable_error")
        self.assertEqual(result["promotions"][0]["error_type"], "OSError")
        reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self._assert_one_merge_and_promotion()

    def test_cached_merge_does_not_authorize_promotion_from_damaged_plan_ledger(self) -> None:
        import json
        from aria_kernel import knowledge_graph as kg
        from aria_kernel.ledger import LedgerIntegrityError
        from aria_kernel.tool_registry import GovernanceError
        path = self._seed_promotion()
        with patch.object(kg, "_append_row_locked", side_effect=OSError("not yet promoted")):
            reconcile_recorded_implementations(base_dir=self.tools, reader=MergedPRReader())
        self.assertEqual(fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"], "IMPLEMENTATION_MERGED")
        events = self.tools / "plans/events.jsonl"
        raw = events.read_bytes()
        last_hash = json.loads(raw.splitlines()[-1])["ledger_hash"].encode()
        damaged = raw.replace(last_hash, b"x" * len(last_hash))
        self.assertEqual(len(damaged), len(raw), "exercise the warm size-keyed fold cache")
        events.write_bytes(damaged)
        before = path.read_bytes()

        class UnavailableReader:
            def readable(self) -> tuple[bool, str]:
                return (False, "offline")

        with self.assertRaises((LedgerIntegrityError, GovernanceError)):
            reconcile_recorded_implementations(base_dir=self.tools, reader=UnavailableReader())
        self.assertEqual(events.read_bytes(), damaged)
        self.assertEqual(path.read_bytes(), before)

    def test_reconciler_leaves_unmerged_pr_alone(self) -> None:
        self._to_recorded()

        class _Reader:
            def readable(self):
                return (True, "ok")

            def pr_merge_state(self, pr_number: int):
                return {"state": "OPEN", "mergedAt": None, "mergeCommit": None}

        result = reconcile_recorded_implementations(base_dir=self.tools, reader=_Reader())
        self.assertEqual(result["merged"], [])
        self.assertEqual(
            fold_plan_state(plan_id="plan-e2", base_dir=self.tools)["state"],
            "IMPLEMENTATION_RECORDED",
        )

    def test_pr_number_extraction(self) -> None:
        self.assertEqual(_pr_number_from_url("https://github.com/o/r/pull/17"), 17)
        self.assertIsNone(_pr_number_from_url("not-a-url"))


class OrphanReapWindowTests(unittest.TestCase):
    """ORPHAN-HIGH-729 — an outstanding request is not the same thing as an
    abandoned one, once mint and drain live in different workflow runs.

    The scanner has always carried `last_event_at`; nothing read it. These
    pin the reap window itself, at the scanner boundary the orchestrator's
    startup hook consumes, so the policy is testable without booting an
    orchestrator (the hook's own behaviour is pinned in
    `tests/test_autonomy_orchestrator.py`).
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_window_is_one_executor_night_plus_slack(self) -> None:
        from aria_kernel.plan_convergence import (
            ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS,
            STALE_PLAN_MAX_AGE_HOURS,
        )
        self.assertEqual(ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS, 24)
        self.assertEqual(
            STALE_PLAN_MAX_AGE_HOURS, 72,
            "adoption staleness mirrors autonomy_unlock's acceptance gap and "
            "is a different policy; folding the two together would tie the "
            "executor window to the ladder's continuity rule",
        )

    @staticmethod
    def _hours_ago(hours: float) -> str:
        from datetime import datetime, timedelta, timezone

        return (
            datetime.now(timezone.utc) - timedelta(hours=hours)
        ).isoformat().replace("+00:00", "Z")

    def test_a_request_inside_the_window_is_not_old_enough_to_reap(self) -> None:
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_REAP,
            ORPHAN_DECISION_SPARE_RECENT,
            decide_orphan_reap,
        )
        self.assertEqual(
            decide_orphan_reap({"last_event_at": self._hours_ago(1)}).decision,
            ORPHAN_DECISION_SPARE_RECENT,
        )
        self.assertEqual(
            decide_orphan_reap({"last_event_at": self._hours_ago(30)}).decision,
            ORPHAN_DECISION_REAP,
        )

    def test_an_unreadable_newest_stamp_falls_back_to_the_plans_birth(self) -> None:
        """A corrupt `recorded_at` must not be able to buy a plan immunity.

        The first version of this bound asked `_older_than_hours`, which
        answers False for an unparseable stamp — so a mangled row read
        exactly like a request minted ten minutes ago, and the plan was
        filed as `spared_recent` forever. The age now comes from the plan's
        FIRST event when its newest one cannot be read: older by definition,
        so the fallback can only ever make a plan look old enough, never
        young enough.
        """
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_REAP,
            ORPHAN_DECISION_SPARE_RECENT,
            decide_orphan_reap,
        )
        stale = decide_orphan_reap({
            "last_event_at": "not-a-date",
            "first_event_at": self._hours_ago(30),
        })
        self.assertEqual(stale.decision, ORPHAN_DECISION_REAP)
        self.assertEqual(stale.age_source, "first_event_at")
        recent = decide_orphan_reap({
            "last_event_at": "not-a-date",
            "first_event_at": self._hours_ago(2),
        })
        self.assertEqual(recent.decision, ORPHAN_DECISION_SPARE_RECENT)
        self.assertEqual(recent.age_source, "first_event_at")

    def test_a_plan_with_no_readable_stamp_at_all_is_undateable(self) -> None:
        """Neither stamp readable is a corrupt ledger, not a schedule
        question: `_append_event` always stamps, so this shape cannot be
        produced by the writer. The decision says so by name, and the caller
        escalates rather than guessing in either direction — sparing it was
        what made such a plan immortal, since `resume_candidate_plan_id`
        skips implementation-phase states and never sees it."""
        from aria_kernel.plan_convergence import (
            ORPHAN_DECISION_ESCALATE_UNDATEABLE,
            decide_orphan_reap,
        )
        for orphan in (
            {"last_event_at": None, "first_event_at": None},
            {"last_event_at": "not-a-date", "first_event_at": "also-not-a-date"},
            {},
        ):
            with self.subTest(orphan=orphan):
                decision = decide_orphan_reap(orphan)
                self.assertEqual(
                    decision.decision, ORPHAN_DECISION_ESCALATE_UNDATEABLE,
                )
                self.assertIsNone(decision.age_source)

    def test_the_scanner_reports_the_stamp_the_window_is_measured_from(self) -> None:
        """The bound is only as real as the field it reads. `last_event_at`
        was `None` for every orphan until the writer/reader mismatch was
        fixed (C12/E8); a bound over `None` would spare everything forever."""
        from aria_kernel.plan_convergence import scan_orphan_implementation_requests

        start_plan(
            plan_id="plan-window",
            initial_revision_id="rev-0",
            plan_content=converging_plan_content("window"),
            base_dir=self.tools,
        )
        with patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={"state": "IMPLEMENTATION_REQUESTED"},
        ):
            orphans = scan_orphan_implementation_requests(base_dir=self.tools)
        self.assertEqual([row["plan_id"] for row in orphans], ["plan-window"])
        self.assertIsInstance(orphans[0]["last_event_at"], str)
        self.assertTrue(orphans[0]["last_event_at"])
        # ...and the second clock, which is what gives a plan with one
        # mangled row a terminal path instead of permanent immunity.
        self.assertIsInstance(orphans[0]["first_event_at"], str)
        self.assertTrue(orphans[0]["first_event_at"])


class PlanContinuityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_mid_flight_plan_is_adopted(self) -> None:
        start_plan(
            plan_id="plan-last-night",
            initial_revision_id="rev-0",
            plan_content=converging_plan_content("last night"),
            base_dir=self.tools,
        )
        self.assertEqual(
            resume_candidate_plan_id(base_dir=self.tools), "plan-last-night"
        )

    def test_no_mid_flight_plan_means_fresh_start(self) -> None:
        self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
