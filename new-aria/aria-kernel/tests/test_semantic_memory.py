"""Z7 — semantic memory substrate: no-op discipline + deterministic search.

Model supply is an operator item (ORPHAN-MEDIUM-639); the kernel must be
fully correct in BOTH worlds: without a model every entry point is a
structured no-op (None / []), with one the ledger rows chain and nearest()
ranks deterministically within a single model_id space.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import semantic_memory as sm
from aria_kernel.ledger import load_jsonl


def _fake_embedder(vocab: dict[str, list[float]]):
    def embed(text: str) -> list[float]:
        return vocab[text]

    return embed, "fake-model-1"


class NoOpDisciplineTests(unittest.TestCase):
    def test_without_model_everything_is_a_structured_noop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            "os.environ", {sm.EMBEDDER_CMD_ENV: ""}
        ):
            self.assertIsNone(sm.configured_embedder())
            self.assertIsNone(
                sm.record_embedding(
                    kind="finding", ref_id="F-1", text="x", base_dir=tmp
                )
            )
            self.assertEqual(
                sm.nearest(text="x", base_dir=tmp), []
            )
            # No ledger file appears as a side effect of no-op calls.
            self.assertFalse(
                (Path(tmp) / "knowledge-graph" / "embeddings.jsonl").exists()
            )

    def test_unknown_kind_refuses_loudly(self) -> None:
        with self.assertRaises(ValueError):
            sm.record_embedding(kind="sideways", ref_id="X", text="x")


class RecordAndSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.vocab = {
            "tenant leak in farm": [1.0, 0.0, 0.1],
            "tenant isolation broken": [0.9, 0.1, 0.1],
            "slow query on sensors": [0.0, 1.0, 0.0],
        }
        self.embedder = _fake_embedder(self.vocab)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _record_all(self) -> None:
        for idx, text in enumerate(sorted(self.vocab)):
            sm.record_embedding(
                kind="finding",
                ref_id=f"F-{idx}",
                text=text,
                base_dir=self.tmp.name,
                embedder=self.embedder,
            )

    def test_rows_chain_and_carry_model_id(self) -> None:
        self._record_all()
        rows = load_jsonl(
            Path(self.tmp.name) / "aria-tools" / "knowledge-graph" / "embeddings.jsonl"
        ) or load_jsonl(
            Path(self.tmp.name) / "knowledge-graph" / "embeddings.jsonl"
        )
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(r["model_id"] == "fake-model-1" for r in rows))

    def test_nearest_ranks_by_cosine_and_is_deterministic(self) -> None:
        self._record_all()
        first = sm.nearest(
            text="tenant leak in farm",
            k=2,
            base_dir=self.tmp.name,
            embedder=self.embedder,
        )
        second = sm.nearest(
            text="tenant leak in farm",
            k=2,
            base_dir=self.tmp.name,
            embedder=self.embedder,
        )
        self.assertEqual(first, second)
        self.assertEqual(len(first), 2)
        # Both tenant rows outrank the unrelated slow-query row.
        texts = sorted(self.vocab)
        tenant_refs = {
            f"F-{texts.index('tenant leak in farm')}",
            f"F-{texts.index('tenant isolation broken')}",
        }
        self.assertEqual({item["ref_id"] for item in first}, tenant_refs)

    def test_cross_model_vectors_are_never_compared(self) -> None:
        self._record_all()
        other = (_fake_embedder(self.vocab)[0], "different-model")
        self.assertEqual(
            sm.nearest(
                text="tenant leak in farm",
                base_dir=self.tmp.name,
                embedder=other,
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
