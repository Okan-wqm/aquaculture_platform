"""E19 — the portability claim, proven instead of asserted.

"ARIA's core is ~70% portable" has been repeated since the arc audit
without a single test bootstrapping the kernel against anything but this
repository. Every existing tools-binding test runs inside a fixture that
imitates THIS repo (remote set, host workspace shape). What was never
pinned is the minimal contract a FOREIGN repository must satisfy for the
kernel to stand up at all — and which refusals fire when it doesn't.

What these tests prove, hermetically, in a tmp directory:

  1. A minimal foreign repo (two files + ``.claude/agents/``) is enough
     for ``ensure_tools_dir`` + ``ensure_tools_binding`` to bootstrap a
     complete tools root: ``repo_identity.json``, ``registry.json``,
     ``tools_contract.json``, governance ledger.
  2. With NO ``remote.origin.url`` the canonical identity is derived
     from the repository's root commit SHA (``workspace.canonical_identity``
     offline fallback) — pinned by recomputing the exact recipe, not by
     calling the function twice — and the degraded mode is named in the
     governance ledger (``canonical_identity_offline_fallback``).
  3. Governed ledger appends (``append_tools_governance``) and the
     agent-priors surface both work under the foreign root.
  4. Deliberate breaks: a foreign repo without ``.claude/agents`` is a
     GovernanceError (agent_priors hard requirement, agent_priors.py:24);
     binding an already-bound tools root from a DIFFERENT repository is
     refused with ``tools_root_canonical_identity_mismatch``
     (tool_registry.ensure_tools_binding fail-closed branch).

Isolation: ``tests/__init__`` applies the hermetic git environment for
the whole process (scrubs GIT_CONFIG_* and GIT_DIR-family variables), so
the fixture repos here cannot see ambient config nor write into the host
repository. ``setUp`` asserts that guard is actually active rather than
trusting import order — a portability proof that silently ran against
the host repo would be worse than no proof.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_priors import map_agent_priors
from aria_kernel.tool_registry import (
    SCHEMA_VERSION,
    TOOLS_CONTRACT_FILENAME,
    GovernanceError,
    append_tools_governance,
    ensure_tools_binding,
    ensure_tools_dir,
)
from aria_kernel.workspace import canonical_identity_source

from tests._helpers.hermetic_git import hermetic_git_env_is_active


# Minimal frontmatter: ``name`` must satisfy agent_priors._valid_agent_name
# (^[a-z][a-z0-9-]{1,80}$) or the agent is silently skipped and the map
# would report agent_count == 0 — a pass that proves nothing. The backtick
# scope line exercises the scope-glob extractor on foreign paths.
DUMMY_AGENT_MD = """---
name: dummy-agent
description: Minimal foreign reviewer used by the E19 portability proof.
---

