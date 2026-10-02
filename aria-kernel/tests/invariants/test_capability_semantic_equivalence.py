"""ARIA-HIGH-288 — a capability's proofs are bound to declared semantics, pinned by what the fold does.

A capability's evidence used to be bound to a hash over the SOURCE BYTES of a
roster of kernel files, so every storage-layer refactor touching that roster
reset all seven capabilities to ``declared``. Evidence is now bound to the
SEMANTIC AUTHORITY declared in ``aria_kernel/data/capability_semantic_authority.json``
(capability contract version, evidence fold version, upcaster set version):
a change that keeps every declared version keeps existing evidence, a change
that bumps one resets it by construction.

This suite is what keeps a declared version honest. It folds a frozen corpus
of fixture ledger rows (``capability_semantic_equivalence/corpus.jsonl``)
through the executing kernel — producer-native contracts, upcasters, the
streaming count fold, the carried checkpoint fold — and compares each
capability's output with the digest pinned for its declared authority in
``capability_semantic_equivalence/pins.json``:

* output changed, declared authority unchanged → the suite fails: the
  change altered semantics without bumping a version;
* declared authority bumped, no pin recorded for it → the suite fails until
  the operator records the new fold output.

Both files live under ``aria-kernel/tests/invariants/``, a READONLY path for
ARIA's implementer (``implementation_safety.READONLY_PATHS``), so the agent
whose autonomy the evidence earns can neither re-pin a changed fold nor
declare a new authority on its own.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from collections.abc import Mapping
from dataclasses import asdict
from pathlib import Path
from types import MappingProxyType
from typing import Any
from unittest import mock

from aria_kernel import autonomy_evidence as evidence
from aria_kernel.implementation_safety import READONLY_PATHS

DATA = Path(__file__).with_name("capability_semantic_equivalence")
CORPUS = DATA / "corpus.jsonl"
PINS = DATA / "pins.json"
PINS_SCHEMA = "aria/capability-semantic-equivalence-pins/v1"
Rows = list[tuple[str, dict[str, Any]]]


def _streams() -> dict[str, Rows]:
    streams: dict[str, Rows] = {}
    for line in CORPUS.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        streams.setdefault(record["stream"], []).append((record["surface"], record["row"]))
    return streams


def _fold(rows: Rows) -> Any:
    accumulator = evidence._StreamingEvidenceAccumulator()
    for surface, row in rows:
        accumulator.consume(surface, row)
    return accumulator


def _plain(value: Any) -> Any:
    """A JSON-stable form of the fold's projections (proxies, sets, tuples)."""
    if isinstance(value, (Mapping, MappingProxyType)):
        return {str(key): _plain(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if isinstance(value, (set, frozenset)):
        return sorted(_plain(item) for item in value)
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _contract(contract: evidence.EvidenceContract) -> dict[str, Any]:
    return {
        "surface": contract.surface,
        "proof_kind": contract.proof_kind,
        "schema_id": contract.schema_id,
        "schema_versions": sorted(contract.schema_versions),
        "identity_field": contract.identity_field,
        "integrity_hash_field": contract.integrity_hash_field,
        "authoritative_sha_field": contract.authoritative_sha_field,
    }


def _native(summary: Any) -> dict[str, Any]:
    return {
        "counts": dict(summary.counts),
        "blockers": list(summary.blockers),
        "budget_exceeded": [summary.distinct_target_budget_exceeded, summary.global_target_budget_exceeded],
        "targets": {
            contract.surface: sorted(
                [
                    target.candidate.evidence_target_sha, target.candidate.row_id, target.candidate.row_hash,
                    target.candidate.schema_id, target.candidate.schema_version, target.admissible_count,
                    sorted(target.admissible_by_schema.items()), target.ordinal,
                ]
                for target in targets
            )
            for contract, targets in summary.targets_by_contract.items()
        },
    }


def projection(capability: str) -> dict[str, Any]:
    """What one capability's evidence is, folded from the frozen corpus.

    The unlock verdict counts are left out: they apply the operator's unlock
    policy at the target at the current clock (``autonomy_unlock``), not the
    evidence fold; the rows the fold hands that rule are projected instead.
    """
    spec = evidence.CAPABILITY_SPECS[capability]
    streams = _streams()
    folded: dict[str, Any] = {
        "contracts": [_contract(contract) for contract in spec.contracts],
        "count_surfaces": list(spec.count_surfaces),
    }
    for name, rows in sorted(streams.items()):
        accumulator = _fold(rows)
        with mock.patch.object(evidence, "_stream_unlock_verdict_counts", return_value=({}, None)):
            counts, blockers = accumulator.capability_counts(repo_root=Path("."), target_sha="0" * 40)
        folded[name] = {
            "counts": counts[capability],
            "count_blockers": blockers[capability],
            "native": _native(accumulator.native_summaries()[capability]),
            "surface_counts": {surface: accumulator.surface_counts[surface] for surface in spec.count_surfaces},
            "autonomy_state": asdict(accumulator.autonomy_state) if "autonomy_state" in spec.count_surfaces else None,
            "promoted": sorted(accumulator.promoted_fingerprints) if "promotions" in spec.count_surfaces else None,
            "acceptance_rows": (
                accumulator.acceptance_rows if "enterprise_acceptance_events" in spec.count_surfaces else None
            ),
        }
    # The checkpoint row a carried ledger's verified prefix becomes (ARIA-HIGH-278).
    folded["carried"] = {
        surface: _fold([row for row in streams["main"] if row[0] == surface]).carried_state(surface)
        for surface in spec.count_surfaces
        if surface in evidence._CARRIED_COUNT_SURFACES
    }
    return _plain(folded)


def digest(capability: str) -> str:
    canonical = json.dumps(projection(capability), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _pins() -> dict[str, str]:
    document = json.loads(PINS.read_text(encoding="utf-8"))
    if document.get("$schema") != PINS_SCHEMA or not isinstance(document.get("pins"), dict):
        raise AssertionError(f"{PINS} is not a {PINS_SCHEMA} document")
    return document["pins"]


def mismatches(declared: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Every capability whose fold disagrees with its declared authority's pin."""
    declaration = declared if declared is not None else evidence._DECLARED_SEMANTICS
    pins = _pins()
    found: dict[str, str] = {}
    for capability in evidence.CAPABILITY_SPECS:
        authority = evidence._semantic_authority(declaration, capability)
        if authority not in pins:
            found[capability] = f"no pin for {authority}: a semantic version was bumped; the operator records its fold"
        elif pins[authority] != digest(capability):
            found[capability] = f"the fold changed under the unchanged authority {authority}: bump its version"
    return found


class CapabilitySemanticEquivalenceTests(unittest.TestCase):
    def test_the_declaration_names_exactly_the_capability_roster(self) -> None:
        self.assertEqual(
            set(evidence._DECLARED_SEMANTICS["capability_contract_versions"]),
            set(evidence.CAPABILITY_SPECS),
        )

    def test_the_checkpoint_fold_version_is_the_declared_one(self) -> None:
        self.assertEqual(
            evidence.EVIDENCE_CHECKPOINT_FOLD_VERSION,
            evidence._DECLARED_SEMANTICS["evidence_fold_version"],
        )

    def test_the_declaration_and_its_pins_are_readonly_to_the_implementer(self) -> None:
        for path in (evidence.SEMANTIC_AUTHORITY_PATH, "aria-kernel/tests/invariants/capability_semantic_equivalence/"):
            with self.subTest(path=path):
                self.assertTrue(any(path.startswith(prefix) for prefix in READONLY_PATHS), path)

    def test_the_corpus_reaches_every_fold_branch(self) -> None:
        """A pin over a corpus that misses a branch would not see that branch change."""
        folded = {capability: projection(capability) for capability in evidence.CAPABILITY_SPECS}
        witnesses = {
            capability: [surface for surface, targets in value["main"]["native"]["targets"].items() if targets]
            for capability, value in folded.items()
        }
        self.assertEqual(witnesses["cycle_runtime"], ["cycles"])
        self.assertEqual(witnesses["executor"], ["agent_invocation_results"])
        self.assertEqual(witnesses["enterprise_readiness"], ["enterprise_readiness_claims"])
        reasons = {
            blocker.split(":", 1)[0]
            for value in folded.values()
            for blocker in value["main"]["native"]["blockers"]
        }
        self.assertEqual(reasons, {
            "proof_upcast_rejected", "proof_schema_unsupported", "proof_identity_missing",
            "proof_integrity_hash_missing", "proof_target_sha_unavailable", "proof_target_sha_invalid",
        })
        self.assertEqual(folded["cycle_runtime"]["count_rejected"]["count_blockers"], ["count_rejected:cycle_runtime"])
        carried = {surface for value in folded.values() for surface in value["carried"]}
        self.assertEqual(carried, set(evidence._CARRIED_COUNT_SURFACES))
        # The K3 segment-opening row is chain structure, never a counted row.
        self.assertEqual(folded["executor"]["main"]["surface_counts"]["agent_invocation_requests"], 3)

    def test_every_capability_folds_the_corpus_as_pinned_for_its_declared_authority(self) -> None:
        self.assertEqual(mismatches(), {})

    def test_a_fold_change_without_a_version_bump_fails_the_pin(self) -> None:
        legacy = "aria_kernel.upcasters.cycles._LEGACY_EVENT_TO_STATUS"
        with mock.patch.dict(legacy, {"completed": "failed"}):
            self.assertIn("cycle_runtime", mismatches())
        with mock.patch.object(evidence._StreamingEvidenceAccumulator, "carried_state", lambda self, key: {}):
            self.assertTrue({"executor", "fixture_calibration", "pre_merge_perimeter"} <= set(mismatches()))
        widened = dict(evidence.CAPABILITY_SPECS)
        executor = widened["executor"]
        contract = executor.contracts[0]
        widened["executor"] = evidence.CapabilitySpec(
            authority_paths=executor.authority_paths,
            producer_paths=executor.producer_paths,
            authorizing_consumer_paths=executor.authorizing_consumer_paths,
            contracts=(evidence.EvidenceContract(
                surface=contract.surface, proof_kind=contract.proof_kind, schema_id=contract.schema_id,
                schema_versions=frozenset({1, 2}), identity_field=contract.identity_field,
                integrity_hash_field=contract.integrity_hash_field,
                authoritative_sha_field=contract.authoritative_sha_field,
                upcaster=contract.upcaster, terminal_predicate=contract.terminal_predicate,
            ),),
            count_surfaces=executor.count_surfaces,
        )
        with mock.patch.object(evidence, "CAPABILITY_SPECS", MappingProxyType(widened)):
            self.assertEqual(set(mismatches()), {"executor"})

    def test_a_version_bump_needs_a_pin_the_implementer_cannot_write(self) -> None:
        bumped = json.loads(json.dumps(evidence._DECLARED_SEMANTICS))
        bumped["capability_contract_versions"]["executor"] += 1
        self.assertEqual(set(mismatches(bumped)), {"executor"})
        bumped["evidence_fold_version"] += 1
        self.assertEqual(set(mismatches(bumped)), set(evidence.CAPABILITY_SPECS))


if __name__ == "__main__":
    unittest.main()
