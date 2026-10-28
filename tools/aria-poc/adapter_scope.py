"""The one definition of the sources the source-scanning adapters never read.

The cqrs adapter's rule premises require a controller that serves requests in
production, and the outbox adapter's rule is about domain code that publishes in
production; a spec, a ``__tests__`` helper, a ``.test.ts`` file, a migration, a
vendored dependency or a build output is neither. The two adapters used to keep
this list privately and disagreed on it (cqrs lacked ``.test.ts`` and
``/migrations/``); both now ask ``is_excluded_source`` and the list lives here
only (DET-RCA B18).

The runner starts an adapter as ``python3 <adapter>.py`` in this directory, so
the adapters import this module as a sibling.
"""
from __future__ import annotations


# Substring match on the repo-relative posix path: the fragments are the ones
# the adapters already used, so the set of files read does not change.
_NON_PRODUCTION_FRAGMENTS: tuple[str, ...] = (
    "node_modules/",
    "dist/",
    "/__tests__/",
    ".spec.ts",
    ".test.ts",
    "/migrations/",
)


def is_excluded_source(rel: str) -> bool:
    """True when the repo-relative posix path ``rel`` is not production source."""
    return any(fragment in rel for fragment in _NON_PRODUCTION_FRAGMENTS)
