"""ARIA-LOW-518 — one owner says what a git object id is.

Fifteen kernel modules restated the rule and disagreed: 40 hex only, 40 or
64, ``40(24)?``; anchored with ``^...$`` and called through ``re.match``,
where ``$`` also matches before a trailing newline. The owner is
``aria_kernel.git_object_id``; this file pins its rule and fails on a kernel
module that writes the rule out again instead of calling it.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.git_object_id import (
    ANY_OBJECT_FORMAT,
    SHA1_OBJECT_FORMAT,
    is_object_id,
    is_object_id_prefix,
    object_id_pattern,
)

_KERNEL_PACKAGE = Path(__file__).resolve().parents[1] / "aria_kernel"
_OWNER = _KERNEL_PACKAGE / "git_object_id.py"

SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"

# A hex character class followed by a git-id length: a full id ({40}), or an
# abbreviation bounded by a full id ({7,40}, {7,64}). A bare {64} is not
# matched — a sha256 CONTENT digest is 64 hex digits too, and `digest.py`
# owns that rule.
_RESTATED_REGEX = re.compile(
    r"\[(?:0-9a-f|a-f0-9|0-9a-fA-F|0-9A-Fa-f|a-fA-F0-9|A-Fa-f0-9)\]\{(?:\d+,)?40\}"
    r"|\[(?:0-9a-f|a-f0-9|0-9a-fA-F|0-9A-Fa-f|a-fA-F0-9|A-Fa-f0-9)\]\{\d+,64\}"
)
# A length test against a full-id length: `len(x) == 40`, `len(str(x)) != 40`,
# `len(x) in {40, 64}`, `len(x) not in (40, 64)`; and SHA-1's null id spelled
# out (`"0" * 40`).
_RESTATED_LENGTH = re.compile(
    r"len\((?:[^()]|\([^()]*\))*\)\s*(?:==|!=|(?:not\s+)?in)\s*[({]?\s*40\b"
    r"|\"0\"\s*\*\s*40\b"
)


class TheRule(unittest.TestCase):
    def test_a_full_id_is_whole_lowercase_hex_in_a_git_object_format(self) -> None:
        self.assertTrue(is_object_id(SHA1, formats=ANY_OBJECT_FORMAT))
        self.assertTrue(is_object_id(SHA256, formats=ANY_OBJECT_FORMAT))
        for value in (SHA1 + "\n", SHA1[:-1], SHA1 + "0", SHA1.upper(), SHA1 + SHA1[:24] + "\n",
                      " " + SHA1, SHA1[:39] + "g", "", None, 40, b"0" * 40):
            with self.subTest(value=value):
                self.assertFalse(is_object_id(value, formats=ANY_OBJECT_FORMAT))

    def test_every_check_states_its_policy(self) -> None:
        # No default: a site that forgets to choose is a TypeError at its own call.
        with self.assertRaises(TypeError):
            is_object_id(SHA1)  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            is_object_id_prefix(SHA1[:7])  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            object_id_pattern()  # type: ignore[call-arg]

    def test_a_caller_bound_to_sha1_says_so(self) -> None:
        self.assertTrue(is_object_id(SHA1, formats=SHA1_OBJECT_FORMAT))
        self.assertFalse(is_object_id(SHA256, formats=SHA1_OBJECT_FORMAT))
        with self.assertRaises(ValueError):
            is_object_id(SHA1, formats=frozenset())

    def test_an_abbreviation_is_a_hex_prefix_up_to_a_full_id(self) -> None:
        any_format = ANY_OBJECT_FORMAT
        self.assertTrue(is_object_id_prefix(SHA1[:7], formats=any_format, min_digits=7))
        self.assertTrue(is_object_id_prefix(SHA256, formats=any_format, min_digits=7))
        self.assertFalse(is_object_id_prefix(SHA1[:6], formats=any_format, min_digits=7))
        self.assertFalse(is_object_id_prefix(SHA256 + "0", formats=any_format, min_digits=7))
        self.assertFalse(is_object_id_prefix(SHA256, formats=SHA1_OBJECT_FORMAT))
        self.assertFalse(is_object_id_prefix("ABCD", formats=any_format))
        self.assertTrue(is_object_id_prefix("ABCD", formats=any_format, case_insensitive=True))
        self.assertFalse(is_object_id_prefix(SHA1[:7] + "\n", formats=any_format, min_digits=7))
        self.assertFalse(is_object_id_prefix("abc", formats=any_format, min_digits=3), "git's floor is four digits")

    def test_the_pattern_fragment_is_the_same_rule(self) -> None:
        pattern = re.compile(object_id_pattern(ANY_OBJECT_FORMAT))
        self.assertIsNotNone(pattern.fullmatch(SHA1))
        self.assertIsNotNone(pattern.fullmatch(SHA256))
        self.assertIsNone(pattern.fullmatch(SHA1 + SHA1[:23]))
        self.assertIsNone(re.compile(object_id_pattern(SHA1_OBJECT_FORMAT)).fullmatch(SHA256))


class TheReadersAgree(unittest.TestCase):
    """Behaviour, not text: readers that restated the rule disagreed about one id."""

    def _verdicts(self, value: str) -> dict[str, bool]:
        from aria_kernel import change_paths, readiness_diff_surface, state_store
        from aria_kernel.tool_registry import GovernanceError

        def accepts(check) -> bool:
            try:
                check()
            except GovernanceError:
                return False
            return True

        return {
            "change_paths": accepts(lambda: change_paths._full_sha("head", value)),
            "readiness_diff_surface": accepts(lambda: readiness_diff_surface._require_sha(value, name="head")),
            "state_store": state_store._full_git_sha(value),
        }

    def test_a_sha256_id_is_read_alike_by_every_reader(self) -> None:
        # At 606169730 change_paths accepted it and the other two refused it.
        self.assertEqual(set(self._verdicts(SHA256).values()), {True}, self._verdicts(SHA256))
        self.assertEqual(set(self._verdicts(SHA1).values()), {True}, self._verdicts(SHA1))
        self.assertEqual(set(self._verdicts(SHA1[:39]).values()), {False}, self._verdicts(SHA1[:39]))

    def test_the_null_id_is_not_a_commit_in_either_format(self) -> None:
        from aria_kernel.state_store import _full_git_sha

        self.assertFalse(_full_git_sha("0" * 40))
        self.assertFalse(_full_git_sha("0" * 64))


class NoKernelModuleRestatesTheRule(unittest.TestCase):
    def test_every_object_id_check_goes_through_the_owner(self) -> None:
        offenders: list[str] = []
        for path in sorted(_KERNEL_PACKAGE.rglob("*.py")):
            if path == _OWNER:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if _RESTATED_REGEX.search(line) or _RESTATED_LENGTH.search(line):
                    offenders.append(f"{path.relative_to(_KERNEL_PACKAGE.parent)}:{number}: {line.strip()[:100]}")
        self.assertEqual(offenders, [], "call aria_kernel.git_object_id instead of restating the rule")


if __name__ == "__main__":
    unittest.main()
