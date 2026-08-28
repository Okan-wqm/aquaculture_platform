"""ORPHAN-HIGH-788 — a workflow env key and its consumers must agree on case.

`aria-readiness-claim.yml` exported `work_dir` to $GITHUB_ENV and read
`${WORK_DIR}` eleven times under `set -u`; the lane died on "unbound
variable" every time it fired, continuously, from the day the typo landed
(#1300) — invisible to kernel-side tests, because the mismatch lives in
YAML/bash, not Python. This detector covers the class: every name a
workflow exports to $GITHUB_ENV must be consumed in that exact spelling;
a case-variant usage anywhere in the file fails.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
_EXPORT = re.compile(r'echo\s+"([A-Za-z_][A-Za-z0-9_]*)=.*>>.*GITHUB_ENV')
_USAGE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class WorkflowEnvBinding(unittest.TestCase):
    def test_every_github_env_export_is_consumed_in_its_exact_spelling(self) -> None:
        checked = 0
        for wf in sorted(_WORKFLOWS.glob("aria-*.yml")):
            text = wf.read_text(encoding="utf-8")
            exports = set(_EXPORT.findall(text))
            if not exports:
                continue
            checked += 1
            usages = set(_USAGE.findall(text))
            exported_lower = {name.lower(): name for name in exports}
            for used in usages:
                canonical = exported_lower.get(used.lower())
                if canonical is None:
                    continue  # runner/GitHub-provided variable, not this file's export
                self.assertEqual(
                    used,
                    canonical,
                    msg=(
                        f"{wf.name}: exports `{canonical}` to GITHUB_ENV but the "
                        f"run steps read `{used}` — under set -u that is an "
                        f"unbound variable and the lane dies at first use "
                        f"(ORPHAN-HIGH-788)."
                    ),
                )
        self.assertGreaterEqual(checked, 1, "no aria workflow exports env — detector went vacuous")

    def test_the_readiness_claim_lane_bindings_are_consistent(self) -> None:
        # The concrete instance the class detector exists for, pinned by
        # name so a rename cannot silently orphan the fix.
        text = (_WORKFLOWS / "aria-readiness-claim.yml").read_text(encoding="utf-8")
        self.assertIn('echo "WORK_DIR=', text)
        self.assertNotIn('echo "work_dir=', text)


if __name__ == "__main__":
    unittest.main()
