"""Plan ARIA-V2 §Phase 1 invariants I-1..I-4 — canonical_identity recipe.

Locks the architectural decision that ``canonical_identity(repo_root)``
is environment-independent: same repo → same hash regardless of clone
path, protocol, credentials, .git suffix, host casing, or worktree
location.

If any of these tests is silently removed or weakened, a future change
to ``aria_kernel.workspace.canonical_identity`` could re-introduce the
ARIA-V-006 regression class.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.workspace import canonical_identity, canonical_identity_source, canonicalize_remote_url

# _helpers/ is a sibling dir with underscored name so unittest discover
# does not descend into it. Plain Python import works regardless of
# discovery globbing.
import importlib.util
import sys
_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


class CanonicalizeRemoteUrlTests(unittest.TestCase):
    """Plan ARIA-V2 §3.1 — verify the canonicalize_remote_url normalizer
    treats each URL-form equivalence class as identical strings.
    """

    HTTPS = "https://github.com/Okan-Wqm/aquaculture_platform.git"
    HTTPS_NO_GIT = "https://github.com/Okan-Wqm/aquaculture_platform"
    HTTPS_HOST_CASE = "https://GITHUB.COM/Okan-Wqm/aquaculture_platform.git"
    HTTPS_WITH_CREDS = "https://user:tokensecret@github.com/Okan-Wqm/aquaculture_platform.git"
    SSH_AT = "git@github.com:Okan-Wqm/aquaculture_platform.git"
    SSH_SCHEME = "ssh://git@github.com/Okan-Wqm/aquaculture_platform.git"
    EXPECTED = "github.com/Okan-Wqm/aquaculture_platform"

    def test_https_normalizes_to_expected_canonical(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.HTTPS), self.EXPECTED)

    def test_https_without_git_suffix_matches(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.HTTPS_NO_GIT), self.EXPECTED)

    def test_host_case_lowercased_only(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.HTTPS_HOST_CASE), self.EXPECTED)

    def test_credentials_stripped(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.HTTPS_WITH_CREDS), self.EXPECTED)

    def test_ssh_at_form_matches(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.SSH_AT), self.EXPECTED)

    def test_ssh_scheme_form_matches(self) -> None:
        self.assertEqual(canonicalize_remote_url(self.SSH_SCHEME), self.EXPECTED)

    def test_owner_case_preserved_distinct(self) -> None:
        """Owner casing is preserved by design (GitHub treats Owner/Repo
        and owner/repo as the same repo at HTTP layer but the URLs are
        distinct strings; locking this rule prevents silent drift)."""
        upper = canonicalize_remote_url("https://github.com/UPPER/repo.git")
        lower = canonicalize_remote_url("https://github.com/upper/repo.git")
        self.assertNotEqual(upper, lower)
        self.assertEqual(upper, "github.com/UPPER/repo")
        self.assertEqual(lower, "github.com/upper/repo")

    def test_empty_input_returns_empty(self) -> None:
        self.assertEqual(canonicalize_remote_url(""), "")
        self.assertEqual(canonicalize_remote_url("   "), "")


class CanonicalIdentityEquivalenceClassesTests(unittest.TestCase):
    """Plan ARIA-V2 I-1 — same repo hashes identically under every URL form.

    Builds two git repos at different paths with semantically-equivalent
    remote URLs and asserts ``canonical_identity`` returns the same hash.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def _expect_same(self, *remote_forms: str) -> None:
        hashes = set()
        for idx, url in enumerate(remote_forms):
            repo = git_fixtures.make_local_git_repo(self.tmp, name=f"r{idx}", remote_url=url)
            hashes.add(canonical_identity(repo))
        self.assertEqual(
            len(hashes), 1,
            f"Plan ARIA-V2 I-1 violation: equivalent URL forms produced {len(hashes)} distinct hashes: {hashes}",
        )

    def test_https_vs_ssh_match(self) -> None:
        self._expect_same(
            "https://github.com/Okan-Wqm/aquaculture_platform.git",
            "git@github.com:Okan-Wqm/aquaculture_platform.git",
        )

    def test_with_and_without_git_suffix_match(self) -> None:
        self._expect_same(
            "https://github.com/Okan-Wqm/aquaculture_platform.git",
            "https://github.com/Okan-Wqm/aquaculture_platform",
        )

    def test_host_case_variants_match(self) -> None:
        self._expect_same(
            "https://github.com/Okan-Wqm/aquaculture_platform.git",
            "https://GITHUB.COM/Okan-Wqm/aquaculture_platform.git",
        )

    def test_credentials_variants_match(self) -> None:
        self._expect_same(
            "https://github.com/Okan-Wqm/aquaculture_platform.git",
            "https://user:tokensecret@github.com/Okan-Wqm/aquaculture_platform.git",
        )


class CanonicalIdentityDistinctReposTests(unittest.TestCase):
    """Plan ARIA-V2 I-2 — different ``owner/repo`` hashes differently."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_distinct_owner_distinct_hash(self) -> None:
        r1 = git_fixtures.make_local_git_repo(self.tmp, name="a", remote_url="https://github.com/owner1/repo")
        r2 = git_fixtures.make_local_git_repo(self.tmp, name="b", remote_url="https://github.com/owner2/repo")
        self.assertNotEqual(canonical_identity(r1), canonical_identity(r2))

    def test_distinct_repo_distinct_hash(self) -> None:
        r1 = git_fixtures.make_local_git_repo(self.tmp, name="a", remote_url="https://github.com/owner/repo1")
        r2 = git_fixtures.make_local_git_repo(self.tmp, name="b", remote_url="https://github.com/owner/repo2")
        self.assertNotEqual(canonical_identity(r1), canonical_identity(r2))


class CanonicalIdentityOfflineFallbackTests(unittest.TestCase):
    """Plan ARIA-V2 I-3 — offline fallback uses git root-commit SHA.

    A repo with no ``remote.origin.url`` configured falls back to the
    first root commit SHA so two clones at different paths still hash
    identically (architecturally stronger than per-clone basename
    hashing).
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_no_remote_falls_back_to_root_commit_sha(self) -> None:
        repo = git_fixtures.make_local_git_repo(self.tmp, name="noremote", remote_url=None, initial_commit=True)
        source = canonical_identity_source(repo)
        self.assertEqual(source["source"], "root_commit_sha")
        self.assertTrue(source["normalized"].startswith("local-root:"))

    def test_remote_url_present_takes_precedence(self) -> None:
        repo = git_fixtures.make_local_git_repo(
            self.tmp, name="hasremote", remote_url="https://github.com/x/y", initial_commit=True,
        )
        source = canonical_identity_source(repo)
        self.assertEqual(source["source"], "remote_url")


class CanonicalIdentityWorktreeIndependentTests(unittest.TestCase):
    """Plan ARIA-V2 I-4 — worktree of canonical hashes identically."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_worktree_canonical_identity_matches_root(self) -> None:
        canonical = git_fixtures.make_local_git_repo(
            self.tmp, name="canonical", remote_url="https://github.com/x/y.git",
        )
        worktree = git_fixtures.make_git_worktree(canonical, self.tmp / "worktree-x")
        self.assertEqual(canonical_identity(canonical), canonical_identity(worktree))


if __name__ == "__main__":
    unittest.main()
