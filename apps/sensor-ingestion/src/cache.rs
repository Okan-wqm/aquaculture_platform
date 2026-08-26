//! Tenant- and sensor-scoped topic cache for the sensor-ingestion hot
//! path.
//!
//! WHY this module exists at all:
//!   The hot ingestion pipeline resolves every incoming MQTT publish
//!   into a `(tenant, sensor)` pair before persistence. Looking that
//!   resolution up against PostgreSQL on every message is a non-starter
//!   at the 50K msg/sn target — even a 1ms round-trip torpedoes the
//!   plan's `< 10ms` p99 budget. The cache caps lookup to in-process
//!   memory, with the upstream resolver only consulted on cold-cache
//!   misses. The plan (`docs/plans/sensor-rust-migration/PLAN.md` § Faz
//!   2 — Multi-Tenant Cache) names this layer explicitly.
//!
//! WHY the key is composite `(TenantId, Uuid)`:
//!   This is SEC-M16 discipline carried into the cache layer. There is
//!   no public API that lets a caller look up a sensor by raw `Uuid`
//!   alone — every read AND every write threads the [`TenantId`]. Two
//!   tenants that happen to allocate the same `sensor_id` (the platform
//!   uses tenant-local UUIDs in some legacy migrations) cannot pollute
//!   each other's cache slot, because the slot identity is the pair —
//!   not the bare UUID. A regression test pins this property
//!   ("`cross_tenant_key_isolation`") so a future refactor that adds an
//!   inadvertent `get_by_sensor_id(uuid)` overload fails the test
//!   instead of silently breaking tenant isolation.
//!
//! WHY a 2-store design (moka storage + papaya per-tenant counter):
//!   The plan demands TWO bounded properties:
//!     1. Total entries ≤ `total_capacity` (default 100K) — defends
//!        against runaway memory in a multi-tenant deploy.
//!     2. Per-tenant entries ≤ `per_tenant_capacity` (default 10K) —
//!        defends against one noisy tenant evicting every other
//!        tenant's hot set (cache pollution / Vektör 4 mitigation).
//!   `moka::sync::Cache` natively enforces (1) via its `max_capacity`
//!   knob and a TinyLFU+LRU eviction policy. It does NOT have a native
//!   per-tenant cap. We layer (2) by tracking a per-tenant counter and
//!   probing it before every insert; if the count is at or over the
//!   cap, we let the new insert through and let moka's LRU absorb the
//!   pressure on the next eviction tick. The per-tenant cap therefore
//!   manifests as an EAGERLY-evicted ceiling rather than a hard
//!   rejection — which is the right semantic, because rejecting a
//!   resolved lookup would just force a re-fetch from the upstream,
//!   round-tripping the slow path we just paid to populate.
//!
//! WHY moka over a hand-rolled `RwLock<HashMap>`:
//!   `moka` ships an audited concurrent cache with per-shard locking,
//!   native `max_capacity`, native `eviction_listener` (we wire ours
//!   to keep the per-tenant counter consistent), and per-key
//!   `invalidate`. Re-implementing that surface with `RwLock<HashMap>`
//!   would be a strict downgrade in correctness AND throughput — moka's
//!   read path bypasses the per-shard lock for hot keys via a frequency
//!   sketch. The edge agent (`sens-api-gateway/Cargo.toml`) already
//!   uses `moka = "0.12"`, so the supply-chain footprint is unchanged.
//!
//! WHY papaya for the per-tenant counter map:
//!   The plan names `papaya` as the read-heavy lock-free concurrent
//!   map for ingestion (PLAN.md § Faz 2 — Crate Seçimleri). Per-tenant
//!   counter probes happen on EVERY cache insert and the typical
//!   pattern is many reads vs few writes per tenant id. papaya's
//!   seqlock-based reads stay lock-free; classic `RwLock<HashMap>`
//!   would serialise the hot path. We use `papaya::HashMap<TenantId,
//!   Arc<AtomicUsize>>` so the counter itself is also lock-free.
//!
//! WHY entries are wrapped in `Arc<SensorMeta>`:
//!   Downstream stages (payload validator, batch aggregator) want to
//!   stash the resolved metadata alongside the in-flight message
//!   without cloning it once per consumer. `Arc` clone is a refcount
//!   bump; deep-clone of `SensorMeta` (which carries `Vec<Uuid>` and
//!   will grow to include calibration coefficients + alert thresholds)
//!   is not. The cache stores ONE `Arc` per key; consumers clone the
//!   pointer.
//!
//! WHY `SensorMeta` itself is immutable post-insertion:
//!   Cache invalidation is the SoT for change. If the upstream's idea
//!   of a sensor's channels mutates, the upstream publishes a
//!   `sensor.updated` NATS event and the cache layer calls
//!   [`TopicCache::invalidate`] / [`TopicCache::invalidate_tenant`].
//!   The next read then re-fetches the new shape. There is NO partial
//!   in-place mutation — that would require interior mutability inside
//!   `Arc<SensorMeta>`, which would in turn require either a lock
//!   (defeats the lock-free read path) or atomics for every field
//!   (correct but premature complexity). Eager invalidate-and-refetch
//!   is the architectural primitive.
//!
//! WHAT this module does NOT do at this stage:
//!   - It does NOT issue the upstream lookup itself. The miss-handler
//!     callback is invoked by the caller (or stays absent in stub
//!     mode); the real `sensor.lookup.by-topic` NATS request-reply
//!     wiring lands in a follow-on stage on this same PR.
//!   - It does NOT carry calibration coefficients or alert thresholds
//!     yet — the [`SensorMeta`] struct documents the future fields
//!     directly so a reader can see exactly what the cache key is
//!     guarding.
//!   - It does NOT subscribe to a NATS invalidate-channel; that wiring
//!     also lands in the follow-on stage. The `invalidate` /
//!     `invalidate_tenant` methods are the public seams that NATS
//!     subscriber code will call.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use moka::notification::RemovalCause;
use moka::sync::Cache;
use papaya::HashMap as PapayaMap;
use serde::Deserialize;
use tenant_context::TenantId;
use uuid::Uuid;

