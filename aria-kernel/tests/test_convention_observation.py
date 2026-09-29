"""Persisted observation identity and lock ownership regressions."""
from dataclasses import asdict, replace
import json
import multiprocessing
import traceback
from pathlib import Path
from typing import Iterator
from unittest.mock import patch
import pytest
from aria_kernel import knowledge_graph as kg
from aria_kernel.contention_replay import replay_append_only_suffixes
from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
from aria_kernel.ledger import read_jsonl, verify_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def observation(**changes) -> kg.Pattern:
    return replace(kg.Pattern(pattern_id="observation", pattern_type="convention",
        confidence=0.5, evidence_refs=("fixture/a.py:1", "fixture/b.py:2"),
        discovered_by_cycle_id="cycle", observed_at="2026-09-10T00:00:00Z",
        outcome_status="hypothesis", plan_id="plan"), **changes)


@pytest.fixture
def signer(tmp_path) -> Iterator[str]:
    key = mint_signing_key(cycle_id="fixture-key", workspace_root=tmp_path)
    try:
        yield key.fingerprint
    finally:
        revoke_signing_key(cycle_id="fixture-key", workspace_root=tmp_path)


def record(root, signer, pattern=None) -> Path:
    return kg.record_convention(pattern or observation(), workspace_root=root, signer_key_fp=signer)


def test_sequential_retry(tmp_path, signer) -> None:
    path = record(tmp_path, signer)
    before = path.read_bytes()
    key = mint_signing_key(cycle_id="rotated", workspace_root=tmp_path)
    try:
        assert record(tmp_path, key.fingerprint, observation(observed_at="2026-09-11T00:00:00Z")) == path
    finally:
        revoke_signing_key(cycle_id="rotated", workspace_root=tmp_path)
    assert path.read_bytes() == before
    assert len(read_jsonl(path)) == 1
    with pytest.raises(kg.KnowledgeGraphSchemaError):
        record(tmp_path, "invalid")
    assert path.read_bytes() == before


@pytest.mark.parametrize("changes", [
    {"pattern_type": "other"}, {"confidence": 0.6},
    {"evidence_refs": ("fixture/b.py:2", "fixture/a.py:1")},
    {"evidence_refs": ("fixture/c.py:1",)}, {"discovered_by_cycle_id": "other"},
    {"plan_id": "other"}, {"outcome_status": "verified"}, {"supersedes_pattern_id": "prior"},
])
def test_conflicting_identity(tmp_path, signer, changes) -> None:
    path = record(tmp_path, signer)
    before = path.read_bytes()
    with pytest.raises(kg.KnowledgeGraphSchemaError, match="observation conflict"):
        record(tmp_path, signer, observation(**changes))
    assert path.read_bytes() == before


def test_promotion_then_original_retry(tmp_path, signer) -> None:
    path = record(tmp_path, signer)
    promoted = kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
    before = path.read_bytes()
    record(tmp_path, signer)
    assert path.read_bytes() == before
    assert read_jsonl(path)[1]["pattern_id"] == promoted["pattern_id"]
    record(tmp_path, signer, observation(pattern_id="revision", supersedes_pattern_id="observation"))
    assert len(read_jsonl(path)) == 3


@pytest.mark.parametrize("format", ["native", "dual", "mixed", "replay"])
def test_historical_defaults_and_transport(tmp_path, signer, format) -> None:
    path = ensure_tools_dir(tmp_path / "aria-tools") / "knowledge-graph/conventions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    default = observation(outcome_status="unknown", plan_id=None)
    row = asdict(default)
    for field in ("outcome_status", "plan_id", "supersedes_pattern_id", "schema_version"):
        row.pop(field)
    row["signer_key_fp"] = signer
    # The declared writer stamps an absent schema as ledger format v2.
    # Native history exercises absence; declared Pattern rows state v1.
    if format in {"dual", "replay"}:
        row["schema_version"] = 1
    if format in {"native", "mixed"}:
        row["prev_row_hash"] = kg.GENESIS_PREV_HASH
        path.write_text(json.dumps(row) + "\n")
        if format == "mixed":
            kg._append_row(path, {**row, "pattern_id": "unrelated"})
    elif format == "dual":
        kg._append_row(path, row)
    else:
        loser = ensure_tools_dir(tmp_path / "loser") / "knowledge-graph/conventions.jsonl"
        kg._append_row(loser, row)
        replay_append_only_suffixes(surfaces={"kg_conventions": {
            "winner_path": path, "loser_path": loser, "base_row_count": 0, "base_tail_hash": None,
        }}, replay_transaction_id="observation-retry")
    before = path.read_bytes()
    record(tmp_path, signer, default)
    assert path.read_bytes() == before
    for changes in ({"outcome_status": "hypothesis"}, {"plan_id": "plan"}, {"supersedes_pattern_id": "old"}):
        with pytest.raises(kg.KnowledgeGraphSchemaError, match="observation conflict"):
            record(tmp_path, signer, replace(default, **changes))
    assert path.read_bytes() == before


