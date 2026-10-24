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

import functools
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


# C0 control characters and DEL. Space is not one: it is part of a name
# (ARIA-MEDIUM-224).
_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


def _refuse_non_repo_spelling(text: str, raw_path: object) -> None:
    """The refusals every repo-relative reading shares: an absolute path (a
    POSIX root or a drive letter) and a backslash.

    A backslash is a legal POSIX name character, so ``docs\\x.md`` names one
    root-level file; rewriting it into a separator (as this module once did)
    classified a different path than the one the change holds. It is refused
    rather than guessed at, which also refuses a UNC root.
    """
    from .tool_registry import GovernanceError as _GE

    if text.startswith("/") or (len(text) >= 2 and text[1] == ":" and text[0].isalpha()):
        raise _GE(f"repo_relpath_absolute: {raw_path!r}")
    if "\\" in text:
        raise _GE(f"repo_relpath_backslash: {raw_path!r}")


def normalize_repo_relpath(raw_path: object) -> str:
    """The canonical spelling of a path that must stay inside the repository.

    ARIA-MEDIUM-224 — ONE canonical form: after the leading ``./`` prefixes
    ``lexical_repo_path`` removes, a path is its segments joined by ``/``
    with no ``''``, ``.`` or ``..`` segment (``snapshot._scoped_input_path``
    holds the same rule). ``docs//x.md``, ``docs/./x.md`` and ``docs/x.md/``
    are refused, not returned: they are spellings no glob is written for, so
    a classifier handed one judged a string instead of the file. A space is
    part of a POSIX name and is kept (``strip()`` once turned a name with a
    leading space into ``docs/x.md``, a different file). An absolute path and
    a backslash are refused (``_refuse_non_repo_spelling``).

    ARIA-CRITICAL-215 (fix round) — a C0 control character (newline, tab,
    ...) or DEL is refused too. It is legal in a git name and ``git diff -z``
    returns it verbatim, but no repository glob is written for such a name:
    the lane classifier once placed ``.../__tests__/a\\nb.test.ts`` under the
    blocked billing tree in L1. ``resolve_repo_relpath`` keeps it, because
    its readers (agent evidence refs) refuse control and bidi characters
    under their own code (``agent_evidence_path_unresolvable``).

    Raises ``tool_registry.GovernanceError`` with ``repo_relpath_absolute``,
    ``repo_relpath_backslash``, ``repo_relpath_control_char``,
    ``repo_relpath_traversal``, ``repo_relpath_non_canonical`` or
    ``repo_relpath_empty``.
    """
    from .tool_registry import GovernanceError as _GE

    text = str(raw_path)
    _refuse_non_repo_spelling(text, raw_path)
    if _CONTROL_CHARACTER.search(text):
        raise _GE(f"repo_relpath_control_char: {raw_path!r}")
    path = lexical_repo_path(text)
    segments = path.split("/")
    if ".." in segments:
        raise _GE(f"repo_relpath_traversal: {raw_path!r}")
    if path in ("", "."):
        raise _GE(f"repo_relpath_empty: {raw_path!r}")
    if any(segment in ("", ".") for segment in segments):
        raise _GE(f"repo_relpath_non_canonical: {raw_path!r}")
    return path


