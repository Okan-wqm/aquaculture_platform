"""DET crossfile-5 (ledger Z-E3 / Z38) — the drift seeder runs the owner of the GraphQL operation check.

``scripts/ci/validate-graphql-operations.mjs`` is the exact check of every FE operation against
the composed supergraph (``graphql.validate(schema, parse(op))``) with a zero-new-drift ratchet.
CI ran it on web PRs; ARIA's nightly cycle already fetches the same supergraph (``ARIA_SUPERGRAPH``)
but only read it for UI option lists, so a hook selecting a field the supergraph does not serve
(``shelfLifeDays`` where ``ChemicalResponse`` has ``shelfLifeMonths``) was never seen by ARIA.

The seeder gains the drift class ``graphql_operation_drift`` and gets it from the owner run with the
supergraph and ``--json`` — never from a second validator. These probes run the REAL owner, copied
into a fixture repository with its own sources, baseline and supergraph, so a finding is the owner's
verdict. Every near-miss sits beside the failing document in the same tree: "nothing minted" alone
would also hold for a seeder that runs nothing, "exactly the failing document minted" does not.

Pinned here (all red at the base, for the defect's reason):

* the owner's failing document becomes one finding of the class, citing the hook;
* the near-misses the owner stays quiet on (the corrected field, an interpolated fragment name that
  cannot parse, fragment wiring, specs, generated files, a baselined key) mint nothing;
* the seeder consumes the owner's output: a drift the owner names is minted although the tree holds
  no real drift, a real drift the owner does not name is not (no second validator in the seeder);
* an absent supergraph is a NAMED observation (``wire_unverifiable``), never findings;
* a supergraph that was not GIVEN is the same observation: the owner's own default, an artifact of
  unknown age under ``dist/``, is never read, so a stale artifact cannot mint findings;
* every other way the owner cannot answer (a crash, unreadable or wrongly shaped stdout, an exit
  code that is not a verdict, a timeout, a tree without the owner) is a NAMED unavailable result,
  never an empty list read as "no drift";
* the recheck of a finding of this class reproduces while the owner reports it, is absent only
  once the owner at the merged revision no longer does, and is unverifiable without the supergraph
  (never "absent": that would close an unfixed drift on the strength of a missing artifact).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[3]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (_POC_DIR, _REPO_ROOT / "aria-kernel"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import seed_drift_findings as seeder  # noqa: E402
from aria_kernel.finding_subject import finding_subject_key  # noqa: E402

DRIFT_CLASS = "graphql_operation_drift"
OWNER = "scripts/ci/validate-graphql-operations.mjs"
OWNER_LIB = "scripts/ci/lib"
BASELINE = "scripts/ci/graphql-fe-drift.baseline.json"
HOOKS = "web/modules/farm-module/src/hooks"
HOOK = f"{HOOKS}/useChemicals.ts"

SUBGRAPHS = {"subgraphs": [{"name": "farm", "nxProject": "farm-service"}]}

# The composed supergraph in the shape @apollo/composition prints; the type serves
# `shelfLifeMonths`, the Z38 hook asks for `shelfLifeDays`.
SUPERGRAPH = """\
enum join__Graph {
  FARM @join__graph(name: "farm", url: "http://farm-service:3000/graphql")
}

type Query @join__type(graph: FARM) {
  chemical(id: ID!): ChemicalResponse @join__field(graph: FARM)
}

type ChemicalResponse @join__type(graph: FARM) {
  id: ID!
  name: String!
  shelfLifeMonths: Int
}
"""

# What the seeder reads to tell whether an artifact is exact for a revision
# (fetch_supergraph.push_paths): the newest commit touching these paths.
SUPERGRAPH_WORKFLOW = """\
name: Apollo supergraph validate
on:
  push:
    paths:
      - 'web/**'
