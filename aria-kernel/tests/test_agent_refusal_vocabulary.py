"""ORPHAN-HIGH-790 — an agent file may only teach refusal values the kernel accepts.

The refusal envelope's `reason_class` is a four-member closed enum
(``agent_contract.REASON_CLASSES``); the kernel REJECTS any other value at
the boundary (``agent_contract.py`` ``validate`` → ``refusal reason_class
... not in ...``). Two agent files taught values from a DIFFERENT closed
set — the ``implementation_rejected`` payload's ``rejection_class``
taxonomy (``implementation_rejections.py``) — as if they were refusal
envelope classes: an agent following its prompt to the letter produced an
envelope the kernel refused, the exact "cycle stalls" failure the prompts
themselves dramatize. This invariant binds the vocabulary: every literal
``reason_class`` value taught in any aria agent file must be a member of
the enum the kernel enforces.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.agent_contract import REASON_CLASSES
from aria_kernel.implementation_rejections import VALID_IMPLEMENTATION_REJECTION_CLASSES

_REPO = Path(__file__).resolve().parents[2]
_AGENT_DIRS = (_REPO / ".claude" / "agents", _REPO / ".claude" / "agents" / "_maintenance")
_INLINE = re.compile(r"reason_class\s*[=:]\s*`?([a-z_]+)`?")
_BULLET = re.compile(r"^\s*-\s*`([a-z_]+)`")


def _agent_files() -> list[Path]:
    out: list[Path] = []
    for root in _AGENT_DIRS:
        if root.is_dir():
            out.extend(sorted(root.glob("aria-*.md")))
    return out


def _taught_refusal_values(text: str) -> set[str]:
    """Literal reason_class values a prompt teaches, both spellings.

    Inline (``reason_class: scope``) and the bullet-list style where the
    values follow a line naming ``reason_class`` (``- `evidence` — ...``).
    """
    values = set(_INLINE.findall(text))
    lines = text.splitlines()
    for i, line in enumerate(lines):
        # Bullet-style teaching only under a line that INTRODUCES the
        # vocabulary (ends with reason_class:) — a prose mention of
        # reason_class followed by unrelated field bullets must not get
        # swallowed (primary-planner's expected_output_path taught us this).
        stripped = line.rstrip("` ").rstrip()
        if not stripped.endswith("reason_class:"):
            continue
        for follow in lines[i + 1 : i + 9]:
            m = _BULLET.match(follow)
            if m:
                values.add(m.group(1))
            elif follow.strip() and not follow.lstrip().startswith(("-", "#", "|")):
                break
    return values


class AgentRefusalVocabulary(unittest.TestCase):
    def test_every_taught_reason_class_is_a_kernel_enum_member(self) -> None:
        files = _agent_files()
        self.assertGreaterEqual(len(files), 15, "agent corpus shrank — detector went vacuous")
        offenders: dict[str, set[str]] = {}
        teaching_files = 0
        for path in files:
            values = _taught_refusal_values(path.read_text(encoding="utf-8"))
            if values:
                teaching_files += 1
            bad = values - set(REASON_CLASSES)
            if bad:
                offenders[path.name] = bad
        self.assertGreaterEqual(teaching_files, 5, "no agent teaches refusals — detector went vacuous")
        self.assertEqual(
            offenders,
            {},
            msg=(
                "agent files teach refusal values the kernel rejects at the "
                f"boundary (enum: {REASON_CLASSES}): {offenders}. A prompt-faithful "
                "agent produces a refused envelope — the cycle-stall class."
            ),
        )

    def test_rejection_taxonomy_members_never_masquerade_as_reason_classes(self) -> None:
        # The conflation trap, pinned by name: these values are VALID in the
        # implementation_rejected payload's rejection_class field and INVALID
        # anywhere near a refusal envelope's reason_class.
        trap = {"content_hash_mismatch", "validation_failed", "forbidden_scope_violation"}
        self.assertTrue(trap <= VALID_IMPLEMENTATION_REJECTION_CLASSES)
        self.assertFalse(trap & set(REASON_CLASSES))
        for path in _agent_files():
            for value in _taught_refusal_values(path.read_text(encoding="utf-8")):
                self.assertNotIn(
                    value,
                    trap,
                    msg=f"{path.name} teaches {value} as a reason_class; it is a "
                    "rejection_class (implementation_rejected payload), never a "
                    "refusal envelope class.",
                )


if __name__ == "__main__":
    unittest.main()