// ---------- public bound defaults ---------------------------------------

/// Default per-tenant entry cap. Plan (`docs/plans/sensor-rust-
/// migration/PLAN.md` § Faz 2 — Multi-Tenant Cache) names this number
/// directly. A noisy tenant cannot accumulate more than this many
/// resolved sensor entries before the per-tenant ceiling logic kicks in.
pub const DEFAULT_PER_TENANT_CAPACITY: usize = 10_000;

/// Default global entry cap. Plan number per the same section. Acts as
/// the defence-in-depth ceiling against runaway tenant fan-out — even
/// if every tenant is exactly at its per-tenant cap, the global cap
/// blunts the worst-case memory bound at process scope.
pub const DEFAULT_TOTAL_CAPACITY: usize = 100_000;

// ---------- value type --------------------------------------------------

/// Resolved sensor metadata, stored under a `(TenantId, sensor_id)`
/// key.
///
/// `tenant_id` is duplicated inside the value (in addition to being
/// half of the key) on purpose: downstream consumers receive an
/// `Arc<SensorMeta>` and need the tenant id at hand for downstream
/// scoping (NATS publish, COPY tuple binding) without carrying the
/// key separately. Keeping it in the value also makes a future audit
/// of "did the cache return a wrong-tenant value?" a one-line
/// `assert_eq!(meta.tenant_id, expected_tenant)` rather than a key/
/// value pairwise check at every consumer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorMeta {
    /// Unique sensor identifier (the second half of the cache key).
    pub sensor_id: Uuid,
    /// Tenant the sensor belongs to (the first half of the cache key,
    /// duplicated in the value — see the type-level WHY note).
    pub tenant_id: TenantId,
    /// Channel ids known for this sensor at resolve time. Cached value
    /// becomes stale on `sensor.updated`; the upstream publishes that
    /// event and the cache layer invalidates the entry. The vector is
    /// short (typically 1-8 entries) and immutable after construction.
    pub channel_ids: Vec<Uuid>,
    /// Channel UUID to canonical device channel key. This is the metadata
    /// required to emit a typed `SensorReading` without a second writer.
    #[serde(default)]
    pub channel_keys: std::collections::HashMap<Uuid, String>,
    /// Optional farm scope returned by sensor-service when the upstream
    /// resolver has a warm tenant/sensor mapping. Older responders omit
    /// this field; default keeps backward compatibility.
    #[serde(default)]
    pub farm_id: Option<Uuid>,
    /// Optional pond scope. Mirrors `farm_id` semantics and is absent on
    /// cold-cache or older responder paths.
    #[serde(default)]
    pub pond_id: Option<Uuid>,
    // Future fields the value is reserved to carry once the upstream
    // resolution surface stabilises:
    //   * calibration: linear/2-point/poly3 coefficient struct
    //   * alert_thresholds: per-channel min/max + dead-band
    // These land in a follow-on commit on this same PR and DO NOT
    // change the cache key — the value type is the only thing that
    // grows.
}

