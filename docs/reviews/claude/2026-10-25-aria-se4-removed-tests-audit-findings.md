# ARIA SE-4 removed-tests audit: finding (2026-10-25)

An independent audit of SE-4's removal of thirteen plan-coverage-witness tests (commit `91048d66c`,
branch `feat/aria-se4-one-closure`) found two behaviours whose only pin went with them and one
pinned at the reason-text level only. The test commit `06471404c` restores those pins, each shown to
fail under its mutation. The audit also found one point that is not about the removed tests and that
no test restores: a path-dependent skip in the project import scan. It is registered here as one
finding. Its path and line were re-read at `06471404c` and the probe was run again; every evidence
line holds.

## ARIA-MEDIUM-992

`impact_graph._scan_project_dependencies` skips a source file when any component of its absolute
path is node_modules, dist, build or coverage, so a workspace checked out under such a directory
gets no import edges, and the service-order cache then keeps that empty map for every later run of
the same layout

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-25. MEDIUM and not HIGH: no production
  workspace is known to live under such a path, and the effect is limited to the import edges; when
  it does happen the result is silent and persists in the cache.
- Raised by: the SE-4 removed-tests audit (incidental point); registered by the SE-4 removed-tests
  clerk.
- Plan item(s): SE-4 (service-expertise PLAN §8); found by the audit of 91048d66c's removed tests,
  not caused by it.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:932` (the skip test runs over `source.parts`, the
    absolute path, so every directory above the workspace counts as well as the ones below the
    project)
  - `aria-kernel/aria_kernel/impact_graph.py:928` (`project_root = root / meta["root"]` is absolute,
    so the rglob yields absolute paths)
  - `aria-kernel/aria_kernel/impact_graph.py:35-37` (NOT_THE_REPOSITORY, the one named set of
    directories that are not the repository's source, a second and different list from the four
    names at :932)
  - `aria-kernel/aria_kernel/impact_graph.py:880` (`_discover_projects` applies that set to
    directory names found below the root only)
  - `aria-kernel/aria_kernel/impact_graph.py:392-399` (`_graph_fingerprint` digests relative roots
    and tsconfig.base.json, never the workspace path)
  - `aria-kernel/aria_kernel/impact_graph.py:435-436` (a cached map with an equal fingerprint is
    returned without a scan)
  - `aria-kernel/aria_kernel/impact_graph.py:647-658` (`_project_graph`: with no nx graph file the
    dependencies are the local scan's)
  - `aria-kernel/aria_kernel/plan_coverage.py:388` (plan coverage calls impact_closure with no
    nx_graph_file, so it always takes the local scan)
- Rule: impact_closure's contract (service-expertise PLAN §3.3, the docstring at
  aria-kernel/aria_kernel/impact_graph.py:89-94): a change is never routed on a closure that is
  empty or partial for a reason the caller is not told. Import edges are a function of the tree, not
  of the directory it is checked out in, and nothing holds or reports the difference.
- Failure scenario: A workspace lives under a directory named build, dist, coverage or node_modules;
  this program's own handover tree is under `/root/aria-handover/2026-10-21/build/`, and the audit
  met it when fixture repositories created there gave empty import closures (four
  test_impact_closure failures). `_scan_project_dependencies` returns no dependency for any project,
  cached_service_analysis_order writes that map under a fingerprint that does not contain the path,
  and impact_closure for a change to libs/shared reaches none of the projects that import it.
  compute_plan_coverage hands the witness a node set without them, and the witness reports gaps
  against the nodes it is handed, so a plan that leaves those dependents out gets no gap for them.
  Nothing holds, refuses or says so, and the next run of the same layout from an ordinary path reads
  the same empty map from `<tools>/impact/service-order-cache.json` until the layout changes. A
  project's own dist, build or coverage directory is meant to be skipped; the path above the
  workspace is not a property of the project.
- Verified: Probe `/root/aria-handover/2026-10-21/build/SE-4/restore-pins/probe_workspace_path.py`,
  run at HEAD (production code unchanged by the tests commit): the SE-4 closure fixture tree, a
  change to libs/shared, depth 1. Plain path: `[token-lib]`. Workspace under build/, dist/,
  coverage/ or node_modules/: `[]`. Under a directory named cache: `[token-lib]`. First run under
  build/ and a second run from a plain path with one tools directory: `[]` both times (log:
  probe-workspace-path.log). The step from the empty closure to a plan passing without those
  dependents is read from the code (aria-kernel/aria_kernel/plan_coverage.py:388-410), not probed.
  git blame puts :932 at b2b6065ed, before SE-4; SE-4 (91048d66c) made plan coverage depend on the
  local scan.
- Related: ARIA-MEDIUM-862 (closure and service order read different graphs when an nx graph file is
  given); ARIA-LOW-873 (an absent subgraphs.json drops an edge kind silently: the same silence for
  another edge kind).
- Close condition: `_scan_project_dependencies` decides what to skip from each file's path relative
  to the project root, so a project's own node_modules, dist, build and coverage are still skipped
  and the directories above the workspace never count; its skip set is NOT_THE_REPOSITORY or a
  difference recorded next to it, not a second list. A cache file written by the old scan is not
  served after the change (the cache key or a version changes). Tests: the same fixture tree under a
  build/ directory and under a plain path gives the same impact_closure for a change to libs/shared
  (token-lib); a project's own dist/ source adds no edge; a cache written with an empty map under
  the old key is recomputed.
