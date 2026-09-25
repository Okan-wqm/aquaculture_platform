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


__all__ = ["_canonical_evidence_path", "lexical_repo_path", "normalize_repo_relpath"]
