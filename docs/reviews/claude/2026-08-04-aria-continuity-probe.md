# The continuity gate would have frozen ARIA's first live night

Date: 2026-08-04
Branch: `claude/aria-cutover-ceremonies`
Scope: `aria-kernel/aria_kernel/memory_gap.py`, `aria-kernel/aria_kernel/cycle.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1, PR 2.6c

## The defect

`_phase_state_continuity` asks whether the tree this cycle opened on descends
from the last state anyone can attest to. After the lane cutover it answers
**critical** on a perfectly healthy tree, on the first cycle, every time. Two
independent faults, either sufficient alone:

**The probe walks one root; the reference covers three.** The phase built its
snapshot with `roots={"tools": base_dir}`. `resolve_continuity_reference` now
returns the published snapshot, which covers tools, workspace and repo.
`snapshot_continuity` computes `lost_surfaces` as reference-minus-current, so
all sixteen workspace- and repo-root surfaces the store publishes read as lost.

**A probe can never satisfy the linkage test.** The probe is built fresh with no
`previous`, so `prev_manifest_root` is `None`, so `snapshots_are_linked` returns
False — for every tree that has ever existed. `chain_broken`.

`blocks_action` is true for `critical`, so `freeze_autonomous_writes` trips the
`state_integrity_gap` breaker, and `_cycle_preflight` refuses every subsequent
cycle. The first real nightly would have declared amnesia and stopped.

Reproduced against real git before the fix:

```
STATUS: critical    blocks_action: True
reasons: ('state_continuity_chain_broken:...got_prev=None',
          'state_continuity_surfaces_lost:repo_finding_index')
```

## Why it was invisible

`resolve_continuity_reference` returned `None` on every lane. No store was
checked out, and the committed daily anchors all predate the
`state_manifest_root` field. With no reference the verdict is `unknown`, which
blocks nothing — PROGRESS.md records it as "the gate reports `unknown` every
night". The cutover created the reference, and both faults went live in the same
instant.

This is the third control this programme has found that was correct until its
input existed. The pattern is worth naming because it keeps producing CRITICALs
that no test caught: **a gate that has never had a real input proves nothing
about the same gate once it has one.**

## The fix

**Probe roots follow the store.** `continuity_probe_roots` returns
`store_roots(...)` when a store is bound and the tools root when it is not.
Imported rather than restated, for the reason `store_environment`'s own
docstring gives: three roots have to agree, and a second copy of that mapping is
how two come out right and the third is silently wrong.

**Descent is measured where it is decided.** `store_is_at_published_tip`
compares the store worktree's `HEAD` against the remote tip. `publish_state`
pushes fast-forward-only and `checkout_state_store` establishes the worktree at
the tip, so a tree whose HEAD is the tip provably continues the published
history — one git comparison, no inference.

The rejected alternative is worth recording: passing the reference in as
`previous` so the linkage test passes. That would have made the gate assert the
very thing under examination — green, vacuous, and indistinguishable from
correct.

**The transport answers descent and only descent.** The proof replaces the
linkage half; the lost-surface half is untouched, because loss is the question
no transport can answer and the one the gate actually exists for. A refusal now
names both SHAs (`head=X tip=Y`) instead of "chain broken" — the difference
between a diagnosis and a fetch away from fixed.

## Verification

Five behavioural tests, plus two on the probe roots:

- a tree at the published tip is continuous;
- **the regression itself**: the same probe is critical without the proof and ok
  with it, asserted in one test so the two cannot drift apart;
- **the negative control**: a store behind the tip is still caught, and both
  SHAs appear in the reason. A proof that could only say yes would be the check
  deleted, which is the one outcome worse than the false alarm it replaced;
- surface loss still fires under a proven descent;
- an anchor reference keeps the linkage test it was designed for.

Mutation-checked three ways — ignoring the proof, a proof hardcoded to `True`,
and reverting the probe roots — each fails the suite (2, 2 and 3 failures).

## Findings

- **ORPHAN-CRITICAL-549** — registered here; the close ceremony rides the next
  PR (PROC-HIGH-001: `close` refuses branch-local SHAs).

## Validation limit

Verified locally against real git repositories, and **unexercised** on the
self-hosted runner, exactly like the cutover it repairs. The first real nightly
remains the only evidence that matters.

Owner: okan
