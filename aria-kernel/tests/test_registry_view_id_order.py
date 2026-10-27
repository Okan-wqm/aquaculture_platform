"""REG-ID — the kernel's registry view lists findings in the registry's order of ids: the sequence as a number.

WHY. The view (``report_ingestion.read_registry_view``) is the registry CLI's
projection, and the projection reads the per-finding event store in the order of
ids, not of paths. A path order puts ``ARIA-LOW-1000`` before ``ARIA-LOW-999``
(``1`` sorts before ``9``), so once the first four-digit finding was stored the
view's order and the order a path listing of the store gives parted ways. The
kernel's one assertion of the order (``test_the_live_registry_reads_through_the_view``)
compared the view to a path listing, so it measured the store layout and not the
order the registry promises; the ids it was checked against all had three digits
until REG-ID.

WHAT this module pins, on a repository built for the purpose rather than the live
store (whose order would move under the pin with every finding registered):

  * born findings (one event log each, after the frozen genesis segment) read
    through the view in the owner's order, ``finding_id_sort_key``: domain,
    classifier, then the sequence as a number: 999, 1000, 1001, whichever order
    the logs were created in;
  * the fixture discriminates: its expected order is not the order of the paths,
    so a view that fell back to the path order is red here and green nowhere else.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: the fixture copies the registry CLI's input
# set from the live checkout (outside the kernel surface), so this module runs in
# aria-kernel.yml's always-run `workspace` job, never in a skippable shard.
READS_LIVE_CHECKOUT = 'the registry CLI and its data under tools/gates and docs/reviews/_registry/'

import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

from aria_kernel.finding_id_grammar import finding_id_sort_key
from aria_kernel.report_ingestion import read_registry_view
from tests.test_report_ingestion_registry_view import _TS_NODE, _ProjectionRepo, _canonical, _chained, _registry_row

_REPO_ROOT = Path(__file__).resolve().parents[2]
_STORE = "docs/reviews/_registry/findings"
_GENESIS_IDS = ("ARIA-LOW-998",)
# Born after the freeze, written to the store one event log each. Three digits
# and four, two severities, two domains: every pair the numeric order and the
# path order disagree on is in here.
_BORN_IDS = (
    "ARIA-LOW-999",
    "ARIA-LOW-1000",
    "ARIA-LOW-1001",
    "ARIA-HIGH-1000",
    "ARIA-HIGH-999",
    "PROC-LOW-100",
    "PROC-LOW-1000",
)


def _created_event(finding_id: str, anchor: str) -> str:
    """One CREATED event line (MF-DESIGN §4.1): the row body without its chain fields, chained to ``anchor``."""
    body = {key: value for key, value in _registry_row(finding_id).items() if key not in ("prev_hash", "content_hash")}
    event: dict[str, Any] = {
        "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{finding_id}:1:{anchor}")),
        "finding_id": finding_id,
        "version": 1,
        "event_type": "CREATED",
        "payload": body,
        "actor": "Okan-wqm",
        "reason": None,
        "occurred_at": "2026-10-25T00:00:00.000Z",
        "prev_hash": anchor,
    }
    event["content_hash"] = hashlib.sha256(_canonical(event).encode("utf-8")).hexdigest()
    return json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"


def _store_path(finding_id: str) -> str:
    return f"{_STORE}/{finding_id.split('-')[0]}/{finding_id}.jsonl"


@unittest.skipUnless((_REPO_ROOT / _TS_NODE).is_file(), "the repository's ts-node is not installed in this checkout")
class TheViewKeepsTheRegistrysOrderOfIds(unittest.TestCase):
    def _view_ids(self, creation_order: tuple[str, ...]) -> list[str]:
        """The ids the view lists for a repository whose born findings were created in ``creation_order``."""
        with tempfile.TemporaryDirectory(prefix="aria-registry-order-") as tmp:
            repo = _ProjectionRepo(Path(tmp) / "repo")
            genesis = [_registry_row(finding_id) for finding_id in _GENESIS_IDS]
            repo.write_registry(genesis)
            tip = json.loads(_chained(genesis).splitlines()[-1])["content_hash"]
            repo.commit("chore(registry): the frozen genesis segment", "2026-10-01T10:00:00Z")
            for day, finding_id in enumerate(creation_order, start=2):
                repo.write(_store_path(finding_id), _created_event(finding_id, tip))
                repo.commit(f"chore(registry): create {finding_id}", f"2026-10-{day:02d}T10:00:00Z")
            return [row["id"] for row in read_registry_view(repo.root).rows]

    def test_the_fixture_is_one_the_path_order_gets_wrong(self) -> None:
        by_path = sorted(_BORN_IDS, key=_store_path)
        by_number = sorted(_BORN_IDS, key=finding_id_sort_key)
        self.assertNotEqual(by_path, by_number)
        self.assertLess(by_path.index("ARIA-LOW-1000"), by_path.index("ARIA-LOW-999"))
        self.assertLess(by_number.index("ARIA-LOW-999"), by_number.index("ARIA-LOW-1000"))

    def test_born_findings_read_in_the_owners_numeric_order_whichever_order_they_were_created_in(self) -> None:
        ascending = tuple(sorted(_BORN_IDS, key=finding_id_sort_key))
        expected = [*_GENESIS_IDS, *ascending]
        for label, creation_order in (("ascending", ascending), ("descending", tuple(reversed(ascending)))):
            with self.subTest(created=label):
                self.assertEqual(self._view_ids(creation_order), expected)


if __name__ == "__main__":
    unittest.main()
