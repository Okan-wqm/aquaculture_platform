"""CE-1 — a class verdict, and the four things it is allowed to change.

Before CE-1 judgement was spent per instance and never anywhere else: a
fingerprint carries the path and the line, so five anchor verdicts saying
"this matcher is wrong" bought silence for five lines and the sixth
occurrence still cost three judges and still reached the operator.
`rule_health` measured rules but could only quarantine the MATCHER — it
never suppressed a produced finding and never promoted one.

Deliberate-breakage pins, each one a thing that was previously impossible:

* five DISTINCT instances judged the same way by ANCHOR consensus (JJ-1)
  yield a class verdict — and FOUR do not, which is the line the class
  layer is allowed to act on;
* a new instance of a `confirmed_fp` class IS written to raw (the
  observation ledger must keep the evidence that could contradict the
  class) and reaches neither judged-sampling nor the operator;
* instance suppression is untouched — the instance record still wins and
  still says so;
* `confirmed_tp` promotes the class's REMAINING instances through the
  existing promotion writer, marked `via_class`, and those promotions meet
  the same evidence gate as any other finding;
* a `mixed` class (five each way) keeps consuming judge budget, because a
  class the judges disagree about is the one worth the next judgement.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    _sampleable_raw_findings,
    append_jsonl,
    list_findings,
    load_jsonl,
    raw_findings_path,
    record_findings_for_run,
    record_operator_feedback,
    record_raw_findings_for_run,
    suppression_for,
    suppression_layers,
)
from aria_kernel.finding_classes import (
    MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT,
    class_promotion_candidates,
    class_states,
    finding_classes_path,
    record_finding_classes,
    recorded_class_states,
    settled_class_keys,
)
from aria_kernel.finding_promotion import promote_consensus_findings

_TOOL = "security-boundary-adapter"
_RULE = "public_write_endpoint_without_allowlist"


class FindingClassTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        self.repo = Path(self._tmp.name) / "repo"
        (self.repo / "apps").mkdir(parents=True)
        (self.repo / "apps" / "target.ts").write_text("export const x = 1;\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(
            [
                "git", "-C", str(self.repo),
                "-c", "user.email=t@t", "-c", "user.name=t",
                "commit", "-qm", "seed",
            ],
            check=True,
        )

    # ------------------------------------------------------------------ helpers
    def _raw(self, fingerprint: str, *, rule: str = _RULE, path: str = "apps/target.ts") -> None:
        append_jsonl(
            raw_findings_path(self.tools),
            {
                "schema_version": 1,
                "tool_id": _TOOL,
                "run_id": f"run-{fingerprint}",
                "cycle_id": "cyc-1",
                "finding_id": f"f-{fingerprint}",
                "finding_fingerprint": fingerprint,
                "status": "raw",
                "finding": {
                    "id": f"f-{fingerprint}",
                    "rule": rule,
                    "path": path,
                    "message": f"m-{fingerprint}",
                    "severity": "medium",
                },
            },
        )

    def _anchor_verdict(self, fingerprint: str, verdict: str, *, source: str = "ai_consensus") -> None:
        record_operator_feedback(
            tool_id=_TOOL,
            run_id=f"judged-{fingerprint}",
            finding_id=f"jf-{fingerprint}",
            verdict=verdict,
            severity="medium",
            note="anchor ground truth",
            source_type=source,
            judge_id="aria-consensus-arbiter",
            judgment_group_id=f"judge:{_TOOL}:{fingerprint}",
            finding_fingerprint=fingerprint,
            judge_count=ANCHOR_MIN_JUDGE_COUNT if source == "ai_consensus" else None,
            judges_voted=ANCHOR_MIN_JUDGE_COUNT if source == "ai_consensus" else None,
            base_dir=self.tools,
        )

    def _judged_instances(self, count: int, verdict: str, *, prefix: str = "fp", rule: str = _RULE) -> None:
        """`count` DISTINCT instances of one rule, each settled by an anchor."""
        for index in range(count):
            fingerprint = f"{prefix}-{verdict}-{index}"
            self._raw(fingerprint, rule=rule, path=f"apps/{prefix}-{index}.ts")
            self._anchor_verdict(fingerprint, verdict)

    def _run_producing(self, finding: dict[str, object], *, run_id: str = "run-new") -> dict[str, object]:
        run = {
            "tool_id": _TOOL,
            "run_id": run_id,
            "cycle_id": "cyc-2",
            "status": "ok",
            "runner": {"raw_findings_sample": [finding]},
            "emitted_findings": [finding],
        }
        record_raw_findings_for_run(run, base_dir=self.tools)
        record_findings_for_run(run, base_dir=self.tools)
        return run

    def _new_instance(self) -> dict[str, object]:
        return {
            "id": "f-new",
            "rule": _RULE,
            "path": "apps/brand-new.ts",
            "message": "a brand new instance of the same rule",
            "severity": "medium",
            "evidence": [{"path": "apps/target.ts"}],
        }

    def _raw_rows(self) -> list[dict[str, object]]:
        return load_jsonl(raw_findings_path(self.tools))

    # ------------------------------------------------------------- the verdict
    def test_the_threshold_is_five_distinct_instances(self) -> None:
        """The NUMBER is the contract, not whatever the constant says today.

        Held as a literal on purpose: a pin written in terms of the constant
        it guards passes for any value, which is how a threshold quietly
        drops to four. Five deliberately equals the anchor-promotion floor
        (`feedback_store.ANCHOR_PROMOTION_MIN_JUDGMENTS`) — a class verdict
        is at least as consequential as making one tool promotable.
        """
        from aria_kernel.feedback_store import ANCHOR_PROMOTION_MIN_JUDGMENTS

        self.assertEqual(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, 5)
        self.assertEqual(
            MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, ANCHOR_PROMOTION_MIN_JUDGMENTS,
        )
        self._judged_instances(4, "false_positive")
        self.assertNotEqual(
            class_states(self.tools)[(_TOOL, _RULE)]["lifecycle"], "confirmed_fp",
        )
        self._raw("fp-fifth", path="apps/fifth.ts")
        self._anchor_verdict("fp-fifth", "false_positive")
        self.assertEqual(
            class_states(self.tools)[(_TOOL, _RULE)]["lifecycle"], "confirmed_fp",
        )

    def test_five_distinct_anchor_instances_confirm_a_class(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "false_positive")
        state = class_states(self.tools)[(_TOOL, _RULE)]
        self.assertEqual(state["lifecycle"], "confirmed_fp")
        self.assertEqual(
            state["distinct_false_positive_instances"],
            MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT,
        )
        # The statistics are rule_health's, read not recomputed.
        from aria_kernel.rule_health import rule_stats

        self.assertEqual(state["judged"], rule_stats(self.tools)[(_TOOL, _RULE)]["judged"])

    def test_four_instances_do_not_produce_a_class_verdict(self) -> None:
        """THE line. Four anchors on four distinct lines is a quarantined
        matcher (rule_health's verdict) and NOT a class verdict, so a new
        instance is still recorded live and still reaches the operator."""
        self._judged_instances(4, "false_positive")
        state = class_states(self.tools)[(_TOOL, _RULE)]
        self.assertNotIn(state["lifecycle"], ("confirmed_fp", "confirmed_tp"))
        self.assertEqual(state["lifecycle"], "quarantined")
        self.assertEqual(settled_class_keys(self.tools), set())

        self._run_producing(self._new_instance())
        fresh = [row for row in self._raw_rows() if row.get("run_id") == "run-new"]
        self.assertEqual([row["status"] for row in fresh], ["raw"])
        self.assertEqual(
            [row["status"] for row in list_findings(tool_id=_TOOL, base_dir=self.tools)],
            ["open"],
        )

    def test_one_instance_judged_five_times_is_not_a_class_verdict(self) -> None:
        """Depth is not breadth: the same fingerprint re-judged five times."""
        self._raw("fp-solo")
        for _ in range(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT):
            self._anchor_verdict("fp-solo", "false_positive")
        state = class_states(self.tools)[(_TOOL, _RULE)]
        self.assertEqual(state["judged"], MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT)
        self.assertEqual(state["distinct_false_positive_instances"], 1)
        self.assertNotIn(state["lifecycle"], ("confirmed_fp", "confirmed_tp"))

    def test_two_judge_consensus_cannot_confirm_a_class(self) -> None:
        """The class layer inherits JJ-1: only ANCHOR-grade rows count."""
        for index in range(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT):
            fingerprint = f"pair-{index}"
            self._raw(fingerprint, path=f"apps/pair-{index}.ts")
            record_operator_feedback(
                tool_id=_TOOL,
                run_id=f"judged-{fingerprint}",
                finding_id=f"jf-{fingerprint}",
                verdict="false_positive",
                severity="medium",
                note="two judges agreed, nobody examined the agreement",
                source_type="ai_consensus",
                judge_id="aria-consensus-arbiter",
                judgment_group_id=f"judge:{_TOOL}:{fingerprint}",
                finding_fingerprint=fingerprint,
                judge_count=2,
                judges_voted=2,
                base_dir=self.tools,
            )
        self.assertEqual(class_states(self.tools), {})

    # --------------------------------------------------------- confirmed_fp
    def test_new_instance_of_confirmed_fp_class_is_raw_but_reaches_nobody(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "false_positive")
        self._run_producing(self._new_instance())

        fresh = [row for row in self._raw_rows() if row.get("run_id") == "run-new"]
        self.assertEqual(len(fresh), 1, "a new instance must still be WRITTEN to raw")
        self.assertEqual(fresh[0]["status"], "suppressed_false_positive")
        self.assertEqual(fresh[0]["suppressed_by_feedback"]["suppression_scope"], "class")
        self.assertEqual(fresh[0]["suppressed_by_feedback"]["rule"], _RULE)

        # …and neither the judges nor the operator ever see it.
        self.assertEqual(
            _sampleable_raw_findings(tool_id=_TOOL, cycle_id=None, base_dir=self.tools), [],
        )
        operator_rows = list_findings(tool_id=_TOOL, base_dir=self.tools)
        self.assertEqual([row["status"] for row in operator_rows], ["suppressed_false_positive"])
        self.assertEqual(list_findings(tool_id=_TOOL, status="open", base_dir=self.tools), [])

    def test_instance_suppression_is_unchanged_and_still_wins(self) -> None:
        """The class layer is ADDED beside the instance layer, not over it."""
        self._raw("fp-instance", rule="some_other_rule", path="apps/other.ts")
        self._anchor_verdict("fp-instance", "false_positive")
        layers = suppression_layers(self.tools)
        record = suppression_for(
            tool_id=_TOOL, rule="some_other_rule", fingerprint="fp-instance", layers=layers,
        )
        self.assertIsNotNone(record)
        self.assertEqual(record["suppression_scope"], "instance")
        self.assertEqual(record["source_type"], "ai_consensus")
        # One judged instance is nowhere near a class verdict.
        self.assertEqual(settled_class_keys(self.tools), set())
        self.assertIsNone(
            suppression_for(
                tool_id=_TOOL, rule="some_other_rule", fingerprint="fp-sibling", layers=layers,
            ),
        )

    def test_mixed_class_keeps_spending_judge_budget(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "false_positive")
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "true_positive")
        state = class_states(self.tools)[(_TOOL, _RULE)]
        self.assertEqual(state["lifecycle"], "mixed")
        self.assertEqual(settled_class_keys(self.tools), set())
        self._run_producing(self._new_instance())
        fresh = [row for row in self._raw_rows() if row.get("run_id") == "run-new"]
        self.assertEqual([row["status"] for row in fresh], ["raw"])
        self.assertIn(
            "f-new",
            [
                item["finding_id"]
                for item in _sampleable_raw_findings(
                    tool_id=_TOOL, cycle_id=None, base_dir=self.tools,
                )
            ],
        )

    # --------------------------------------------------------- confirmed_tp
    def test_confirmed_tp_promotes_remaining_instances_via_class(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "true_positive")
        self._raw("fp-remaining", path="apps/target.ts")
        self.assertEqual(class_states(self.tools)[(_TOOL, _RULE)]["lifecycle"], "confirmed_tp")
        self.assertEqual(
            [row["finding_fingerprint"] for row in class_promotion_candidates(self.tools)],
            ["fp-remaining"],
            "only the instance no judge examined is a class-promotion candidate",
        )

        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["via_class_count"], 1)
        promoted = [row for row in result["promoted"] if row["finding_fingerprint"] == "fp-remaining"]
        self.assertEqual(promoted[0]["via_class"], f"{_TOOL}:{_RULE}")

        from aria_kernel.feedback_store import promotions_path

        ledger = {
            row["finding_fingerprint"]: row
            for row in load_jsonl(promotions_path(self.tools))
        }
        self.assertEqual(ledger["fp-remaining"]["via_class"], f"{_TOOL}:{_RULE}")

        # Idempotent, exactly like the instance lane.
        again = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(again["promoted_count"], 0)

    def test_via_class_promotion_meets_the_same_evidence_gate(self) -> None:
        """A via_class candidate is a finding at the gates like any other."""
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "true_positive")
        self._raw("fp-ghost", path="apps/does-not-exist.ts")
        result = promote_consensus_findings(repo_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["promoted_count"], 0)
        ghost = [row for row in result["skipped"] if row["finding_fingerprint"] == "fp-ghost"]
        self.assertEqual(
            ghost,
            [{
                "finding_fingerprint": "fp-ghost",
                "reason": "no_repo_verified_evidence",
                "via_class": f"{_TOOL}:{_RULE}",
            }],
        )

    def test_confirmed_class_stops_being_sampled(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "true_positive")
        self._raw("fp-remaining", path="apps/target.ts")
        self.assertEqual(settled_class_keys(self.tools), {(_TOOL, _RULE)})
        self.assertEqual(
            _sampleable_raw_findings(tool_id=_TOOL, cycle_id=None, base_dir=self.tools), [],
        )
        # Judge budget still flows to a class nobody has settled.
        self._raw("fp-open", rule="unjudged_rule", path="apps/open.ts")
        self.assertEqual(
            [
                item["rule"]
                for item in _sampleable_raw_findings(
                    tool_id=_TOOL, cycle_id=None, base_dir=self.tools,
                )
            ],
            ["unjudged_rule"],
        )

    # ------------------------------------------------------------- the ledger
    def test_ledger_records_transitions_only(self) -> None:
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT - 1, "false_positive")
        first = record_finding_classes(self.tools)
        self.assertEqual(first["recorded_count"], 1)
        self.assertEqual(first["recorded"][0]["lifecycle"], "quarantined")
        self.assertIsNone(first["recorded"][0]["previous_lifecycle"])

        # Nothing changed → nothing appended.
        self.assertEqual(record_finding_classes(self.tools)["recorded_count"], 0)

        # The fifth distinct instance IS a transition.
        self._raw("fp-fifth", path="apps/fifth.ts")
        self._anchor_verdict("fp-fifth", "false_positive")
        second = record_finding_classes(self.tools)
        self.assertEqual(second["recorded_count"], 1)
        self.assertEqual(second["recorded"][0]["lifecycle"], "confirmed_fp")
        self.assertEqual(second["recorded"][0]["previous_lifecycle"], "quarantined")

        rows = load_jsonl(finding_classes_path(self.tools))
        self.assertEqual(len(rows), 2, "append-only: the first row is never rewritten")
        self.assertEqual(
            recorded_class_states(self.tools)[(_TOOL, _RULE)]["lifecycle"], "confirmed_fp",
        )

    def test_ledger_is_history_and_the_derivation_is_authority(self) -> None:
        """An unwritten ledger must never cost a verdict — and a stale one
        must never grant it. Suppression works with nothing recorded."""
        self._judged_instances(MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT, "false_positive")
        self.assertFalse(finding_classes_path(self.tools).exists())
        self.assertEqual(settled_class_keys(self.tools), {(_TOOL, _RULE)})
        self._run_producing(self._new_instance())
        fresh = [row for row in self._raw_rows() if row.get("run_id") == "run-new"]
        self.assertEqual([row["status"] for row in fresh], ["suppressed_false_positive"])


class FindingClassSurfaceTests(unittest.TestCase):
    def test_the_class_ledger_is_a_declared_surface(self) -> None:
        """ORPHAN-670 — an unrostered ledger dies at job teardown."""
        from aria_kernel.state_manifest import surface_for_relative_path

        surface = surface_for_relative_path("finding-classes.jsonl")
        self.assertIsNotNone(surface)
        self.assertEqual(surface.name, "finding_classes")


class SingleSuppressionWriterTests(unittest.TestCase):
    """A SECOND suppression writer is banned, and this is the ban.

    Suppression is the most irreversible thing a verdict causes — the
    finding class stops being produced, so no later evidence can contradict
    it — and the pre-JJ-1 ledger proved what happens when the eligibility
    decision has more than one home: five readers each re-decided it, and
    tightening the rule reached four of them. CE-1 adds a LAYER to the one
    decision point rather than a second decider, and this static sweep is
    what keeps it that way: the suppression record may only be minted in
    feedback_store, through `suppression_for`.
    """

    def test_only_feedback_store_mints_a_suppression_record(self) -> None:
        import aria_kernel

        kernel_dir = Path(aria_kernel.__file__).resolve().parent
        offenders: list[str] = []
        for module in sorted(kernel_dir.glob("*.py")):
            if module.name == "feedback_store.py":
                continue
            source = module.read_text(encoding="utf-8")
            if '"suppressed_by_feedback"' in source or "_confirmed_false_positive_fingerprints" in source:
                offenders.append(module.name)
        self.assertEqual(
            offenders,
            [],
            "a second suppression writer: the confirmed-false-positive "
            "decision lives once, in feedback_store.suppression_for — add a "
            "LAYER there instead of a second decider: " + ", ".join(offenders),
        )

    def test_the_class_layer_is_reachable_only_through_that_decision_point(self) -> None:
        from aria_kernel import feedback_store

        source = Path(feedback_store.__file__).resolve().read_text(encoding="utf-8")
        self.assertEqual(
            source.count("confirmed_false_positive_classes("),
            1,
            "the class layer enters suppression at exactly one callsite "
            "(suppression_layers); a second read is a second decider",
        )


if __name__ == "__main__":
    unittest.main()