@pytest.mark.parametrize("conflict", [False, True])
def test_all_historical_matches(tmp_path, signer, conflict) -> None:
    path = record(tmp_path, signer)
    kg._append_row(path, {**asdict(observation(confidence=0.6 if conflict else 0.5)), "signer_key_fp": signer})
    kg._append_row(path, {**asdict(observation()), "signer_key_fp": signer})
    before = path.read_bytes()
    if conflict:
        with pytest.raises(kg.KnowledgeGraphSchemaError, match="observation conflict"):
            record(tmp_path, signer)
    else:
        record(tmp_path, signer)
    assert path.read_bytes() == before


@pytest.mark.parametrize("damage", ["native", "outer", "schema"])
def test_retry_checks_integrity_and_schema(tmp_path, signer, damage) -> None:
    path = record(tmp_path, signer)
    if damage == "schema":
        kg._append_row(path, asdict(observation(schema_version=2)))
    else:
        row = json.loads(path.read_text())
        row["prev_row_hash" if damage == "native" else "ledger_hash"] = "sha256:broken"
        if damage == "native":
            from aria_kernel.ledger import _record_hash
            row["ledger_hash"] = _record_hash(row, None)
        path.write_text(json.dumps(row) + "\n")
    before = path.read_bytes()
    with pytest.raises((kg.KnowledgeGraphTamper, kg.KnowledgeGraphSchemaError)):
        record(tmp_path, signer)
    assert path.read_bytes() == before


def _child_record(root, signer, changes, barrier, results) -> None:
    try:
        barrier.wait(timeout=15)
        record(root, signer, observation(**changes))
        results.put(("ok", None))
    except kg.KnowledgeGraphSchemaError as exc:
        results.put(("conflict", str(exc)))
    except BaseException:
        results.put(("error", traceback.format_exc()))
        raise


@pytest.mark.parametrize("changes, expected", [({}, ["ok", "ok"]),
    ({"pattern_id": "distinct"}, ["ok", "ok"]), ({"confidence": 0.6}, ["conflict", "ok"])])
def test_two_process_replay(tmp_path, signer, changes, expected) -> None:
    ensure_tools_dir(tmp_path / "aria-tools")
    ctx = multiprocessing.get_context("spawn")
    barrier, results = ctx.Barrier(3), ctx.Queue()
    children = [ctx.Process(target=_child_record, args=(tmp_path, signer, item, barrier, results)) for item in ({}, changes)]
    try:
        for child in children:
            child.start()
        barrier.wait(timeout=15)
        for child in children:
            child.join(timeout=20)
        assert all(not child.is_alive() for child in children)
        outcomes = [results.get(timeout=3) for _ in children]
        assert all(child.exitcode == 0 for child in children), outcomes
        assert sorted(item[0] for item in outcomes) == expected, outcomes
    finally:
        for child in children:
            if child.is_alive():
                child.terminate()
                child.join(timeout=5)
        results.close()
        results.join_thread()
    path = tmp_path / "aria-tools/knowledge-graph/conventions.jsonl"
    count = 2 if "pattern_id" in changes else 1
    assert len(read_jsonl(path)) == count
    assert kg.verify_chain_or_quarantine(path) == (True, count)
    assert verify_jsonl(path)["valid"]


