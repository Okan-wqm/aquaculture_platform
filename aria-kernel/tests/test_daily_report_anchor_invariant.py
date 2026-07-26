"""Plan ARIA-V2 §3.9 + I-26 — committed daily-anchor invariants.

After Phase 5 gitignored per-clone runtime ledgers, the daily
``aria-tools/reports/daily/YYYY-MM-DD.md`` file is the load-bearing
audit-trust source. The bot writes it via
``aria-kernel report daily --emit-anchor`` (Plan ARIA-V2 §3.9).

Three invariants locked here:

  1. Every committed daily-anchor file that ships Plan ARIA-V2
     frontmatter has a parseable YAML block (no malformed YAML
     can slip into the audit trail).
  2. ``chain_tip_ledger_hash`` MAY be null only when
     ``events_emitted_count == 0`` — non-zero event count without a
     chain hash is a structurally inconsistent anchor.
  3. ``events_emitted_count`` cannot decrease day-over-day without
     a ``governance_chain_seam`` event recorded between the two
     anchors (kernel emits this event when a fresh clone resets the
     chain). Absent the seam event AND a decreasing count means the
     audit chain was silently truncated.

Pre-§3.9 stub anchors (no frontmatter) are LEGACY and exempt from
these invariants. The transition is naturally backward-compatible:
each new daily anchor opts in to the schema by emitting frontmatter.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[2]
_DAILY_DIR = _REPO_ROOT / "aria-tools" / "reports" / "daily"
_GOVERNANCE_PATH = _REPO_ROOT / "aria-tools" / "governance.jsonl"

if str(_REPO_ROOT / "aria-kernel") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))


def _has_frontmatter(text: str) -> bool:
    return text.startswith("---\n") and "\n---\n" in text


def _read_governance_seam_dates() -> set[str]:
    """Return YYYY-MM-DD dates on which a ``governance_chain_seam`` event
    was emitted (kernel-managed seam-markers when a fresh clone reset
    the chain). Absent file → empty set.
    """
    seams: set[str] = set()
    if not _GOVERNANCE_PATH.exists():
        return seams
    try:
        for line in _GOVERNANCE_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            if row.get("kind") == "governance_chain_seam":
                event_time = row.get("eventTime") or row.get("recorded_at") or ""
                if isinstance(event_time, str) and len(event_time) >= 10:
                    seams.add(event_time[:10])
    except OSError:
        pass
    return seams


def _anchors() -> list[tuple[Path, dict[str, Any]]]:
    """Return (path, parsed_frontmatter) for every committed anchor that
    has frontmatter. Legacy stubs without frontmatter are skipped.
    """
    from aria_kernel.report import parse_anchor_frontmatter

    out: list[tuple[Path, dict[str, Any]]] = []
    if not _DAILY_DIR.exists():
        return out
    for path in sorted(_DAILY_DIR.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not _has_frontmatter(text):
            continue
        parsed = parse_anchor_frontmatter(path)
        if parsed is not None:
            out.append((path, parsed))
    return out


class DailyAnchorInvariant(unittest.TestCase):
    def test_every_v2_anchor_parses_cleanly(self) -> None:
        violations: list[str] = []
        for path, anchor in _anchors():
            for key in ("date", "events_emitted_count"):
                if key not in anchor:
                    violations.append(f"{path}: missing required key {key!r}")
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_chain_tip_null_only_when_no_events(self) -> None:
        violations: list[str] = []
        for path, anchor in _anchors():
            count = anchor.get("events_emitted_count")
            tip = anchor.get("chain_tip_ledger_hash")
            if not isinstance(count, int):
                violations.append(f"{path}: events_emitted_count must be int; got {count!r}")
                continue
            if count > 0 and (tip is None or tip == ""):
                violations.append(
                    f"{path}: events_emitted_count={count} but chain_tip_ledger_hash is empty"
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    def test_event_count_monotonic_or_seam_explained(self) -> None:
        seam_dates = _read_governance_seam_dates()
        anchors = _anchors()
        violations: list[str] = []
        previous_count: int | None = None
        previous_date: str | None = None
        for path, anchor in anchors:
            count = anchor.get("events_emitted_count")
            date = anchor.get("date")
            if not isinstance(count, int) or not isinstance(date, str):
                continue
            if previous_count is not None and count < previous_count:
                # Decreasing event count is allowed only when a seam
                # event sits between previous_date and date.
                seam_present = any(
                    previous_date is not None and previous_date <= s <= date
                    for s in seam_dates
                )
                if not seam_present:
                    violations.append(
                        f"{path}: events_emitted_count {count} < previous {previous_count} "
                        f"({previous_date}) with no governance_chain_seam in between"
                    )
            previous_count = count
            previous_date = date
        self.assertEqual(violations, [], msg="\n".join(violations))


class DailyAnchorEmitSmoke(unittest.TestCase):
    """Plan ARIA-V2 I-26 supplementary — `aria-kernel report daily
    --emit-anchor` produces a file that the parser round-trips.
    """

    def test_emit_then_parse_roundtrip(self) -> None:
        import tempfile

        from aria_kernel.report import emit_anchor_to_path, parse_anchor_frontmatter

        with tempfile.TemporaryDirectory(prefix="aria-i26-") as tmp:
            tmp_path = Path(tmp)
            tools = tmp_path / "aria-tools"
            tools.mkdir()
            (tools / "governance.jsonl").write_text(
                '{"ledger_hash":"sha256:roundtrip","kind":"test"}\n',
                encoding="utf-8",
            )
            anchor_path = tmp_path / "anchor.md"
            result = emit_anchor_to_path(
                date="2026-05-15",
                workspace_root=tmp_path,
                tools_root=tools,
                output_path=anchor_path,
            )
            self.assertEqual(result["status"], "written")

            parsed = parse_anchor_frontmatter(anchor_path)
            self.assertIsNotNone(parsed)
            self.assertEqual(parsed["date"], "2026-05-15")
            self.assertEqual(parsed["chain_tip_ledger_hash"], "sha256:roundtrip")
            self.assertEqual(parsed["events_emitted_count"], 1)

            # Re-running with the same date is idempotent.
            again = emit_anchor_to_path(
                date="2026-05-15",
                workspace_root=tmp_path,
                tools_root=tools,
                output_path=anchor_path,
            )
            self.assertEqual(again["status"], "already_anchored")


class AnchorPathsAreStageable(unittest.TestCase):
    """ORPHAN-HIGH-434 — the anchor must be addable, not merely writable.

    `.gitignore` names this file as the thing that catches a revert of the
    `aria-tools/*` descent fix. That claim was false when it was written: this
    module globbed already-tracked files and never invoked git's ignore
    machinery, so reverting the pattern left it green while every anchor since
    2026-05-08 lived only inside an expiring CI artifact.

    These assertions are the positive half. `git check-ignore --no-index` is
    used so a path that does not exist yet is still evaluated against the rules
    — the question is whether the anchor COULD be staged, not whether one
    happens to be on disk.
    """

    _REPO_ROOT = Path(__file__).resolve().parents[2]

    def _is_ignored(self, rel_path: str) -> bool:
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "-q", "--", rel_path],
            cwd=self._REPO_ROOT, capture_output=True,
        )
        if result.returncode not in (0, 1):
            self.fail(
                f"git check-ignore failed for {rel_path!r}: rc={result.returncode} "
                f"{result.stderr.decode(errors='replace')[:200]}"
            )
        return result.returncode == 0

    def test_every_declared_tracked_entry_is_stageable(self) -> None:
        """The three entries `.gitignore` declares tracked must all work.

        Before the ancestor re-includes were added, only reports/daily/ did:
        `aria-tools/*` excludes the DIRECTORY `agent-evals`, so the negations
        nested under it could never fire, and repo_identity.json had no
        negation at all.
        """
        for rel_path in (
            "aria-tools/reports/daily/2099-01-01.md",
            "aria-tools/agent-evals/fixtures/F999_PROBE.json",
            "aria-tools/repo_identity.json",
        ):
            with self.subTest(path=rel_path):
                self.assertFalse(
                    self._is_ignored(rel_path),
                    msg=(
                        f"{rel_path} is ignored, but .gitignore declares it tracked. "
                        "git does not descend into an excluded directory, so every "
                        "ancestor needs its own re-include."
                    ),
                )

    def test_runtime_ledgers_remain_ignored(self) -> None:
        """Re-including ancestors must not un-ignore the runtime state."""
        for rel_path in (
            "aria-tools/runs.jsonl",
            "aria-tools/governance.jsonl",
            "aria-tools/reports/latest.md",
            "aria-tools/agent-evals/runs.jsonl",
            "aria-tools/agent-invocations/claims.jsonl",
            "aria-tools/memory/beliefs.jsonl",
        ):
            with self.subTest(path=rel_path):
                self.assertTrue(
                    self._is_ignored(rel_path),
                    msg=f"{rel_path} became trackable; the allowlist has widened",
                )


if __name__ == "__main__":
    unittest.main()
