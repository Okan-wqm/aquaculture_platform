# CI Full trigger and summary contract

**Date:** 2026-07-27
**Baseline:** `99afcff0`

## INFRA-HIGH-084 — full CI did not protect PR or main SHAs

`CI - Full` ran weekly, manually and for release tags. A pull request could therefore merge
without the full project matrix, and the merge commit itself had no full-CI evidence.

The workflow also grouped concurrency by `github.ref` and set `cancel-in-progress: true`.
Every main push shares `refs/heads/main`, so a later merge could cancel the exact-main SHA run
that was supposed to serve as protected release evidence.

The repair:

- triggers CI Full for pull requests targeting `main` and pushes to `main`;
- groups PR runs by PR number and all other runs by immutable SHA;
- cancels only superseded PR runs, never main/tag/scheduled SHA runs;
- gives the existing summary job the explicit stable context `build-status`;
- adds `build-status` to the required-status manifest and contracts it to every CI Full job;
- adds an invariant that parses the workflow and locks all trigger, concurrency and summary
  relationships.

No existing release-tag, schedule or manual trigger is removed.

## INFRA-HIGH-085 — concurrent capacity fixture writes split one logical record

The deploy capacity invariant launches four `du` workers concurrently. Its fake `du` executable
appended each base64 scope and its newline with two separate writes to one shared log. Under CI
load, another worker could append between those writes, so a real hostile scope invocation was
present but no longer occupied one complete line. The assertion then reported zero invocations
even though the production script behaved correctly.

The fixture now builds the encoded record first and appends the complete line with one `printf`.
This preserves the concurrency exercised by the test while making its observation boundary
atomic for records well below `PIPE_BUF`.

## INFRA-HIGH-086 — full-surface jobs raced while installing the Rust toolchain

CI Full launched all Nx lint, test, and build targets in parallel without first installing the
repository's pinned Rust toolchain. Multiple cargo-backed targets therefore invoked rustup
concurrently. Observed failures included a partial toolchain without cargo, failed component
directory replacement, and a partial toolchain without rustc.

Each full-surface job now installs Rust 1.88.0 and the required components and targets exactly
once before Nx starts. An invariant locks the action SHA, toolchain inputs, and ordering ahead of
all three full-surface commands.

## INFRA-HIGH-087 — full CI promoted historical format debt into a blocking gate

After lint, type-check, and the spec ratchet passed, CI Full ran the repository-wide legacy
`format:check` command. Main already contains thousands of files that predate the current
Prettier contract, so enabling CI Full on pull requests made unrelated historical debt block
every merge candidate.

CI Full now checks only Prettier-managed files changed by the PR or push. New files and files
that were clean at the comparison base must remain clean; an already non-conforming base file is
reported as quarantined debt instead of forcing an unrelated bulk rewrite. The comparison base
is the pull request base SHA or push `before` SHA; scheduled and manual runs fall back to the
parent of `HEAD`. The committed format-scope manifest remains authoritative, and an invariant
prevents the full-tree legacy command from returning to the required workflow.

## INFRA-HIGH-088 — full coverage omitted the shared Vitest provider

CI Full reached the complete test matrix with coverage enabled and exposed three workspaces that
invoke Vitest but cannot start coverage collection: `messaging-module`, `tenant-admin`, and
`@platform/mcp-farm-management`. All three stopped before test discovery because the reproducible
root installation did not contain `@vitest/coverage-v8`.

The root development contract now installs the V8 coverage provider at the exact version of the
root Vitest runner. This keeps one lockfile-governed provider for every npm workspace and makes
the same `test:all -- --coverage` command usable across the full matrix.

## PERF-HIGH-011 — MCP coverage repeated invariant chemistry calculations

After the missing provider was installed, the MCP risk report scenario reached test execution
and exceeded Vitest's five-second budget under coverage. Its TAN threshold search recalculated
the same pH-only H₂S, CO₂, and ammonia-fraction inputs for every TAN candidate—roughly 700,000
instrumented chemistry calls for one report.

The scenario now precomputes the fixed pH risk grid once, then varies only TAN in the inner
search. Search resolution, threshold selection, and report output remain unchanged; the fix
removes repeated work instead of weakening the test timeout.
