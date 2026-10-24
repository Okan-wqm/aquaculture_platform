"""PV-R4 corrective round 1 — the roots the appellate accepted against the
R16-R18 round (/root/aria-handover/2026-10-21/build/PV-R4/appellate-r1.md),
one class per property:

* R19 the glob owner reads how many alternatives a brace pattern expands to
  before it builds one, and refuses a pattern over its named bound
  (``repo_glob_too_many_alternatives``): a 24-group reviewer ref once cost
  minutes and hundreds of MB on every record and every freshness read.

Source: SPEC.md (PV P1, P3); findings ARIA-HIGH-779 and ARIA-LOW-785.
"""
from __future__ import annotations

import re
import sys
import time
import unittest
from unittest import mock

from aria_kernel import canonical_path, converged_delivery, plan_convergence
from aria_kernel.canonical_path import (
    MAX_REPO_GLOB_ALTERNATIVES,
    expand_repo_glob,
    matches_repo_glob,
    require_repo_glob,
)
from aria_kernel.convergence_outcome import parked_plan_request_id
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    fold_plan_state,
    plan_verdict_paths,
    plan_verdict_staleness,
    record_cross_review,
    start_plan,
)
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.self_improvement import kernel_authority_set
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace_view import WorkspaceViewRefused, commit_names_blob
from tests._helpers.production_shaped import production_converged_plan
from tests.test_converged_delivery_scope_precheck import FARM, FORCER, _ScopeCase
from tests.test_plan_verdict_integrity import (
    PLAN_EVIDENCE,
    RISK_EVIDENCE_FILE,
    SURFACE,
    _git,
    _PlanFixture,
    _risk,
    _terminal,
)
from tests.test_plan_verdict_roots_r2 import _event_count

PATH_REFUSED = "plan_verdict_path_refused"
UNVERIFIABLE = "plan_verdict_unverifiable"
STALE = "plan_verdict_stale"
TOO_MANY = "repo_glob_too_many_alternatives"
NOT_IN_TREE = "evidence_ref_not_in_reviewed_tree"
# Pinned by value: the reason lands on the plan ledger and the kind on governance.
KIND = "converged_delivery_plan_verdict_stale"
WITHHELD = "plan_verdict_stale"
BRACES_24 = "{a,b}" * 24


class R19TheGlobOwnerBoundsTheAlternativesBeforeBuildingAny(_PlanFixture):
    """SEC-R4-B1: 12/16/18/20 groups cost 3.6/12/41/174 s and 3/47/194/792 MB."""

    def test_a_24_group_glob_is_refused_before_any_alternative_is_built(self) -> None:
        pattern = f"a/{BRACES_24}.ts"
        with mock.patch.object(canonical_path, "_expand_braces", side_effect=AssertionError("built")) as built:
            started = time.monotonic()
            with self.assertRaisesRegex(GovernanceError, TOO_MANY):
                require_repo_glob(pattern)
            with self.assertRaisesRegex(GovernanceError, TOO_MANY):
                matches_repo_glob("a/a.ts", pattern)
            self.assertLess(time.monotonic() - started, 1.0)
        built.assert_not_called()

    def test_a_risk_ref_of_24_groups_is_refused_at_record(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        before = _event_count(self)
        ref = f"apps/farm-service/src/feed/{BRACES_24}.ts:1"
        started = time.monotonic()
        with self.assertRaisesRegex(GovernanceError, f"plan_path_refused.*{TOO_MANY}"):
            self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[ref])], verdict="agreed")
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(_event_count(self), before)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def test_the_count_is_the_expanders_own(self) -> None:
        for pattern in ("a.ts", "a.{b,c}.{d,e,f}", "x/{a,{b,c}}/y", "{a,b", "a{}b", "{a,b}}{c,d}", "{,x}/{y}"):
            with self.subTest(pattern=pattern):
                self.assertEqual(canonical_path._brace_alternative_count(pattern),
                                 len(canonical_path._expand_braces(pattern)))

    def test_the_authority_sets_stdlib_glob_expands_and_matches_as_before(self) -> None:
        names = sorted(sys.stdlib_module_names)
        glob = "aria-tools/{" + ",".join(names) + "}.py"
        self.assertLessEqual(len(names), MAX_REPO_GLOB_ALTERNATIVES)
        self.assertEqual(expand_repo_glob(glob), tuple(f"aria-tools/{name}.py" for name in names))
        self.assertEqual(expand_repo_glob(glob), tuple(canonical_path._expand_braces(glob)))
        self.assertTrue(matches_repo_glob("aria-tools/os.py", glob))
        self.assertFalse(matches_repo_glob("aria-tools/not_a_stdlib_name.py", glob))
        # Every member the running kernel derives is admitted by the bound.
        for member in kernel_authority_set():
            require_repo_glob(member)


if __name__ == "__main__":
    unittest.main()
