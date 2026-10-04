#!/usr/bin/env python3
"""Fetch the composed supergraph the nightly drift scan judges wire values against.

WHY. The drift scan compares a UI option list with what the GraphQL transport actually carries, which it reads from
the composed supergraph (`dist/graphql/supergraph.graphql`). The nightly cycle runs on the production host, so it does
not compose one; `apollo-supergraph-validate.yml` already composes it on GitHub-hosted runners for every schema-
affecting push to main and uploads it as the `supergraph-sdl` artifact.

WHAT. The artifact is accepted only when it is EXACT for the cycle's commit: it must come from a successful main run
whose head contains the newest commit that touched the workflow's own `paths:` filter (walked along main's first-
parent line) and is itself contained in HEAD, so nothing schema-affecting lies between the artifact and HEAD. The
workflow also runs weekly, so a quiet schema still has an unexpired artifact. Anything
else — no such run, an expired artifact, a failed download — prints a named reason and exits 3; the scanner then
reports every UI pair as `wire_unverifiable` instead of guessing.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

WORKFLOW = ".github/workflows/apollo-supergraph-validate.yml"
ARTIFACT = "supergraph-sdl"


def push_paths(workflow_text: str) -> list[str]:
    """The `on.push.paths` globs, read by indentation without a YAML dependency. Comment and blank lines are skipped,
    not taken as the end of the list (the workflow interleaves comments with its globs)."""
    in_on = in_push = in_paths = False
    out: list[str] = []
    for line in workflow_text.splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_on, in_push, in_paths = text == "on:", False, False
        elif in_on and indent == 2:
            in_push, in_paths = text == "push:", False
        elif in_push and indent == 4:
            in_paths = text == "paths:"
        elif in_paths and indent >= 6 and text.startswith("- "):
            out.append(text[2:].strip().strip("'\""))
    return out


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


def schema_commit(repo: Path, paths: list[str]) -> str | None:
    if not paths:
        return None
    out = _git(repo, "log", "-1", "--first-parent", "--format=%H", "HEAD", "--", *[f":(glob){p}" for p in paths])
    return out or None


def _is_ancestor(repo: Path, older: str, newer: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer],
                          capture_output=True).returncode == 0


def pick_run(runs: list[dict], schema_sha: str, repo: Path) -> dict | None:
    """The newest successful main run that composed exactly HEAD's schema.

    A run qualifies when its head contains the schema commit and is itself contained in HEAD: no schema-affecting
    commit lies between it and HEAD (the schema commit is the newest one), so its supergraph is HEAD's. A scheduled
    run on a later main commit therefore qualifies as well as the push run on the schema commit itself.
    """
    ok = [r for r in runs if r.get("conclusion") == "success" and r.get("headSha")
          and _is_ancestor(repo, schema_sha, r["headSha"]) and _is_ancestor(repo, r["headSha"], "HEAD")]
    return max(ok, key=lambda r: r.get("createdAt", ""), default=None)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--repo", required=True, help="owner/name for gh")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args(argv)
    repo = Path(args.repo_root)
    paths = push_paths((repo / WORKFLOW).read_text(encoding="utf-8"))
    sha = schema_commit(repo, paths)
    if sha is None:
        print("supergraph_unavailable: workflow_paths_unreadable")
        return 3
    listing = subprocess.run(
        ["gh", "run", "list", "-R", args.repo, "--workflow", Path(WORKFLOW).name, "--branch", "main",
         "--limit", "100", "--json", "databaseId,headSha,conclusion,createdAt"],
        capture_output=True, text=True,
    )
    if listing.returncode != 0:
        print("supergraph_unavailable: run_listing_failed")
        return 3
    run = pick_run(json.loads(listing.stdout or "[]"), sha, repo)
    if run is None:
        print(f"supergraph_unavailable: no_successful_run_for_schema_commit {sha[:12]}")
        return 3
    out = Path(args.out_dir)
    shutil.rmtree(out, ignore_errors=True)
    got = subprocess.run(["gh", "run", "download", str(run["databaseId"]), "-R", args.repo, "-n", ARTIFACT,
                          "-D", str(out)], capture_output=True, text=True)
    sdl = out / "supergraph.graphql"
    if got.returncode != 0 or not sdl.is_file():
        print(f"supergraph_unavailable: artifact_download_failed run={run['databaseId']}")
        return 3
    print(json.dumps({"supergraph": str(sdl), "schema_commit": sha, "run_id": run["databaseId"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
