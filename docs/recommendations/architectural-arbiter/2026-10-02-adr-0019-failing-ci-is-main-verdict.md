# ADR-0019 — FAILING_CI Means a Red Workflow Whose Verdict Is About `main` Itself

**Status:** proposed
**Date:** 2026-10-02 (role definitions corrected the same day after review round 2)
**Owner:** okan
**Decision deadline:** 2026-10-16
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-HIGH-256
**Refines:** ADR-0003 (`2026-05-20-adr-0003-aria-self-feed-deferred.md`), ARCH-HIGH-002

## Context

ADR-0003 ARCH-HIGH-002 defines what FAILING_CI stands for in the source order: "operator signal >
production breakage > all other auto-discovered sources". The slot is for production breakage.
`scan_failing_ci` (`aria-kernel/aria_kernel/plan_synthesizer.py`) supplies a candidate for every
workflow whose newest decisive run on `main` failed (ARIA-HIGH-250), and `failing_ci` ranks at
priority 1, above ORPHAN and F findings. The source has no notion of what a workflow judges. On
2026-10-02 eight workflows were red on `main`. Some of them compute their verdict from OTHER
workflows' runs (watchdogs, aggregators) — their red repeats a red the source already sees, or
reports that a schedule went stale. Some judge a pull request, not `main`.

Probes of production state are not in that group. WAL archive freshness and deploy capacity are
production breakage in ARCH-HIGH-002's sense, whatever the code on `main` looks like, and so is a
red `aria-daily-report`. A blanket exclusion by trigger is wrong too: `e2e-tests.yml` runs on
`workflow_run` after deploy and its verdict IS about `main`.

## Proposal

- A role manifest under `.github/manifests/` classifies each workflow:
  - `main_verdict` — the verdict is about `main` or about production: CI on `main`, post-deploy
    e2e, production probes (WAL archive freshness, deploy capacity), `aria-daily-report`;
  - `pr_verdict` — the verdict is about a pull request (for example `aria-readiness-claim`);
  - `observer` — the verdict is computed from OTHER workflows' runs (watchdogs, aggregators).
- An undeclared workflow counts as `main_verdict`, so a new workflow is never silently excluded.
- An invariant checks each declared role against the workflow's `on:` triggers (a `pr_verdict`
  workflow has a pull-request trigger; an `observer` reads other runs).
- `scan_failing_ci` supplies candidates only for `main_verdict` workflows, and every red workflow
  it excludes is logged per cycle with its role, so an excluded red is visible, never dropped.
- The standing source priority does not change (ADR-0003 decision item 5).

## Consequences

- Watchdog and aggregator staleness signals leave ARIA's candidate list: the failure they echo is
  planned from the workflow that actually failed, and their own red stays an operational signal in
  the per-cycle exclusion log.
- Production probes keep the FAILING_CI slot ARCH-HIGH-002 gives production breakage.
- A pull-request verdict no longer ranks as breakage of `main`.
- The losing side: every workflow added to the repository needs a role decision, or it counts as a
  verdict about `main`.

## Status of this record

Proposed, not decided. Nothing in the branch that records it implements it. Until it is decided, a
one-time operator decision outranks failing CI through the signed request channel (ADR-0018).
