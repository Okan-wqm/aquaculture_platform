"""ARIA-MEDIUM-378 (review M4) — findings of two rules about one adapter-declared subject are one subject.

cqrs-adapter reports a controller that injects a repository and calls it past
the bus as two findings, one per rule. Promoted as two records they would be
two plan candidates for one fix. The adapter declares a subject on both; the
promotion carries it as a ``subject=`` fact; ``finding_subject_key`` derives
one key from it, so ARIA-HIGH-363's subject dedupe — the one mechanism the
slot policy and the merge closure already use — collapses them.
"""
from __future__ import annotations

import unittest

from aria_kernel.finding_promotion import _subject_facts
from aria_kernel.finding_subject import (
    ADAPTER_SUBJECT_FACT_PREFIX,
    CONSENSUS_ORIGIN,
    finding_subject_key,
    findings_with_subject,
)

_SUBJECT = "cqrs-adapter:controller_layer_skip:apps/x/src/controllers/a.controller.ts"


def _record(rule: str, subject: str | None, origin: str = CONSENSUS_ORIGIN) -> dict:
    facts = [f"rule={rule}", "finding_fingerprint=finding:x"]
    if subject is not None:
        facts.append(f"{ADAPTER_SUBJECT_FACT_PREFIX}{subject}")
    return {"originating_skill": origin, "facts": facts, "evidences": [{"ref": "apps/x/src/a.ts:3"}]}


class AdapterSubjectKeyTests(unittest.TestCase):
    def test_two_rules_on_one_subject_share_a_key(self) -> None:
        injects = _record("controller_injects_repository_directly", _SUBJECT)
        skips = _record("controller_skips_command_query_bus", _SUBJECT)
        self.assertIsNotNone(finding_subject_key(injects))
        self.assertEqual(finding_subject_key(injects), finding_subject_key(skips))
        key = finding_subject_key(injects)
        assert key is not None
        self.assertEqual(findings_with_subject({"F-1": injects, "F-2": skips}, key), ["F-1", "F-2"])

    def test_different_subjects_and_unsubjected_records_stay_apart(self) -> None:
        other = _record("controller_injects_repository_directly", _SUBJECT.replace("a.controller", "b.controller"))
        self.assertNotEqual(finding_subject_key(_record("r", _SUBJECT)), finding_subject_key(other))
        self.assertIsNone(finding_subject_key(_record("r", None)))
        self.assertIsNone(finding_subject_key(_record("r", _SUBJECT, origin="manual:operator")))

    def test_promotion_carries_the_adapter_subject_as_a_fact(self) -> None:
        self.assertEqual(_subject_facts({"subject": _SUBJECT}), [f"{ADAPTER_SUBJECT_FACT_PREFIX}{_SUBJECT}"])
        self.assertEqual(_subject_facts({"rule": "r"}), [])


if __name__ == "__main__":
    unittest.main()
