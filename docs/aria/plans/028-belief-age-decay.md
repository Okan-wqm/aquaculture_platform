<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 028 — Time-based belief decay (D4)

> **Status:** Implemented (age-based belief decay). CVE / external-contract / ADR-supersession event triggers tracked as ARIA-028-D1.
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-023-D4 (belief decay was change-coupled only).

## Summary

Belief decay was purely evidence/change-coupled: `_apply_diff_to_existing_beliefs`
moves a belief to `needs_revalidation`/`stale` only when a **diff touches its
evidence**. A belief about code that simply never changes could stay `supported`
forever, even if it was last verified a year ago — and the world may have moved
(a dependency CVE, an upstream contract shift, a superseded ADR) without any
local diff. The age axis was missing.

## Implementation (tier-3 "make it detectable")

New `memory.decay_stale_beliefs_by_age(*, cycle_id, base_dir, ttl_days=90, now)`:
- A `supported` belief whose `verified_at` is older than `ttl_days` is moved to
  `needs_revalidation` (or `stale` once the revalidation-cycle ceiling is
  crossed), with `stale_reason = "age decay, code unchanged"`. It reuses the
  `_stamp_belief_freshness` chokepoint and the existing `needs_revalidation`
  machinery — and `run_pressure` already turns `needs_revalidation` beliefs into
  operator pressure, so the aged belief surfaces without new plumbing.
- Only `supported` beliefs are decayed; once a belief is already
  `needs_revalidation`/`stale`/`contradicted`/`withdrawn` the existing machinery
  owns it, so age-decay bumps each belief at most once (idempotent across cycles
  until re-verified).
- Wired as a per-cycle phase **between `memory` and `pressure`** so a freshly
  aged belief becomes pressure in the same cycle. Skipped under shadow/discovery
  no-write runs; surfaced on `state["belief_decay"]`.

## Acceptance

- A `supported` belief past the TTL decays to `needs_revalidation`; a fresh one
  stays `supported`.
- Non-`supported` beliefs are left alone; decay is idempotent once a belief is
  revalidating. Test: `tests/test_belief_age_decay.py`.

## Deferred — ARIA-028-D1 (owner: aria-core, due 2026-09-25)

The **event-based** triggers — a dependency CVE, an external API/contract change,
or an ADR superseding the belief's basis invalidating a belief whose code is
unchanged — need external signal feeds (CVE database, ADR-supersession events).
That overlaps the runtime-signal bridge (ARIA-023-D5); the age trigger here is
the fully-internal, zero-dependency half of belief decay and the foundation those
event triggers will plug into (they would call the same `needs_revalidation`
transition with a different `stale_reason`).
