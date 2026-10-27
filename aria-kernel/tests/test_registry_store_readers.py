"""MF-2 conformance audit R14b — a kernel reader of the registry reads the whole store.

WHY. MF-2 moved every change after the freeze out of ``findings.jsonl`` into one
event log per finding (``docs/reviews/_registry/findings/<PREFIX>/<ID>.jsonl``).
The frozen file is the genesis segment only: a finding born after the freeze is
not in it, and a legacy finding whose title, owner or evidence was amended
reads differently once its log is folded in. The SPEC says to update every
caller in the same package, and three kernel readers still treat the frozen
file as the registry:

  * ``system_one._finding`` reads ``findings.jsonl`` at the public ref and
    refuses every finding born after the freeze as ``finding_not_registered``;
    for an amended legacy finding it returns the genesis title (ARIA-MEDIUM-962).
  * ``report_ingestion.read_registry_view`` reads through the projection, but
    stamps every row with ``findings.jsonl`` as its source, so a finding the
    view ingests cites a file that does not hold it (ARIA-MEDIUM-962).
  * the autonomy closure verdict pins and chain-verifies the frozen blob only:
    the event logs the closure projection folds are never verified, and the
    evidence ref is the same string for every state of the store
    (ARIA-MEDIUM-985).

WHAT these tests pin, each on a real git repository that carries the registry
CLI and a store with one finding born after the freeze, one legacy finding
amended, and the genesis pin:

  * ``_finding`` returns the folded row's title and rule for the born finding
    and for the amended one, and still returns a legacy finding unchanged;
  * the view's entry for a born finding names the file that holds it;
  * the autonomy closure's registry predicate is false when an event log at the
    evidence commit does not chain, or the genesis pin does not match the blob,
    holds on a store that verifies, and its evidence ref names the git tree of
    ``docs/reviews/_registry`` at the evidence commit.

Each store is first judged by the registry's own ``verify`` (the premise), so a
red here is the reader's, not the fixture's.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: the fixtures copy the registry CLI and its
# data out of the live checkout, so this module runs in aria-kernel.yml's
# always-run `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = (
    "the registry CLI (tools/gates), its event schema and CODEOWNERS, copied from the live checkout "
    "into each fixture repository"
)

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

import aria_kernel.autonomy_closure as closure_module
from aria_kernel import system_one
from aria_kernel.autonomy_closure import derive_autonomy_closure_verdict
from aria_kernel.report_ingestion import read_registry_view
from aria_kernel.system_one import StateRef
from tests._helpers.witness_sources import REGISTRY_CLI_DATA, registry_cli_tool_paths
from tests.test_autonomy_closure import ClosureHistory, _git, _status
from tests.test_report_ingestion_registry_view import _ProjectionRepo, _canonical, _chained, _registry_row

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_NODE = Path("node_modules/.bin/ts-node")
_REGISTRY_DIR = "docs/reviews/_registry"
_GENESIS_BLOB = f"{_REGISTRY_DIR}/findings.jsonl"
_GENESIS_PIN = f"{_REGISTRY_DIR}/genesis.json"
# What the CLI's `verify` reads beyond what the projection needs: the event
# contract, and CODEOWNERS for the owner spelling of an event's row.
_VERIFY_DATA = (f"{_REGISTRY_DIR}/finding-event.schema.json", ".github/CODEOWNERS")
_ALIASES = f"{_REGISTRY_DIR}/finding-id-aliases.yaml"
_NO_ALIASES = "version: 1\n\naliases: []\n"
_ZERO_HASH = "0" * 64
_RULE = "Use getScopedRepository"
_GENESIS_TITLE = "genesis title of the amended finding"
_AMENDED_TITLE = "title the AMENDED event wrote"
_BORN_TITLE = "a finding born after the freeze"

_needs_node = unittest.skipUnless((_REPO_ROOT / _TS_NODE).is_file(), "the repository's ts-node is not installed in this checkout")


def _event_log_path(finding_id: str) -> str:
    return f"{_REGISTRY_DIR}/findings/{finding_id.split('-')[0]}/{finding_id}.jsonl"


def _event(finding_id: str, version: int, event_type: str, payload: dict[str, Any], prev_hash: str,
           reason: str | None) -> dict[str, Any]:
    """One event line in the format finding-event.schema.json fixes (MF-DESIGN §4.2, §4.3)."""
    body: dict[str, Any] = {
        "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{finding_id}:{version}")),
        "finding_id": finding_id, "version": version, "event_type": event_type, "payload": payload,
        "actor": "Okan-wqm", "reason": reason, "occurred_at": "2026-10-25T00:00:00Z", "prev_hash": prev_hash,
    }
    body["content_hash"] = hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()
    return body


def write_store(
    write: Callable[[str, str], None], rows: list[dict[str, Any]], *,
    amended: dict[str, str], born: list[dict[str, Any]], break_log_of: str | None = None,
    stale_pin: bool = False,
) -> None:
    """The frozen segment, its pin, and the event logs: ``amended`` retitles legacy findings, ``born`` creates new ones.

    ``break_log_of`` names a finding whose log carries a content hash its line does not match; ``stale_pin``
    writes a pin whose blob hash is not the segment's. Either makes the registry's own ``verify`` fail.
    """
    text = _chained(rows)
    write(_GENESIS_BLOB, text)
    chained = [json.loads(line) for line in text.splitlines()]
    tip = chained[-1]["content_hash"] if chained else _ZERO_HASH
    pin = {
        "path": _GENESIS_BLOB,
        "blob_sha256": ("0" * 64) if stale_pin else hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "entries": len(chained), "tip_content_hash": tip,
    }
    write(_GENESIS_PIN, json.dumps(pin, indent=2) + "\n")
    by_id = {row["id"]: row for row in chained}
    logs: dict[str, dict[str, Any]] = {}
    for finding_id, title in amended.items():
        logs[finding_id] = _event(
            finding_id, 1, "AMENDED", {"fields": {"title": title}}, by_id[finding_id]["content_hash"],
            "the title named the wrong problem",
        )
    for row in born:
        payload = {key: value for key, value in row.items() if key not in ("prev_hash", "content_hash")}
        logs[row["id"]] = _event(row["id"], 1, "CREATED", payload, tip, None)
    for finding_id, line in logs.items():
        if finding_id == break_log_of:
            line = {**line, "content_hash": _ZERO_HASH}
        write(_event_log_path(finding_id), json.dumps(line) + "\n")


def run_registry_cli(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """The fixture's own registry CLI, run from the fixture."""
    return subprocess.run(
        [str(root / _TS_NODE), "--project", "tools/gates/tsconfig.json", "tools/gates/finding-registry.ts", *args],
        cwd=root, check=False, capture_output=True, text=True, timeout=300,
    )