def resolve_repo_relpath(raw_path: object) -> str:
    """The canonical path a repo-relative spelling resolves to, lexically.

    ``''`` and ``.`` segments are dropped and ``..`` consumes the segment
    before it, so ``src/../aria-tools/x`` and ``.//aria-tools/x`` both
    resolve to ``aria-tools/x``. Nothing touches the filesystem
    (``_canonical_evidence_path`` is the resolver when a real root is the
    question). Refuses what ``_refuse_non_repo_spelling`` refuses, a ``..``
    that would leave the root, and an empty result.
    """
    from .tool_registry import GovernanceError as _GE

    text = str(raw_path)
    _refuse_non_repo_spelling(text, raw_path)
    parts: list[str] = []
    for segment in text.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not parts:
                raise _GE(f"repo_relpath_traversal: {raw_path!r}")
            parts.pop()
            continue
        parts.append(segment)
    if not parts:
        raise _GE(f"repo_relpath_empty: {raw_path!r}")
    return "/".join(parts)


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
    * ``[...]`` is a character class and ``[!...]`` its negation; a class
      that cannot compile raises ``GovernanceError`` (``repo_glob_invalid``),
      so the answer is a bool or that typed refusal, never ``re.error``.
    * Other characters are matched literally.
    * Every wildcard reads a newline as a name character, and the match ends
      at the end of the path (ARIA-CRITICAL-215 fix round; ``fnmatch``'s
      ``(?s:…)\\Z``). ``**`` once compiled to ``.`` without DOTALL while
      ``*`` matched a newline, so ``apps/billing-service/**`` missed a name
      ``*.test.ts`` matched; and ``$`` also matched before a trailing
      newline, so ``*.spec.ts`` matched ``a.spec.ts\\n``.
    """
    return any(_glob_match(path, candidate) for candidate in expand_repo_glob(pattern))


@functools.lru_cache(maxsize=8192)
def expand_repo_glob(pattern: str) -> tuple[str, ...]:
    """THE brace expansion of a repo glob: the brace-free alternatives
    ``matches_repo_glob`` matches ``pattern`` as, in its lexical repo form.

    ARIA-CRITICAL-215 — a reader that must judge what a glob CAN match (the
    L1 entry validator in ``risk_policy``) reads these alternatives, so it
    judges exactly the patterns the matcher compiles; a private expander
    beside the matcher is a second brace semantics that can disagree with
    it. Only the outermost group of each alternative is expanded (see
    ``_expand_braces``): a nested group and an unbalanced brace stay in the
    alternative literally, so a caller that requires brace-free alternatives
    refuses them instead of guessing.

    Cached by pattern (the expansion is a pure function of the text): the
    authority set's judge matches each path against every member, and a
    member is one brace glob over the standard library's module names
    (B1 round 4), so expanding per match would dominate every check.
    """
    return tuple(_expand_braces(lexical_repo_path(pattern)))


def repo_glob_directory(pattern: str) -> str | None:
    """The directory every path ``pattern`` can match lies under: the text
    before its first wildcard (``*``, ``?``, ``[``, ``{``), cut back to its
    last ``/`` — ``aria-kernel/**/conftest.py`` lies under ``aria-kernel``.
    ``""`` when the pattern can match at the repository root (``*.py``,
    ``*/__init__.*``); None when it has no wildcard and names one path.

    PLAN-v2 B1 — two readers need the same answer: the implementer room
    projects an authority member to a read-only mount over this directory,
    and the authority set's derivation reads a checkout's Python files only
    under it.
    """
    cut = min((pattern.index(ch) for ch in "*?[{" if ch in pattern), default=None)
    if cut is None:
        return None
    return pattern[:cut].rpartition("/")[0]


def typed_alternatives(glob: str) -> tuple[str, ...]:
    """The brace alternatives of ``glob`` whose last segment names a file type.

    ARIA-HIGH-531 — a scope glob is read two ways. As a READ allowlist every
    alternative counts; as a claim that an adapter can PARSE what it matches,
    only an alternative whose file name fixes a type does. A last segment
    made of ``*``, ``?`` and ``.`` alone (``**``, ``*``, ``*.*``) matches any
    file: it says where an adapter may look, never what it can read.
    ``*.rs``, ``jest.config.*``, ``Dockerfile*`` and ``registry.json`` name
    one; ``web/**/*.{ts,*}`` keeps ``web/**/*.ts`` only. Braces expand
    through :func:`expand_repo_glob`, the one expander.
    """
    return tuple(
        alternative for alternative in expand_repo_glob(glob)
        if any(character not in "*?." for character in alternative.rsplit("/", 1)[-1])
    )


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
# The refusal of a glob this owner cannot compile (``_glob_to_regex``).
REPO_GLOB_INVALID = "repo_glob_invalid"


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
            # Character class — copied through to its closing `]`. fnmatch's
            # negation `[!x]` is regex `[^x]`: copied raw it was a class that
            # MATCHES `!` and `x`, a pattern other than the one written.
            close = pattern.find("]", index + 1)
            if close == -1:
                # Unterminated class — treat literally
                parts.append(re.escape(char))
                index += 1
                continue
            body = pattern[index + 1 : close]
            parts.append(f"[^{body[1:]}]" if body.startswith("!") else f"[{body}]")
            index = close + 1
            continue
        # Literal character
        parts.append(re.escape(char))
        index += 1
    # `\Z`, not `$`: `$` also matches before a trailing newline. DOTALL: the
    # `.` that `**` compiles to must read a newline as `*` (`[^/]*`) does.
    parts.append(r"\Z")
    # A class the translation copied may still not compile (`[z-a]`, `[]x`):
    # that pattern is refused by name, never rewritten into one that does,
    # and ``re.error`` never reaches a caller (PV R16 — one reviewer string
    # raised it through the plan freshness gate and the delivery drain).
    try:
        compiled = re.compile("".join(parts), re.DOTALL)
    except re.error as exc:
        from .tool_registry import GovernanceError as _GE

        raise _GE(f"{REPO_GLOB_INVALID}: {pattern!r}: {exc}") from exc
    _GLOB_REGEX_CACHE[pattern] = compiled
    return compiled


def require_repo_glob(pattern: str) -> None:
    """Refuse ``pattern`` unless every brace alternative compiles in this owner.

    The admission half of :func:`matches_repo_glob`: a recorder that will
    hand a text to the matcher later asks here first, so the refusal
    (``repo_glob_invalid``) is raised when the text is written, by name,
    instead of when some later reader matches against it.
    """
    for alternative in expand_repo_glob(pattern):
        _glob_to_regex(alternative)

__all__ = [
    "REPO_GLOB_INVALID",
    "_canonical_evidence_path",
    "expand_repo_glob",
    "lexical_repo_path",
    "matches_repo_glob",
    "normalize_repo_relpath",
    "repo_glob_directory",
    "require_repo_glob",
    "resolve_repo_relpath",
    "typed_alternatives",
]
