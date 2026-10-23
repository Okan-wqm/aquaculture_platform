"""ARIA-LOW-517 — the ``sha256:`` label is spelled in one module: ``digest``.

WHY THIS EXISTS. About 165 kernel sites and 10 executor sites composed the
label inline (``"sha256:" + hashlib.sha256(x).hexdigest()``, ``f"sha256:{x}"``),
five modules compiled and two more inlined the validator as a regex, four
modules carried byte-identical private lease-token hashers, and hand-rolled
``startswith`` + ``len`` checks re-derived what ``digest.is_sha256_digest``
owns. A format with no owner is re-spelled by every caller: the spellings
diverged (a ``re.match`` that accepts a trailing newline, prefix-only gates
that pass ``sha256:abc``, truncated hex under the same label), and nothing
stopped the next spelling. ``aria_kernel/digest.py`` is the one owner
(ARIA-LOW-517 part C1); this pin is the "impossible" tier — the label cannot
be spelled anywhere else, so a new composition, f-string, ``str.format``
template, regex restatement or lease-token hasher fails here by name.

WHAT IS SCANNED. Every Python module of the kernel (``aria_kernel/``) and the
executor (``tools/aria-poc/``), the two trees the finding measured. The
kernel's own ``tests/`` tree is not scanned — the triage measured production
modules, and a test that builds a golden value composes it through the owner,
as ``test_digest_byte_pins.py`` does.
``digest.py`` itself is the owner and is exempt. A spelling is a composition
(``+``/``%`` with a label constant, an f-string whose constant part ends in
the label right before a formatted value, a ``str.format`` template), a regex
whose pattern embeds the label (the validator restated), or a def under one
of the four collapsed lease-token hasher names. An error message that merely
mentions the format spells no rule and stays legal.

WHY THE LABEL IS NOT EXPORTED. Exporting it is what lets a caller write
``value.startswith(label)`` and call that validation; the owner exports the
check (``is_sha256_digest``), the body extractor (``sha256_digest_hex``) and
the legacy-bare policy (``normalize_sha256_digest``) instead.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = (
    _REPO_ROOT / "aria-kernel" / "aria_kernel",
    _REPO_ROOT / "tools" / "aria-poc",
)
_OWNER = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "digest.py"
_LABEL = "sha256:"

# The four byte-identical lease-token hashers the finding names. After the
# collapse a module delegates to ``digest.sha256_digest_text`` (or compares
# with ``secret_matches_sha256_digest``); a private hasher under either of
# these names is the duplicate coming back.
_HASHER_NAMES = frozenset({"_hash_lease_token", "token_digest"})

_REGEX_CALLS = frozenset({
    "compile", "fullmatch", "match", "search", "findall", "finditer", "split", "sub", "subn",
})


def _label_constant(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and _LABEL in node.value


def _sources() -> list[Path]:
    return sorted(
        path for root in _SCANNED for path in root.rglob("*.py")
        if "tests" not in path.parts and path != _OWNER
    )


def _offenders(path: Path) -> list[str]:
    """Every spelling of the label in ``path``, as ``line:kind`` strings."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[str] = []
    where = f"{path.relative_to(_REPO_ROOT)}"
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
            if _label_constant(node.left) or _label_constant(node.right):
                found.append(f"{where}:{node.lineno}:label_composed_with_operator")
        elif isinstance(node, ast.JoinedStr):
            # Only the composition shape: a constant part ENDING in the label
            # that immediately labels a formatted value (``f"sha256:{x}"``,
            # ``f"source_hash: sha256:{x}"``). An error message that merely
            # mentions the format (``f"must be a sha256: digest, got {x}"``)
            # spells no rule and stays legal.
            for i, part in enumerate(node.values):
                if (isinstance(part, ast.Constant) and isinstance(part.value, str)
                        and part.value.endswith(_LABEL)
                        and i + 1 < len(node.values)
                        and isinstance(node.values[i + 1], ast.FormattedValue)):
                    found.append(f"{where}:{node.lineno}:label_composed_in_fstring")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "format" and node.args and _label_constant(node.func.value):
                found.append(f"{where}:{node.lineno}:label_composed_with_str_format")
            elif node.func.attr in _REGEX_CALLS and node.args and _label_constant(node.args[0]):
                found.append(f"{where}:{node.lineno}:validator_restated_as_regex")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            # ``from re import fullmatch`` shape: any bare call named like a
            # regex primitive whose pattern spells the label.
            if node.func.id in _REGEX_CALLS and node.args and _label_constant(node.args[0]):
                found.append(f"{where}:{node.lineno}:validator_restated_as_regex")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in _HASHER_NAMES:
            found.append(f"{where}:{node.lineno}:second_token_hasher_defined")
    return found


class DigestLabelHasOneOwner(unittest.TestCase):
    def test_the_label_is_spelled_in_digest_alone(self) -> None:
        offenders = [entry for path in _sources() for entry in _offenders(path)]
        self.assertEqual(
            offenders, [],
            "the 'sha256:' label is composed, formatted into an f-string, used as a "
            "str.format template, restated as a regex, or a second lease-token hasher "
            "is defined outside aria_kernel/digest.py (ARIA-LOW-517):\n"
            + "\n".join(offenders),
        )

    def test_the_owner_still_owns_the_label(self) -> None:
        # A pin that bans the label everywhere is vacuous if the owner lost
        # it: digest.py must still define the prefix and export the producer,
        # the validator and the comparison the callers delegate to.
        owner = ast.parse(_OWNER.read_text(encoding="utf-8"), filename=str(_OWNER))
        names = {node.name for node in ast.walk(owner) if isinstance(node, ast.FunctionDef)}
        self.assertIn("sha256_digest", names)
        self.assertIn("is_sha256_digest", names)
        self.assertIn("secret_matches_sha256_digest", names)
        self.assertIn('_PREFIX: Final = "sha256:"', _OWNER.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
