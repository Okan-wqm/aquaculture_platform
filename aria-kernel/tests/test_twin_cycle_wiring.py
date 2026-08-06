"""Twin-lite gets a keeper and a reader in the same change.

PLAN Wave 3. Twin-lite shipped as a CLI: `twin build`, `twin refresh`,
`twin status`, `twin context`. Nothing in the cycle kept the map current and
nothing in the cycle read it, so the map ARIA was meant to consult was only
ever as fresh as the last time a human ran a command.

Wiring only the refresh would have been worse than leaving it alone: a phase
that pays git-log and parse cost every cycle to produce a map no consumer
reads is the same defect this programme keeps closing, inverted — not
"written but never called" but "called and never read". So the producer
(`twin_refresh`) and its first reader (the agent envelope's repository-map
slice) land together, and this suite pins both halves plus the boundary
between them.

THE BOUNDARY IS THE LOAD-BEARING PART. The invocation prompt already
separates "Evidence refs (file:line entries; the ONLY admissible evidence)"
from "Impact graph refs" — one is citable, the other is orientation. The twin
map is DERIVED data recomputable from the repo at `indexed_sha`; it is
orientation, never evidence. It therefore renders in its own section and must
never reach `evidence_refs`, or a model could cite a projection as proof.
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_contract import validate_request
from aria_kernel.agent_invocations import render_invocation_prompt
from aria_kernel.cycle import CYCLE_PHASES, _phase_twin_refresh, build_phase_context
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.twin import read_twin_map


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    ).stdout


class TwinRefreshPhaseTests(unittest.TestCase):
    """The map is kept current BY THE CYCLE, not by remembering to run a CLI."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name) / "repo"
        (self.repo / "apps" / "svc" / "src").mkdir(parents=True)
        (self.repo / "apps" / "svc" / "project.json").write_text('{"name":"svc"}', encoding="utf-8")
        (self.repo / "apps" / "svc" / "src" / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "t@t")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "first")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def _run(self, cycle_id: str) -> dict:
        return _phase_twin_refresh(
            build_phase_context(cycle_id=cycle_id, workspace_root=self.repo, base_dir=self.tools)
        )

    def _commit(self, rel: str, body: str) -> str:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", f"add {rel}")
        return _git(self.repo, "rev-parse", "HEAD").strip()

    def test_the_phase_is_on_the_pipeline_and_in_the_discovery_stage(self) -> None:
        # CYCLE_PHASES is the SSoT — a phase that is not a row does not run,
        # which is how the four extended phases were dead without anyone noticing.
        row = next((p for p in CYCLE_PHASES if p.name == "twin_refresh"), None)
        self.assertIsNotNone(row, "twin_refresh is not on the pipeline")
        self.assertEqual(row.stage, "discovery")

    def test_the_observe_lane_keeps_the_map_too(self) -> None:
        # The map is a declared OBSERVATION surface, and the observe lane's
        # output is the acceptance evidence the ladder counts. A burn-in cycle
        # reading a map frozen at some past commit would be judging the wrong
        # repository.
        row = next(p for p in CYCLE_PHASES if p.name == "twin_refresh")
        self.assertIn("burn_in", row.modes)
        self.assertIn("standard", row.modes)

    def test_a_stale_map_must_not_fail_the_cycle_but_must_be_recorded(self) -> None:
        # A map that failed to refresh is a degraded read, not a broken cycle.
        row = next(p for p in CYCLE_PHASES if p.name == "twin_refresh")
        self.assertEqual(row.on_error, "record_and_continue")
        self.assertEqual(row.state_key, "twin_refresh")

    def test_the_first_cycle_builds_the_map(self) -> None:
        result = self._run("cyc-1")
        self.assertEqual(result["refresh"]["mode"], "full")
        self.assertEqual(read_twin_map(base_dir=self.tools)["indexed_sha"], result["indexed_sha"])

    def test_a_commit_is_on_the_map_by_the_next_cycle(self) -> None:
        # PLAN Wave 3 completion evidence: "a user commit is in the graph on
        # the next cycle" — the property the CLI-only twin could not have.
        self._run("cyc-1")
        head = self._commit("apps/svc/src/b.ts", "export const b = 2;\n")
        self._run("cyc-2")
        self.assertEqual(read_twin_map(base_dir=self.tools)["indexed_sha"], head)

    def test_the_second_cycle_refreshes_rather_than_rebuilds(self) -> None:
        # The other half of the completion evidence: a normal cycle does not
        # do a full scan. `mode` is the discriminator, and it is derived from
        # whether a prior map's anchor commit is known — not from a flag.
        self._run("cyc-1")
        self._commit("apps/svc/src/c.ts", "export const c = 3;\n")
        result = self._run("cyc-2")
        self.assertEqual(result["refresh"]["mode"], "incremental")
        self.assertEqual(result["refresh"]["changed_files"], 1)

    def test_a_cycle_with_no_new_commit_does_no_work(self) -> None:
        self._run("cyc-1")
        result = self._run("cyc-2")
        self.assertEqual(result["refresh"]["mode"], "noop")

    def test_the_refreshed_map_reaches_a_minted_request(self) -> None:
        """THE LOOP. Refresh produces, minting consumes — in one tools root.

        Tested end to end rather than in halves, because the failure this
        guards against is precisely the two halves being individually correct
        and never meeting: a phase that refreshes a map nothing reads, or a
        renderer for a field nothing sets.
        """
        from aria_kernel.agent_invocations import create_agent_invocation_request

        self._run("cyc-1")
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[{"id": "M1", "statement": "s"}],
            allowed_scope=["apps/svc/**"],
            evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=self.tools,
            cycle_id="cyc-1",
        )
        self.assertIn("repository_map", request)
        self.assertEqual(
            [entry["file"] for entry in request["repository_map"]["files"]],
            ["apps/svc/src/a.ts"],
        )
        self.assertEqual(request["repository_map"]["files"][0]["project"], "svc")

    def test_a_request_minted_without_a_map_simply_has_no_map(self) -> None:
        # No twin build has run in this tools root. The mint must not fail,
        # and must not invent an empty projection.
        from aria_kernel.agent_invocations import create_agent_invocation_request

        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[{"id": "M1", "statement": "s"}],
            allowed_scope=["apps/svc/**"],
            evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=ensure_tools_dir(Path(self._tmp.name) / "aria-tools-empty"),
            cycle_id="cyc-1",
        )
        self.assertNotIn("repository_map", request)