def test_real_memory_hook_audit_failure_retry() -> None:
    from tests.invariants.v3_1.test_phase_v31_c2_memory_hook_wire import MemoryHookImplBehavioralTests
    from aria_kernel.cycle_phases import MemoryHookImpl
    from aria_kernel import tool_registry
    fixture = MemoryHookImplBehavioralTests()
    fixture.setUp()
    try:
        fixture._converge("audit-retry")
        key = mint_signing_key(cycle_id="audit-retry", workspace_root=fixture.tmp)
        args = dict(cycle_id="audit-retry", plan_id="audit-retry", workspace_root=fixture.tmp,
                    base_dir=fixture.base, plan_envelope_metadata={}, profile="standard", signer_key_fp=key.fingerprint)
        original = tool_registry.append_tools_governance
        def fail_success(base, kind, details, **kwargs) -> dict:
            if kind == "convention_recorded":
                raise OSError("fixture audit failure")
            return original(base, kind, details, **kwargs)
        with patch.object(tool_registry, "append_tools_governance", side_effect=fail_success):
            first = MemoryHookImpl().record(**args)
        assert first["status"] == "convention_audit_failed"
        assert first["convention_recorded"] is True
        assert first["chain_verified"] is True
        path = fixture.base / "knowledge-graph/conventions.jsonl"
        before = path.read_bytes()
        second = MemoryHookImpl().record(**args)
        assert second["status"] == "memory_hook_recorded"
        assert second["chain_verified"] is True
        assert path.read_bytes() == before
        assert len(read_jsonl(path)) == 1
    finally:
        revoke_signing_key(cycle_id="audit-retry", workspace_root=fixture.tmp)
        fixture.tearDown()


@pytest.mark.parametrize("damage", ["outer", "transport"])
def test_replay_retry_verifies_envelope(tmp_path, signer, damage) -> None:
    from aria_kernel.ledger import _record_hash

    loser_root = tmp_path / "loser"
    loser = record(loser_root, signer)
    path = ensure_tools_dir(tmp_path / "aria-tools") / "knowledge-graph/conventions.jsonl"
    replay_append_only_suffixes(surfaces={"kg_conventions": {
        "winner_path": path, "loser_path": loser,
        "base_row_count": 0, "base_tail_hash": None,
    }}, replay_transaction_id="envelope-integrity")
    row = json.loads(path.read_text())
    if damage == "outer":
        row["ledger_hash"] = "sha256:broken"
    else:
        # A valid outer hash must not excuse a wrong transport surface.
        row["surface"] = "cycles"
        row["ledger_hash"] = _record_hash(row, None)
    path.write_text(json.dumps(row) + "\n")
    before = path.read_bytes()
    with pytest.raises(kg.KnowledgeGraphTamper):
        record(tmp_path, signer)
    assert path.read_bytes() == before


@pytest.mark.parametrize("already_promoted", [False, True])
@pytest.mark.parametrize("damage", ["native", "outer", "schema"])
def test_promotion_checks_history_before_append_or_noop(tmp_path, signer, damage, already_promoted) -> None:
    path = record(tmp_path, signer)
    if already_promoted:
        kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
    if damage == "schema":
        kg._append_row(path, asdict(observation(schema_version=2)))
    else:
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[-1]["prev_row_hash" if damage == "native" else "ledger_hash"] = "sha256:broken"
        if damage == "native":
            from aria_kernel.ledger import _record_hash
            rows[-1]["ledger_hash"] = _record_hash(
                rows[-1], rows[-2]["ledger_hash"] if len(rows) > 1 else None,
            )
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    before = path.read_bytes()
    with pytest.raises((kg.KnowledgeGraphTamper, kg.KnowledgeGraphSchemaError)):
        kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
    assert path.read_bytes() == before
    assert not list(path.parent.glob("*.quarantined.*"))


def _child_probe_promotion_lock(path, ready, result) -> None:
    from aria_kernel.ledger import state_transaction
    try:
        if not ready.wait(timeout=20):
            raise TimeoutError("promotion read was not reached")
        try:
            with state_transaction([path], timeout_seconds=0.3):
                result.put("acquired")
        except TimeoutError:
            result.put("excluded")
    except BaseException:
        result.put(traceback.format_exc())
        raise