Reviews `src/**` in the foreign repository.
"""


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def _make_foreign_repo(base: Path, name: str, *, with_agents: bool = True) -> Path:
    """A repository that is deliberately NOT this one.

    Two trivial committed files, no remote configured. Content embeds the
    repo name so two fixtures never share a root-commit SHA — the identity
    fallback under test hashes exactly that SHA, and a collision would
    make the cross-repo refusal test vacuous.
    """
    repo = base / name
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "main.py").write_text(f'print("{name}")\n', encoding="utf-8")
    (repo / "README.md").write_text(
        f"# {name}\n\nA foreign repository; not the ARIA host.\n", encoding="utf-8"
    )
    if with_agents:
        agent = repo / ".claude" / "agents" / "dummy-agent.md"
        agent.parent.mkdir(parents=True)
        agent.write_text(DUMMY_AGENT_MD, encoding="utf-8")
    _git(repo, "init")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", f"genesis of {name}")
    return repo


def _root_commit_sha(repo: Path) -> str:
    return _git(repo, "rev-list", "--max-parents=0", "HEAD")


def _governance_rows(root: Path) -> list[dict]:
    path = root / "governance.jsonl"
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


class ForeignRepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # Fail loud if the process-wide hermetic guard is not active:
        # without it every `git init` below could act on the HOST repo
        # (GIT_DIR leakage — see tests/_helpers/hermetic_git.py).
        self.assertTrue(
            hermetic_git_env_is_active(),
            "hermetic git env inactive; foreign-repo fixtures would touch the host repo",
        )
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.foreign = _make_foreign_repo(self.base, "foreign-one")
        # The tools root lives INSIDE the foreign repo — the shape a real
        # adoption would use, not a side-by-side fixture convenience.
        self.tools = self.foreign / "aria-tools"


class TheKernelBootstrapsAgainstAForeignRepo(ForeignRepoTestCase):
    def test_bootstrap_writes_identity_registry_and_governance(self) -> None:
        """The minimal contract, positive half: two committed files and a
        directory are enough for a complete, self-describing tools root."""
        root = ensure_tools_dir(self.tools)

        self.assertEqual(root, self.tools.resolve())
        self.assertTrue((root / "repo_identity.json").is_file())
        self.assertTrue((root / TOOLS_CONTRACT_FILENAME).is_file())
        registry = json.loads((root / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual(registry["tools"], [])
        self.assertIn("tools_root_bootstrapped", [r["kind"] for r in _governance_rows(root)])

    def test_binding_derives_identity_from_the_root_commit_fallback(self) -> None:
        """The interesting portability path: no ``remote.origin.url``.

        The expected identity is recomputed here from the recipe
        (``sha256("local-root:" + root_commit_sha)[:16]``) rather than by
        calling ``canonical_identity`` again — calling the function twice
        would pass under any recipe, including a clone-path-dependent one,
        which is exactly the regression this fallback exists to prevent.
        """
        root = ensure_tools_binding(self.tools, workspace_root=self.foreign)

        expected = hashlib.sha256(
            f"local-root:{_root_commit_sha(self.foreign)}".encode("utf-8")
        ).hexdigest()[:16]
        identity = json.loads((root / "repo_identity.json").read_text(encoding="utf-8"))
        self.assertEqual(identity["bound_canonical_identity"], expected)
        self.assertEqual(identity["bound_repo_hash"], expected)  # legacy mirror stays in sync
        self.assertEqual(identity["aria_tools_contract_version"], SCHEMA_VERSION)

        # The kernel knows it is in the degraded mode, and says so.
        self.assertEqual(
            canonical_identity_source(self.foreign)["source"], "root_commit_sha"
        )
        rows = _governance_rows(root)
        by_kind = {row["kind"]: row for row in rows}
        self.assertIn("tools_root_bound", by_kind)
        fallback = by_kind.get("canonical_identity_offline_fallback")
        self.assertIsNotNone(
            fallback, "offline-fallback bind must leave an audit row naming the mode"
        )
        self.assertEqual(fallback["details"]["identity_source"], "root_commit_sha")
        self.assertEqual(fallback["details"]["canonical_identity"], expected)

    def test_a_governed_ledger_append_works_under_the_foreign_root(self) -> None:
        """append_declared_jsonl (via append_tools_governance) must accept
        the foreign root: manifest surface matching validates the tools
        identity at the BASE of the path, not a hardcoded host location."""
        root = ensure_tools_binding(self.tools, workspace_root=self.foreign)
        before = len(_governance_rows(root))

        appended = append_tools_governance(
            root, "portability_probe", {"plan": "E19", "repo": "foreign-one"}
        )

        self.assertEqual(appended["kind"], "portability_probe")
        rows = _governance_rows(root)
        self.assertEqual(len(rows), before + 1)
        self.assertEqual(rows[-1]["kind"], "portability_probe")
        self.assertEqual(rows[-1]["details"]["plan"], "E19")

    def test_agent_priors_maps_the_foreign_dummy_agent(self) -> None:
        root = ensure_tools_binding(self.tools, workspace_root=self.foreign)

        row = map_agent_priors(workspace_root=self.foreign, base_dir=root)

        self.assertEqual(row["agent_count"], 1)
        agent = row["agents"][0]
        self.assertEqual(agent["name"], "dummy-agent")
        self.assertEqual(agent["path"], ".claude/agents/dummy-agent.md")
        # The map is a declared ledger surface under the FOREIGN tools root.
        self.assertTrue((root / "agent-priors" / "agent-map.jsonl").is_file())


class PortabilityRefusals(ForeignRepoTestCase):
    """The deliberate breaks — what the minimal contract refuses."""

    def test_a_repo_without_claude_agents_is_refused(self) -> None:
        """agent_priors hard-requires ``.claude/agents`` (agent_priors.py:24).

        Pinned so the requirement stays a NAMED GovernanceError rather than
        drifting into a silent empty map — an adopter must learn the
        contract from the error, not from an inexplicable zero.
        """
        bare = _make_foreign_repo(self.base, "foreign-bare", with_agents=False)

        with self.assertRaises(GovernanceError) as caught:
            map_agent_priors(workspace_root=bare, base_dir=bare / "aria-tools")
        self.assertIn(".claude/agents", str(caught.exception))

    def test_the_bound_tools_root_refuses_a_second_repository(self) -> None:
        """Cross-repo reuse fails closed even in root-commit-fallback mode.

        Both repos here are offline (no remote), so this also proves the
        fallback identities of two distinct repos do not collapse into one
        value — if they did, the mismatch could never fire and one repo's
        ledgers would silently adopt another repo's history.
        """
        ensure_tools_binding(self.tools, workspace_root=self.foreign)
        other = _make_foreign_repo(self.base, "foreign-two")

        with self.assertRaises(GovernanceError) as caught:
            ensure_tools_binding(self.tools, workspace_root=other)
        self.assertIn("tools_root_canonical_identity_mismatch", str(caught.exception))

    def test_rebinding_the_same_repository_is_not_refused(self) -> None:
        """Positive control: without it the refusal above would pass just
        as well if ensure_tools_binding refused every second bind."""
        ensure_tools_binding(self.tools, workspace_root=self.foreign)

        root = ensure_tools_binding(self.tools, workspace_root=self.foreign)

        self.assertEqual(root, self.tools.resolve())


if __name__ == "__main__":
    unittest.main()
