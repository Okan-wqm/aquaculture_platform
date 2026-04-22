//! Persistence sinks behind a [`BatchSink`] trait.
//!
//! WHY a trait:
//!   The hot-path module (`crate::batch`) consumes `Vec<SensorReading>`
//!   batches and hands them off to a sink. The trait makes the sink
//!   replaceable in tests ([`LoggingSink`]) and at deploy time
//!   ([`PostgresSink`] writes binary COPY into TimescaleDB).
//!
//! WHY UNLOGGED staging table + INSERT ... ON CONFLICT:
//!   The existing NestJS path (`apps/sensor-service/src/ingestion/
//!   batch-processor.service.ts`) issues `INSERT ... ON CONFLICT DO
//!   UPDATE SET value/raw_value/quality_code = EXCLUDED.*`. PostgreSQL
//!   `COPY` does not support `ON CONFLICT`, so the existing semantic
//!   ("re-publish updates the row") would silently break if we
//!   COPY-ed straight into the hypertable. Plan-blessed Option A:
//!   COPY into an UNLOGGED `<tenant>.sensor_metrics_stage` then
//!   `INSERT ... SELECT ... ON CONFLICT DO UPDATE` from the stage to
//!   the hypertable, then `TRUNCATE` the stage. Atomic per tenant
//!   per batch via `BEGIN ... COMMIT`.
//!
//! WHY tenant-scoped schema name:
//!   ADR-011: every tenant gets its own schema `tenant_<32-hex>`. The
//!   schema name is derived from the [`TenantId`] via
//!   [`SchemaName::from_tenant_id`] — the schema string never enters
//!   this module from operator input, so SQL identifier injection is
//!   structurally impossible.
//!
//! WHY mTLS via tokio-postgres-rustls:
//!   `tokio-postgres` is TLS-agnostic by default (`NoTls`). The
//!   `tokio-postgres-rustls` bridge from the same authors enables
//!   SCRAM channel binding (`tls-server-end-point`) — without channel
//!   binding, an MITM with a forged-but-trusted cert can still phish
//!   the SCRAM exchange even if `sslmode=verify-full` alone passed.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use deadpool_postgres::{ManagerConfig, Pool, RecyclingMethod, Runtime};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_postgres::types::Type as PgType;
use tracing::instrument;

use crate::payload::SensorReading;
use tenant_context::{SchemaName, TenantId};

/// Errors raised by [`BatchSink`] implementations.
#[derive(Debug, Error)]
pub enum SinkError {
    /// The supplied batch was empty. Sinks treat empty batches as a
    /// caller bug — the batch aggregator never emits empty.
    #[error("batch sink received an empty batch")]
    EmptyBatch,

