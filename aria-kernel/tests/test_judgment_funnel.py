"""WP-J slice C — the judgment funnel is the ONE routing owner.

`_phase_judgment_pipeline` minted the full two-judge pair for every sampled
finding (cycle.py:1950→1958): no tier, no early stop, no cache, no
drain-sized envelope. Second sealed night measured: 462 envelopes minted
against ~9 drained, 296 dead of anchor staleness. WP-J's synthesis folds
WP-J-1's panel_router and WP-J-2's in-fanout gate into ONE module,
`judgment_funnel`, called between `generate_judgment_sample` and
`dispatch_judges_for_sample`; tier assignment, escalation, early stop,
cache key and batch key live nowhere else.

The first law these tests pin: **policy-off is bit-for-bit legacy**. With the
funnel policy block absent the phase must hand `dispatch_judges_for_sample`
the sampler's own sample object with the exact legacy kwargs and write no
funnel row anywhere — the mechanical proof of wire-don't-rewrite.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.tool_registry import GovernanceError


def _context(base: str):
    return cycle_mod.build_phase_context(
        cycle_id="cyc-funnel",
        workspace_root=Path(base),
        base_dir=Path(base) / "aria-tools",
    )


def _run_phase(tmp: str, *, sample_items: list[dict] | None = None, enable_funnel: bool = False,
               drained: int = 0):
    """Run the real phase entry point with the sampler/dispatch recorded.

    Production-shaped: nothing mocks the process under test — the phase, the
    policy accessor, the drain measurement and the ledgers all run for real;
    only the two organs the funnel sits BETWEEN are recorded (the sampler's
    output is the funnel's real input, the dispatch's recorded kwargs are the
    funnel's real output), plus the request ledgers that feed the drain
    measurement (the suite's established seeding shape,
    test_request_admission._ledgers).
    """
    ctx = _context(tmp)
    calls: dict[str, list] = {"dispatch": []}
    items = sample_items if sample_items is not None else [
        {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
    ]
    if enable_funnel:
        # The operator's production activation: the policy override file the
        # accessor merges over the shipped defaults.
        import json

        override = Path(tmp) / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(json.dumps({
            "$schema": "aria/genesis-policy/v1",
            "judgment_pipeline": {"funnel_enabled": True},
        }), encoding="utf-8")

    def fake_sample(**kw):
        return {"sample_id": "S1", "cycle_id": kw.get("cycle_id"), "items": [dict(i) for i in items]}

    def fake_dispatch(**kw):
        calls["dispatch"].append(kw)
        return {"minted": [], "skipped": []}

    from datetime import datetime, timedelta, timezone

    now = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)
    ledgers = _seed_ledgers(drained=drained, now=now)

    with _door_open(), patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
         patch("aria_kernel.feedback_store.generate_judgment_sample", fake_sample), \
         patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
         patch("aria_kernel.feedback_store.generate_ai_consensus",
               return_value={"consensus": []}), \
         patch("aria_kernel.request_drain_capacity._request_ledgers", return_value=ledgers), \
         patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value="a" * 40):
        result = cycle_mod._phase_judgment_pipeline(ctx)
    return result, calls, ctx


def _door_open():
    """Isolate the router-under-test from the admission door's environment.

    The door (request_admission) is an INPUT organ for the tier/envelope
    tests, like the drain ledgers: its own suite pins it. On a shared host
    the door's provider read depends on the routing table's global state
    (a sibling slice mid-flight on the panel roles makes it fail closed),
    which must not decide whether SEVERITY ROUTING works. The door's own
    contract is pinned by test_request_admission and by the
    PRODUCER_CLASSES assertion below.
    """
    from aria_kernel.request_admission import Admission, CRITICAL_PATH

    def _always_admit(producer, role, **_kw):
        return Admission(producer, role, CRITICAL_PATH, "test", 1, True, CRITICAL_PATH)

    return patch("aria_kernel.request_admission.admit_request", _always_admit)


def _seed_ledgers(*, drained: int, now) -> tuple[list[dict], list[dict], list[dict]]:
    """Request/result/claim ledgers with ``drained`` results inside the
    7-day window (drain_per_day = drained/7) and no claimable backlog."""
    from datetime import timedelta

    iso = lambda dt: dt.isoformat().replace("+00:00", "Z")  # noqa: E731

    requests, results = [], []
    for i in range(drained):
        requests.append({"request_id": f"d-{i}", "role": "evidence_judgment",
                         "state": "pending", "created_at": iso(now - timedelta(days=1, hours=1))})
        results.append({"request_id": f"d-{i}", "status": "rejected",
                        "submitted_at": iso(now - timedelta(days=1))})
    return requests, results, []


def _governance_kinds(base_dir: Path) -> list[str]:
    path = base_dir / "governance.jsonl"
    if not path.exists():
        return []
    import json

    return [json.loads(line).get("kind") for line in path.read_text().splitlines() if line.strip()]


class FunnelExistsTest(unittest.TestCase):
    def test_the_one_router_module_exists_and_names_its_law(self) -> None:
        # RED-first pin: the routing owner is ONE module, imported by the
        # phase, and no tier/routing logic lives in dispatch_judges_for_sample.
        from aria_kernel import judgment_funnel

        self.assertTrue(callable(judgment_funnel.route_judgment_sample))


class PolicyOffGoldenTest(unittest.TestCase):
    """The funnel block absent → the phase is byte-identical to legacy."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def test_policy_off_hands_dispatch_the_samplers_own_sample_with_legacy_kwargs(self) -> None:
        with TemporaryDirectory() as tmp:
            result, calls, ctx = _run_phase(tmp)

            # ONE dispatch call per tool, with the legacy kwarg set — the
            # funnel must not add, drop or rename a single kwarg while off.
            self.assertEqual(len(calls["dispatch"]), 1)
            dispatched = calls["dispatch"][0]
            self.assertEqual(
                set(dispatched),
                {"sample", "base_dir", "target_sha", "repo_root", "max_pending_per_role"},
            )
            self.assertEqual(dispatched["target_sha"], "a" * 40)
            self.assertEqual(dispatched["max_pending_per_role"], 32)
            # The sample is the sampler's own object, unfiltered, unreordered.
            self.assertEqual([i["finding_id"] for i in dispatched["sample"]["items"]], ["F1"])

    def test_policy_off_writes_no_funnel_row_anywhere(self) -> None:
        with TemporaryDirectory() as tmp:
            _result, _calls, ctx = _run_phase(tmp)
            self.assertEqual(_result["status"], "completed")

            kinds = [k for k in _governance_kinds(ctx.base_dir) if k and "judgment_funnel" in k]
            self.assertEqual(kinds, [], "policy-off must write no judgment_funnel governance row")
            self.assertFalse((ctx.base_dir / "judgment-funnel").exists(),
                             "policy-off must not create the funnel ledger")

    def test_the_pre_funnel_phase_pins_still_pass_unmodified(self) -> None:
        # The existing test_judgment_pipeline_phases suite pins the phase's
        # legacy counts; running it is part of this finding's proof, recorded
        # in the commit. Here: the phase result keeps its legacy shape.
        with TemporaryDirectory() as tmp:
            result, _calls, _ctx = _run_phase(tmp)
            for key in ("sampled_findings", "judge_requests_minted", "mint_skipped_backlog",
                        "consensus_rows", "arbiter_requests_minted", "target_sha", "blocked"):
                self.assertIn(key, result)


class EnvelopeBudgetHoldsTest(unittest.TestCase):
    """Caps HOLD (579 discipline): refusal, never a raise, never lost work."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def test_a_dead_drain_holds_the_night_mints_nothing_and_the_phase_completes(self) -> None:
        # The measured drain is 0 (the design-time verdict: last judgment
        # mint 2026-10-01) → tonight's envelope allowance is 0 → the funnel
        # plans no seat, dispatch is never handed an item, the phase returns
        # completed and ONE governance row names the held work.
        with TemporaryDirectory() as tmp:
            result, calls, ctx = _run_phase(
                tmp, enable_funnel=True, drained=0,
                sample_items=[
                    {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
                    {"finding_id": "F2", "tool_id": "adapter-a", "run_id": "run-1", "rule": "rule-x"},
                ],
            )

            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["judge_requests_minted"], 0)
            for kw in calls["dispatch"]:
                self.assertEqual(kw["sample"]["items"], [],
                                 "a held night must not hand the fan-out any item")
            kinds = _governance_kinds(ctx.base_dir)
            self.assertEqual(kinds.count("judgment_funnel_budget_held"), 1)
            # HOLD, not fail: no blocked entry, no GovernanceError, nothing
            # that reads as a fault.
            self.assertEqual(result["blocked"], [])
            # 579 discipline: the findings stay sampleable — the funnel wrote
            # no feedback row that would exclude them from the next sample.
            feedback = ctx.base_dir / "feedback.jsonl"
            self.assertFalse(feedback.exists())

    def test_a_live_drain_grants_a_drain_sized_allowance(self) -> None:
        # 91 results in the 7-day window = 13/day → allowance = min(cap 13,
        # ceil(13)) = 13 envelopes; the item's pair (2 seats) fits.
        with TemporaryDirectory() as tmp:
            result, calls, _ctx = _run_phase(
                tmp, enable_funnel=True, drained=91,
                sample_items=[{"finding_id": "F1", "tool_id": "adapter-a",
                               "run_id": "run-1", "rule": "rule-x"}],
            )
            self.assertEqual(result["status"], "completed")
            self.assertTrue(any(kw["sample"]["items"] for kw in calls["dispatch"]),
                            "a live drain must route the sampled item")

    def test_the_mint_path_never_calls_the_raising_budget_gate(self) -> None:
        # assert_within_budget raises GovernanceError and trips the breaker:
        # banned from every mint path. The module's own source is the proof
        # surface — a call would have to be spelled here.
        import aria_kernel.judgment_funnel as funnel_mod
        import inspect

        source = inspect.getsource(funnel_mod)
        self.assertNotIn("assert_within_budget", source)
        self.assertNotIn("from .cost_budget", source)

    def test_the_funnel_is_admitted_through_the_request_admission_door(self) -> None:
        # The envelope hold is expressed THROUGH the door: a per-tier
        # producer classified in PRODUCER_CLASSES, so a refusal is named,
        # recorded by the door, and the finding is re-offered next cycle.
        from aria_kernel.request_admission import PRODUCER_CLASSES

        spec = PRODUCER_CLASSES.get("judgment_funnel.tiers")
        self.assertIsNotNone(spec, "the funnel's mint must be classified at the door")
        self.assertEqual(
            spec.roles,
            {"evidence_judgment": "discretionary", "adversarial_judgment": "discretionary"},
        )


class Tier0EarlyStopTest(unittest.TestCase):
    """Tier-0 mechanical checks run before any mint; a reject is an early stop."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def _repo(self, tmp: str) -> str:
        """A real hermetic git repo (the suite applies hermetic_git_env on
        import) with one committed file, returning its HEAD sha."""
        import subprocess

        repo = Path(tmp) / "ws"
        repo.mkdir()

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(repo), *args], check=True,
                           capture_output=True, text=True)

        git("init", "-q")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "user.name", "fixture")
        (repo / "src").mkdir()
        (repo / "src" / "real.py").write_text("print('hello')\n", encoding="utf-8")
        # The operator's production activation, inside the workspace the
        # policy accessor reads.
        config = repo / "aria-config"
        config.mkdir()
        (config / "genesis_policy.json").write_text(
            '{"$schema": "aria/genesis-policy/v1", "judgment_pipeline": {"funnel_enabled": true}}',
            encoding="utf-8",
        )
        git("add", "-A")
        git("commit", "-q", "-m", "fixture")
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                              check=True, capture_output=True, text=True).stdout.strip()

    def _run_funnel(self, tmp: str, *, items: list[dict]) -> tuple[dict, list[dict], Path]:
        head = self._repo(tmp)
        ctx = cycle_mod.build_phase_context(
            cycle_id="cyc-tier0",
            workspace_root=Path(tmp) / "ws",
            base_dir=Path(tmp) / "aria-tools",
        )
        calls: list[dict] = []

        def fake_dispatch(**kw):
            calls.append(kw)
            return {"minted": [], "skipped": []}

        with _door_open(), patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
             patch("aria_kernel.feedback_store.generate_judgment_sample",
                   return_value={"sample_id": "S1", "cycle_id": "cyc-tier0", "items": items}), \
             patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
             patch("aria_kernel.feedback_store.generate_ai_consensus",
                   return_value={"consensus": []}), \
             patch("aria_kernel.request_drain_capacity._request_ledgers",
                   return_value=_seed_ledgers(drained=91, now=datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc))), \
             patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value=head):
            result = cycle_mod._phase_judgment_pipeline(ctx)
        return result, calls, ctx

    def test_an_unresolved_ref_is_rejected_before_any_mint(self) -> None:
        # The operator's funnel law, step 2: refs resolve at the SHA, and a
        # failure here is rejected with NO LLM call. The item cites a path
        # that does not exist in the tree at HEAD — the funnel must not hand
        # it to the fan-out, must name the refusal, and the phase completes.
        with TemporaryDirectory() as tmp:
            result, calls, ctx = self._run_funnel(
                tmp,
                items=[{"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1",
                        "rule": "rule-x", "path": "src/missing.py", "severity": "medium"}],
            )

            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["judge_requests_minted"], 0)
            for kw in calls:
                self.assertEqual(kw["sample"]["items"], [],
                                 "a tier-0 reject must never be dispatched")
            kinds = _governance_kinds(ctx.base_dir)
            self.assertIn("judgment_funnel_tier0_rejected", kinds)
            # Not a fault and not a hold: a REFUSAL with its own name.
            self.assertNotIn("judgment_funnel_budget_held", kinds)
            self.assertEqual(result["blocked"], [])
            # The finding stays sampleable: no feedback row excludes it.
            self.assertFalse((ctx.base_dir / "feedback.jsonl").exists())

    def test_a_resolving_ref_passes_through_to_the_fanout(self) -> None:
        with TemporaryDirectory() as tmp:
            _result, calls, _ctx = self._run_funnel(
                tmp,
                items=[{"finding_id": "F1", "tool_id": "adapter-a", "run_id": "run-1",
                        "rule": "rule-x", "path": "src/real.py", "severity": "medium"}],
            )
            self.assertTrue(any(kw["sample"]["items"] for kw in calls),
                            "a resolving ref must reach the fan-out")

    def test_the_tier0_module_is_a_pure_named_gate(self) -> None:
        # No anchor to verify against is NOT a verdict (the tri-state law):
        # the item passes with a note, never rejected on missing data.
        from aria_kernel.tier0 import tier0_gate

        verdict = tier0_gate({"path": "src/real.py"}, None, repo_root=None, target_sha=None)
        self.assertEqual(verdict["status"], "pass")
        self.assertTrue(verdict.get("note"))