"""

# `${...}` spelled without a template-curly literal in this file.
INTERPOLATION = "$" + "{FRAGMENT_NAME}"


def document(name: str, field: str) -> str:
    return (
        "export const DOCUMENT = `\n"
        f"  query {name}($id: ID!) {{\n"
        "    chemical(id: $id) {\n"
        "      id\n"
        f"      {field}\n"
        "    }\n"
        "  }\n"
        "`;\n"
    )


# poc.py derives the directories its SQL enum scan reads from the schema registry (the one owner of
# migration locations), so a tree it scans declares one; this fixture holds no migrations.
SCHEMA_REGISTRY_FILE = "apps/db-migrate/src/schema-registry.ts"
SCHEMA_REGISTRY_TEXT = (
    "export const SCHEMA_REGISTRY = [\n"
    "  {\n"
    "    service: 'fixture-service',\n"
    "    schema: 'fixture',\n"
    "    migrationsGlob: ['apps/fixture-service/src/database/migrations/[0-9]*{.ts,.js}'],\n"
    "    reason: 'fixture',\n"
    "  },\n"
    "];\n"
)


class _Tree:
    """A git repository holding the owner as this checkout ships it, plus FE sources and a baseline."""

    def __init__(self, base: Path, files: dict[str, str], baseline_keys: tuple[str, ...] = ()) -> None:
        self.base = base
        self.repo = base / "repo"
        self.supergraph = base / "artifact" / "supergraph.graphql"
        self.state = base / "state"
        self.env = self._environment()
        self.repo.mkdir(parents=True)
        self.supergraph.parent.mkdir(parents=True)
        self.supergraph.write_text(SUPERGRAPH, encoding="utf-8")
        (self.repo / OWNER).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_REPO_ROOT / OWNER, self.repo / OWNER)
        shutil.copytree(_REPO_ROOT / OWNER_LIB, self.repo / OWNER_LIB)
        # Tracked, so a detached worktree of any revision resolves `graphql` too: this fixture does
        # not decide how a recheck's tree finds the dependency, only what the owner reports there.
        (self.repo / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
        baseline = {
            "count": len(baseline_keys),
            "operations": [
                {"key": key, "file": key.split("::")[0], "op": key.split("::")[1], "category": "MISSING-FIELD"}
                for key in baseline_keys
            ],
        }
        self.write(BASELINE, json.dumps(baseline, indent=2) + "\n")
        self.write("infrastructure/apollo-router/subgraphs.json", json.dumps(SUBGRAPHS))
        self.write(".github/workflows/apollo-supergraph-validate.yml", SUPERGRAPH_WORKFLOW)
        self.write(SCHEMA_REGISTRY_FILE, SCHEMA_REGISTRY_TEXT)
        for path, text in files.items():
            self.write(path, text)
        self.git("init", "-q")
        self.git("config", "gc.auto", "0")
        self.git("config", "maintenance.auto", "false")
        self.commit("fixture")

    def _environment(self) -> dict[str, str]:
        # No GIT_* from a hook running this suite may reach the fixture, and no ARIA store of the
        # host: findings, ledger and workspaces all live under this fixture's base.
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "ARIA_"))}
        env.update(
            HOME=str(self.base / "home"),
            GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
            GIT_AUTHOR_NAME="Aqua Test", GIT_AUTHOR_EMAIL="aqua-test@example.invalid",
            GIT_COMMITTER_NAME="Aqua Test", GIT_COMMITTER_EMAIL="aqua-test@example.invalid",
            ARIA_REPO_STATE_ROOT=str(self.state),
            ARIA_TOOLS_DIR=str(self.base / "tools"),
            ARIA_WORKSPACE_BASE=str(self.base / "workspaces"),
        )
        return env

    def write(self, path: str, text: str) -> None:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def commit(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def seed(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_POC_DIR / "seed_drift_findings.py"), "--repo-root", str(self.repo), *args],
            cwd=self.repo, env=self.env, capture_output=True, text=True, check=False,
        )

    def findings(self) -> list[dict]:
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((self.state / "aria-findings").glob("F-*.json"))
        ]


class _TreeCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-gql-operation-drift-")
        self.base = Path(self._tmp.name)

    def tearDown(self) -> None:
        # Unlink the dependency link first: a recursive delete must never reach the shared tree.
        link = self.base / "repo" / "node_modules"
        if link.is_symlink():
            link.unlink()
        self._tmp.cleanup()

    def tree(self, files: dict[str, str], baseline_keys: tuple[str, ...] = ()) -> _Tree:
        return _Tree(self.base, files, baseline_keys)


def _cited(record: dict) -> str:
    """What a finding says about where it is and what: its claim, evidence and facts, as one string."""
    return json.dumps(
        {key: record.get(key) for key in ("claim_summary", "evidences", "facts", "scope_files")}, sort_keys=True,
    )


class GraphqlOperationDriftSeedTests(_TreeCase):
    def test_the_owners_failing_document_is_minted_as_a_graphql_operation_drift(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        run = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(run.returncode, 0, run.stderr)
        records = tree.findings()
        self.assertEqual(len(records), 1, run.stdout)
        self.assertEqual(records[0]["claim_type"], "spine_drift")
        self.assertIn(DRIFT_CLASS, records[0]["claim_summary"])
        self.assertIn(HOOK, _cited(records[0]))
        # A supergraph that is present is not an observation of absence.
        self.assertEqual(
            [line for line in run.stdout.splitlines() if DRIFT_CLASS in line and "wire_unverifiable" in line], [],
        )

    def test_the_near_misses_beside_the_failing_document_mint_nothing(self) -> None:
        interpolated = (
            "export const DOCUMENT = `\n"
            "  query Interpolated($id: ID!) {\n"
            "    chemical(id: $id) {\n"
            "      id\n"
            "      shelfLifeDays\n"
            f"      ...{INTERPOLATION}\n"
            "    }\n"
            "  }\n"
            "`;\n"
        )
        fragments = (
            "export const DOCUMENT = `\n"
            '  query WithSiblingFragment { chemical(id: "1") { ...ChemicalFields } }\n'
            "`;\n"
            "export const UNUSED = `\n"
            '  query Plain { chemical(id: "1") { id } }\n'
            "  fragment UnusedFields on ChemicalResponse { id }\n"
            "`;\n"
        )
        baselined = f"{HOOKS}/useBaselined.ts"
        tree = self.tree(
            {
                HOOK: document("Chemical", "shelfLifeDays"),
                # The same operation with the field the type serves.
                f"{HOOKS}/useChemicalsFixed.ts": document("ChemicalFixed", "shelfLifeMonths"),
                # The interpolation cannot parse once removed: the owner skips the document.
                f"{HOOKS}/useInterpolated.ts": interpolated,
                f"{HOOKS}/useSiblingFragments.ts": fragments,
                f"{HOOKS}/useChemicals.spec.ts": document("SpecDrift", "shelfLifeDays"),
                f"{HOOKS}/useChemicals.test.tsx": document("TestDrift", "shelfLifeDays"),
                "web/modules/farm-module/src/generated/chemicals.ts": document("GeneratedDrift", "shelfLifeDays"),
                # Known debt the ratchet already tracks: quiet by the owner's own rule.
                baselined: document("Baselined", "shelfLifeDays"),
            },
            baseline_keys=(f"{baselined}::Baselined",),
        )
        run = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(run.returncode, 0, run.stderr)
        records = tree.findings()
        self.assertEqual(len(records), 1, run.stdout)
        cited = _cited(records[0])
        self.assertIn(HOOK, cited)
        for near_miss in ("useChemicalsFixed.ts", "useInterpolated.ts", "useSiblingFragments.ts",
                          "useChemicals.spec.ts", "useChemicals.test.tsx", "src/generated/", "useBaselined.ts"):
            with self.subTest(near_miss=near_miss):
                self.assertNotIn(near_miss, cited)

    def test_the_seeder_consumes_the_owners_output_and_validates_nothing_itself(self) -> None:
        """A stub owner names a drift the tree does not hold and omits the one it does.

        The real check, run on this tree, reports `useChemicals.ts` and nothing else. A seeder that
        validates for itself would mint that and not the stub's drift; one that feeds on the owner
        mints the stub's drift only.
        """
        named = f"{HOOKS}/useStub.ts"
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays"), named: document("Stub", "shelfLifeMonths")})
        canned = [{
            "key": f"{named}::Stub", "file": named, "op": "Stub", "category": "MISSING-FIELD",
            "messages": ['Cannot query field "ghostField" on type "ChemicalResponse".'],
        }]
        tree.write(OWNER, f"process.stdout.write({json.dumps(json.dumps(canned))});\nprocess.exitCode = 1;\n")
        tree.commit("the owner reports a drift of its own")
        run = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(run.returncode, 0, run.stderr)
        records = tree.findings()
        self.assertEqual(len(records), 1, run.stdout)
        self.assertIn(named, _cited(records[0]))
        self.assertNotIn(HOOK, _cited(records[0]))

    def test_the_same_drift_on_a_later_night_is_one_record_wherever_the_artifact_lands(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        first = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(first.returncode, 0, first.stderr)
        later = self.base / "later-artifact" / "supergraph.graphql"
        later.parent.mkdir()
        shutil.copy2(tree.supergraph, later)
        second = tree.seed("--supergraph", str(later))
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(tree.findings()), 1, second.stdout)
        self.assertIn("minted 0 findings", second.stdout)
        self.assertIn("1 already recorded", second.stdout)

    def test_the_owners_whole_list_reaches_the_seeder_past_the_size_of_a_pipe(self) -> None:
        # A pipe takes 64 KiB at once: an owner that exits right after writing a longer list is read
        # cut, and the seeder would parse half a document or none. 300 drifts are well past it.
        tree = self.tree({f"{HOOKS}/useBulk{n}.ts": document(f"Bulk{n}", "shelfLifeDays") for n in range(300)})
        section = seeder.run_graphql_operations(tree.repo, str(tree.supergraph))
        self.assertEqual(section["status"], "ok", section)
        self.assertEqual(len(section["drifts"]), 300)

    def test_an_absent_supergraph_is_a_named_observation_never_findings(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        missing = str(self.base / "artifact" / "not-fetched.graphql")
        absences = (
            ("no supergraph argument", ()),
            ("a supergraph path that is not a file", ("--supergraph", missing)),
        )
        for label, args in absences:
            with self.subTest(label):
                run = tree.seed(*args)
                self.assertEqual(run.returncode, 0, run.stderr)
                named = [
                    line for line in run.stdout.splitlines()
                    if DRIFT_CLASS in line and "wire_unverifiable" in line
                ]
                self.assertEqual(len(named), 1, run.stdout)
                self.assertEqual(tree.findings(), [])


AMBIENT_SUPERGRAPH = "dist/graphql/supergraph.graphql"


class GraphqlOperationUnavailableTests(_TreeCase):
    """Every way the owner cannot answer is a NAMED unavailable result, never an empty list or ``ok``.

    "No drift listed" is only evidence when the check ran to a verdict. Each tree here holds a real
    drift (the Z38 hook), so a seeder that turned an unanswered owner into an empty, ``ok`` list
    would print no observation and look clean: the assertions are the status, the reason, the one
    observation line the operator reads, and that nothing is minted.
    """

    def _tree_with_owner(self, owner_js: str | None) -> _Tree:
        """The failing document beside an owner replaced by ``owner_js`` (None: no owner at all)."""
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        self._replace_owner(tree, owner_js)
        return tree

    @staticmethod
    def _replace_owner(tree: _Tree, owner_js: str | None) -> None:
        if owner_js is None:
            (tree.repo / OWNER).unlink()
        else:
            tree.write(OWNER, owner_js)

    def _seed_in_process(self, tree: _Tree, *args: str, timeout: int | None = None) -> str:
        """The seeder's own ``main`` with its stdout, so a module constant can be lowered for one run."""
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, tree.env, clear=True))
            if timeout is not None:
                stack.enter_context(mock.patch.object(seeder, "GRAPHQL_OWNER_TIMEOUT_SECONDS", timeout))
            stack.enter_context(contextlib.redirect_stdout(out))
            self.assertEqual(seeder.main(["--repo-root", str(tree.repo), *args]), 0)
        return out.getvalue()

    def _assert_named_unavailable(self, tree: _Tree, reason: str, *, timeout: int | None = None) -> None:
        supergraph = str(tree.supergraph)
        limit = timeout or seeder.GRAPHQL_OWNER_TIMEOUT_SECONDS
        with mock.patch.object(seeder, "GRAPHQL_OWNER_TIMEOUT_SECONDS", limit):
            section = seeder.run_graphql_operations(tree.repo, supergraph)
        self.assertEqual(section, {"status": "unavailable", "reason": reason, "drifts": []})
        stdout = self._seed_in_process(tree, "--supergraph", supergraph, timeout=timeout)
        named = [line for line in stdout.splitlines() if DRIFT_CLASS in line and f"wire_unverifiable:{reason}" in line]
        self.assertEqual(len(named), 1, stdout)
        self.assertEqual(tree.findings(), [], stdout)

    def test_an_owner_that_crashes_is_unavailable_not_an_empty_list(self) -> None:
        # What node does on a missing dependency: exit 1, nothing on stdout.
        tree = self._tree_with_owner(
            "process.stderr.write(\"Error: Cannot find package 'graphql'\\n\");\nprocess.exitCode = 1;\n"
        )
        self._assert_named_unavailable(tree, "owner_exit_1")

    def test_an_owner_whose_stdout_is_not_json_is_unavailable(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        for label, exit_code in (("exit 0", 0), ("exit 1", 1)):
            with self.subTest(label):
                self._replace_owner(
                    tree, f"process.stdout.write('no drift found\\n');\nprocess.exitCode = {exit_code};\n"
                )
                self._assert_named_unavailable(tree, f"owner_exit_{exit_code}")

    def test_an_owner_whose_stdout_is_json_but_not_its_array_is_unavailable(self) -> None:
        wrong_shapes = (
            ("an object", '{"drifts": []}'),
            ("null", "null"),
            ("a string", '"[]"'),
            ("an array of non-objects", "[1]"),
            ("an entry without its fields", '[{"key": "k"}]'),
            ("an array followed by text", "[] done"),
        )
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        for label, printed in wrong_shapes:
            with self.subTest(label):
                self._replace_owner(tree, f"process.stdout.write({json.dumps(printed)});\nprocess.exitCode = 1;\n")
                self._assert_named_unavailable(tree, "owner_exit_1")

    def test_an_exit_code_that_is_not_a_verdict_is_unavailable_even_when_an_array_is_printed(self) -> None:
        # The array would mint a finding; the owner's exit codes are 0 and 1 (verdict) and 2 (no schema).
        named = f"{HOOKS}/useStub.ts"
        canned = [{
            "key": f"{named}::Stub", "file": named, "op": "Stub", "category": "MISSING-FIELD",
            "messages": ['Cannot query field "ghostField" on type "ChemicalResponse".'],
        }]
        tree = self._tree_with_owner(
            f"process.stdout.write({json.dumps(json.dumps(canned))});\nprocess.exitCode = 3;\n"
        )
        self._assert_named_unavailable(tree, "owner_exit_3")

    def test_an_owner_that_does_not_finish_in_time_is_unavailable(self) -> None:
        tree = self._tree_with_owner("setTimeout(() => {}, 60000);\n")
        self._assert_named_unavailable(tree, "owner_unrunnable:TimeoutExpired", timeout=1)

    def test_a_tree_without_the_owner_is_unavailable(self) -> None:
        self._assert_named_unavailable(self._tree_with_owner(None), "owner_not_found")


class GraphqlOperationAmbientSupergraphTests(_TreeCase):
    """Only a supergraph that was GIVEN is read: the owner's own default is an artifact of unknown age."""

    def _with_stale_artifact(self, *, tracked: bool = False) -> _Tree:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        tree.write(AMBIENT_SUPERGRAPH, SUPERGRAPH)
        if tracked:
            tree.commit("a supergraph artifact of unknown age")
        return tree

    def test_a_stale_artifact_at_the_owners_default_path_mints_nothing_and_is_named(self) -> None:
        tree = self._with_stale_artifact()
        run = tree.seed()
        self.assertEqual(run.returncode, 0, run.stderr)
        named = [
            line for line in run.stdout.splitlines()
            if DRIFT_CLASS in line and "wire_unverifiable:supergraph_not_given" in line
        ]
        self.assertEqual(len(named), 1, run.stdout)
        self.assertEqual(tree.findings(), [], run.stdout)
        self.assertEqual(
            seeder.run_graphql_operations(tree.repo),
            {"status": "unavailable", "reason": "supergraph_not_given", "drifts": []},
        )

    def test_the_owner_is_not_run_at_all_without_a_given_supergraph(self) -> None:
        tree = self._with_stale_artifact()
        marker = tree.base / "owner-ran"
        tree.write(
            OWNER,
            f"import {{ writeFileSync }} from 'node:fs';\nwriteFileSync({json.dumps(str(marker))}, 'ran');\n"
            "process.stdout.write('[]');\n",
        )
        tree.commit("an owner that says when it ran")
        for label, supergraph in (("None", None), ("an empty path", "")):
            with self.subTest(label):
                section = seeder.run_graphql_operations(tree.repo, supergraph)
                self.assertEqual(section["status"], "unavailable", section)
                self.assertEqual(section["reason"], "supergraph_not_given")
                self.assertFalse(marker.exists())
        # A given path is what makes it run: the marker is the owner's proof, not an absent file.
        seeder.run_graphql_operations(tree.repo, str(tree.supergraph))
        self.assertTrue(marker.exists())

    def test_the_recheck_never_reads_an_artifact_of_unknown_age_either(self) -> None:
        # A recheck gets no supergraph when the fetched one is not exact for the revision; the revision
        # itself holds an artifact at the owner's default path. It must be unverifiable, not reproduces.
        tree = self._with_stale_artifact(tracked=True)
        run = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(run.returncode, 0, run.stderr)
        records = tree.findings()
        self.assertEqual(len(records), 1, run.stdout)
        key = finding_subject_key(records[0])
        self.assertIsNotNone(key)
        with mock.patch.dict(os.environ, tree.env, clear=True):
            verdict = seeder.recheck_subject(
                tree.repo, subject_key=str(key), drift_class=DRIFT_CLASS, at_sha=tree.git("rev-parse", "HEAD"),
                supergraph=None,
            )
        self.assertEqual(verdict["verdict"], seeder.VERDICT_UNVERIFIABLE, verdict)
        self.assertIn("supergraph_not_given", verdict["reason"])


class GraphqlOperationDriftRecheckTests(_TreeCase):
    """The closure side: a finding of the class is closed only on the owner's word at the merged revision."""

    def test_the_judge_never_calls_a_missing_supergraph_absent(self) -> None:
        doc = {
            "drifts_above_threshold": [],
            "frontend_dropdown_drifts": [],
            "wire": {
                "status": "unavailable", "reason": "supergraph_not_found",
                "supergraph": "dist/graphql/supergraph.graphql",
            },
        }
        verdict = seeder.judge_subject(doc, subject_key="subject_unrelated", drift_class=DRIFT_CLASS)
        self.assertEqual(verdict["verdict"], seeder.VERDICT_UNVERIFIABLE)

    def _recheck(self, tree: _Tree, key: str, at_sha: str, supergraph: str | None) -> dict:
        with mock.patch.dict(os.environ, tree.env, clear=True):
            return seeder.recheck_subject(
                tree.repo, subject_key=key, drift_class=DRIFT_CLASS, at_sha=at_sha, supergraph=supergraph,
            )

    def _seeded_subject(self, tree: _Tree) -> str:
        """Seed the failing document and return the subject key of the one finding it minted."""
        run = tree.seed("--supergraph", str(tree.supergraph))
        self.assertEqual(run.returncode, 0, run.stderr)
        records = tree.findings()
        self.assertEqual(len(records), 1, run.stdout)
        key = finding_subject_key(records[0])
        self.assertIsNotNone(key)
        return str(key)

    def test_the_recheck_reproduces_while_the_owner_reports_it_and_is_absent_once_fixed(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        key = self._seeded_subject(tree)
        broken = tree.git("rev-parse", "HEAD")

        verdict = self._recheck(tree, key, broken, str(tree.supergraph))
        self.assertEqual(verdict["verdict"], seeder.VERDICT_REPRODUCES, verdict)

        tree.write(HOOK, document("Chemical", "shelfLifeMonths"))
        fixed = tree.commit("select the field the type serves")
        verdict = self._recheck(tree, key, fixed, str(tree.supergraph))
        self.assertEqual(verdict["verdict"], seeder.VERDICT_ABSENT, verdict)

    def test_the_recheck_resolves_graphql_in_a_worktree_with_no_node_modules_of_its_own(self) -> None:
        # A dependency install is not a tracked path: the detached worktree of a revision has none, and
        # the owner's `import 'graphql'` must still resolve there, or every recheck reads "unavailable".
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays"), ".gitignore": "node_modules\n"})
        key = self._seeded_subject(tree)
        verdict = self._recheck(tree, key, tree.git("rev-parse", "HEAD"), str(tree.supergraph))
        self.assertEqual(verdict["verdict"], seeder.VERDICT_REPRODUCES, verdict)

    def test_the_recheck_without_the_supergraph_is_unverifiable_even_after_the_fix(self) -> None:
        tree = self.tree({HOOK: document("Chemical", "shelfLifeDays")})
        key = self._seeded_subject(tree)
        tree.write(HOOK, document("Chemical", "shelfLifeMonths"))
        fixed = tree.commit("select the field the type serves")
        verdict = self._recheck(tree, key, fixed, None)
        self.assertEqual(verdict["verdict"], seeder.VERDICT_UNVERIFIABLE, verdict)


if __name__ == "__main__":
    unittest.main()
