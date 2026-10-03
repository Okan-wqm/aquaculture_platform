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

Two more pins close what that left open (ARIA-MEDIUM-NNN):

* the carried checkpoint fold, pinned per declared fold version
  (``pins.json`` ``folds``) by what it makes of the corpus, never by its
  source: a refactor that keeps the output keeps the fold version, and a
  checkpoint recorded under one fold can only be merged by code that folds
  as it did;
* every evidence contract surface's producer, pinned per declared row schema
  version (``pins.json`` ``producers``) by what the fold makes of the row the
  producer constructs from frozen inputs: a producer that changes what its
  rows mean to the evidence without bumping their schema_version fails.

All of it lives under ``aria-kernel/tests/invariants/``, a READONLY path for
ARIA's implementer (``implementation_safety.READONLY_PATHS``), so the agent
whose autonomy the evidence earns can neither re-pin a changed fold nor
declare a new authority on its own.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import unittest
from collections.abc import Iterator, Mapping
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


def _view(capability: str, accumulator: Any) -> dict[str, Any]:
    """What one capability's evidence is after ``accumulator`` folded rows."""
    spec = evidence.CAPABILITY_SPECS[capability]
    with mock.patch.object(evidence, "_stream_unlock_verdict_counts", return_value=({}, None)):
        counts, blockers = accumulator.capability_counts(repo_root=Path("."), target_sha="0" * 40)
    return {
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
        folded[name] = _view(capability, _fold(rows))
    # The checkpoint row a carried ledger's verified prefix becomes (ARIA-HIGH-278).
    folded["carried"] = {
        surface: _fold([row for row in streams["main"] if row[0] == surface]).carried_state(surface)
        for surface in spec.count_surfaces
        if surface in evidence._CARRIED_COUNT_SURFACES
    }
    return _plain(folded)


def _digest(value: Any) -> str:
    canonical = json.dumps(_plain(value), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def digest(capability: str) -> str:
    return _digest(projection(capability))


def fold_projection() -> dict[str, Any]:
    """What the carried checkpoint fold makes of the corpus, whoever reads it.

    Both halves of a checkpoint: the evidence each carried ledger's rows
    fold into (``carried_state``) and what merging those back yields
    (``merge_carried``), per stream. Pinned per declared fold version: a
    checkpoint recorded under that version is merged as if folded now.
    """
    carried = sorted(evidence._CARRIED_COUNT_SURFACES)
    folded: dict[str, Any] = {"carried_surfaces": carried}
    for name, rows in sorted(_streams().items()):
        checkpoints = {
            surface: _fold([row for row in rows if row[0] == surface]).carried_state(surface)
            for surface in carried
        }
        merged = evidence._StreamingEvidenceAccumulator()
        for surface, state in checkpoints.items():
            merged.merge_carried(state, surface)
        folded[name] = {"checkpoints": checkpoints, "merged": merged.carried_state("merged")}
    return _plain(folded)


# Producer fixtures: every evidence contract surface's rows as its producer
# constructs them, from frozen inputs and a frozen clock. The ledger adds the
# integrity hash when it appends, so the fixture stamps a fixed one.
_PRODUCED_AT = "2026-10-01T00:00:00Z"
_PRODUCED_SHA = "d4" * 20
_PRODUCED_LEDGER_HASH = "sha256:" + "e" * 64


@contextlib.contextmanager
def _frozen_producer_clock() -> Iterator[None]:
    from aria_kernel import (
        agent_invocations, autonomy_unlock, cycle, enterprise_readiness, finding_promotion, fixture_runner,
    )

    with contextlib.ExitStack() as stack:
        for module in (agent_invocations, autonomy_unlock, cycle, enterprise_readiness, finding_promotion, fixture_runner):
            stack.enter_context(mock.patch.object(module, "utc_now", return_value=_PRODUCED_AT))
        yield


def _readiness_inputs() -> dict[str, Any]:
    """A claim's inputs, taken from the corpus's valid claim, so the producer's claim is one the contract admits."""
    claim = next(
        row for surface, row in _streams()["main"]
        if surface == "enterprise_readiness_claims" and "branch_protection_proof" in row
    )
    return {
        "readiness_claim_id": claim["readiness_claim_id"],
        "binding": {name: claim[name] for name in ("pr_number", "repo", "target_ref", "head_ref", "head_sha")},
        "workflow_run_ids": set(claim["workflow_run_ids"]),
        "artifact_ref": claim["artifact_refs"][0],
        "rollback_proof": claim["rollback_proof"],
        "retention_proof": claim["retention_proof"],
        "open_expired_waivers": claim["waiver_ledger"]["open_expired_waivers"],
        "waiver_ref": claim["waiver_ledger"]["source_ledger_ref"],
        "branch_protection_proof": claim["branch_protection_proof"],
        "dlp_proof": claim["dlp_proof"],
        "token_proof": claim["token_proof"],
    }


def produced_rows() -> list[tuple[str, str, dict[str, Any]]]:
    """(producer, surface, row) for every row constructor of an evidence contract surface."""
    from aria_kernel import (
        agent_invocations, autonomy_unlock, cycle, enterprise_readiness, finding_promotion, fixture_runner,
        readiness_proofs,
    )

    result = {
        "claim_id": "claim-producer", "request_id": "AIR-producer", "agent_id": "aria-worker",
        "output_path": "outputs/producer.json", "output_hash": "sha256:" + "1" * 64,
        "envelope_evidence_hash": "sha256:" + "2" * 64, "transcript_hash": "sha256:" + "3" * 64,
    }
    cases = [
        {"name": "baseline", "lane": "real_repo_baseline", "passed": True},
        {"name": "semantic", "lane": "semantic_regression", "passed": True},
    ]
    verdict = autonomy_unlock.AutonomyUnlockVerdict(
        valid=True, lane="L1", counts={"merged": 3}, requirements={"merged": 3}, reasons=(),
    )
    with _frozen_producer_clock():
        rows = [
            ("cycle.started", "cycles", cycle._started_cycle_row(cycle_id="cyc-producer")),
            ("cycle.completed", "cycles", cycle._completed_event("cyc-producer", 2, git_head_sha_at_cycle=_PRODUCED_SHA)),
            ("cycle.failed", "cycles", cycle._failed_event("cyc-producer", git_head_sha_at_cycle=_PRODUCED_SHA)),
            ("cycle.stopped", "cycles", cycle._stopped_event("cyc-producer", git_head_sha_at_cycle=_PRODUCED_SHA)),
            ("cycle.aborted", "cycles", cycle._aborted_event("cyc-producer", git_head_sha_at_cycle=_PRODUCED_SHA)),
            ("agent_invocations.accepted", "agent_invocation_results", agent_invocations._build_accepted_row(
                **result, role="judge", context_hash="sha256:" + "4" * 64, prompt_hash="sha256:" + "5" * 64,
                transcript_artifact_ref="transcripts/producer.jsonl", target_sha=_PRODUCED_SHA,
                checked_evidence_count=2,
            )),
            ("agent_invocations.rejected", "agent_invocation_results", agent_invocations._build_rejection_row(
                **result, reasons=["evidence ref unresolved"], reason_codes=["evidence_ref_unresolved"],
            )),
            ("readiness_proofs.claim", "enterprise_readiness_claims", enterprise_readiness.readiness_claim_row(
                readiness_proofs.build_readiness_claim(**_readiness_inputs()),
            )),
            ("finding_promotion.promotion", "promotions", finding_promotion.promotion_row(
                finding_fingerprint="fp-producer", finding_id="F-producer", tool_id="producer-tool",
                judgment_group_id="jg-producer",
            )),
            ("fixture_runner.suite", "agent_eval_fixture_runs", fixture_runner.fixture_suite_row(
                tool_id="producer-tool", tool={"tool_id": "producer-tool", "version": "1.0.0", "fixture_set": "producer"},
                fixture_set_digest="sha256:" + "6" * 64, cycle_id="cyc-producer", case_results=cases,
                execution_run_id="exec-producer",
            )),
            ("autonomy_unlock.verdict", "enterprise_autonomy_unlock_events", autonomy_unlock.unlock_verdict_row("L1", verdict)),
        ]
    return [(producer, surface, {**row, "ledger_hash": _PRODUCED_LEDGER_HASH}) for producer, surface, row in rows]


def _contract_owner(surface: str) -> tuple[str, evidence.EvidenceContract]:
    return next(
        (capability, contract)
        for capability, spec in evidence.CAPABILITY_SPECS.items()
        for contract in spec.contracts
        if contract.surface == surface
    )


def producer_key(producer: str, surface: str, row: Mapping[str, Any], declared: Mapping[str, Any]) -> str:
    """A producer's row, named by the schema version it DECLARES and the authority it is read under."""
    capability, _contract = _contract_owner(surface)
    return (
        f"{producer}|{row.get('$schema') or 'none'}@{row.get('schema_version')}"
        f"|{evidence._semantic_authority(declared, capability)}"
    )


def producer_digest(surface: str, row: Mapping[str, Any]) -> str:
    """What the row means to the evidence: its owning capability's fold of it."""
    capability, _contract = _contract_owner(surface)
    return _digest(_view(capability, _fold([(surface, dict(row))])))


def _pin_section(section: str) -> dict[str, str]:
    document = json.loads(PINS.read_text(encoding="utf-8"))
    if document.get("$schema") != PINS_SCHEMA or not isinstance(document.get(section), dict):
        raise AssertionError(f"{PINS} is not a {PINS_SCHEMA} document with {section}")
    return document[section]


def _pins() -> dict[str, str]:
    return _pin_section("pins")


def fold_mismatch(declared: Mapping[str, Any] | None = None) -> str | None:
    """Why the carried fold disagrees with its declared fold version's pin, or None."""
    declaration = declared if declared is not None else evidence._DECLARED_SEMANTICS
    key = f"fold@{declaration['evidence_fold_version']}"
    pins = _pin_section("folds")
    if key not in pins:
        return f"no pin for {key}: the fold version was bumped; the operator records its fold"
    if pins[key] != _digest(fold_projection()):
        return f"the carried fold changed under the unchanged {key}: bump evidence_fold_version"
    return None


def producer_mismatches(declared: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Every producer whose row means something else than pinned for its declared schema version."""
    declaration = declared if declared is not None else evidence._DECLARED_SEMANTICS
    pins = _pin_section("producers")
    found: dict[str, str] = {}
    for producer, surface, row in produced_rows():
        key = producer_key(producer, surface, row, declaration)
        if key not in pins:
            found[producer] = f"no pin for {key}: a row schema or semantic version was bumped; the operator records it"
        elif pins[key] != producer_digest(surface, row):
            found[producer] = f"{producer} changed what its {surface} rows mean under {key}: bump their schema_version"
    return found


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

    # -- the carried checkpoint fold, pinned by output per fold version --

    def test_the_carried_fold_folds_the_corpus_as_pinned_for_its_declared_fold_version(self) -> None:
        self.assertIsNone(fold_mismatch())

    def test_a_checkpoint_carries_its_prefix_exactly(self) -> None:
        """What a checkpoint is for: its prefix's evidence merged back, plus
        the rows after it, folds to what the whole ledger folds to."""
        for name, rows in sorted(_streams().items()):
            for surface in sorted(evidence._CARRIED_COUNT_SURFACES):
                ledger = [row for row in rows if row[0] == surface]
                whole = _fold(ledger).carried_state(surface)
                for cut in range(len(ledger) + 1):
                    with self.subTest(stream=name, surface=surface, cut=cut):
                        resumed = evidence._StreamingEvidenceAccumulator()
                        resumed.merge_carried(_fold(ledger[:cut]).carried_state(surface), surface)
                        for _surface, row in ledger[cut:]:
                            resumed.consume(surface, row)
                        self.assertEqual(resumed.carried_state(surface), whole)

    def test_a_fold_refactor_keeps_its_version_and_a_fold_change_needs_a_bump(self) -> None:
        original = evidence._StreamingEvidenceAccumulator.carried_state

        def reordered(self: Any, key: str) -> dict[str, Any]:
            return dict(reversed(list(original(self, key).items())))

        with mock.patch.object(evidence._StreamingEvidenceAccumulator, "carried_state", reordered):
            self.assertIsNone(fold_mismatch())
        merge = evidence._StreamingEvidenceAccumulator.merge_carried

        def drops_metrics(self: Any, state: Mapping[str, Any], key: str) -> None:
            merge(self, {**state, "metrics": {}}, key)

        with mock.patch.object(evidence._StreamingEvidenceAccumulator, "merge_carried", drops_metrics):
            self.assertIn("bump evidence_fold_version", fold_mismatch() or "")
        bumped = json.loads(json.dumps(evidence._DECLARED_SEMANTICS))
        bumped["evidence_fold_version"] += 1
        self.assertIn("no pin for fold@", fold_mismatch(bumped) or "")

    # -- producers, pinned by what their rows mean per declared schema version --

    def test_every_evidence_contract_surface_has_a_producer_its_contract_accepts(self) -> None:
        produced = produced_rows()
        surfaces = {
            contract.surface for spec in evidence.CAPABILITY_SPECS.values() for contract in spec.contracts
        }
        self.assertEqual({surface for _producer, surface, _row in produced}, surfaces)
        for producer, surface, row in produced:
            with self.subTest(producer=producer):
                _capability, contract = _contract_owner(surface)
                self.assertIn(row["schema_version"], contract.schema_versions)
                self.assertEqual(row.get("$schema"), contract.schema_id)
        # Each proof row a producer writes is one its contract admits.
        admitted = {
            producer for producer, surface, row in produced
            if any(_fold([(surface, row)]).native_summaries()[_contract_owner(surface)[0]].targets_by_contract.values())
        }
        self.assertEqual(admitted, {"cycle.completed", "agent_invocations.accepted", "readiness_proofs.claim"})

    def test_every_producer_is_pinned_for_its_declared_schema_version(self) -> None:
        self.assertEqual(producer_mismatches(), {})

    def test_a_producer_meaning_change_without_a_schema_bump_fails_its_pin(self) -> None:
        from aria_kernel import cycle

        completed = cycle._completed_event

        def unbound(*args: Any, **kwargs: Any) -> dict[str, Any]:
            row = completed(*args, **kwargs)
            row.pop("git_head_sha_at_cycle")
            return row

        with mock.patch.object(cycle, "_completed_event", unbound):
            self.assertEqual(set(producer_mismatches()), {"cycle.completed"})
            self.assertIn("bump their schema_version", producer_mismatches()["cycle.completed"])

        def bumped(*args: Any, **kwargs: Any) -> dict[str, Any]:
            return {**completed(*args, **kwargs), "schema_version": 4}

        with mock.patch.object(cycle, "_completed_event", bumped):
            self.assertIn("no pin for cycle.completed|none@4|", producer_mismatches()["cycle.completed"])
        # A semantic bump of the reading capability re-keys its producers too.
        declared = json.loads(json.dumps(evidence._DECLARED_SEMANTICS))
        declared["capability_contract_versions"]["executor"] += 1
        self.assertEqual(
            set(producer_mismatches(declared)), {"agent_invocations.accepted", "agent_invocations.rejected"},
        )


if __name__ == "__main__":
    unittest.main()