class TierRoutingTest(unittest.TestCase):
    """Severity routes the ladder; tier 2 is ONE seat; tier 4 is quota-bound."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def _run(self, tmp: str, items: list[dict], *, extra_policy: dict | None = None,
             drained: int = 91):
        import json

        repo = Path(tmp) / "ws"
        repo.mkdir(parents=True, exist_ok=True)
        import subprocess

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(repo), *args], check=True,
                           capture_output=True, text=True)

        git("init", "-q")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "user.name", "fixture")
        (repo / "src").mkdir(exist_ok=True)
        for rule_file in ("a.py", "b.py"):
            (repo / "src" / rule_file).write_text("x = 1\n", encoding="utf-8")
        policy: dict = {"funnel_enabled": True}
        policy.update(extra_policy or {})
        config = repo / "aria-config"
        config.mkdir(exist_ok=True)
        (config / "genesis_policy.json").write_text(json.dumps(
            {"$schema": "aria/genesis-policy/v1", "judgment_pipeline": policy}), encoding="utf-8")
        git("add", "-A")
        git("commit", "-q", "-m", "fixture")
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                              check=True, capture_output=True, text=True).stdout.strip()
        ctx = cycle_mod.build_phase_context(
            cycle_id="cyc-tiers", workspace_root=repo, base_dir=Path(tmp) / "aria-tools",
        )
        calls: list[dict] = []

        def fake_dispatch(**kw):
            calls.append(kw)
            return {"minted": [], "skipped": []}

        with _door_open(), patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
             patch("aria_kernel.feedback_store.generate_judgment_sample",
                   return_value={"sample_id": "S1", "cycle_id": "cyc-tiers", "items": items}), \
             patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
             patch("aria_kernel.feedback_store.generate_ai_consensus",
                   return_value={"consensus": []}), \
             patch("aria_kernel.request_drain_capacity._request_ledgers",
                   return_value=_seed_ledgers(drained=drained, now=datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc))), \
             patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value=head):
            result = cycle_mod._phase_judgment_pipeline(ctx)
        return result, calls, ctx

    def _routing_rows(self, ctx) -> list[dict]:
        from aria_kernel.judgment_funnel import routing_path
        from aria_kernel.ledger import load_declared_jsonl

        path = routing_path(ctx.base_dir)
        return load_declared_jsonl(path, expected_surface="judgment_funnel_routing") if path.exists() else []

    def test_severity_routes_and_tier2_mints_one_seat(self) -> None:
        # Operator tier semantics: T2 = ONE seat for S/M risk, T3 for HIGH,
        # T4 (full panel, quota-bound) for CRITICAL. The one-seat tier is
        # expressed through the roles the router hands the fan-out — the
        # fan-out itself keeps no tier logic.
        with TemporaryDirectory() as tmp:
            items = [
                {"finding_id": "F-LOW", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "LOW"},
                {"finding_id": "F-MED", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "MEDIUM"},
                {"finding_id": "F-HIGH", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "HIGH"},
                {"finding_id": "F-CRIT", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "CRITICAL"},
            ]
            _result, calls, ctx = self._run(tmp, items)

            rows = {row["finding_id"]: row for row in self._routing_rows(ctx) if row.get("held") is None}
            self.assertEqual(rows["F-LOW"]["tier"], 2)
            self.assertEqual(rows["F-MED"]["tier"], 2)
            self.assertEqual(rows["F-HIGH"]["tier"], 3)
            self.assertEqual(rows["F-CRIT"]["tier"], 4)
            self.assertEqual(rows["F-LOW"]["seats_planned"], 1)
            self.assertEqual(rows["F-HIGH"]["seats_planned"], 2)

            tier2_leg = next(kw for kw in calls if kw.get("roles") is not None)
            self.assertEqual(
                [i["finding_id"] for i in tier2_leg["sample"]["items"]], ["F-LOW", "F-MED"],
            )
            self.assertEqual(
                tier2_leg["roles"],
                (("evidence_judgment", "aria-evidence-judge"),),
                "tier 2 mints exactly one seat",
            )
            # The default-pair legs carry no roles kwarg at all.
            pair_legs = [kw for kw in calls if kw.get("roles") is None]
            self.assertTrue(any(kw["sample"]["items"] for kw in pair_legs))

    def test_tier4_is_quota_bound(self) -> None:
        # At most funnel_tier4_quota of the night's decisions: 10 CRITICAL
        # items at quota 0.10 leave exactly one at tier 4; the rest
        # downgrade to tier 3, on the record.
        with TemporaryDirectory() as tmp:
            items = [
                {"finding_id": f"F-CRIT-{i}", "tool_id": "adapter-a", "run_id": "r",
                 "rule": "rule-a", "path": "src/a.py", "severity": "CRITICAL"}
                for i in range(10)
            ]
            _result, _calls, ctx = self._run(
                tmp, items, extra_policy={"funnel_nightly_envelope": 20}, drained=161,
            )
            rows = [row for row in self._routing_rows(ctx) if row.get("held") is None]
            tiers = sorted(row["tier"] for row in rows)
            self.assertEqual(len(rows), 10, "every item routed: the envelope fits")
            self.assertEqual(tiers.count(4), 1)
            self.assertEqual(tiers.count(3), 9)

    def test_the_batch_key_groups_same_rule_findings(self) -> None:
        # Batching key (tool_id, rule): same-rule findings are minted
        # adjacently so the drain's sibling fill serves them as one batch.
        with TemporaryDirectory() as tmp:
            items = [
                {"finding_id": "F1", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-b",
                 "path": "src/b.py", "severity": "MEDIUM"},
                {"finding_id": "F2", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "MEDIUM"},
                {"finding_id": "F3", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-b",
                 "path": "src/b.py", "severity": "MEDIUM"},
                {"finding_id": "F4", "tool_id": "adapter-a", "run_id": "r", "rule": "rule-a",
                 "path": "src/a.py", "severity": "MEDIUM"},
            ]
            _result, calls, _ctx = self._run(tmp, items)
            order = [i["finding_id"] for kw in calls for i in kw["sample"]["items"]]
            self.assertEqual(order.index("F2") < order.index("F3"), True)
            self.assertEqual(
                [i["rule"] for kw in calls for i in kw["sample"]["items"]],
                ["rule-a", "rule-a", "rule-b", "rule-b"],
                "same-rule findings must be minted adjacently (the batch key)",
            )

    def test_calibration_sampling_routes_low_to_the_full_tier(self) -> None:
        # LOW findings sampled to the full tier purely for calibration
        # (funnel_calibration_sample_per_cycle), marked on the routing row.
        with TemporaryDirectory() as tmp:
            items = [
                {"finding_id": "F-LOW", "tool_id": "adapter-a", "run_id": "r",
                 "rule": "rule-a", "path": "src/a.py", "severity": "LOW"},
            ]
            _result, _calls, ctx = self._run(tmp, items)
            rows = [row for row in self._routing_rows(ctx) if row.get("held") is None]
            self.assertEqual(rows[0]["tier"], 4)
            self.assertIs(rows[0].get("calibration"), True)

    def test_tier1_jev_is_shadow_only(self) -> None:
        # J2 is asked (recorded) and NEVER routed on: with no registry the
        # outcome is "unavailable" and severity still routes the item.
        with TemporaryDirectory() as tmp:
            items = [
                {"finding_id": "F-MED", "tool_id": "adapter-a", "run_id": "r",
                 "rule": "rule-a", "path": "src/a.py", "severity": "MEDIUM",
                 "evidence": ["src/a.py:1"]},
            ]
            _result, calls, ctx = self._run(tmp, items)
            rows = [row for row in self._routing_rows(ctx) if row.get("held") is None]
            self.assertEqual(rows[0]["tier"], 2, "shadow score must not change the tier")
            self.assertEqual(rows[0].get("tier1", {}).get("outcome"), "unavailable")
            self.assertTrue(any(kw["sample"]["items"] for kw in calls))


_JUDGE_LAW_REF = ".claude/knowledge/layer-2-judge-law.md"


def _kernel_checkout(tmp: str) -> Path:
    """The fixture KERNEL checkout: where the executor renders every judge
    seat's contract from (ARIA-HIGH-146), apart from the workspace. The
    evidence judge cites a knowledge file, inlined into its contract."""
    from aria_kernel.agent_surface import JUDGE_ROLES, ROLE_TARGET_PAIRING

    kernel = Path(tmp) / "kernel"
    if not kernel.exists():
        (kernel / "aria-kernel").mkdir(parents=True)
        agents = kernel / ".claude" / "agents"
        agents.mkdir(parents=True)
        for agent in {agent for role in JUDGE_ROLES for agent in ROLE_TARGET_PAIRING[role]}:
            cites = f"\nWeigh per @{_JUDGE_LAW_REF}\n" if agent == "aria-evidence-judge" else ""
            (agents / f"{agent}.md").write_text(
                f"---\nname: {agent}\n---\n{agent} contract v1\n{cites}", encoding="utf-8")
        (kernel / _JUDGE_LAW_REF).parent.mkdir(parents=True)
        (kernel / _JUDGE_LAW_REF).write_text("judge law v1\n", encoding="utf-8")
    return kernel


class JudgmentCacheTest(unittest.TestCase):
    """A settled verdict over identical cited code is reused, never re-paid."""

    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_CONSENSUS_PROMOTION_ACK", "operator-approved-tests")

    def _night(self, tmp: str, items: list[dict], *, mutate: bool = False,
               edit: dict[str, str] | None = None, kernel_edit: dict[str, str] | None = None):
        import json
        import subprocess

        repo = Path(tmp) / "ws"
        if not repo.exists():
            repo.mkdir(parents=True)

            def git(*args: str) -> None:
                subprocess.run(["git", "-C", str(repo), *args], check=True,
                               capture_output=True, text=True)

            git("init", "-q")
            git("config", "user.email", "fixture@example.invalid")
            git("config", "user.name", "fixture")
            (repo / "src").mkdir()
            (repo / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
            config = repo / "aria-config"
            config.mkdir()
            (config / "genesis_policy.json").write_text(json.dumps(
                {"$schema": "aria/genesis-policy/v1",
                 "judgment_pipeline": {"funnel_enabled": True}}), encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", "fixture")

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(repo), *args], check=True,
                           capture_output=True, text=True)

        if mutate:
            (repo / "src" / "a.py").write_text("x = 2  # changed\n", encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", "code change")
        if edit:
            for rel, text in edit.items():
                (repo / rel).parent.mkdir(parents=True, exist_ok=True)
                (repo / rel).write_text(text, encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", "edit")
        kernel = _kernel_checkout(tmp)
        for rel, text in (kernel_edit or {}).items():
            (kernel / rel).write_text(text, encoding="utf-8")
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                              check=True, capture_output=True, text=True).stdout.strip()
        # Each night starts 24h apart: the finding-opener gate admits one
        # fan-out per interval (cycle_guard), so a same-day second night
        # would be throttled before the funnel ever ran.
        night_index = 0 if not hasattr(self, "_nights") else self._nights
        self._nights = getattr(self, "_nights", 0) + 1
        from datetime import timedelta

        ctx = cycle_mod.build_phase_context(
            cycle_id=f"cyc-cache-{night_index}-{mutate}", workspace_root=repo,
            base_dir=Path(tmp) / "aria-tools",
            cycle_started_at=datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)
            + timedelta(days=night_index),
        )
        calls: list[dict] = []

        def fake_dispatch(**kw):
            calls.append(kw)
            return {"minted": [], "skipped": []}

        with _door_open(), patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "adapter-a"}]), \
             patch("aria_kernel.feedback_store.generate_judgment_sample",
                   return_value={"sample_id": "S", "cycle_id": ctx.cycle_id, "items": items}), \
             patch("aria_kernel.judge_fanout.dispatch_judges_for_sample", fake_dispatch), \
             patch("aria_kernel.feedback_store.generate_ai_consensus",
                   return_value={"consensus": []}), \
             patch("aria_kernel.request_drain_capacity._request_ledgers",
                   return_value=_seed_ledgers(drained=91, now=datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc))), \
             patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha", return_value=head), \
             patch("aria_kernel.claude_settings.kernel_code_root", return_value=kernel / "aria-kernel"):
            result = cycle_mod._phase_judgment_pipeline(ctx)
        return result, calls, ctx

    def _seed_consensus(self, ctx, *, fingerprint: str, group: str) -> None:
        from aria_kernel.feedback_store import record_operator_feedback

        record_operator_feedback(
            tool_id="adapter-a", run_id="r", finding_id="F-1",
            verdict="false_positive", severity="low", note="settled",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            judgment_group_id=group, finding_fingerprint=fingerprint,
            judge_count=3, judges_voted=3,
            observers=[{"judge_id": "j1", "model": "m1"}, {"judge_id": "j2", "model": "m2"},
                       {"judge_id": "j3", "model": "m3"}],
            confidence=0.9, base_dir=ctx.base_dir,
        )

    def test_a_hit_mints_nothing_and_a_blob_change_invalidates(self) -> None:
        fingerprint = "fp-same-claim"
        item = {"finding_id": "F-1", "tool_id": "adapter-a", "run_id": "r",
                "rule": "rule-a", "path": "src/a.py", "severity": "MEDIUM",
                "finding_fingerprint": fingerprint}
        with TemporaryDirectory() as tmp:
            # Night 1: the item routes; the group later settles.
            _r1, calls1, ctx = self._night(tmp, [dict(item)])
            self.assertTrue(any(kw["sample"]["items"] for kw in calls1))
            from aria_kernel.judge_fanout import _group_id

            self._seed_consensus(ctx, fingerprint=fingerprint, group=_group_id(item))

            # Night 2, same fingerprint, SAME cited code, a fresh finding id
            # (what a re-run of the adapter mints): the cache answers and
            # nothing is dispatched for it.
            item2 = dict(item, finding_id="F-2")
            _r2, calls2, _ctx2 = self._night(tmp, [item2])
            self.assertFalse(any(kw["sample"]["items"] for kw in calls2),
                             "a cache hit must mint nothing")

            from aria_kernel.judgment_funnel import routing_path
            from aria_kernel.ledger import load_declared_jsonl

            rows = [r for r in load_declared_jsonl(
                routing_path(ctx.base_dir), expected_surface="judgment_funnel_routing")
                if r.get("finding_id") == "F-2"]
            self.assertIs(rows[-1].get("cache_hit"), True)
            self.assertEqual(rows[-1].get("held"), "cache_hit")

            # Night 3: the cited blob CHANGED — the pin no longer describes
            # the code, the verdict is stale, and the item is judged again.
            item3 = dict(item, finding_id="F-3")
            _r3, calls3, _ctx3 = self._night(tmp, [item3], mutate=True)
            self.assertTrue(any(kw["sample"]["items"] for kw in calls3),
                            "a blob change must invalidate the cache")

    def test_a_judge_contract_edit_invalidates_the_cached_verdict(self) -> None:
        # J2 (SEPT-HARVEST §2) — no cached verdict outlives the judge that
        # gave it. The judge's identity has ONE owner: the contract the
        # executor DELIVERS (agent_contract_delivery.render_agent_contract —
        # agent body + inlined knowledge + validator contract), rendered
        # from the KERNEL checkout (ARIA-HIGH-146), the same hash
        # score_judges scopes calibration on. The workspace tree at
        # target_sha is not where a judge's contract comes from: a cited
        # knowledge-file edit, or an agent edit in the kernel checkout with
        # the workspace sha unchanged, is a new judge and a miss.
        from aria_kernel.agent_contract_delivery import render_agent_contract
        from aria_kernel.judge_fanout import _group_id

        fingerprint = "fp-same-claim"
        item = {"finding_id": "F-1", "tool_id": "adapter-a", "run_id": "r",
                "rule": "rule-a", "path": "src/a.py", "severity": "MEDIUM",
                "finding_fingerprint": fingerprint}
        judge_body = ".claude/agents/aria-evidence-judge.md"
        cases = {
            "cited knowledge file": {_JUDGE_LAW_REF: "judge law v2: rule X\n"},
            "agent body in the kernel checkout only": {judge_body: (
                "---\nname: aria-evidence-judge\n---\naria-evidence-judge contract v2\n"
                f"\nWeigh per @{_JUDGE_LAW_REF}\n")},
        }
        for label, kernel_edit in cases.items():
            with self.subTest(edit=label), TemporaryDirectory() as tmp:
                self._nights = 0
                _r1, calls1, ctx = self._night(tmp, [dict(item)])
                self.assertTrue(any(kw["sample"]["items"] for kw in calls1))
                self._seed_consensus(ctx, fingerprint=fingerprint, group=_group_id(item))

                # Night 2: an unrelated workspace commit — same code, same judges.
                _r2, calls2, _ctx2 = self._night(
                    tmp, [dict(item, finding_id="F-2")], edit={"docs/notes.md": "unrelated\n"})
                self.assertFalse(any(kw["sample"]["items"] for kw in calls2),
                                 "an unrelated commit must not invalidate the cache")

                kernel = _kernel_checkout(tmp)
                before = render_agent_contract("aria-evidence-judge", repo_root=kernel).contract_hash
                # Night 3: the judge changed in the kernel checkout; the
                # workspace (and its target_sha) did not.
                _r3, calls3, _ctx3 = self._night(
                    tmp, [dict(item, finding_id="F-3")], kernel_edit=kernel_edit)
                after = render_agent_contract("aria-evidence-judge", repo_root=kernel).contract_hash
                self.assertNotEqual(before, after)
                self.assertTrue(any(kw["sample"]["items"] for kw in calls3),
                                "a delivered judge contract edit must invalidate the cached verdict")

    def test_unknown_blob_state_is_a_miss_never_a_hit(self) -> None:
        # Tri-state law at the cache boundary: no anchor, no verdict.
        from aria_kernel.evidence_trust import cited_blobs_code_hash

        self.assertIsNone(cited_blobs_code_hash(Path("/tmp"), ["a.py"], None))
        self.assertIsNone(cited_blobs_code_hash(Path("/tmp"), ["a.py"], ""))


class PerDecisionCostJoinTest(unittest.TestCase):
    """Cost is joinable per decision: judgment_group_id is the one join."""

    def _ci_executor(self):
        import importlib
        import sys

        repo = Path(__file__).resolve().parents[2]
        tools_dir = repo / "tools" / "aria-poc"
        if str(tools_dir) not in sys.path:
            sys.path.insert(0, str(tools_dir))
        return importlib.import_module("ci_executor")

    def test_a_judge_envelope_attributes_to_its_decision(self) -> None:
        # _cost_identity is the ONE derivation every runtime path uses; a
        # judge request has no convergence and no plan, so it fell back to
        # plan-<request tail> - 186 judge-lane rows / $114.86 lived in
        # cost-attribution joinable to no decision. The minted
        # judgment_group_id is the decision identity.
        executor = self._ci_executor()
        cycle_id, plan_id = executor._cost_identity(
            {"cycle_id": "cyc-1", "judgment_group_id": "judge:adapter-a:fp-1"},
            "req-abcdef123456",
        )
        self.assertEqual(cycle_id, "cyc-1")
        self.assertEqual(plan_id, "judge:adapter-a:fp-1")
        # A converged plan keeps its plan identity; the group never
        # displaces a real convergence.
        _cycle, plan = executor._cost_identity(
            {"cycle_id": "cyc-1", "convergence_id": "conv-9",
             "judgment_group_id": "judge:adapter-a:fp-1"}, "req-x",
        )
        self.assertEqual(plan, "conv-9")

    def test_the_consensus_row_carries_the_decisions_cost_and_agents(self) -> None:
        # The read side of the join: an ai_consensus row names what the
        # decision cost and which agents ran it, read from the ONE ledger
        # (cost-attribution) filtered by the group - no second cost store.
        with TemporaryDirectory() as tmp:
            from aria_kernel.budget import record_cost_attribution
            from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback

            base = Path(tmp) / "aria-tools"
            group = "judge:adapter-a:fp-cost"
            for judge_id, role in (("judge-e", "evidence_judgment"),
                                   ("judge-a", "adversarial_judgment")):
                record_operator_feedback(
                    tool_id="adapter-a", run_id="run-1", finding_id="F-1",
                    verdict="true_positive", severity="medium", note="n",
                    source_type="ai_judge", judge_id=judge_id, model="m-1",
                    confidence=0.9, judgment_group_id=group,
                    finding_fingerprint="fp-cost", base_dir=base,
                )
                record_cost_attribution(
                    cycle_id="cyc-1", plan_id=group, agent_role=role, model="m-1",
                    input_tokens=1000, output_tokens=500, estimated_usd=0.25,
                    base_dir=base,
                )
            result = generate_ai_consensus(
                tool_id="adapter-a", cycle_id=None, base_dir=base,
            )
            self.assertEqual(result["consensus_count"], 1)
            row = result["consensus"][0]
            self.assertEqual(row["cost_usd"], 0.5)
            self.assertEqual(row["agents"], ["adversarial_judgment", "evidence_judgment"])


class FunnelPolicyKeysTest(unittest.TestCase):
    def test_the_funnel_keys_are_real_configuration(self) -> None:
        # A key absent from the defaults is dead JSON: judgment_pipeline_policy
        # merges only keys JUDGMENT_PIPELINE_DEFAULTS already names, and the
        # block joins the contract only through POLICY_KEYS.
        from aria_kernel.genesis_policy import JUDGMENT_PIPELINE_DEFAULTS, POLICY_KEYS

        self.assertIn("judgment_pipeline", POLICY_KEYS)
        for key in ("funnel_enabled", "funnel_nightly_envelope", "funnel_tier4_quota",
                    "funnel_tier1_budget_seconds", "funnel_calibration_sample_per_cycle"):
            self.assertIn(key, JUDGMENT_PIPELINE_DEFAULTS, key)

    def test_the_default_is_off(self) -> None:
        # Bit-for-bit legacy is the SHIPPED default; activation is the
        # operator's override (ARIA is paused — live activation is theirs).
        from aria_kernel.genesis_policy import JUDGMENT_PIPELINE_DEFAULTS

        self.assertIs(JUDGMENT_PIPELINE_DEFAULTS["funnel_enabled"], False)


if __name__ == "__main__":
    unittest.main()
