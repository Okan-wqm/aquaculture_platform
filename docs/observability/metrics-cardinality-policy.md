# Metrics Cardinality Policy

**Owner:** platform team (Okan-Wqm + SRE)
**Related ADRs:** ADR-032 (Rust binary supply-chain hardening — §Part A covers the Prometheus surface this policy governs)
**Related code:** `crates/observability/src/cardinality.rs`, sensor-ingestion emitter call sites
**Related runbooks:** `docs/runbooks/sensor-ingestion-deployment.md` §6 (operator scrape verification)
**Related findings:** `docs/reviews/orphan-findings.md#ORPHAN-017`

## Purpose

Every Prometheus label value adds a time series. Multi-tenant platforms that naively tag `tenant_id` onto every counter / gauge / histogram produce cardinality counts that match the tenant fleet — at 50 000 tenants × 10 metrics × a few histogram buckets that is 1.5 M active series, well beyond what a single Prometheus absorbs without dashboard timeouts and alert-evaluator lag.

This policy codifies how every Rust service emits tenant-scoped observability without blowing the scrape budget. The **default posture** is "no tenant label"; the **approved escape hatches** are bucketed and top-N, both documented below.

## Policy (authoritative)

### P1 — Default: no tenant-scoped label

Every metric ships without a `tenant_id` label unless §P2 or §P3 applies:

```rust
// Good: platform-wide counter, one series total.
metrics::counter!("sensor_ingestion_upsert_rows_attempted_total").increment(row_count);
```

### P2 — Bucketed tenant label

When the operator dashboard needs per-tenant resolution that is coarser than the fleet size, the emitter uses the `tenant_bucket` helper from `observability::cardinality`. The bucket is **256**, so the label adds one of 256 series per tenant-scoped metric, independent of fleet size:

```rust
use observability::cardinality::tenant_bucket;

let bucket = tenant_bucket(tenant_id);
metrics::counter!(
    "sensor_ingestion_outbox_dlq_total",
    "tenant_bucket" => bucket.to_string(),
).increment(1);
```

**Properties the helper guarantees (tests in `cardinality.rs` pin these):**

1. **Range** — always in `0..=255`.
2. **Deterministic** — the same tenant id maps to the same bucket in every region, every process restart; dashboard filters on `tenant_bucket="42"` see the same tenants everywhere.
3. **Uniform-ish** — 10 000 synthetic tenants distribute with stddev < 25% of the mean; the hash does not collapse traffic into a few hot buckets.

### P3 — Top-N per-tenant label (hot-tenant only)

For metrics where operators need raw `tenant_id` resolution (DoS investigation, calibration-drift alerting), the emitter maintains an in-memory top-N tracker and emits the `tenant_id` label **only** for the current top-N tenants. The long tail keeps the bucketed label (or no label at all).

The top-N tracker lives outside this module (lands alongside the emitter that uses it); the cardinality policy only codifies that the pattern exists and when it applies.

### P4 — Per-metric cardinality cap

Every metric the workspace emits stays under **1000 active series**. Breaches are caught by:

- **Build-time review:** adding a new emitter with an attacker-controllable label value (e.g. a user-supplied string) requires this policy's reviewer sign-off. The emitter call site MUST use one of the §P1-§P3 shapes.
- **Scrape-time check:** the `/metrics` endpoint exposes series counts per metric (standard Prometheus rendering). A dashboard panel (under `infrastructure/monitoring/prometheus/`) tracks per-metric series count; violations emit `sensor_ingestion_cardinality_breach_total` as a warning-level counter and fire a pager alert on sustained breach.

## Review checklist for new emitters

When adding `metrics::counter!` / `gauge!` / `histogram!` to the Rust workspace:

- [ ] Is the metric tenant-scoped? If no → **§P1** (no tenant label); done.
- [ ] Does the operator need per-tenant resolution? If no → **§P1**; done.
- [ ] Is per-tenant resolution coarse-enough for 256 buckets? If yes → **§P2** via `tenant_bucket(tid)`.
- [ ] Does the operator need raw `tenant_id` for a specific, bounded set (top-N, flagged tenants)? If yes → **§P3** via a top-N tracker.
- [ ] Does any label value come from untrusted input (user string, sensor payload field)? If yes → **stop and redesign**. Never emit a label whose cardinality the attacker can inflate.

## Why 256 buckets specifically

The plan (`snappy-sniffing-pine.md` Kör Nokta 4) fixes the bucket count at 256:

- Fits a `u8` so the label value is always a 1-3 character string (`"0"`..`"255"`).
- Small enough that a per-bucket alert rule fits on one dashboard panel.
- Large enough that the uniform hash distributes 50 000 tenants to ~200 per bucket, keeping each bucket's traffic statistically meaningful.
- Well below the platform-wide 1000-series-per-metric cap in §P4, leaving headroom for orthogonal labels (status code, region, tier) without breaching.

A future change that altered the bucket count constitutes a breaking change for dashboard queries filtered on `tenant_bucket`; raise it in an ADR revision, not an inline refactor.

## Relationship to existing metrics

At the time of this policy landing, sensor-ingestion emits 9 live metric contracts:

| Metric | Labels | Series count |
|---|---|---|
| `sensor_ingestion_upsert_rows_attempted_total` | (none) | 1 |
| `sensor_ingestion_cache_miss_spawn_total` | (none) | 1 |
| `sensor_ingestion_cache_miss_dedup_skip_total` | (none) | 1 |
| `outbox_dispatch_success_total` | (none) | 1 |
| `outbox_dispatch_failure_total` | (none) | 1 |
| `outbox_dlq_total` | (none) | 1 |
| `outbox_claim_batch_size` | (none, histogram) | histogram buckets |
| `outbox_pending` | (none, gauge) | 1 |
| `outbox_cleanup_deleted_total` | (none) | 1 |

Every one of these is §P1 — no tenant-scoped label. Total active series count is ~15 regardless of fleet size. A future emitter that needs tenant scope lands via §P2 (bucketed) or §P3 (top-N) without blowing this envelope.

## Operator actions during a cardinality breach

1. **Identify the offending metric** — Prometheus rendering shows per-metric series count; the metric exceeding 1000 is the one to investigate.
2. **Revert or re-label** — if the breach is from a freshly-deployed emitter, roll back the image and open a PR adjusting the label to §P2 / §P3.
3. **File incident finding** — add to `docs/reviews/orphan-findings.md` with the offending commit SHA + the emitter location so the review discipline absorbs the lesson.
4. **Verify scrape recovery** — `cosign tree` the re-deployed image first (ADR-032), then `docker compose up -d` / `kubectl rollout restart`, confirm `/metrics` series count drops under 1000, confirm Prometheus alert clears.