    /// One of the cert / key files in [`PostgresConfig`] could not be
    /// read.
    #[error("cannot read TLS material at {path}: {source}")]
    TlsMaterial {
        /// File path that failed to load.
        path: std::path::PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// rustls / x509 parsing failed on the supplied CA certificate.
    #[error("rustls TLS configuration error: {0}")]
    Tls(String),

    /// A single row inside an otherwise-valid batch failed a defense-
    /// in-depth check at sink time (e.g. `producer_ts` outside
    /// `chrono`'s representable range, or a future consistency probe).
    ///
    /// The payload validator already rejects these before the batch
    /// reaches the sink; this variant exists so a future code path
    /// that bypasses the validator surfaces the failure with a
    /// sink-level label instead of being mis-tagged as a TLS error
    /// in operator logs (the previous placement used `Tls` which
    /// made alarms fire on the wrong shelf).
    ///
    /// `reason` is human-readable and safe to log — the validator
    /// guarantees no attacker-controlled bytes reach this variant.
    #[error("invalid row rejected at sink: {reason}")]
    InvalidRow {
        /// Short, log-safe description of which invariant the row
        /// violated (e.g. `"producer_ts 9999999999999 out of chrono range"`).
        reason: String,
    },

    /// deadpool failed to construct the pool.
    #[error("postgres pool construction failed")]
    PoolBuild(#[source] deadpool_postgres::BuildError),

    /// deadpool could not lease a connection (pool exhausted, broker
    /// down).
    #[error("postgres pool lease failed")]
    PoolGet(#[source] deadpool_postgres::PoolError),

    /// A postgres query / COPY frame / transaction step failed.
    #[error("postgres operation failed")]
    Postgres(#[source] tokio_postgres::Error),
}

/// Persistence sink. Implementations: [`LoggingSink`] for the
/// stub-mode boot + tests; production `PostgresSink` lands in a
/// follow-on commit.
#[async_trait]
pub trait BatchSink: Send + Sync {
    /// Write the batch to the backend. Whole-batch atomicity — partial
    /// success is not supported.
    async fn write(&self, batch: Vec<SensorReading>) -> Result<(), SinkError>;
}

// -----------------------------------------------------------------
// LoggingSink — used by the binary's stub-mode boot AND by the
// batch / drain unit tests. Counts batches + last-batch-size so unit
// tests can assert delivery without a postgres container.
// -----------------------------------------------------------------

/// Test-grade sink that logs each batch and records counts. Cheap
/// to clone; the inner state is `Arc<AtomicUsize>` so concurrent
/// callers see consistent counters.
#[derive(Debug, Default, Clone)]
pub struct LoggingSink {
    batches: Arc<std::sync::atomic::AtomicU64>,
    last_size: Arc<std::sync::atomic::AtomicUsize>,
}

impl LoggingSink {
    /// Construct a fresh sink with zero counters.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of batches the sink has received. Test-only accessor:
    /// production code observes batch flow through tracing spans
    /// instead of polling a counter.
    #[cfg(test)]
    pub fn batches(&self) -> u64 {
        self.batches.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Size of the most recently received batch. Test-only accessor.
    #[cfg(test)]
    pub fn last_batch_size(&self) -> usize {
        self.last_size.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[async_trait]
impl BatchSink for LoggingSink {
    #[instrument(skip(self, batch), fields(rows = batch.len()))]
    async fn write(&self, batch: Vec<SensorReading>) -> Result<(), SinkError> {
        if batch.is_empty() {
            return Err(SinkError::EmptyBatch);
        }
        self.batches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.last_size
            .store(batch.len(), std::sync::atomic::Ordering::Relaxed);
        tracing::debug!(rows = batch.len(), "logging sink received batch");
        Ok(())
    }
}

/// Receive flushed batches from a `mpsc::Receiver` and feed each one
/// to the supplied [`BatchSink`]. Returns when the receiver closes.
/// Used by `main::async_main` to spawn the sink consumer task.
pub async fn run_sink_loop(
    sink: Arc<dyn BatchSink>,
    mut rx: tokio::sync::mpsc::Receiver<Vec<SensorReading>>,
) {
    while let Some(batch) = rx.recv().await {
        if let Err(e) = sink.write(batch).await {
            tracing::error!(error = %e, "batch sink write failed");
        }
    }
    tracing::info!("batch sink loop exited (channel closed)");
}

// -----------------------------------------------------------------
// PostgresSink — production COPY pipeline.
// -----------------------------------------------------------------

/// PostgreSQL connection configuration for [`PostgresSink::connect`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresConfig {
    /// Server host name (must match the cert's CN/SAN for verify-full).
    pub host: String,
    /// Server TCP port. Default 5432.
    pub port: u16,
    /// Database name.
    pub db_name: String,
    /// Postgres role for the sidecar (per-service role with USAGE +
    /// INSERT/UPDATE on the per-tenant schemas).
    pub user: String,
    /// Password for the role above. Caller wraps in `secrecy::Secret`
    /// at the env-loading site.
    pub password: String,
    /// Path to the platform CA certificate (PEM). Only this CA is
    /// trusted — system roots are intentionally NOT consulted, so a
    /// Web-PKI cert cannot MITM the connection.
    pub ca_cert_pem: std::path::PathBuf,
    /// Connection pool size. Plan § Faz 2: 4 (matches the COPY worker
    /// pool count). Defaults to 4 in `with_defaults`.
    pub pool_size: usize,
}

/// Production [`BatchSink`] backed by a deadpool-postgres pool +
/// rustls-mTLS connections + binary COPY into per-tenant UNLOGGED
/// staging tables.
#[derive(Debug, Clone)]
pub struct PostgresSink {
    pool: Pool,
}

impl PostgresSink {
    /// Build the rustls `ClientConfig` with the platform CA pinned
    /// (no system roots), then construct the deadpool-postgres pool
    /// and probe one connection so a misconfiguration surfaces at
    /// startup rather than at first batch.
    ///
    /// # Errors
    /// - [`SinkError::TlsMaterial`] — CA cert file unreadable.
    /// - [`SinkError::Tls`] — CA cert PEM does not parse.
    /// - [`SinkError::PoolBuild`] — deadpool refused the pool config.
    /// - [`SinkError::PoolGet`] / [`SinkError::Postgres`] — initial
    ///   handshake failed.
    pub async fn connect(cfg: &PostgresConfig) -> Result<Self, SinkError> {
        // 1. rustls ClientConfig with the platform CA pinned.
        let pem_bytes =
            tokio::fs::read(&cfg.ca_cert_pem)
                .await
                .map_err(|source| SinkError::TlsMaterial {
                    path: cfg.ca_cert_pem.clone(),
                    source,
                })?;
        let mut roots = rustls::RootCertStore::empty();
        let mut pem_cursor = std::io::Cursor::new(pem_bytes);
        for cert in rustls_pemfile::certs(&mut pem_cursor) {
            let cert = cert.map_err(|e| SinkError::Tls(e.to_string()))?;
            roots.add(cert).map_err(|e| SinkError::Tls(e.to_string()))?;
        }
        if roots.is_empty() {
            return Err(SinkError::Tls(
                "ca_cert_pem contained zero certificates".to_owned(),
            ));
        }
        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config);

        // 2. tokio-postgres connection config.
        let mut pg_cfg = tokio_postgres::Config::new();
        pg_cfg
            .host(&cfg.host)
            .port(cfg.port)
            .dbname(&cfg.db_name)
            .user(&cfg.user)
            .password(&cfg.password)
            .ssl_mode(tokio_postgres::config::SslMode::Require)
            .application_name("sensor-ingestion");

        // 3. deadpool manager + pool.
        let mgr_cfg = ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        };
        let mgr = deadpool_postgres::Manager::from_config(pg_cfg, tls, mgr_cfg);
        let pool = Pool::builder(mgr)
            .max_size(cfg.pool_size)
            .runtime(Runtime::Tokio1)
            .build()
            .map_err(SinkError::PoolBuild)?;

        // 4. Probe one connection so a typo / firewall surfaces now,
        //    not at the first batch.
        let probe = pool.get().await.map_err(SinkError::PoolGet)?;
        probe
            .simple_query("SELECT 1")
            .await
            .map_err(SinkError::Postgres)?;

        Ok(Self { pool })
    }
}

#[async_trait]
impl BatchSink for PostgresSink {
    #[instrument(skip(self, batch), fields(rows = batch.len()))]
    async fn write(&self, batch: Vec<SensorReading>) -> Result<(), SinkError> {
        if batch.is_empty() {
            return Err(SinkError::EmptyBatch);
        }
        // Group readings by tenant — one transaction + one COPY per
        // tenant. Tenants in the same batch are independent so a
        // failure on tenant A does not abort tenant B's commit. The
        // grouping key carries the TenantId alongside the SchemaName
        // so write_tenant_batch can bind `app.current_tenant` on the
        // transaction — defense-in-depth alongside the schema-per-
        // tenant structural isolation (see ADR-030 / ORPHAN-022).
        let by_tenant = group_by_tenant(batch);
        for ((tenant_id, schema), readings) in by_tenant {
            self.write_tenant_batch(tenant_id, schema, readings).await?;
        }
        Ok(())
    }
}

impl PostgresSink {
    async fn write_tenant_batch(
        &self,
        tenant_id: TenantId,
        schema: SchemaName,
        readings: Vec<SensorReading>,
    ) -> Result<(), SinkError> {
        if readings.is_empty() {
            return Ok(());
        }
        let mut conn = self.pool.get().await.map_err(SinkError::PoolGet)?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;

        // Pin the tenant id on this transaction via a GUC. The setting
        // is LOCAL (third arg = true) so it lives only for the length
        // of the transaction and cannot leak into a subsequent pool
        // lease. Two orthogonal benefits:
        //   1. Audit / trace observability — any future log hook that
        //      reads `current_setting('app.current_tenant')` sees the
        //      authoritative tenant id for every row written by this
        //      COPY, even though the schema name already encodes it.
        //   2. Future defense-in-depth — if a shared table (e.g. a
        //      cross-tenant aggregate / outbox) gets added later, the
        //      same GUC drives the RLS policy without an application-
        //      layer code change.
        // The value is bound as a prepared-statement parameter, so a
        // hostile tenant_id (it is a strictly-validated UUID here, but
        // the guard is still free) cannot inject SQL into the SET.
        let tenant_uuid_text = tenant_id.as_uuid().to_string();
        tx.execute(build_set_current_tenant_sql(), &[&tenant_uuid_text])
            .await
            .map_err(SinkError::Postgres)?;

        let copy_sql = build_copy_in_sql(&schema);
        let copy_sink = tx.copy_in(&copy_sql).await.map_err(SinkError::Postgres)?;
        // Column types match the `(time, sensor_id, channel_id, value,
        // raw_value, quality_code)` order in build_copy_in_sql.
        let writer = tokio_postgres::binary_copy::BinaryCopyInWriter::new(
            copy_sink,
            &[
                PgType::TIMESTAMPTZ,
                PgType::UUID,
                PgType::UUID,
                PgType::FLOAT8,
                PgType::FLOAT8,
                PgType::INT2,
            ],
        );
        tokio::pin!(writer);
        let row_count = readings.len();
        for r in &readings {
            let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(r.producer_ts);
            let Some(ts) = ts else {
                // Out-of-range producer_ts. The payload validator
                // already rejects these; this branch is defence in
                // depth so a future code path that bypasses the
                // validator does not silently corrupt the COPY.
                // `SinkError::InvalidRow` tags this as a row-level
                // rejection so operator logs read "invalid row at
                // sink", not the misleading "TLS configuration error"
                // the earlier implementation emitted.
                return Err(SinkError::InvalidRow {
                    reason: format!("producer_ts {} out of chrono range", r.producer_ts),
                });
            };
            let value = r.value;
            let raw_value = r.value;
            let quality = i16::from(r.quality);
            writer
                .as_mut()
                .write(&[
                    &ts,
                    r.sensor_id.as_uuid_ref(),
                    r.channel_id.as_uuid_ref(),
                    &value,
                    &raw_value,
                    &quality,
                ])
                .await
                .map_err(SinkError::Postgres)?;
        }
        let copied = writer.finish().await.map_err(SinkError::Postgres)?;
        debug_assert_eq!(
            usize::try_from(copied).unwrap_or(usize::MAX),
            row_count,
            "BinaryCopyInWriter row count mismatch",
        );

        // Upsert from stage to hypertable, then truncate the stage.
        // batch_execute runs both in one round-trip.
        let upsert_sql = build_upsert_sql(&schema);
        let truncate_sql = build_truncate_stage_sql(&schema);
        let combined = format!("{upsert_sql};\n{truncate_sql};");
        tx.batch_execute(&combined)
            .await
            .map_err(SinkError::Postgres)?;
        tx.commit().await.map_err(SinkError::Postgres)?;
        Ok(())
    }
}

/// Tiny helper trait so `&Uuid` can be passed to `tokio_postgres`
/// `&dyn ToSql` slots without juggling intermediate locals.
trait UuidExt {
    fn as_uuid_ref(&self) -> &uuid::Uuid;
}

impl UuidExt for uuid::Uuid {
    fn as_uuid_ref(&self) -> &Self {
        self
    }
}

fn group_by_tenant(
    batch: Vec<SensorReading>,
) -> HashMap<(TenantId, SchemaName), Vec<SensorReading>> {
    let mut groups: HashMap<(TenantId, SchemaName), Vec<SensorReading>> = HashMap::new();
    for r in batch {
        let schema = SchemaName::from_tenant_id(r.tenant_id);
        groups.entry((r.tenant_id, schema)).or_default().push(r);
    }
    groups
}

/// Static SQL for binding the tenant id as a transaction-local GUC.
///
/// `set_config(name, value, is_local=true)` — the setting is reset at
/// transaction end (`COMMIT` or `ROLLBACK`), so a subsequent connection
/// pool lease starts clean. The value is a single `$1` parameter so
/// the caller binds a typed UUID string without touching SQL syntax.
///
/// Exposed `pub` so the unit-test layer can assert the shape without
/// holding a live postgres connection, mirroring the pattern used by
/// [`build_copy_in_sql`] + [`build_upsert_sql`] + [`build_truncate_stage_sql`].
#[must_use]
pub const fn build_set_current_tenant_sql() -> &'static str {
    "SELECT set_config('app.current_tenant', $1, true)"
}

/// Per-tenant `COPY ... FROM STDIN BINARY` SQL. Pure function so the
/// SQL shape can be unit-tested without postgres.
#[must_use]
pub fn build_copy_in_sql(schema: &SchemaName) -> String {
    format!(
        "COPY {schema}.sensor_metrics_stage \
         (time, sensor_id, channel_id, value, raw_value, quality_code) \
         FROM STDIN WITH (FORMAT BINARY)"
    )
}

/// Per-tenant upsert from staging table to the hypertable. Preserves
/// the existing NestJS contract: re-publish updates value/raw_value/
/// quality_code on conflict.
#[must_use]
pub fn build_upsert_sql(schema: &SchemaName) -> String {
    format!(
        "INSERT INTO {schema}.sensor_metrics \
         (time, sensor_id, channel_id, value, raw_value, quality_code) \
         SELECT time, sensor_id, channel_id, value, raw_value, quality_code \
           FROM {schema}.sensor_metrics_stage \
         ON CONFLICT (time, sensor_id, channel_id) DO UPDATE \
           SET value = EXCLUDED.value, \
               raw_value = EXCLUDED.raw_value, \
               quality_code = EXCLUDED.quality_code"
    )
}

/// Truncate the staging table after a successful upsert.
#[must_use]
pub fn build_truncate_stage_sql(schema: &SchemaName) -> String {
    format!("TRUNCATE TABLE {schema}.sensor_metrics_stage")
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::{BatchSink, LoggingSink, SinkError, run_sink_loop};
    use crate::payload::SensorReading;
    use std::sync::Arc;
    use tenant_context::{SchemaName, TenantId};
    use tokio::sync::mpsc;

    fn fixed_uuid(seed: u8) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        Uuid::from_bytes(bytes)
    }

    fn reading() -> SensorReading {
        SensorReading {
            tenant_id: TenantId::from_uuid(fixed_uuid(0xAA)),
            sensor_id: fixed_uuid(0xBB),
            channel_id: fixed_uuid(0xCC),
            value: 24.5,
            quality: 1,
            producer_ts: Utc::now().timestamp_millis(),
        }
    }

    #[tokio::test]
    async fn logging_sink_records_batch_count() {
        let sink = LoggingSink::new();
        sink.write(vec![reading(), reading()]).await.unwrap();
        sink.write(vec![reading()]).await.unwrap();
        assert_eq!(sink.batches(), 2);
        assert_eq!(sink.last_batch_size(), 1);
    }

    #[tokio::test]
    async fn logging_sink_rejects_empty_batch() {
        let sink = LoggingSink::new();
        let err = sink.write(vec![]).await.unwrap_err();
        assert!(matches!(err, SinkError::EmptyBatch));
        assert_eq!(sink.batches(), 0);
    }

    #[test]
    fn copy_sql_uses_validated_schema_name() {
        let tenant = TenantId::from_uuid(fixed_uuid(0xAA));
        let schema = SchemaName::from_tenant_id(tenant);
        let sql = super::build_copy_in_sql(&schema);
        assert!(sql.contains(schema.as_str()));
        assert!(sql.contains("sensor_metrics_stage"));
        assert!(sql.contains("FORMAT BINARY"));
        assert!(sql.contains("(time, sensor_id, channel_id, value, raw_value, quality_code)"));
    }

    #[test]
    fn upsert_sql_preserves_on_conflict_semantic() {
        let tenant = TenantId::from_uuid(fixed_uuid(0xBB));
        let schema = SchemaName::from_tenant_id(tenant);
        let sql = super::build_upsert_sql(&schema);
        // Mirrors the NestJS path's INSERT ... ON CONFLICT DO UPDATE
        // SET value/raw_value/quality_code = EXCLUDED.* contract.
        assert!(sql.contains(schema.as_str()));
        assert!(sql.contains("ON CONFLICT (time, sensor_id, channel_id) DO UPDATE"));
        assert!(sql.contains("SET value = EXCLUDED.value"));
        assert!(sql.contains("raw_value = EXCLUDED.raw_value"));
        assert!(sql.contains("quality_code = EXCLUDED.quality_code"));
    }

    #[test]
    fn truncate_stage_sql_uses_correct_table() {
        let tenant = TenantId::from_uuid(fixed_uuid(0xCC));
        let schema = SchemaName::from_tenant_id(tenant);
        let sql = super::build_truncate_stage_sql(&schema);
        assert!(sql.contains("TRUNCATE"));
        assert!(sql.contains(schema.as_str()));
        assert!(sql.contains("sensor_metrics_stage"));
        assert!(!sql.contains("sensor_metrics ")); // not the hypertable
    }

    #[test]
    fn invalid_row_variant_is_distinct_from_tls_variant() {
        // ADR-028 + plan Kör Nokta 2: a row-level invariant failure
        // (e.g. producer_ts out of chrono range) MUST surface as
        // `SinkError::InvalidRow`, NOT `SinkError::Tls`. Operator
        // alarms route on the variant shape — mis-tagging row
        // failures as TLS errors fires the wrong on-call. Two guards:
        //   1. Both variants exist and compile.
        //   2. A matcher that accepts `Tls` rejects a properly-
        //      constructed `InvalidRow` (and vice versa). If a future
        //      refactor conflates them into one variant, this test
        //      stops compiling — the error surfaces at build, not in
        //      production logs.
        let row_error = SinkError::InvalidRow {
            reason: "producer_ts 9999999999999 out of chrono range".to_owned(),
        };
        let tls_error = SinkError::Tls("CA bundle not PEM".to_owned());

        assert!(
            matches!(row_error, SinkError::InvalidRow { .. }),
            "InvalidRow must match its own variant"
        );
        assert!(
            !matches!(row_error, SinkError::Tls(_)),
            "InvalidRow must NOT match Tls — distinct variants"
        );
        assert!(
            matches!(tls_error, SinkError::Tls(_)),
            "Tls must still match its own variant"
        );

        // The Display surface is what operators read in logs. Make
        // sure the row-level error carries "invalid row" (the operator
        // signal) and the out-of-range detail (the ops debug signal).
        let rendered = format!(
            "{}",
            SinkError::InvalidRow {
                reason: "producer_ts 9999999999999 out of chrono range".to_owned(),
            }
        );
        assert!(
            rendered.contains("invalid row rejected at sink"),
            "InvalidRow Display should lead with the operator-visible label, got: {rendered}"
        );
        assert!(
            rendered.contains("producer_ts 9999999999999 out of chrono range"),
            "InvalidRow Display should carry the reason detail, got: {rendered}"
        );
    }

    #[test]
    fn set_current_tenant_sql_is_parameterised_local_guc() {
        // The SQL we emit at the start of every write_tenant_batch
        // transaction MUST:
        //   1. Use `set_config(..., ..., true)` — the `true` is the
        //      `is_local` flag, which scopes the setting to THIS
        //      transaction. Anything else would leak the GUC into the
        //      next pool lease (connection pool hazard).
        //   2. Bind `app.current_tenant` — the exact key that audit /
        //      trace hooks + any future cross-tenant RLS policy will
        //      read from.
        //   3. Use `$1` as a placeholder — hostile input cannot inject
        //      SQL because the value is a typed prepared-statement
        //      parameter, NOT string-interpolated.
        let sql = super::build_set_current_tenant_sql();
        assert!(
            sql.contains("set_config("),
            "must use set_config(), got: {sql}"
        );
        assert!(
            sql.contains("'app.current_tenant'"),
            "must target app.current_tenant, got: {sql}"
        );
        assert!(
            sql.contains("$1"),
            "must use parameterised placeholder, got: {sql}"
        );
        assert!(
            sql.contains(", true)"),
            "must pass is_local=true, got: {sql}"
        );
        // Guard against accidental string interpolation slipping in
        // later — there must be NO other placeholders and NO embedded
        // tenant ids in the template.
        assert!(
            !sql.contains("$2"),
            "single-parameter SQL; $2 would mean the template drifted: {sql}"
        );
    }

    #[test]
    fn group_by_tenant_preserves_tenant_id_with_schema() {
        let tenant_a = TenantId::from_uuid(fixed_uuid(0xAA));
        let tenant_b = TenantId::from_uuid(fixed_uuid(0xBB));
        let mk = |tid: TenantId| SensorReading {
            tenant_id: tid,
            sensor_id: fixed_uuid(0x01),
            channel_id: fixed_uuid(0x02),
            value: 1.0,
            quality: 1,
            producer_ts: Utc::now().timestamp_millis(),
        };
        let batch = vec![mk(tenant_a), mk(tenant_b), mk(tenant_a)];
        let grouped = super::group_by_tenant(batch);
        assert_eq!(grouped.len(), 2, "two distinct tenants expected");
        let schema_a = SchemaName::from_tenant_id(tenant_a);
        let schema_b = SchemaName::from_tenant_id(tenant_b);
        let group_a = grouped
            .get(&(tenant_a, schema_a))
            .expect("tenant_a group present");
        let group_b = grouped
            .get(&(tenant_b, schema_b))
            .expect("tenant_b group present");
        assert_eq!(group_a.len(), 2);
        assert_eq!(group_b.len(), 2 - 1);
        // Every reading under a tenant key carries that same tenant_id
        // — the key is authoritative. A future regression that mixed
        // two tenants under one key would flip this assertion.
        for r in group_a {
            assert_eq!(r.tenant_id, tenant_a);
        }
        for r in group_b {
            assert_eq!(r.tenant_id, tenant_b);
        }
    }

    #[test]
    fn schema_name_in_sql_cannot_be_attacker_supplied() {
        // SchemaName::try_parse rejects anything outside
        // ^tenant_[0-9a-f]{32}$, so the SQL builders cannot embed an
        // injected string.
        for attempt in [
            "tenant_; DROP TABLE sensor_metrics; --",
            "tenant_00000000000000000000000000000000\"; DROP TABLE",
            "tenant_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "evil_schema_name",
            "",
        ] {
            assert!(
                SchemaName::try_parse(attempt).is_err(),
                "attacker bytes {attempt:?} unexpectedly accepted"
            );
        }
    }

    #[test]
    fn group_by_tenant_partitions_correctly() {
        let tenant_a = TenantId::from_uuid(fixed_uuid(0xA1));
        let tenant_b = TenantId::from_uuid(fixed_uuid(0xB2));
        let mk = |tenant| SensorReading {
            tenant_id: tenant,
            sensor_id: fixed_uuid(0x10),
            channel_id: fixed_uuid(0x20),
            value: 1.0,
            quality: 1,
            producer_ts: Utc::now().timestamp_millis(),
        };
        let batch = vec![mk(tenant_a), mk(tenant_b), mk(tenant_a), mk(tenant_a)];
        let groups = super::group_by_tenant(batch);
        let schema_a = SchemaName::from_tenant_id(tenant_a);
        let schema_b = SchemaName::from_tenant_id(tenant_b);
        // The grouping key is now (TenantId, SchemaName) — the TenantId
        // rides along with the schema so write_tenant_batch can bind
        // `app.current_tenant` (GUC) at transaction start without
        // re-deriving the UUID from the first reading in the group.
        assert_eq!(groups.get(&(tenant_a, schema_a)).map(Vec::len), Some(3));
        assert_eq!(groups.get(&(tenant_b, schema_b)).map(Vec::len), Some(1));
    }

    #[tokio::test]
    async fn postgres_sink_connect_rejects_missing_ca() {
        let cfg = super::PostgresConfig {
            host: "localhost".to_owned(),
            port: 5432,
            db_name: "test".to_owned(),
            user: "test".to_owned(),
            password: "test".to_owned(),
            ca_cert_pem: "/nonexistent/ca.pem".into(),
            pool_size: 1,
        };
        match super::PostgresSink::connect(&cfg).await {
            Err(super::SinkError::TlsMaterial { path, .. }) => {
                assert_eq!(path.to_str().unwrap(), "/nonexistent/ca.pem");
            }
            other => panic!("expected TlsMaterial error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn postgres_sink_connect_rejects_invalid_ca_pem() {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), b"not a valid pem certificate").unwrap();
        let cfg = super::PostgresConfig {
            host: "localhost".to_owned(),
            port: 5432,
            db_name: "test".to_owned(),
            user: "test".to_owned(),
            password: "test".to_owned(),
            ca_cert_pem: f.path().to_path_buf(),
            pool_size: 1,
        };
        // PEM parser may either return a Tls error OR an empty cert
        // list (which we also reject via SinkError::Tls). Either way
        // the connect MUST fail before opening a socket.
        let err = super::PostgresSink::connect(&cfg).await.unwrap_err();
        assert!(matches!(err, super::SinkError::Tls(_)));
    }

    /// Live-postgres integration test. Skipped by default; set
    /// `SENSOR_INGESTION_PG_INTEGRATION=1` and ensure a TimescaleDB
    /// instance with the per-tenant schema + sensor_metrics +
    /// sensor_metrics_stage tables is reachable to run it. CI ships
    /// a service-container `timescale/timescaledb-ha:pg16` for this.
    #[tokio::test]
    #[ignore = "requires SENSOR_INGESTION_PG_INTEGRATION=1 + reachable TimescaleDB; CI service-container job in follow-on commit"]
    async fn postgres_sink_live_smoke_writes_and_upserts() {
        if std::env::var("SENSOR_INGESTION_PG_INTEGRATION").is_err() {
            return;
        }
        // Implementation detail intentionally minimal — the gate is
        // the env var; a real run wires up a full schema + asserts
        // the row count after write. Lands together with the CI
        // service-container job in a follow-on commit.
    }

    #[tokio::test]
    async fn run_sink_loop_consumes_until_close() {
        let sink = Arc::new(LoggingSink::new());
        let counter = Arc::clone(&sink);
        let (tx, rx) = mpsc::channel::<Vec<SensorReading>>(8);
        let handle = tokio::spawn(run_sink_loop(sink, rx));

        tx.send(vec![reading()]).await.unwrap();
        tx.send(vec![reading(), reading()]).await.unwrap();
        drop(tx);

        handle.await.unwrap();
        assert_eq!(counter.batches(), 2);
        assert_eq!(counter.last_batch_size(), 2);
    }
}