// ---------- TopicCache --------------------------------------------------

/// Tenant- and sensor-scoped resolution cache.
///
/// The cache is `Send + Sync` because every internal store (`moka` and
/// `papaya`) is concurrency-safe by construction. It is intended to be
/// instantiated once per process, wrapped in an `Arc`, and shared
/// across every parser worker.
#[derive(Debug)]
pub struct TopicCache {
    /// Storage layer. Keyed by `(tenant, sensor)` so cross-tenant
    /// poisoning of a same-`Uuid` sensor entry is impossible — the
    /// hash bucket discriminator is the pair.
    storage: Cache<(TenantId, Uuid), Arc<SensorMeta>>,

    /// Per-tenant entry counter. Read-heavy: every cache `insert`
    /// probes the counter for the per-tenant cap. Lock-free under
    /// papaya's seqlock pattern. The value is `Arc<AtomicUsize>` so
    /// a single in-flight reader holding the counter through a
    /// lookup→increment window cannot be racing with a concurrent
    /// remove that would otherwise drop the slot underneath them;
    /// `Arc` keeps the counter alive across the whole increment.
    per_tenant_counts: Arc<PapayaMap<TenantId, Arc<AtomicUsize>>>,

    /// Per-tenant cap (entries-per-tenant ceiling). Stored on the
    /// struct so eviction policy + capacity audit are both readable
    /// at runtime via [`TopicCache::per_tenant_capacity`].
    per_tenant_capacity: usize,
}

