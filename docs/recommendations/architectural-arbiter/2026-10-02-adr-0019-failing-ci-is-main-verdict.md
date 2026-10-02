# ADR-0019 — FAILING_CI Means a Red Workflow Whose Verdict Is About `main` Itself

**Status:** proposed
**Date:** 2026-10-02
**Owner:** okan
**Decision deadline:** 2026-10-16
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-HIGH-256

## Context

`scan_failing_ci` (`aria-kernel/aria_kernel/plan_synthesizer.py`) supplies a candidate for every
workflow whose newest decisive run on `main` failed (ARIA-HIGH-250), and `failing_ci` ranks at
priority 1, above ORPHAN and F findings. The source has no notion of what a workflow judges. On
2026-10-02 eight workflows were red on `main`; several are observers (watchdogs, freshness probes,
the daily report) whose red is about an operational condition, not about the code on `main`, and
some workflows' verdicts are about pull requests. Each such red outranks every finding ARIA has.

A blanket exclusion by trigger is wrong: `e2e-tests.yml` runs on `workflow_run` after deploy and
its verdict IS about `main`.

## Proposal

- A role manifest under `.github/manifests/` classifies each workflow as `main_verdict`,
  `pr_verdict` or `observer`. An undeclared workflow counts as `main_verdict`, so a new workflow is
  never silently excluded.
- An invariant checks each declared role against the workflow's `on:` triggers (a `pr_verdict`
  workflow has a pull-request trigger; a `main_verdict` workflow runs on `main`).
- `scan_failing_ci` supplies candidates only for `main_verdict` workflows, and every red workflow
  it excludes is logged per cycle with its role, so an excluded red is visible, never dropped.
- The standing source priority does not change.

## Status of this record

Proposed, not decided. Nothing in the branch that records it implements it. Until it is decided, a
one-time operator decision outranks failing CI through the signed request channel (ADR-0018).