@pytest.mark.parametrize("already_promoted", [False, True])
def test_promotion_serializes_the_success_lookup(tmp_path, signer, already_promoted) -> None:
    path = record(tmp_path, signer)
    if already_promoted:
        kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
    ctx = multiprocessing.get_context("spawn")
    ready, result = ctx.Event(), ctx.Queue()
    probe = ctx.Process(target=_child_probe_promotion_lock, args=(path, ready, result))
    read = kg._read_jsonl_strict
    observed = []

    def read_with_probe(target):
        rows = list(read(target))
        if not observed:
            ready.set()
            observed.append(result.get(timeout=20))
        yield from rows

    try:
        probe.start()
        with patch.object(kg, "_read_jsonl_strict", side_effect=read_with_probe):
            kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
        probe.join(timeout=5)
        assert probe.exitcode == 0
        assert observed == ["excluded"], "promotion read escaped the canonical transaction"
    finally:
        if probe.is_alive():
            probe.terminate()
            probe.join(timeout=5)
        result.close()
        result.join_thread()


@pytest.mark.parametrize("with_workspace", [False, True])
def test_explicit_tools_root_wins_over_workspace_environment_and_cwd(tmp_path, signer, monkeypatch, with_workspace) -> None:
    tools = ensure_tools_dir(tmp_path / "store/tools")
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    cwd = tmp_path / "unrelated-cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    ambient = tmp_path / "ambient/tools"
    monkeypatch.setenv("ARIA_TOOLS_DIR", str(ambient))
    roots = {"base_dir": tools}
    if with_workspace:
        roots["workspace_root"] = checkout

    path = kg.record_convention(observation(), signer_key_fp=signer, **roots)
    assert path == tools / "knowledge-graph/conventions.jsonl"
    assert kg.lookup_pattern("observation", min_confidence=0.5, **roots)["plan_id"] == "plan"
    first = kg.reconcile_convention_promotion(plan_id="plan", **roots)
    assert first["status"] == "promoted"
    before = path.read_bytes()
    assert kg.promote_convention_for_plan(plan_id="plan", **roots) is None
    assert path.read_bytes() == before
    assert [r["pattern_id"] for r in kg.conventions_for_paths(paths=["fixture/a.py"], **roots)] == ["observation-verified"]
    assert kg.lookup_pattern("observation-verified", **roots)["outcome_status"] == "verified"
    assert not ambient.exists()
    for shadow in (checkout / "aria-tools", tools.parent / "aria-tools", cwd / "aria-tools"):
        assert not shadow.exists()


def test_legacy_workspace_root_ignores_unrelated_environment(tmp_path, signer, monkeypatch) -> None:
    workspace = tmp_path / "legacy-checkout"
    ambient = tmp_path / "ambient/tools"
    monkeypatch.setenv("ARIA_TOOLS_DIR", str(ambient))
    path = record(workspace, signer)
    assert path == workspace / "aria-tools/knowledge-graph/conventions.jsonl"
    assert kg.lookup_pattern("observation", workspace_root=workspace, min_confidence=0.5)
    assert kg.promote_convention_for_plan(plan_id="plan", workspace_root=workspace)["outcome_status"] == "verified"
    assert kg.reconcile_convention_promotion(plan_id="plan", workspace_root=workspace)["status"] == "already_verified"
    assert len(kg.conventions_for_paths(workspace_root=workspace, paths=["fixture/a.py"])) == 1
    assert not ambient.exists()


def test_explicit_root_reads_do_not_create_state(tmp_path) -> None:
    tools = tmp_path / "absent-store/tools"
    assert kg.lookup_pattern("missing", base_dir=tools) is None
    assert kg.conventions_for_paths(base_dir=tools, paths=["fixture/a.py"]) == []
    assert kg.anti_patterns_for_paths(base_dir=tools, paths=["fixture/a.py"]) == []
    assert kg.reconcile_convention_promotion(plan_id="missing", base_dir=tools) == {"status": "no_hypothesis"}
    assert kg.promote_convention_for_plan(plan_id="missing", base_dir=tools) is None
    assert not tools.exists()


@pytest.mark.parametrize("configured", [False, True])
def test_omitted_roots_use_the_existing_resolver(tmp_path, signer, monkeypatch, configured) -> None:
    from aria_kernel.tool_registry import GovernanceError

    cwd = tmp_path / "isolated"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    tools = tmp_path / "store/tools"
    if configured:
        monkeypatch.setenv("ARIA_TOOLS_DIR", str(tools))
        assert kg.record_convention(observation(), signer_key_fp=signer) == tools / "knowledge-graph/conventions.jsonl"
        assert kg.lookup_pattern("observation", min_confidence=0.5)["plan_id"] == "plan"
    else:
        monkeypatch.delenv("ARIA_TOOLS_DIR", raising=False)
        with pytest.raises(GovernanceError, match="tools_root_unresolvable"):
            kg.record_convention(observation(), signer_key_fp=signer)
        assert not tools.exists()
    assert not (cwd / "aria-tools").exists()


