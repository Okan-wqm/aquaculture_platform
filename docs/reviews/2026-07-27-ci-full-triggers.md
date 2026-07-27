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
