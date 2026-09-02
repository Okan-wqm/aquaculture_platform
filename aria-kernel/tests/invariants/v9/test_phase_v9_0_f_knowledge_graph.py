"""Plan ARIA-V9.0-F — knowledge_graph integrity invariants.

Closes ai-safety MED-014 (poisoning), sec CRIT-005 (forgery),
arb HIGH-008 (provenance + rollback).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import knowledge_graph as _kg


def _mk_pattern(
    pattern_id: str = "conv_2026_05_18_001",
    pattern_type: str = "convention",
    confidence: float = 0.85,
) -> _kg.Pattern:
    return _kg.Pattern(
        pattern_id=pattern_id,
        pattern_type=pattern_type,
        confidence=confidence,
        evidence_refs=("evidence/foo.py:42",),
        discovered_by_cycle_id="cycle-test-001",
        observed_at="2026-05-18T15:00:00Z",
    )


class TestV9KnowledgeGraphSchema(unittest.TestCase):

    def test_i_v10_mem_01_schema_version_pinned(self):
        self.assertEqual(_kg.KNOWLEDGE_GRAPH_SCHEMA_VERSION, 1)

    def test_i_v10_mem_01_min_confidence_canonical(self):
        self.assertEqual(_kg.MIN_PATTERN_CONFIDENCE, 0.7)

    def test_i_v10_mem_01_anti_pattern_types_closed(self):
        self.assertEqual(
            _kg.ANTI_PATTERN_TYPES,
            frozenset({"tool_design", "scope_decision", "architecture_class"}),
        )

    def test_i_v10_mem_01_pattern_frozen(self):
        p = _mk_pattern()
        with self.assertRaises((AttributeError, Exception)):
            p.pattern_id = "evil"  # type: ignore[misc]

    def test_validate_rejects_bad_confidence(self):
        for bad in (-0.1, 1.1, 2, "high", None):
            p = _kg.Pattern(
                pattern_id="x", pattern_type="convention",
                confidence=bad,  # type: ignore[arg-type]
                evidence_refs=("e:1",),
                discovered_by_cycle_id="c1",
                observed_at="2026-05-18T15:00:00Z",
            )
            with self.assertRaises(_kg.KnowledgeGraphSchemaError):
                _kg._validate_pattern(p)

    def test_validate_rejects_empty_evidence_refs(self):
        p = _kg.Pattern(
            pattern_id="x", pattern_type="convention", confidence=0.5,
            evidence_refs=(),
            discovered_by_cycle_id="c1",
            observed_at="2026-05-18T15:00:00Z",
        )
        with self.assertRaises(_kg.KnowledgeGraphSchemaError):
            _kg._validate_pattern(p)

    def test_validate_requires_cycle_id(self):
        p = _kg.Pattern(
            pattern_id="x", pattern_type="convention", confidence=0.5,
            evidence_refs=("e:1",),
            discovered_by_cycle_id="",
            observed_at="2026-05-18T15:00:00Z",
        )
        with self.assertRaises(_kg.KnowledgeGraphSchemaError):
            _kg._validate_pattern(p)


class TestV9KnowledgeGraphHashChain(unittest.TestCase):

    def test_i_v10_mem_04_genesis_hash_constant(self):
        self.assertTrue(_kg.GENESIS_PREV_HASH.startswith("sha256:"))
        self.assertEqual(len(_kg.GENESIS_PREV_HASH), len("sha256:") + 64)

    def test_i_v10_mem_04_record_convention_appends_chained(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _kg.record_convention(
                _mk_pattern(),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            self.assertTrue(path.exists())
            lines = path.read_text().strip().splitlines()
            self.assertEqual(len(lines), 1)
            row = json.loads(lines[0])
            self.assertEqual(row["prev_row_hash"], _kg.GENESIS_PREV_HASH)

    def test_i_v10_mem_04_second_append_chained_to_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            _kg.record_convention(
                _mk_pattern(pattern_id="conv-001"),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            _kg.record_convention(
                _mk_pattern(pattern_id="conv-002"),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            path = Path(tmp) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
            lines = path.read_text().strip().splitlines()
            self.assertEqual(len(lines), 2)
            row0 = json.loads(lines[0])
            row1 = json.loads(lines[1])
            expected_prev = _kg._row_hash(row0)
            self.assertEqual(row1["prev_row_hash"], expected_prev)

    def test_i_v10_mem_04_verify_chain_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            _kg.record_convention(
                _mk_pattern(pattern_id="conv-001"),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            _kg.record_convention(
                _mk_pattern(pattern_id="conv-002"),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            path = Path(tmp) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
            ok, count = _kg.verify_chain_or_quarantine(path)
            self.assertTrue(ok)
            self.assertEqual(count, 2)

    def test_i_v10_mem_04_tampering_detected_and_quarantined(self):
        with tempfile.TemporaryDirectory() as tmp:
            _kg.record_convention(
                _mk_pattern(pattern_id="conv-001"),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            path = Path(tmp) / "aria-tools" / "knowledge-graph" / "conventions.jsonl"
            # Tamper: append a forged row with wrong prev_row_hash
            with path.open("a") as f:
                forged = {
                    "pattern_id": "evil",
                    "pattern_type": "convention",
                    "confidence": 0.99,
                    "evidence_refs": ["evil:1"],
                    "discovered_by_cycle_id": "evil-cycle",
                    "observed_at": "2026-05-18T15:00:00Z",
                    "schema_version": 1,
                    "supersedes_pattern_id": None,
                    "signer_key_fp": "SHA256:evil",
                    "prev_row_hash": "sha256:" + "0" * 64,  # WRONG
                }
                f.write(json.dumps(forged, sort_keys=True, separators=(",", ":")) + "\n")

            ok, broken = _kg.verify_chain_or_quarantine(path)
            self.assertFalse(ok)
            self.assertEqual(broken, 2)
            # File quarantined (renamed)
            self.assertFalse(path.exists())
            # Quarantined file exists
            parent = path.parent
            quarantined = list(parent.glob(f"{path.name}.quarantined.*"))
            self.assertEqual(len(quarantined), 1)


class TestV9AntiPatternGate(unittest.TestCase):
    def setUp(self) -> None:
        import os as _os

        _os.environ.setdefault("ARIA_TEST_V9_KG_SIGNATURE", "operator-test-signature")


    def test_record_anti_pattern_requires_signature(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _mk_pattern(pattern_type="anti_pattern")
            with self.assertRaises(_kg.KnowledgeGraphSignatureMissing):
                _kg.record_anti_pattern(
                    p, workspace_root=tmp,
                    reason_class="tool_design",
                    operator_signature="",
                )

    def test_record_anti_pattern_validates_reason_class(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _mk_pattern(pattern_type="anti_pattern")
            with self.assertRaises(_kg.KnowledgeGraphSchemaError):
                _kg.record_anti_pattern(
                    p, workspace_root=tmp,
                    reason_class="totally_invented_class",
                    operator_signature="ack-env:ARIA_TEST_V9_KG_SIGNATURE",
                )

    def test_record_anti_pattern_requires_pattern_type_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _mk_pattern(pattern_type="convention")  # WRONG
            with self.assertRaises(_kg.KnowledgeGraphSchemaError):
                _kg.record_anti_pattern(
                    p, workspace_root=tmp,
                    reason_class="tool_design",
                    operator_signature="ack-env:ARIA_TEST_V9_KG_SIGNATURE",
                )

    def test_record_anti_pattern_canonical_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = _mk_pattern(pattern_type="anti_pattern")
            path = _kg.record_anti_pattern(
                p, workspace_root=tmp,
                reason_class="tool_design",
                operator_signature="ack-env:ARIA_TEST_V9_KG_SIGNATURE",
            )
            self.assertTrue(path.exists())
            self.assertEqual(path.name, "anti-patterns.jsonl")


class TestV9LookupPattern(unittest.TestCase):

    def test_lookup_pattern_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(_kg.lookup_pattern("nonexistent", workspace_root=tmp))

    def test_lookup_pattern_below_confidence_floored(self):
        with tempfile.TemporaryDirectory() as tmp:
            _kg.record_convention(
                _mk_pattern(pattern_id="low-conf", confidence=0.3),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            result = _kg.lookup_pattern("low-conf", workspace_root=tmp)
            self.assertIsNone(result, "low-confidence row MUST be filtered out")

    def test_lookup_pattern_above_confidence_returned(self):
        with tempfile.TemporaryDirectory() as tmp:
            _kg.record_convention(
                _mk_pattern(pattern_id="high-conf", confidence=0.9),
                workspace_root=tmp,
                signer_key_fp="SHA256:abc",
            )
            result = _kg.lookup_pattern("high-conf", workspace_root=tmp)
            self.assertIsNotNone(result)
            self.assertEqual(result["pattern_id"], "high-conf")


class TestV9PublicApi(unittest.TestCase):

    def test_kg_public_api_pinned(self):
        canonical = {
            "KNOWLEDGE_GRAPH_SCHEMA_VERSION", "MIN_PATTERN_CONFIDENCE",
            "ANTI_PATTERN_TYPES", "GENESIS_PREV_HASH", "Pattern",
            "KnowledgeGraphTamper", "KnowledgeGraphSignatureMissing",
            "KnowledgeGraphSchemaError",
            "verify_chain_or_quarantine", "record_convention",
            "record_anti_pattern", "lookup_pattern", "rank_pressure_sources",
        }
        self.assertEqual(set(_kg.__all__), canonical)


if __name__ == "__main__":
    unittest.main()