def copy_registry_cli(root: Path) -> None:
    """The CLI, its tsconfig, its data files and the verifier's data, and a link to this checkout's node_modules."""
    for rel in (*registry_cli_tool_paths(), *REGISTRY_CLI_DATA, *_VERIFY_DATA):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_REPO_ROOT / rel, root / rel)
    if not (root / "node_modules").exists():
        (root / "node_modules").symlink_to(_REPO_ROOT / "node_modules", target_is_directory=True)
    # The fixture's own sidecar: the copied live one names commits this repository does not hold.
    (root / _ALIASES).write_text(_NO_ALIASES, encoding="utf-8")


def _rows(*finding_ids: str) -> list[dict[str, Any]]:
    return [
        _registry_row(
            finding_id, title=_GENESIS_TITLE if finding_id == _AMENDED_ID else f"legacy finding {finding_id}",
            rule_violated=_RULE,
        )
        for finding_id in finding_ids
    ]


_AMENDED_ID = "ARIA-HIGH-901"
_UNCHANGED_ID = "ARIA-HIGH-902"
_BORN_ID = "ARIA-HIGH-905"


class _StoreRepo(_ProjectionRepo):
    """A repository the registry CLI runs in, holding a frozen segment, its pin and the event logs."""

    def __init__(self, root: Path, **store: Any) -> None:
        super().__init__(root)
        for rel in _VERIFY_DATA:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_REPO_ROOT / rel, root / rel)
        born = _registry_row(
            _BORN_ID, title=_BORN_TITLE, rule_violated=_RULE, evidence=["tools/gates/finding-registry.ts:1"],
        )
        write_store(
            self.write, _rows(_AMENDED_ID, _UNCHANGED_ID), amended={_AMENDED_ID: _AMENDED_TITLE},
            born=[born], **store,
        )
        self.commit("chore(registry): freeze the segment and record two findings' history", "2026-10-02T10:00:00Z")