def test_recorded_convention_lookup_missing_history_does_not_create_state(tmp_path) -> None:
    tools = tmp_path / "absent-store/tools"
    assert kg._has_recorded_convention(observation(), base_dir=tools) is False
    assert not tools.exists()


def test_recorded_convention_lookup_exact_retry_uses_explicit_root(tmp_path, signer) -> None:
    tools = tmp_path / "store/tools"
    checkout = tmp_path / "checkout"
    path = kg.record_convention(observation(), base_dir=tools, signer_key_fp=signer)
    before = path.read_bytes()

    assert kg._has_recorded_convention(
        observation(observed_at="2026-09-11T00:00:00Z", signer_key_fp="SHA256:later-owner"),
        base_dir=tools, workspace_root=checkout,
    ) is True
    assert kg._has_recorded_convention(
        observation(pattern_id="not-recorded"), base_dir=tools,
    ) is False
    assert path.read_bytes() == before
    assert not (checkout / "aria-tools").exists()


@pytest.mark.parametrize("changes", [
    {"pattern_type": "other"}, {"confidence": 0.6},
    {"evidence_refs": ("fixture/b.py:2", "fixture/a.py:1")},
    {"evidence_refs": ("fixture/c.py:1",)}, {"discovered_by_cycle_id": "other"},
    {"plan_id": "other"}, {"outcome_status": "verified"}, {"supersedes_pattern_id": "prior"},
])
def test_recorded_convention_lookup_rejects_any_conflicting_history(tmp_path, signer, changes) -> None:
    path = record(tmp_path, signer)
    # A matching first and last row must not hide a conflicting middle row.
    kg._append_row(path, {**asdict(observation(**changes)), "signer_key_fp": signer})
    kg._append_row(path, {**asdict(observation()), "signer_key_fp": signer})
    before = path.read_bytes()

    with pytest.raises(kg.KnowledgeGraphObservationConflict, match="observation conflict"):
        kg._has_recorded_convention(observation(), workspace_root=tmp_path)
    assert path.read_bytes() == before
    assert not list(path.parent.glob("*.quarantined.*"))


@pytest.mark.parametrize("damage", ["native", "outer", "schema"])
def test_recorded_convention_lookup_verifies_entire_history_before_match(tmp_path, signer, damage) -> None:
    path = record(tmp_path, signer)
    if damage == "schema":
        kg._append_row(path, asdict(observation(pattern_id="unrelated", schema_version=2)))
    else:
        record(tmp_path, signer, observation(pattern_id="unrelated"))
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[-1]["prev_row_hash" if damage == "native" else "ledger_hash"] = "sha256:broken"
        if damage == "native":
            from aria_kernel.ledger import _record_hash
            rows[-1]["ledger_hash"] = _record_hash(rows[-1], rows[-2]["ledger_hash"])
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    before = path.read_bytes()

    with pytest.raises((kg.KnowledgeGraphTamper, kg.KnowledgeGraphSchemaError)):
        kg._has_recorded_convention(observation(), workspace_root=tmp_path)
    assert path.read_bytes() == before
    assert not list(path.parent.glob("*.quarantined.*"))


@pytest.mark.parametrize("later_status", ["verified", "refuted"])
def test_recorded_convention_lookup_retains_superseded_original(tmp_path, signer, later_status) -> None:
    path = record(tmp_path, signer)
    promoted = kg.promote_convention_for_plan(plan_id="plan", workspace_root=tmp_path)
    assert promoted["pattern_id"] == "observation-verified"
    if later_status == "refuted":
        record(tmp_path, signer, observation(
            pattern_id="observation-refuted", outcome_status="refuted",
            supersedes_pattern_id=promoted["pattern_id"], confidence=0.1,
        ))
    before = path.read_bytes()

    assert kg._has_recorded_convention(observation(), workspace_root=tmp_path) is True
    assert path.read_bytes() == before
    assert read_jsonl(path)[-1]["outcome_status"] == later_status
