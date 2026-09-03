"""Plan ARIA-V6 §3 V6.3 Phase 6.3 — adapter request seed invariants.

Three invariants pin the schema contract for operator-curated adapter
seeds without keeping historical ``aria-findings`` runtime state tracked:

  * I-V6.3-01 — seed schema validity (every row carries the
                required fields)
  * I-V6.3-02 — must_satisfy[] non-empty per seed
  * I-V6.3-03 — every seed declares a calibration_corpus_path
                (B-V5-1 + B-V2-2: sandbox cannot validate without a
                corpus, so a seed without one cannot reach
                authored_validated)

Historical seed files under ``aria-findings`` are not live authority.
Future seed inputs must be runtime/operator state or a new current owner
surface with its own invariant.
"""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]

_REQUIRED_FIELDS = {
    "seed_id", "title", "capability_gap_key",
    "claim_types", "declared_scope", "must_satisfy",
    "calibration_corpus_path", "adapter_lang",
}

_ALLOWED_ADAPTER_LANGS = {"typescript", "python"}
_ALLOWED_PRIORITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW"}


_SEED_CONTRACT_FIXTURE = "\n".join(
    json.dumps(
        {
            "seed_id": f"seed-{idx:02d}",
            "title": f"Adapter seed {idx}",
            "capability_gap_key": f"capability-{idx}",
            "claim_types": ["architecture"],
            "declared_scope": ["aria-kernel/**"],
            "must_satisfy": [
                {
                    "id": f"REQ-{idx:02d}",
                    "description": "Seed contract requirement",
                }
            ],
            "calibration_corpus_path": f"aria-kernel/tests/fixtures/seed-{idx:02d}.json",
            "adapter_lang": "python" if idx % 2 else "typescript",
            "priority": "HIGH",
        },
        sort_keys=True,
    )
    for idx in range(1, 10)
)


def _load_seed_rows(text: str = _SEED_CONTRACT_FIXTURE) -> list[dict]:
    rows = []
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise AssertionError(
                f"V6.3 seed fixture line {ln} is not valid JSON: {exc}"
            )
    return rows


class PhaseV6_3SeedsSchema(unittest.TestCase):
    def test_i_v6_3_00_historical_seed_file_not_tracked(self) -> None:
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(_REPO_ROOT),
                "ls-files",
                "aria-findings/F-012-adapter-seeds.jsonl",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.stdout.strip(), "")

    def test_i_v6_3_01_seed_schema_validity(self) -> None:
        """Plan ARIA-V6 §3 V6.3 — every seed row carries the
        required fields with the expected types."""
        rows = _load_seed_rows()
        self.assertGreaterEqual(
            len(rows), 9,
            msg=(
                "Plan ARIA-V6 §3 V6.3 — operator G1-G10 gap audit "
                "identified 9 priority adapters. Seed contract fixture MUST "
                f"carry ≥9 rows; got {len(rows)}"
            ),
        )
        seen_ids: set[str] = set()
        for idx, seed in enumerate(rows):
            missing = _REQUIRED_FIELDS - set(seed.keys())
            self.assertFalse(
                missing,
                msg=(
                    f"Seed row {idx} (seed_id={seed.get('seed_id')!r}) "
                    f"missing required fields: {sorted(missing)}"
                ),
            )
            self.assertIsInstance(seed["claim_types"], list,
                                  msg=f"seed[{idx}].claim_types must be a list")
            self.assertIsInstance(seed["declared_scope"], list,
                                  msg=f"seed[{idx}].declared_scope must be a list")
            self.assertIn(
                seed["adapter_lang"], _ALLOWED_ADAPTER_LANGS,
                msg=(
                    f"seed[{idx}].adapter_lang must be one of "
                    f"{sorted(_ALLOWED_ADAPTER_LANGS)}; got "
                    f"{seed['adapter_lang']!r}"
                ),
            )
            if "priority" in seed:
                self.assertIn(
                    seed["priority"], _ALLOWED_PRIORITIES,
                    msg=(
                        f"seed[{idx}].priority must be in "
                        f"{sorted(_ALLOWED_PRIORITIES)}; got "
                        f"{seed['priority']!r}"
                    ),
                )
            # Uniqueness of seed_id.
            self.assertNotIn(
                seed["seed_id"], seen_ids,
                msg=f"Duplicate seed_id: {seed['seed_id']!r}",
            )
            seen_ids.add(seed["seed_id"])

    def test_i_v6_3_02_must_satisfy_non_empty_per_seed(self) -> None:
        """Plan ARIA-V6 §3 V6.3 — every seed declares ≥1 must_satisfy
        contract item.

        Without must_satisfy, V6.2's authoring loop has no anchor for
        rule_class scope; primary drafter cannot derive what behaviour
        the adapter must enforce.
        """
        rows = _load_seed_rows()
        for idx, seed in enumerate(rows):
            ms = seed.get("must_satisfy") or []
            self.assertGreaterEqual(
                len(ms), 1,
                msg=(
                    f"Seed[{idx}] (seed_id={seed['seed_id']!r}) MUST "
                    "carry ≥1 must_satisfy item. V6.2 authoring loop "
                    "needs an anchor."
                ),
            )
            for j, item in enumerate(ms):
                self.assertIn(
                    "id", item,
                    msg=f"seed[{idx}].must_satisfy[{j}] missing id",
                )
                self.assertIn(
                    "description", item,
                    msg=f"seed[{idx}].must_satisfy[{j}] missing description",
                )
                self.assertTrue(
                    str(item["description"]).strip(),
                    msg=f"seed[{idx}].must_satisfy[{j}].description is empty",
                )

    def test_i_v6_3_03_every_seed_has_calibration_corpus_path(self) -> None:
        """Plan ARIA-V6 §3 V6.3 (B-V5-1 + B-V2-2) — sandbox cannot
        validate without a corpus.

        A seed without ``calibration_corpus_path`` cannot reach
        ``authored_validated`` (100% precision requires fixtures to
        measure against). I-V6.3-03 prevents that failure mode at the
        seed-file boundary.
        """
        rows = _load_seed_rows()
        for idx, seed in enumerate(rows):
            corpus = seed.get("calibration_corpus_path")
            self.assertTrue(
                corpus and str(corpus).strip(),
                msg=(
                    f"Seed[{idx}] (seed_id={seed['seed_id']!r}) MUST "
                    "declare calibration_corpus_path. V6.2 sandbox "
                    "cannot validate without a corpus; an absent "
                    "path means the seed will never reach "
                    "authored_validated."
                ),
            )
            # And path should be repo-relative (no absolute paths).
            self.assertFalse(
                str(corpus).startswith("/"),
                msg=(
                    f"Seed[{idx}].calibration_corpus_path must be "
                    f"repo-relative; got absolute: {corpus!r}"
                ),
            )


if __name__ == "__main__":
    unittest.main()