class RepositoryMapIsOrientationNotEvidenceTests(unittest.TestCase):
    """The reader — and the trust boundary it must not cross."""

    def _request(self, **extra) -> dict:
        request = {
            "$schema": "aria/agent-request/v1",
            "request_id": "AIR-test-0001",
            "cycle_id": "cyc-1",
            "role": "evidence_judgment",
            "target_agent": "aria-evidence-judge",
            "evidence_refs": ["apps/svc/src/a.ts:1"],
            "allowed_scope": ["apps/svc/**"],
            "forbidden_scope": [],
            "must_satisfy": [{"id": "M1", "statement": "the claim holds", "description": "d"}],
            "validation_commands": ["npm run aria:test:unit"],
            "expected_output_path": "out.json",
            "suggested_prompt": "do the thing",
        }
        request.update(extra)
        return request

    _MAP = {
        "indexed_sha": "a" * 40,
        "files": [
            {
                "file": "apps/svc/src/a.ts",
                "project": "svc",
                "tests": ["apps/svc/src/a.spec.ts"],
                "churn_commits": 7,
                "co_changes_with": [{"file": "apps/svc/src/b.ts", "count": 4}],
            }
        ],
        "impacted_projects": [["svc", {"layer": 0, "depends_on": [], "dependents": ["web-shell"]}]],
    }

    def test_the_map_reaches_the_model(self) -> None:
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        self.assertIn("## Repository map", prompt)
        self.assertIn("apps/svc/src/a.ts", prompt)
        self.assertIn("apps/svc/src/a.spec.ts", prompt)

    def test_the_map_is_labelled_derived_and_not_citable(self) -> None:
        # THE BOUNDARY. A model told to cite only evidence_refs, and handed a
        # map in the same prompt, must be told which is which.
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        map_section = prompt.split("## Repository map", 1)[1].split("\n##", 1)[0]
        self.assertIn("derived", map_section.lower())
        self.assertIn("not evidence", map_section.lower())

    def test_the_map_never_enters_the_evidence_section(self) -> None:
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        evidence_section = prompt.split("## Evidence refs", 1)[1].split("\n##", 1)[0]
        # The evidence block lists exactly the evidence_refs it was given.
        self.assertIn("apps/svc/src/a.ts:1", evidence_section)
        self.assertNotIn("churn", evidence_section.lower())
        self.assertNotIn("co_changes", evidence_section.lower())
        self.assertNotIn("a.spec.ts", evidence_section)

    def test_no_map_means_no_section_rather_than_an_empty_one(self) -> None:
        # Empty scaffolding reads as "the map says nothing about these files",
        # which is a different claim from "there is no map".
        self.assertNotIn("## Repository map", render_invocation_prompt(self._request()))

    def test_a_map_with_no_files_also_renders_nothing(self) -> None:
        # The absent case above is caught by the isinstance guard, so it does
        # NOT pin this one: a mutation dropping the empty-files check left the
        # suite green until this test existed. A projection that resolved no
        # files is the same silence as no projection — printing a heading over
        # nothing turns "I have no map for these paths" into "the map has
        # nothing to say about these paths".
        for empty in ({"indexed_sha": "a" * 40, "files": []}, {"indexed_sha": "a" * 40}):
            with self.subTest(payload=empty):
                prompt = render_invocation_prompt(self._request(repository_map=empty))
                self.assertNotIn("## Repository map", prompt)

    def test_a_prompt_is_a_pure_function_of_its_request(self) -> None:
        # render_invocation_prompt is the SSoT for the prompt whose hash is
        # persisted; if it read the map from disk the hash would depend on
        # when it ran, not on what was asked.
        request = self._request(repository_map=self._MAP)
        self.assertEqual(render_invocation_prompt(request), render_invocation_prompt(request))

    def test_the_contract_type_checks_the_new_field(self) -> None:
        validate_request(self._request(repository_map=self._MAP))
        with self.assertRaises(GovernanceError):
            validate_request(self._request(repository_map=["not", "an", "object"]))


if __name__ == "__main__":
    unittest.main()
