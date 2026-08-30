"""A fixture read back off disk could never be re-added.

`aria-agent-eval` has never completed a scheduled run. Every attempt dies on
the FIRST fixture with:

    F001 ... already exists with different content hash; refusing accidental
    fixture mutation

Nothing had mutated. `add_fixture` computed the content hash over every key
except `recorded_at`, then wrote the result back into the fixture as
`fixture_hash`. The digest therefore covered its own output the next time the
same file was handed back in — and handing the persisted file back is exactly
what re-adding a fixture means.

Measured on the shipped fixture: stored `4d2a364a...`, recomputed from the
file as-is `b61db959...`, recomputed with `fixture_hash` removed `4d2a364a...`
again. The idempotent branch was unreachable for every fixture that had ever
been written, which is every fixture.

These tests pin the round trip rather than the exclusion list, so an
implementation that computes the digest some other correct way still passes.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import agent_eval
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _fixture(fixture_id: str = "F_ROUNDTRIP") -> dict[str, object]:
    return {
        "fixture_id": fixture_id,
        "target_agent": "aria-evidence-judge",
        "role": "evidence_judgment",
        "pinned_commit_sha": "deadbeefcafe1234",
        "input_envelope": {"claim_summary": "does the round trip close"},
        "expected_verdict_class": "ACCEPTED",
        "expected_evidence_refs": ["docs/x.md:1"],
        "max_rounds": 3,
        "max_tokens": 8000,
    }


class FixtureRoundTripTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-eval-roundtrip-"))
        self.base = tmp / "aria-tools"
        ensure_tools_dir(self.base)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)

    def _persisted(self, fixture_id: str) -> dict[str, object]:
        path = next(self.base.rglob(f"{fixture_id}.json"))
        return json.loads(path.read_text(encoding="utf-8"))

    def test_re_adding_the_persisted_file_is_idempotent(self) -> None:
        # The live failure, reproduced: add once, read the file back exactly as
        # written, add again. Before the fix this raised GovernanceError.
        agent_eval.add_fixture(fixture=_fixture(), base_dir=self.base)

        stored = self._persisted("F_ROUNDTRIP")
        self.assertIn("fixture_hash", stored, "the file must carry the digest")

        agent_eval.add_fixture(fixture=stored, base_dir=self.base)

    def test_the_digest_does_not_cover_itself(self) -> None:
        # Stated as a property of the two forms rather than of the exclusion
        # list: whatever the implementation hashes, a fixture carrying the
        # digest and the same fixture without it must agree.
        agent_eval.add_fixture(fixture=_fixture("F_SELF"), base_dir=self.base)
        stored = self._persisted("F_SELF")

        without = {k: v for k, v in stored.items() if k != "fixture_hash"}
        agent_eval.add_fixture(fixture=without, base_dir=self.base)

    def test_a_real_content_change_is_still_refused(self) -> None:
        # The guard this fix must not weaken. Loosening the digest until every
        # re-add passes would close the ticket and delete the protection.
        agent_eval.add_fixture(fixture=_fixture("F_GUARD"), base_dir=self.base)
        stored = self._persisted("F_GUARD")

        mutated = dict(stored)
        mutated["prompt"] = "quietly changed after the fact"

        with self.assertRaises(GovernanceError):
            agent_eval.add_fixture(fixture=mutated, base_dir=self.base)

    def test_a_new_timestamp_alone_is_not_a_content_change(self) -> None:
        # `recorded_at` was already excluded; pinning it stops a future
        # simplification of the exclusion set from reintroducing the older
        # form of the same bug.
        agent_eval.add_fixture(fixture=_fixture("F_TIME"), base_dir=self.base)
        stored = self._persisted("F_TIME")

        stamped = dict(stored)
        stamped["recorded_at"] = "2030-01-01T00:00:00Z"

        agent_eval.add_fixture(fixture=stamped, base_dir=self.base)


class LedgerRowIsReconstructedTest(unittest.TestCase):
    """The second blocker, behind the first.

    The five fixtures are committed as JSON files with no `fixtures.jsonl`
    beside them. With only the hash fixed, the re-add would succeed and `run`
    would still fail with "fixture F001 ledger row not found", because the
    idempotent path returned the file whenever the derived row was absent.
    """

    def setUp(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-eval-ledger-"))
        self.base = tmp / "aria-tools"
        ensure_tools_dir(self.base)
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)

    def test_a_committed_fixture_file_with_no_ledger_row_gets_one(self) -> None:
        agent_eval.add_fixture(fixture=_fixture("F_LEDGER"), base_dir=self.base)

        # Reproduce what git carries: the file, and no ledger.
        ledger = next(self.base.rglob("fixtures.jsonl"))
        ledger.unlink()
        self.assertEqual(agent_eval.list_fixtures(base_dir=self.base), [])

        stored = json.loads(
            next(self.base.rglob("F_LEDGER.json")).read_text(encoding="utf-8")
        )
        row = agent_eval.add_fixture(fixture=stored, base_dir=self.base)

        self.assertEqual(row.get("fixture_id"), "F_LEDGER")
        self.assertEqual(
            [r.get("fixture_id") for r in agent_eval.list_fixtures(base_dir=self.base)],
            ["F_LEDGER"],
        )

    def test_reconstruction_does_not_duplicate_an_existing_row(self) -> None:
        agent_eval.add_fixture(fixture=_fixture("F_ONCE"), base_dir=self.base)
        stored = json.loads(
            next(self.base.rglob("F_ONCE.json")).read_text(encoding="utf-8")
        )

        agent_eval.add_fixture(fixture=stored, base_dir=self.base)
        agent_eval.add_fixture(fixture=stored, base_dir=self.base)

        rows = [
            r for r in agent_eval.list_fixtures(base_dir=self.base)
            if r.get("fixture_id") == "F_ONCE"
        ]
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