@_needs_node
class RegistryStoreFixtureTests(unittest.TestCase):
    """The premise of every test below: the fixture store verifies, and each broken variant does not."""

    def test_the_store_the_readers_are_judged_on_verifies_and_the_broken_variants_do_not(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-store-readers-") as tmp:
            healthy = _StoreRepo(Path(tmp) / "healthy")
            self.assertEqual(run_registry_cli(healthy.root, "verify").returncode, 0)
            chain = _StoreRepo(Path(tmp) / "chain", break_log_of=_BORN_ID)
            self.assertEqual(run_registry_cli(chain.root, "verify").returncode, 1)
            pin = _StoreRepo(Path(tmp) / "pin", stale_pin=True)
            self.assertEqual(run_registry_cli(pin.root, "verify").returncode, 1)


@_needs_node
class SystemOneReadsTheWholeStoreTests(unittest.TestCase):
    """ARIA-MEDIUM-962: ``_finding`` asks the registry's owner, not the frozen file."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-system-one-store-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = _StoreRepo(Path(self.tmp.name) / "repo")
        # "Public" is what the pinned remote publishes; the reader never consults the working tree.
        self.repo.git("update-ref", system_one.PUBLIC_REGISTRY_REF, "HEAD")

    def finding(self, finding_id: str) -> Any:
        try:
            return system_one._finding(self.repo.root, StateRef(finding_id=finding_id))
        except system_one._Refusal as refusal:
            return f"refused:{refusal.reason}"

    def test_a_finding_born_after_the_freeze_is_registered(self) -> None:
        self.assertEqual(self.finding(_BORN_ID), {"finding": _BORN_TITLE, "rule": _RULE})

    def test_an_amended_legacy_finding_reads_with_its_amended_title(self) -> None:
        self.assertEqual(self.finding(_AMENDED_ID), {"finding": _AMENDED_TITLE, "rule": _RULE})

    def test_a_legacy_finding_nothing_amended_reads_as_the_genesis_row_holds_it(self) -> None:
        self.assertEqual(self.finding(_UNCHANGED_ID), {"finding": f"legacy finding {_UNCHANGED_ID}", "rule": _RULE})

    def test_a_finding_in_neither_the_segment_nor_the_store_is_still_refused(self) -> None:
        self.assertEqual(self.finding("ARIA-HIGH-999"), "refused:finding_not_registered")


@_needs_node
class RegistryViewNamesTheFileThatHoldsTheFindingTests(unittest.TestCase):
    """ARIA-MEDIUM-962: an ingested finding cites the file its row came from."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-view-source-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = _StoreRepo(Path(self.tmp.name) / "repo")
        self.entries = {entry.row["id"]: entry for entry in read_registry_view(self.repo.root).entries}

    def test_the_view_reads_the_born_finding(self) -> None:
        self.assertEqual(self.entries[_BORN_ID].row["title"], _BORN_TITLE)
        self.assertEqual(self.entries[_AMENDED_ID].row["title"], _AMENDED_TITLE)

    def test_a_born_finding_s_source_is_a_file_that_holds_it(self) -> None:
        source = self.entries[_BORN_ID].source
        self.assertNotEqual(source, _GENESIS_BLOB)
        self.assertIn(_BORN_ID, (self.repo.root / source).read_text(encoding="utf-8"))

    def test_an_amended_legacy_finding_s_source_is_its_event_log(self) -> None:
        source = self.entries[_AMENDED_ID].source
        self.assertEqual(source, _event_log_path(_AMENDED_ID))
        self.assertIn(_AMENDED_ID, (self.repo.root / source).read_text(encoding="utf-8"))

    def test_a_finding_only_the_frozen_segment_holds_keeps_the_segment_as_its_source(self) -> None:
        self.assertEqual(self.entries[_UNCHANGED_ID].source, _GENESIS_BLOB)


class _StoreClosureHistory(ClosureHistory):
    """The closure plan's history (fix -> evidence target -> report = origin/main) over a registry store.

    The evidence target's tree carries the registry CLI, the frozen segment (one row per policy finding), its
    pin, and one AMENDED event log on the first of them.
    """

    break_log = False
    stale_pin = False

    def write(self, relative: str, text: str) -> None:
        self._install_cli()
        super().write(relative, text)

    def _install_cli(self) -> None:
        if (self.repo / "node_modules").exists():
            return
        (self.repo / ".gitignore").write_text("node_modules\n", encoding="utf-8")
        copy_registry_cli(self.repo)

    def write_registry(self, mutate: Any, closing_commit: str | None = None) -> None:
        ids = [str(entry["finding_id"]) for entry in self.policy["entries"]]
        rows = [_registry_row(finding_id, rule_violated=_RULE) for finding_id in ids]
        write_store(
            self.write, rows, amended={ids[0]: _AMENDED_TITLE}, born=[],
            break_log_of=ids[0] if self.break_log else None, stale_pin=self.stale_pin,
        )


class _BrokenLogHistory(_StoreClosureHistory):
    break_log = True


class _StalePinHistory(_StoreClosureHistory):
    stale_pin = True


@_needs_node
class AutonomyClosureVerifiesTheWholeStoreTests(unittest.TestCase):
    """ARIA-MEDIUM-985: the registry predicate claims no more than it checks."""

    PREDICATE = "registry_chain_valid_at_evidence_target"

    def predicate(self, history_type: type[_StoreClosureHistory]) -> tuple[_StoreClosureHistory, dict[str, Any]]:
        directory = tempfile.TemporaryDirectory(prefix="aria-closure-store-")
        self.addCleanup(directory.cleanup)
        history = history_type(Path(directory.name))
        with mock.patch.object(
            closure_module, "derive_autonomy_evidence_status", return_value=_status(history.evidence),
        ):
            result = derive_autonomy_closure_verdict(
                report_commit_sha=history.report, evidence_target_sha=history.evidence,
                repo_root=history.repo, base_dir=Path(directory.name) / "tools",
            ).to_dict()
        (found,) = [item for item in result["predicates"] if item["name"] == self.PREDICATE]
        return history, found

    def test_the_premise_the_fixture_store_verifies_and_the_broken_ones_do_not(self) -> None:
        for history_type, expected in ((_StoreClosureHistory, 0), (_BrokenLogHistory, 1), (_StalePinHistory, 1)):
            with self.subTest(history=history_type.__name__):
                directory = tempfile.TemporaryDirectory(prefix="aria-closure-premise-")
                self.addCleanup(directory.cleanup)
                history = history_type(Path(directory.name))
                self.assertEqual(run_registry_cli(history.repo, "verify").returncode, expected)

    def test_a_store_that_verifies_at_the_evidence_commit_passes(self) -> None:
        _history, predicate = self.predicate(_StoreClosureHistory)
        self.assertEqual((predicate["passed"], predicate["reasons"]), (True, []))

    def test_an_event_log_that_does_not_chain_at_the_evidence_commit_fails_the_predicate(self) -> None:
        _history, predicate = self.predicate(_BrokenLogHistory)
        self.assertFalse(predicate["passed"], predicate)

    def test_a_genesis_pin_that_does_not_match_the_segment_at_the_evidence_commit_fails_the_predicate(self) -> None:
        _history, predicate = self.predicate(_StalePinHistory)
        self.assertFalse(predicate["passed"], predicate)

    def test_the_evidence_ref_names_the_registry_tree_at_the_evidence_commit(self) -> None:
        history, predicate = self.predicate(_StoreClosureHistory)
        tree = _git(history.repo, "rev-parse", f"{history.evidence}:{_REGISTRY_DIR}")
        self.assertTrue(
            any(tree in ref for ref in predicate["evidence_refs"]),
            f"no evidence ref names the {_REGISTRY_DIR} tree {tree}: {predicate['evidence_refs']}",
        )


if __name__ == "__main__":
    unittest.main()
