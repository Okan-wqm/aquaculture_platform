# Development deploy stall — 2026-09-27

No image has reached the development server since 2026-09-21 (run 35554918873,
head 34db380f9). Every push to `main` since then ran CI - Affected red, and
the development image build or deploy was skipped or refused each time. Four
consecutive main runs were read job by job; three separate causes stop the
train, and two of them are defects this review registers.

| Run         | Head      | Stopped at                                | Cause                                       |
| ----------- | --------- | ----------------------------------------- | ------------------------------------------- |
| 36229686022 | fb500d369 | `deploy-development / capacity-preflight` | disk (INFRA-HIGH-189)                       |
| 36324244294 | 6346dc77a | `deploy-development / capacity-preflight` | disk (INFRA-HIGH-189)                       |
| 36336238308 | bd8d2c6f5 | `test` → `invariants:test`                | closure drift, healed by the reconcile lane |
| 36336983658 | f2778c904 | `test` → `sensor-ingestion:test`          | test race (SENSOR-MEDIUM-128)               |

The third cause is the finding-closure-drift invariant failing the push of a
commit that carries a `Closes:` trailer until the closure-reconcile lane lands
its follow-up. That lane owns closure by design and healed it within twelve
minutes (#1679); it is not a defect of this review.

## INFRA-HIGH-189 — the capacity gate cannot reclaim Docker's build cache

Runs 36229686022 and 36324244294 passed every test and built every image, then
`scripts/deploy/droplet-capacity.sh gate` refused the deploy:

```text
disk_preflight_low_bytes path=/ free_bytes=32638791680 hard_free_bytes=37580963840
disk_preflight_low_percent path=/ free_pct=13 hard_free_pct=20
disk_preflight_projected_low path=/ projected_free_bytes=11163955200 reserve_bytes=21474836480
Safe GC complete; removed_tags=0 ... skipped_protected=77 ... reclaimed_bytes=0 capacity_target_met=false
```

The gate answers a shortfall with two reclaim passes: `safe_image_gc` (unused
app images and superseded rollback retags) and `safe_tmp_gc` (regenerable
caches in TMPDIR). Every image on the droplet was protected, and TMPDIR held
little, so both reclaimed nothing. The space was in a store neither pass may
touch — `docker system df` on the droplet:

```text
Build Cache   34.64GB   (19.36GB reclaimable)
Images        32.72GB   (7.67GB reclaimable, all protected)
Local Volumes 43.43GB
```

The droplet runtime is pull-only (ADR-033): every service image comes from
GHCR, and CI builds with registry-backed caches (`cache-to: type=registry`).
Local build cache is therefore regenerable by construction and read by no
deploy. A gate that blocks on disk and cannot reclaim a regenerable store turns
a cache into a standing outage; that is the defect.

**Fix.** A third reclaim pass, `safe_build_cache_gc`, runs `docker builder
prune` over unused build cache older than an age floor (24 h by default), so an
in-flight build keeps its layers; Docker refuses to remove cache a running build
holds. It touches no image, container, volume or network. The gate runs it
between the image and temp passes and stops as soon as the capacity target is
met; the six-hourly maintenance workflow reaches it through the same `gate`
entry. `tools/gates/capacity-build-cache-gc.spec.ts` runs the real function
against a recording `docker` stub and pins the prune arguments, the dry run,
the refusal of every other Docker store, and that the gate calls it.

Not addressed here, and recorded for the owner: Docker volumes grew by about
8 GB in one day (35.4 → 43.4 GB) and a dozen `/var/aqua-wt-*` session worktrees
hold about 2 GB each. Both are data or work products, which no automatic
sweeper may take; they are operator decisions.

## SENSOR-MEDIUM-128 — the live policy test reads the disk before the write

Run 36336983658 failed `sensor-ingestion:test`:

```text
thread 'policy_subscriber_applies_live_change_event' panicked at
apps/sensor-ingestion/tests/policy_integration.rs:250:10:
subscriber persisted snapshot after apply
```

The same test passed twenty minutes earlier on bd8d2c6f5. `apply_change_message`
applies the change to the in-memory policy first and then persists the snapshot
with an atomic rename; that order is deliberate, because persistence is a
durability optimisation and the in-memory policy is authoritative for the
running process. The test waited only for the in-memory backend to flip and then
read the file, so on a busy runner it could read before the rename landed.

**Fix.** The test waits, within the same budget, for the observable it asserts:
the persisted snapshot carrying the migrated tenant's override. Production code
is unchanged.
