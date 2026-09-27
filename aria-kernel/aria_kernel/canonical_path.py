"""Plan 026R §E.5 — shared canonical-path resolver.

Pre-§E.5 the canonical-resolve helper lived as
``evidence_validator._canonical_evidence_path`` (originally added
by Plan 024 v3 §H-5). Plan 026R §E.5 promotes it to a dedicated
module so two callers (``evidence_validator`` for evidence refs +
``memory._verify_fates_integrity`` for FATES recompute) can share
ONE resolver with one identity. Lexical ``startswith`` checks on
``aria-tools/`` markers and similar paths are FORBIDDEN — they are
defeatable via ``../traversal``; the canonical resolver is the
single source of truth.

The implementation lives here; ``evidence_validator`` re-exports
the symbol for backward compatibility with existing callers. The
plan called for ``evidence_validator.py (delegate)``, which is
exactly the pattern below.
"""
from __future__ import annotations

import re
from pathlib import Path


def _canonical_evidence_path(
    raw_path: str, root: Path,
) -> tuple[str, Path]:
    """Plan 024 v3 §H-5 + Plan 026R §E.5 — canonical-resolve helper.

    Resolves ``raw_path`` relative to ``root`` and returns the
    posix-relative form derived from the absolute resolved path
    plus the absolute Path itself. A path like
    ``src/../aria-tools/output.json`` resolves to the canonical
    ``aria-tools/output.json`` so downstream SELF_OUTPUT prefix
    checks operate on the canonical form, not the lexical input.

    Raises ``tool_registry.GovernanceError`` on:
      * unresolvable path (OSError / ValueError),
      * resolved-path-outside-root (relative_to fails).

    Returns ``(rel_str, absolute)``.
    """
    # Local import avoids a cycle on cold start (tool_registry pulls
    # in runtime_profile which transitively touches ledger code).
    from .tool_registry import GovernanceError as _GE
    try:
        absolute = (root / raw_path).resolve()
    except (OSError, ValueError) as exc:
        raise _GE(
            f"evidence_path_unresolvable: {raw_path!r}: {exc}",
        )
    try:
        rel = absolute.relative_to(root.resolve())
    except ValueError:
        raise _GE(
            f"evidence_path_outside_repo: {raw_path!r} "
            f"resolved to {absolute}",
        )
    return rel.as_posix(), absolute


def lexical_repo_path(raw_path: object) -> str:
    """THE lexical normalizer for repo-relative path strings (ARIA-HIGH-186).

    Converts ``\\`` to ``/`` and removes leading ``./`` PREFIXES, nothing
    else: a leading dot that belongs to the name (``.github``, ``.env``) is
    kept and ``..`` is left visible for the caller to judge. It never touches
    the filesystem; ``_canonical_evidence_path`` is the resolver when
    containment against a real root is the question.

    ``str.lstrip("./")`` looked like this and was not: it strips any leading
    ``.`` or ``/`` CHARACTER, so ``.github/x`` became ``github/x`` and
    ``../x`` became ``x``. It was fixed locally twice (ORPHAN-HIGH-576) and
    returned in five more sites because no shared helper existed; the AST
    invariant in ``tests/test_repo_relpath_ssot.py`` keeps it out.
    """
    path = str(raw_path).replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def normalize_repo_relpath(raw_path: object) -> str:
    """Lexically normalize a path that must stay inside the repository.

    Refuses, BEFORE any prefix is stripped, an absolute path (POSIX root,
    UNC/backslash root, or a drive letter), any ``..`` segment, and an empty
    result. Returns the ``lexical_repo_path`` form otherwise.

    Raises ``tool_registry.GovernanceError`` with ``repo_relpath_absolute``,
    ``repo_relpath_traversal`` or ``repo_relpath_empty``.
    """
    from .tool_registry import GovernanceError as _GE

    text = str(raw_path).strip().replace("\\", "/")
    if text.startswith("/") or (len(text) >= 2 and text[1] == ":" and text[0].isalpha()):
        raise _GE(f"repo_relpath_absolute: {raw_path!r}")
    if ".." in text.split("/"):
        raise _GE(f"repo_relpath_traversal: {raw_path!r}")
    path = lexical_repo_path(text)
    if not path.strip("/"):
        raise _GE(f"repo_relpath_empty: {raw_path!r}")
    return path


