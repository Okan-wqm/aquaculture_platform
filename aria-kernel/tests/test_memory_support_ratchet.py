"""Repetition must not read as certainty.

PLAN gap 6. `_record_belief` raised a belief's confidence every time it
ran, whether or not anything new had been observed. ARIA re-records the
same discovery beliefs on EVERY cycle from the same files, so a belief
backed by one unchanged file climbed toward certainty simply by being
looked at again — the system mistaking its own repetition for
corroboration.

Two mechanisms, and fixing only one leaves the defect:

  * `support_count` incremented unconditionally, and
  * the confidence term is added to `previous_confidence`, not to the
    ORIGINAL confidence — so each call compounds on the already-raised
    value. Freezing the counter alone still ratchets, just more slowly.

PLAN §43 scenario 3: the same evidence read a hundred times raises
confidence once.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.memory import _record_belief
from aria_kernel.tool_registry import ensure_tools_binding


def _hash(text: str) -> str:
    import hashlib

    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


class SupportRatchetTests(unittest.TestCase):
    """One belief, one file, many cycles."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name) / "repo"
        (self.workspace / "docs").mkdir(parents=True)
        self.evidence = self.workspace / "docs" / "fact.md"
        self.evidence.write_text("the observed fact\n", encoding="utf-8")

        # A properly bound tools root: beliefs.jsonl is a DECLARED
        # surface, and the ledger layer refuses to read an undeclared one.
        self.root = ensure_tools_binding(
            Path(self._tmp.name) / "aria-tools", workspace_root=self.workspace
        )

    def _seed_discovery(self, cycle_id: str, content: str | None = None) -> None:
        """FATES is where `_evidence_hashes` reads content hashes from."""
        body = content if content is not None else self.evidence.read_text(encoding="utf-8")
        self.evidence.write_text(body, encoding="utf-8")
        d = self.root / "discovery" / cycle_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "FATES.json").write_text(
            json.dumps({"files": [{"path": "docs/fact.md", "content_hash": _hash(body)}]}),
            encoding="utf-8",
        )

    def _observe(self, cycle_id: str, content: str | None = None) -> dict:
        self._seed_discovery(cycle_id, content)
        return _record_belief(
            self.root,
            cycle_id=cycle_id,
            belief_id="a-stable-fact",
            claim="the fact holds",
            evidence_refs=["docs/fact.md"],
            confidence=0.60,
            workspace_root=self.workspace,
        )

    def test_re_reading_unchanged_evidence_does_not_raise_confidence(self) -> None:
        first = self._observe("cycle-1")
        baseline = first["confidence"]

        for n in range(2, 12):
            row = self._observe(f"cycle-{n}")

        self.assertEqual(
            row["confidence"],
            baseline,
            "confidence climbed on re-observation of unchanged evidence — "
            "the system read its own repetition as corroboration",
        )
        self.assertEqual(
            row["support_count"],
            first["support_count"],
            "support_count counted observations rather than distinct evidence",
        )

    def test_genuinely_new_evidence_still_raises_support(self) -> None:
        """The fix must not freeze learning, only repetition."""
        first = self._observe("cycle-1")
        changed = self._observe("cycle-2", content="the fact, restated differently\n")

        self.assertGreater(
            changed["support_count"],
            first["support_count"],
            "changed evidence must still count as new support",
        )
        self.assertGreater(changed["confidence"], first["confidence"])

    def test_the_row_records_when_it_was_first_and_last_observed(self) -> None:
        """Occurrence is worth keeping — it just is not evidence.

        Dropping the count entirely would lose a real signal (how often
        ARIA has looked at this). Recording it in fields that do NOT feed
        confidence keeps the observation without letting it vote.
        """
        first = self._observe("cycle-1")
        self.assertEqual(first["first_seen_cycle"], "cycle-1")
        self.assertEqual(first["last_seen_cycle"], "cycle-1")
        self.assertEqual(first["observation_count"], 1)

        for n in range(2, 6):
            row = self._observe(f"cycle-{n}")

        self.assertEqual(row["first_seen_cycle"], "cycle-1")
        self.assertEqual(row["last_seen_cycle"], "cycle-5")
        self.assertEqual(row["observation_count"], 5)
        self.assertEqual(row["support_count"], first["support_count"])


if __name__ == "__main__":
    unittest.main()