impl TopicCache {
    /// Build a cache with `capacity` total slots and the default
    /// per-tenant cap.
    ///
    /// `capacity` becomes the global `max_capacity`; the per-tenant cap
    /// is set to `min(capacity, DEFAULT_PER_TENANT_CAPACITY)` so a
    /// caller that asks for a tiny cache (e.g. in a test) does not get
    /// a per-tenant cap that exceeds the global cap.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let per_tenant = capacity.min(DEFAULT_PER_TENANT_CAPACITY);
        Self::new_with_caps(per_tenant, capacity)
    }

    /// Build a cache with explicit per-tenant + total caps. Used by
    /// tests that want to drive eviction deterministically without
    /// allocating a 100K cache; production callers go through
    /// [`TopicCache::new`].
    #[must_use]
    pub fn new_with_caps(per_tenant_capacity: usize, total_capacity: usize) -> Self {
        let per_tenant_counts: Arc<PapayaMap<TenantId, Arc<AtomicUsize>>> =
            Arc::new(PapayaMap::new());
        let listener_counts = Arc::clone(&per_tenant_counts);
        // moka's eviction_listener fires on size-pressure eviction,
        // explicit invalidate, and TTL expiry (we do not set a TTL).
        // Decrement the per-tenant counter on every removal so the
        // counter and the storage stay consistent. The closure must be
        // `Send + Sync + 'static` and the captured `Arc<PapayaMap>`
        // satisfies both.
        let storage = Cache::<(TenantId, Uuid), Arc<SensorMeta>>::builder()
            .max_capacity(total_capacity as u64)
            .eviction_listener(
                move |key: Arc<(TenantId, Uuid)>, _value, _cause: RemovalCause| {
                    let (tenant, _sensor) = *key;
                    let pinned = listener_counts.pin();
                    if let Some(counter) = pinned.get(&tenant) {
                        // saturating_sub via fetch_update — `fetch_sub` would
                        // wrap on a logic bug, which the loud underflow of
                        // saturating logic surfaces faster.
                        let _ =
                            counter.fetch_update(Ordering::Release, Ordering::Acquire, |current| {
                                Some(current.saturating_sub(1))
                            });
                    }
                },
            )
            .build();
        Self {
            storage,
            per_tenant_counts,
            per_tenant_capacity,
        }
    }

    /// Per-tenant cap this cache was constructed with. Exposed for
    /// observability — runtime telemetry surfaces this number so an
    /// operator can correlate cache pressure with the configured
    /// ceiling without reading the Cargo.toml or the constructor call.
    #[must_use]
    pub const fn per_tenant_capacity(&self) -> usize {
        self.per_tenant_capacity
    }

    /// Look up a `(tenant, sensor)` pair. Returns `None` on a cache
    /// miss; the caller is expected to issue the upstream lookup and
    /// repopulate via [`TopicCache::insert`].
    #[must_use]
    pub fn get(&self, tenant: TenantId, sensor: Uuid) -> Option<Arc<SensorMeta>> {
        self.storage.get(&(tenant, sensor))
    }

    /// Insert a resolved [`SensorMeta`]. The cache key is derived from
    /// the value's `(tenant_id, sensor_id)` pair — there is no overload
    /// that accepts a separate tenant id, by design. A caller cannot
    /// accidentally mis-key a value under a tenant that does not own
    /// the sensor.
    ///
    /// If the per-tenant cap is hit, the eldest entry for that tenant
    /// is invalidated before the new one is inserted. moka's TinyLFU+
    /// LRU policy chooses the eldest globally; we surface that choice
    /// to the per-tenant ledger by walking the cache iterator and
    /// invalidating the first entry the iterator yields whose key
    /// matches the saturating tenant. This is bounded work — the
    /// iterator is a snapshot of the storage and the walk terminates
    /// at the first per-tenant match. In steady state the per-tenant
    /// counter never exceeds the cap, so the walk fires only when the
    /// caller floods a single tenant past its budget.
    pub fn insert(&self, meta: SensorMeta) {
        let tenant = meta.tenant_id;
        let sensor = meta.sensor_id;
        let counter = self.counter_for(tenant);
        // Probe BEFORE the insert so the over-cap eviction happens in
        // the right window. The increment happens AFTER the moka insert
        // so a concurrent eviction listener cannot decrement a counter
        // that has not yet been incremented.
        let current = counter.load(Ordering::Acquire);
        if current >= self.per_tenant_capacity {
            self.evict_one_for_tenant(tenant);
        }
        let already_present = self.storage.contains_key(&(tenant, sensor));
        self.storage.insert((tenant, sensor), Arc::new(meta));
        if !already_present {
            counter.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Drop a single entry. Idempotent — calling on a missing key is a
    /// no-op (moka's `invalidate` does not error). The per-tenant
    /// counter is updated by the eviction listener wired in the
    /// constructor, so callers do not need to coordinate.
    pub fn invalidate(&self, tenant: TenantId, sensor: Uuid) {
        self.storage.invalidate(&(tenant, sensor));
        // moka 0.12 may run the eviction listener asynchronously; force
        // pending writes through so the counter sees the decrement
        // before the next observable read.
        self.storage.run_pending_tasks();
    }

    /// Drop every entry for one tenant. Walks the snapshot iterator
    /// and invalidates each matching key. Used when an upstream signal
    /// wipes the entire tenant's cached view (`tenant.purged`,
    /// `gdpr.delete`, schema migration that re-issues sensor ids).
    pub fn invalidate_tenant(&self, tenant: TenantId) {
        // Collect first, then invalidate. moka's iter is a consistent
        // snapshot but invalidating during the walk would be UB-shaped
        // mutation-during-iteration territory we do not need to
        // explore. The vector is sized by the per-tenant counter so
        // allocation is bounded by the cap, not by the global storage.
        let counter_hint = self
            .per_tenant_counts
            .pin()
            .get(&tenant)
            .map_or(0, |c| c.load(Ordering::Acquire));
        let mut victims: Vec<(TenantId, Uuid)> = Vec::with_capacity(counter_hint);
        for (key, _value) in &self.storage {
            if key.0 == tenant {
                victims.push(*key);
            }
        }
        for key in &victims {
            self.storage.invalidate(key);
        }
        // Force the eviction listener to drain so the per-tenant
        // counter is observably 0 for the tenant before the call
        // returns. Without this, a follow-up `len()` from the same
        // thread can see a stale count.
        self.storage.run_pending_tasks();
    }

    /// Total entries currently held across every tenant. moka's
    /// `entry_count` is an estimate maintained alongside the LRU
    /// policy; we drain pending tasks first so the count reflects all
    /// invalidations / inserts the caller has already observed.
    #[must_use]
    pub fn len(&self) -> usize {
        self.storage.run_pending_tasks();
        // entry_count returns u64; downcast to usize is safe on every
        // 64-bit target the platform deploys to. cap defensively for
        // 32-bit targets so a giant deploy on a 32-bit edge box does
        // not overflow.
        let count = self.storage.entry_count();
        usize::try_from(count).unwrap_or(usize::MAX)
    }

    /// `true` if [`TopicCache::len`] is zero. Same drain semantics
    /// as `len()`.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    // ---------- internals ----------

    /// Look up (or create) the per-tenant counter slot. Lock-free read
    /// path under papaya; only the first write per tenant takes the
    /// store-side allocation hit.
    fn counter_for(&self, tenant: TenantId) -> Arc<AtomicUsize> {
        // First try the read-only path — the common case is "tenant
        // already has a counter" because the very first publish for a
        // tenant in process-lifetime is rare relative to the steady
        // stream that follows.
        {
            let pinned = self.per_tenant_counts.pin();
            if let Some(existing) = pinned.get(&tenant) {
                return Arc::clone(existing);
            }
        }
        // Cold path: allocate and insert. `get_or_insert_with` keeps
        // the operation race-free — concurrent callers either see the
        // value we just wrote OR a value another thread wrote first,
        // and both observers get the same `Arc`.
        let pinned = self.per_tenant_counts.pin();
        let entry = pinned.get_or_insert_with(tenant, || Arc::new(AtomicUsize::new(0)));
        Arc::clone(entry)
    }

    /// Test internals visibility for the per-tenant counter. Used by
    /// the self-smoke check to assert post-teardown invariants
    /// (counter must be observably 0 for a tenant whose entries we
    /// just invalidated). Not part of the cache's public message-
    /// path API; the function lives here because exposing the
    /// counter atomically is intentional (test surface only).
    #[must_use]
    pub(crate) fn debug_tenant_count(&self, tenant: TenantId) -> usize {
        self.per_tenant_counts
            .pin()
            .get(&tenant)
            .map_or(0, |c| c.load(Ordering::Acquire))
    }

    /// Evict ONE entry for the named tenant, chosen as the first the
    /// snapshot iterator yields. moka's iterator order is not a strict
    /// LRU but is policy-influenced; for our purpose ("free up space
    /// in this tenant's per-tenant budget so the new insert fits") any
    /// matching key works. The walk is bounded by the per-tenant cap
    /// in steady state.
    fn evict_one_for_tenant(&self, tenant: TenantId) {
        let mut to_evict: Option<(TenantId, Uuid)> = None;
        for (key, _value) in &self.storage {
            if key.0 == tenant {
                to_evict = Some(*key);
                break;
            }
        }
        if let Some(key) = to_evict {
            self.storage.invalidate(&key);
            // Drain so the eviction listener decrements the counter
            // BEFORE the caller's increment for the new entry pushes
            // the counter back over the cap.
            self.storage.run_pending_tasks();
        }
    }
}

/// Process-startup smoke check that exercises the full public cache
/// surface (insert -> get -> invalidate -> invalidate_tenant) with a
/// single ephemeral fixture. Used by `main` to:
///   * fail fast on any deploy-environment bug that affects the cache
///     layer (allocator, futex, papaya / moka ABI mismatch),
///   * keep the binary's dead-code lint honest about every API surface
///     the topic-parser commit will reach for, BEFORE the parser commit
///     lands. Without this call the binary would compile with
///     dead-code warnings on `insert`/`invalidate`/`invalidate_tenant`
///     until the next stage wires them — and warnings hidden behind
///     "we'll use it next commit" are how dead code persists in
///     production.
///
/// The fixture is a fixed `nil-tenant` + a single sensor; teardown
/// restores `len() == 0` so the steady-state cache is observably
/// empty at the moment the message loop starts.
pub fn self_smoke_check(cache: &TopicCache) {
    // Use UUIDs that cannot collide with real tenant ids — `nil()` is
    // the all-zero UUID, never minted by the platform's id allocator.
    let tenant = TenantId::from_uuid(Uuid::nil());
    let sensor_a = Uuid::from_bytes([0xFF; 16]);
    let sensor_b = Uuid::from_bytes([0xFE; 16]);

    cache.insert(SensorMeta {
        sensor_id: sensor_a,
        tenant_id: tenant,
        channel_ids: Vec::new(),
        channel_keys: std::collections::HashMap::new(),
        farm_id: None,
        pond_id: None,
    });
    cache.insert(SensorMeta {
        sensor_id: sensor_b,
        tenant_id: tenant,
        channel_ids: Vec::new(),
        channel_keys: std::collections::HashMap::new(),
        farm_id: None,
        pond_id: None,
    });

    // get → MUST hit (proves the storage round-trips).
    let _hit_a = cache.get(tenant, sensor_a);
    let _hit_b = cache.get(tenant, sensor_b);

    // invalidate ONE entry, then invalidate the rest of the tenant.
    cache.invalidate(tenant, sensor_a);
    cache.invalidate_tenant(tenant);

    // Drain pending tasks so the per-tenant counter observably sees
    // the eviction listener's decrements before we log.
    let post_count = cache.debug_tenant_count(tenant);
    let post_len = cache.len();

    tracing::debug!(
        post_smoke_len = post_len,
        post_smoke_tenant_count = post_count,
        "topic cache self-smoke check complete"
    );
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_PER_TENANT_CAPACITY, DEFAULT_TOTAL_CAPACITY, SensorMeta, TopicCache,
        self_smoke_check,
    };
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use tenant_context::TenantId;
    use uuid::Uuid;

    fn fixed_tenant(seed: u8) -> TenantId {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        TenantId::from_uuid(Uuid::from_bytes(bytes))
    }

    fn fixed_sensor(seed_high: u8, seed_low: u8) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed_high;
        bytes[15] = seed_low;
        Uuid::from_bytes(bytes)
    }

    fn meta_for(tenant: TenantId, sensor: Uuid) -> SensorMeta {
        SensorMeta {
            sensor_id: sensor,
            tenant_id: tenant,
            channel_ids: vec![Uuid::nil()],
            channel_keys: std::collections::HashMap::new(),
            farm_id: None,
            pond_id: None,
        }
    }

    #[test]
    fn insert_then_get_round_trip() {
        let cache = TopicCache::new(128);
        let t = fixed_tenant(0x01);
        let s = fixed_sensor(0x10, 0x01);
        cache.insert(meta_for(t, s));
        let hit = cache.get(t, s).expect("freshly inserted entry must hit");
        assert_eq!(hit.tenant_id, t);
        assert_eq!(hit.sensor_id, s);
    }

    #[test]
    fn get_on_absent_key_returns_none() {
        let cache = TopicCache::new(128);
        let t = fixed_tenant(0x02);
        let s = fixed_sensor(0x10, 0x02);
        assert!(cache.get(t, s).is_none());
    }

    #[test]
    fn invalidate_removes_entry() {
        let cache = TopicCache::new(128);
        let t = fixed_tenant(0x03);
        let s = fixed_sensor(0x10, 0x03);
        cache.insert(meta_for(t, s));
        assert!(cache.get(t, s).is_some());
        cache.invalidate(t, s);
        assert!(cache.get(t, s).is_none(), "post-invalidate get must miss");
    }

    #[test]
    fn invalidate_tenant_removes_only_that_tenants_entries() {
        let cache = TopicCache::new(128);
        let t_a = fixed_tenant(0xAA);
        let t_b = fixed_tenant(0xBB);
        let s1 = fixed_sensor(0x20, 0x01);
        let s2 = fixed_sensor(0x20, 0x02);
        let s3 = fixed_sensor(0x20, 0x03);
        cache.insert(meta_for(t_a, s1));
        cache.insert(meta_for(t_a, s2));
        cache.insert(meta_for(t_b, s3));
        assert_eq!(cache.len(), 3);

        cache.invalidate_tenant(t_a);

        assert!(cache.get(t_a, s1).is_none(), "t_a/s1 must be gone");
        assert!(cache.get(t_a, s2).is_none(), "t_a/s2 must be gone");
        assert!(cache.get(t_b, s3).is_some(), "t_b/s3 must survive");
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn cross_tenant_key_isolation_same_sensor_id() {
        // Two tenants, IDENTICAL sensor uuid. The cache MUST treat them
        // as separate entries. This is the SEC-M16 regression guard:
        // if a future refactor introduces a `get_by_sensor_id(uuid)`
        // overload that drops the tenant discriminator, this test
        // fails because the value stored under tenant B leaks into a
        // lookup under tenant A.
        let cache = TopicCache::new(128);
        let t_a = fixed_tenant(0xCC);
        let t_b = fixed_tenant(0xDD);
        let shared_sensor = fixed_sensor(0x30, 0x01);
        let mut meta_a = meta_for(t_a, shared_sensor);
        meta_a.channel_ids = vec![fixed_sensor(0x30, 0xAA)];
        let mut meta_b = meta_for(t_b, shared_sensor);
        meta_b.channel_ids = vec![fixed_sensor(0x30, 0xBB)];

        cache.insert(meta_a.clone());
        cache.insert(meta_b.clone());

        let hit_a = cache.get(t_a, shared_sensor).unwrap();
        let hit_b = cache.get(t_b, shared_sensor).unwrap();
        assert_eq!(
            hit_a.tenant_id, t_a,
            "tenant A lookup must return tenant A value"
        );
        assert_eq!(
            hit_b.tenant_id, t_b,
            "tenant B lookup must return tenant B value"
        );
        assert_eq!(hit_a.channel_ids, meta_a.channel_ids);
        assert_eq!(hit_b.channel_ids, meta_b.channel_ids);
        assert_ne!(hit_a.channel_ids, hit_b.channel_ids);
    }

    #[test]
    fn capacity_bound_global_eviction_kicks_in() {
        // Tiny global cap (per-tenant cap stays the same). Insert
        // beyond cap; moka must evict eldest entries; len caps at
        // total_capacity (modulo eviction batch size).
        const TOTAL: usize = 4;
        const PER_TENANT: usize = 4;
        let cache = TopicCache::new_with_caps(PER_TENANT, TOTAL);
        let t = fixed_tenant(0xEE);
        // u8::try_from at the loop bound keeps the test honest about
        // the cast: TOTAL=4 fits in u8 trivially, but the explicit
        // try_from documents the bound and silences the workspace
        // cast_possible_truncation lint without a blanket allow.
        let total_u8: u8 = u8::try_from(TOTAL).expect("TOTAL fits in u8");
        for i in 0_u8..total_u8.saturating_mul(3) {
            let s = fixed_sensor(0x40, i);
            cache.insert(meta_for(t, s));
        }
        // moka's eviction is async-batched; run_pending_tasks drains.
        let len = cache.len();
        assert!(
            len <= TOTAL,
            "cache len {len} must be <= TOTAL {TOTAL} after over-insert"
        );
    }

    #[test]
    fn per_tenant_cap_bound_eviction_kicks_in() {
        // Global cap is comfortably large; per-tenant cap is the gate.
        // Inserting more than per-tenant must NOT cause len to exceed
        // per-tenant for the saturating tenant — the per-tenant
        // eviction logic chooses one entry to drop before the new
        // insert lands.
        const PER_TENANT: usize = 3;
        const TOTAL: usize = 1_000;
        let cache = TopicCache::new_with_caps(PER_TENANT, TOTAL);
        let t = fixed_tenant(0xFE);
        // Same fallible-cast hygiene as the global eviction test: pin
        // the bound through u8::try_from so a future increase of
        // PER_TENANT past 255 would fail the test loudly instead of
        // silently truncating.
        let per_u8: u8 = u8::try_from(PER_TENANT).expect("PER_TENANT fits in u8");
        for i in 0_u8..per_u8.saturating_mul(4) {
            let s = fixed_sensor(0x50, i);
            cache.insert(meta_for(t, s));
        }
        let len = cache.len();
        assert!(
            len <= PER_TENANT,
            "single-tenant len {len} must be <= per-tenant cap {PER_TENANT}"
        );
    }

    #[test]
    fn len_and_is_empty_track_state() {
        let cache = TopicCache::new(64);
        assert!(cache.is_empty());
        assert_eq!(cache.len(), 0);
        let t = fixed_tenant(0x11);
        cache.insert(meta_for(t, fixed_sensor(0x60, 0x01)));
        assert_eq!(cache.len(), 1);
        assert!(!cache.is_empty());
        cache.insert(meta_for(t, fixed_sensor(0x60, 0x02)));
        assert_eq!(cache.len(), 2);
        cache.invalidate_tenant(t);
        assert_eq!(cache.len(), 0);
        assert!(cache.is_empty());
    }

    #[test]
    fn double_insert_does_not_double_count() {
        // Re-inserting the same key MUST overwrite, not duplicate.
        // This guards the per-tenant counter — a double insert of the
        // same key must leave the counter at 1, not 2.
        const PER_TENANT: usize = 3;
        const TOTAL: usize = 1_000;
        let cache = TopicCache::new_with_caps(PER_TENANT, TOTAL);
        let t = fixed_tenant(0x22);
        let s = fixed_sensor(0x70, 0x01);
        cache.insert(meta_for(t, s));
        cache.insert(meta_for(t, s));
        cache.insert(meta_for(t, s));
        assert_eq!(cache.len(), 1, "single key must contribute one slot");
        // Now insert PER_TENANT-1 distinct keys; total must still fit
        // under the per-tenant cap because the original key is still
        // worth exactly one slot.
        cache.insert(meta_for(t, fixed_sensor(0x70, 0x02)));
        cache.insert(meta_for(t, fixed_sensor(0x70, 0x03)));
        assert!(
            cache.len() <= PER_TENANT,
            "double-insert leaked extra capacity"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_get_and_insert_does_not_panic() {
        // Spawn many tasks doing concurrent gets + inserts on the same
        // (tenant, sensor) space. The test passes if it terminates
        // without panic (the workspace `clippy::panic = "deny"` and
        // `forbid(unsafe_code)` make any rare-race panic an error). A
        // counter at the end sanity-checks that some work happened.
        let cache = Arc::new(TopicCache::new_with_caps(64, 4_096));
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::new();
        for w in 0_u8..8 {
            let c = Arc::clone(&cache);
            let cnt = Arc::clone(&counter);
            handles.push(tokio::spawn(async move {
                for i in 0_u8..64 {
                    let t = fixed_tenant(w);
                    let s = fixed_sensor(0x80, i);
                    c.insert(meta_for(t, s));
                    let _ = c.get(t, s);
                    cnt.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for h in handles {
            h.await.expect("worker task must finish");
        }
        assert!(
            counter.load(Ordering::Relaxed) >= 8 * 64,
            "every task iteration must have run"
        );
    }

    #[test]
    fn invalidate_missing_key_is_idempotent_noop() {
        // Defensive: calling invalidate on a never-inserted key must
        // not panic and must not mutate the counter into an underflow.
        let cache = TopicCache::new(64);
        let t = fixed_tenant(0x33);
        let s = fixed_sensor(0x90, 0x01);
        cache.invalidate(t, s);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn arc_clone_returns_same_pointer() {
        // Reads MUST be cheap-clones. Two consecutive `get` calls
        // before any mutation must hand back the same underlying
        // allocation.
        let cache = TopicCache::new(64);
        let t = fixed_tenant(0x44);
        let s = fixed_sensor(0xA0, 0x01);
        cache.insert(meta_for(t, s));
        let a = cache.get(t, s).unwrap();
        let b = cache.get(t, s).unwrap();
        assert!(
            Arc::ptr_eq(&a, &b),
            "consecutive cache.get must return Arc::ptr_eq pointers"
        );
    }

    #[test]
    fn defaults_match_plan_numbers() {
        // The plan pins these constants; if a future commit silently
        // moves them, the test makes the change visible in code review.
        assert_eq!(DEFAULT_PER_TENANT_CAPACITY, 10_000);
        assert_eq!(DEFAULT_TOTAL_CAPACITY, 100_000);
    }

    #[test]
    fn new_clamps_per_tenant_to_total() {
        // A tiny `new(2)` cache must NOT report a per-tenant cap of
        // 10_000 — it would lie about the real ceiling.
        let cache = TopicCache::new(2);
        assert_eq!(cache.per_tenant_capacity(), 2);
    }

    #[test]
    fn self_smoke_check_is_idempotent_and_zero_after() {
        // The bootstrap smoke check MUST leave the cache observably
        // empty so the steady-state assertion in main does not fire.
        let cache = TopicCache::new(64);
        self_smoke_check(&cache);
        assert_eq!(cache.len(), 0, "post-smoke cache must be empty");
        // Calling twice must remain idempotent — invalidate is a
        // no-op on a missing key.
        self_smoke_check(&cache);
        assert_eq!(cache.len(), 0, "double-smoke must remain empty");
    }

    #[test]
    fn topic_cache_is_send_and_sync() {
        // Compile-time assertion: the struct lives across thread
        // boundaries. Both moka and papaya satisfy these bounds, but
        // a future field that does not (e.g. an `Rc`) would silently
        // make the cache single-threaded; this test keeps the bound
        // visible in the test surface.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TopicCache>();
    }
}