def matches_repo_glob(path: str, pattern: str) -> bool:
    """Match ``path`` against ``pattern`` with brace expansion + recursive ``**``.

    Plan 022 §C-7 / §C-8 — the pre-fix matcher relied on ``fnmatch`` only,
    which silently mishandled two real-world pattern shapes:

    * Brace alternation — ``*.{yml,yaml}`` was treated literally so neither
      ``.yml`` nor ``.yaml`` matched.  Auditors writing tool manifests in the
      style of ``.gitignore``/``.eslintignore`` saw their patterns silently
      do nothing.
    * Multiple ``**`` segments — ``apps/**/outbox/**/*.ts`` against
      ``apps/farm-service/src/outbox/x.ts`` returned False because the
      single zero-fold replacement applied to only one ``**``.

    Implementation chosen — regex compilation per pattern.  Picked over
    ``pathlib.PurePosixPath.match`` (which up to Python 3.12 does not match
    ``**`` as multi-segment except as the leading element) and over a
    full ``fnmatch`` fallback (which still cannot model multi-segment
    ``**``).  The regex translation is also strictly more expressive than
    the pre-fix two-step ``fnmatch`` + zero-segment swap and remains
    backward-compatible with the simple ``*.ts`` / ``apps/**`` patterns.

    Rules:
    * ``{a,b,c}`` is expanded into N alternative patterns (recursively, so
      ``a.{b,c}.{d,e}`` yields the four combinations).
    * ``**`` matches zero or more path segments; ``a/**/b`` matches both
      ``a/b`` (zero-fold) and ``a/x/y/b`` (multi-fold).  ``**/b`` matches
      ``b`` and ``a/x/b``; ``a/**`` matches ``a`` and ``a/x/y``.
    * ``*`` matches zero or more characters that are not ``/``.
    * ``?`` matches exactly one character that is not ``/``.
    * Other characters are matched literally.
    """
    normalized_pattern = lexical_repo_path(pattern)
    for candidate in _expand_braces(normalized_pattern):
        if _glob_match(path, candidate):
            return True
    return False


def _expand_braces(pattern: str) -> list[str]:
    """Expand ``{a,b,c}`` alternations into a list of patterns.

    Recurses on the tail after each balanced top-level group so multiple
    sequential groups (``a.{b,c}.{d,e}``) yield the full cross-product.
    Nested braces are split depth-aware in :func:`_split_top_level_commas`
    but only the OUTERMOST group is expanded per recursion level — nested
    groups inside an alternative branch are not pre-expanded; tool
    manifests in the corpus do not require shell-style nested expansion
    and keeping the depth flat bounds growth at O(N * groups).
    """
    # Find the first top-level brace group
    depth = 0
    start = -1
    for index, char in enumerate(pattern):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                # Found a balanced group from `start` to `index`
                inner = pattern[start + 1 : index]
                # Split on top-level commas (depth-aware)
                parts = _split_top_level_commas(inner)
                if not parts:
                    # `{}` or empty — treat as no expansion
                    return [pattern]
                head = pattern[:start]
                tail = pattern[index + 1 :]
                results: list[str] = []
                for part in parts:
                    for expanded_tail in _expand_braces(tail):
                        results.append(head + part + expanded_tail)
                return results
    return [pattern]


def _split_top_level_commas(text: str) -> list[str]:
    """Split ``text`` on commas that are not nested inside ``{}``."""
    parts: list[str] = []
    depth = 0
    start = 0
    for index, char in enumerate(text):
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(depth - 1, 0)
        elif char == "," and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    parts.append(text[start:])
    return parts


def _glob_match(path: str, pattern: str) -> bool:
    """Match ``path`` against a single brace-free glob pattern."""
    # Fast path: identical strings
    if path == pattern:
        return True
    regex = _glob_to_regex(pattern)
    return regex.match(path) is not None


_GLOB_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a glob pattern to a compiled regex.

    Cached because tool manifests reuse the same patterns across many
    paths in a single ``find_scope_violations`` call.
    """
    cached = _GLOB_REGEX_CACHE.get(pattern)
    if cached is not None:
        return cached
    parts: list[str] = ["^"]
    index = 0
    length = len(pattern)
    while index < length:
        char = pattern[index]
        # Multi-segment `**` handling — must consider surrounding `/`
        # so that `a/**/b` accepts both `a/b` and `a/x/y/b`.
        if char == "*" and index + 1 < length and pattern[index + 1] == "*":
            # Consume the `**`
            after_idx = index + 2
            # Trailing-slash form: `**/` — match zero or more path segments
            if after_idx < length and pattern[after_idx] == "/":
                # Strip a single preceding `/` from emitted regex if present
                # so that `a/**/b` accepts `a/b`.
                if parts and parts[-1] == "/":
                    parts.pop()
                    parts.append("(?:/.*)?/")
                else:
                    parts.append("(?:.*/)?")
                index = after_idx + 1
                continue
            # Trailing `**` at end of pattern: match the rest of the path
            # including zero-segment case (`a/**` matches `a`).
            if after_idx == length:
                if parts and parts[-1] == "/":
                    parts.pop()
                    parts.append("(?:/.*)?")
                else:
                    parts.append(".*")
                index = after_idx
                continue
            # `**` not bounded by `/` — treat as `.*` (rare in practice)
            parts.append(".*")
            index = after_idx
            continue
        if char == "*":
            # Single-segment wildcard — does not cross `/`
            parts.append("[^/]*")
            index += 1
            continue
        if char == "?":
            parts.append("[^/]")
            index += 1
            continue
        if char == "[":
            # Character class — copy through to closing `]`, escaping nothing
            close = pattern.find("]", index + 1)
            if close == -1:
                # Unterminated class — treat literally
                parts.append(re.escape(char))
                index += 1
                continue
            parts.append(pattern[index : close + 1])
            index = close + 1
            continue
        # Literal character
        parts.append(re.escape(char))
        index += 1
    parts.append("$")
    compiled = re.compile("".join(parts))
    _GLOB_REGEX_CACHE[pattern] = compiled
    return compiled

__all__ = ["_canonical_evidence_path", "lexical_repo_path", "matches_repo_glob", "normalize_repo_relpath"]
