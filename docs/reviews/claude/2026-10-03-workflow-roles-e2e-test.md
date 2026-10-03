# main red on a test that named a deleted workflow (2026-10-03)

Owner: claude. Deadline 2026-10-05.

## ARIA-HIGH-334

The workflow roles manifest test pinned `roles["E2E Tests"] == "main_verdict"`
(`aria-kernel/tests/test_failing_ci_main_verdict.py:199`). main deleted
`.github/workflows/e2e-tests.yml` in 68f120105 (the E2E lane moved off the production host), and the manifest
entry was removed in PR #1734 (fe419d9ef) so the ADR-0019 invariant would pass. The kernel test was not run by that
PR's CI, so main went red after the merge (20:53Z); a pre-push suite on another branch caught it.

Rule: a test pins live repository facts, and a PR is not merged while a test whose inputs it changes is red.

Fix: the test now pins the live workflow_run-triggered lane that judges main (`aria-agent-executor`) and asserts the
deleted lane is absent. Not done here: making the kernel suite run on manifest-only PRs (the reason CI missed it).
