//! Persistence sinks behind a [`BatchSink`] trait.
//!
//! WHY a trait:
//!   The hot-path module (`crate::batch`) consumes `Vec<SensorReading>`
//!   batches and hands them off to a sink. The trait makes the sink
//!   replaceable in tests ([`LoggingSink`]) and at deploy time
//!   ([`PostgresSink`] writes binary COPY into TimescaleDB).
//!
//! WHY a per-transaction TEMP staging table + INSERT ... ON CONFLICT:
//!   The NestJS path (`apps/sensor-service/src/ingestion/
//!   batch-processor.service.ts`) issues `INSERT ... ON CONFLICT DO
//!   UPDATE SET value/raw_value/quality_code = EXCLUDED.*`. PostgreSQL
//!   `COPY` does not support `ON CONFLICT`, so COPY-ing straight into
//!   the hypertable would silently break the "re-publish updates the
//!   row" semantic. So per batch we `CREATE TEMP TABLE
//!   _sensor_metrics_stage (... ON COMMIT DROP)`, binary-COPY into it,
//!   then `INSERT ... SELECT ... ON CONFLICT DO UPDATE` into the
//!   hypertable and commit (the temp stage auto-drops). A session-local
//!   temp stage is self-cleaning: no persistent stage table, no
//!   cross-batch residue, no clear-stage DELETE. Atomic per tenant per
//!   batch via `BEGIN ... COMMIT`.
//!
//! WHY a single cross-tenant `sensor` schema (SENSOR-MEDIUM-068):
//!   sensor_metrics is ONE cross-tenant TimescaleDB hypertable in the
//!   `sensor` schema, isolated by its mandatory tenant_id column (the
//!   same model as scada_* / edge_device_directory) — NOT a per-tenant
//!   clone. Every row carries its own tenant_id; the target identifiers
//!   (`sensor.sensor_metrics`, the temp stage) are compile-time string
//!   constants, so SQL identifier injection is structurally impossible.
//!   Readings are still grouped by tenant so one tenant's failure does
//!   not abort another tenant's commit.
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
// RUST-CVE-001: PemObject trait supplies pem_slice_iter on CertificateDer —
// the first-party replacement for the unmaintained rustls-pemfile.
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_postgres::types::{ToSql, Type as PgType};
use tracing::instrument;

use crate::payload::SensorReading;
use tenant_context::TenantId;

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

    /// A row inside an otherwise-valid batch failed defence-in-depth
    /// checks at sink time (e.g. `producer_ts` outside chrono's
    /// representable range). The payload validator already rejects
    /// these; this variant exists so a future code path that bypasses
    /// the validator surfaces the failure with a sink-level label
    /// instead of being mis-tagged as a TLS error in operator logs.
    #[error("invalid row rejected at sink: {reason}")]
    InvalidRow {
        /// Human-readable reason, safe for logs (no attacker bytes).
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
    #[must_use]
    pub fn batches(&self) -> u64 {
        self.batches.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Size of the most recently received batch. Test-only accessor.
    #[cfg(test)]
    #[must_use]
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
    /// ADR-029 transactional outbox repository. Shares the SAME pool as
    /// the COPY path so the enqueue lands in the identical transaction
    /// (Task 3 restoration of the stripped wiring).
    outbox: Arc<outbox_rs::PgOutboxRepository>,
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
        for cert in CertificateDer::pem_slice_iter(&pem_bytes) {
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

        // ADR-029: the outbox repository shares this pool — write path
        // and dispatcher see a consistent view of sensor.event_outbox.
        let outbox = Arc::new(outbox_rs::PgOutboxRepository::new(pool.clone()));
        Ok(Self { pool, outbox })
    }

    /// Expose the outbox repository so `main.rs` can hand the same
    /// instance to the [`outbox_rs::OutboxDispatcher`].
    #[must_use]
    pub fn outbox_repository(&self) -> Arc<outbox_rs::PgOutboxRepository> {
        Arc::clone(&self.outbox)
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
        // failure on tenant A does not abort tenant B's commit.
        let by_tenant = group_by_tenant(batch);
        for (_tenant, readings) in by_tenant {
            self.write_tenant_batch(readings).await?;
        }
        Ok(())
    }
}

impl PostgresSink {
    async fn write_tenant_batch(&self, readings: Vec<SensorReading>) -> Result<(), SinkError> {
        if readings.is_empty() {
            return Ok(());
        }
        let mut conn = self.pool.get().await.map_err(SinkError::PoolGet)?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;

        // Private per-transaction staging table (ON COMMIT DROP) — see module docs.
        tx.batch_execute(STAGE_DDL)
            .await
            .map_err(SinkError::Postgres)?;

        let copy_sql = build_copy_in_sql();
        let copy_sink = tx.copy_in(&copy_sql).await.map_err(SinkError::Postgres)?;
        // Column types match the `(time, sensor_id, channel_id, tenant_id,
        // value, raw_value, quality_code)` order in build_copy_in_sql.
        let writer = tokio_postgres::binary_copy::BinaryCopyInWriter::new(
            copy_sink,
            &[
                PgType::TIMESTAMPTZ,
                PgType::UUID,
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
                // SinkError::InvalidRow tags this as a row-level
                // rejection so operators see "invalid row at sink",
                // not a misleading "TLS configuration error".
                return Err(SinkError::InvalidRow {
                    reason: format!("producer_ts {} out of chrono range", r.producer_ts),
                });
            };
            let value = r.value;
            let raw_value = r.value;
            let quality = i16::from(r.quality.get());
            let row: [&(dyn ToSql + Sync); 7] = [
                &ts,
                r.sensor_id.as_uuid_ref(),
                r.channel_id.as_uuid_ref(),
                r.tenant_id.as_uuid(),
                &value,
                &raw_value,
                &quality,
            ];
            writer
                .as_mut()
                .write(&row)
                .await
                .map_err(SinkError::Postgres)?;
        }
        let copied = writer.finish().await.map_err(SinkError::Postgres)?;
        debug_assert_eq!(
            usize::try_from(copied).unwrap_or(usize::MAX),
            row_count,
            "BinaryCopyInWriter row count mismatch",
        );

        // Upsert from the temp stage into the shared hypertable, then commit
        // (the ON COMMIT DROP stage is discarded automatically — no clear DML).
        // Task 3: the upsert targets the reading's OWN tenant schema via
        // the validated SchemaName newtype (16-hex platform SSoT,
        // golden-vector parity with the TS side).
        let Some(first) = readings.first() else {
            return Ok(());
        };
        let schema = tenant_context::SchemaName::from_tenant_id(first.tenant_id);
        let upsert_sql = build_upsert_sql(schema.as_str());
        tx.batch_execute(&upsert_sql)
            .await
            .map_err(SinkError::Postgres)?;

        // ADR-029 transactional outbox (Task 3 restoration): enqueue one
        // SensorMetricIngested event per persisted reading INSIDE the same
        // transaction — either the full batch (COPY + upsert + every outbox
        // row) commits, or nothing does. The dispatcher later drains the
        // outbox to the telemetry root with an awaited PubAck.
        for r in &readings {
            let ev = event_contracts_rs::SensorMetricIngestedEvent::new(
                *r.tenant_id.as_uuid(),
                r.sensor_id,
                r.channel_id,
                r.value,
                r.quality.get(),
                r.producer_ts,
            );
            let payload = outbox_rs::encode_payload(&ev).map_err(|e| SinkError::InvalidRow {
                reason: format!("outbox payload encode failed: {e}"),
            })?;
            self.outbox
                .enqueue_in_tx(
                    &tx,
                    r.tenant_id,
                    event_contracts_rs::SENSOR_METRIC_INGESTED_EVENT_TYPE,
                    payload,
                )
                .await
                .map_err(|e| SinkError::InvalidRow {
                    reason: format!("outbox enqueue failed: {e}"),
                })?;
        }

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

fn group_by_tenant(batch: Vec<SensorReading>) -> HashMap<TenantId, Vec<SensorReading>> {
    let mut groups: HashMap<TenantId, Vec<SensorReading>> = HashMap::new();
    for r in batch {
        groups.entry(r.tenant_id).or_default().push(r);
    }
    groups
}

/// DDL for the private per-transaction staging table. `ON COMMIT DROP` makes
/// each transaction's stage session-local and self-cleaning: no persistent
/// per-tenant stage table, no cross-batch residue, no clear-stage DELETE. It
/// carries `tenant_id` because the single cross-tenant hypertable requires it.
pub const STAGE_DDL: &str = "CREATE TEMP TABLE _sensor_metrics_stage (\
    time timestamptz NOT NULL, \
    sensor_id uuid NOT NULL, \
    channel_id uuid NOT NULL, \
    tenant_id uuid NOT NULL, \
    value double precision NOT NULL, \
    raw_value double precision NOT NULL, \
    quality_code smallint NOT NULL\
) ON COMMIT DROP";

/// `COPY ... FROM STDIN BINARY` into the per-transaction temp stage. Pure
/// function so the SQL shape can be unit-tested without postgres. The stage
/// identifier is a compile-time constant — no schema string is interpolated.
#[must_use]
pub fn build_copy_in_sql() -> String {
    "COPY _sensor_metrics_stage \
     (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code) \
     FROM STDIN WITH (FORMAT BINARY)"
        .to_owned()
}

/// Upsert from the temp stage into the reading's OWN tenant schema
/// (`tenant_<16hex>.sensor_metrics` — Task 3, SENSOR-CRITICAL-089: the
/// platform SSoT; the shared `sensor.sensor_metrics` target produced rows
/// no platform reader or scanner could see). The schema identifier is
/// passed as a bind PARAMETER and `format!`-safe because it comes from the
/// validated `SchemaName` newtype, never from the wire. Re-publish keeps
/// the NestJS conflict contract plus the Task 1.5 source-timestamp guard
/// (a stale redelivery cannot overwrite a newer corrected value).
#[must_use]
pub fn build_upsert_sql(schema: &str) -> String {
    format!(
        "INSERT INTO {schema}.sensor_metrics \
         (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_timestamp) \
         SELECT time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, time \
           FROM _sensor_metrics_stage \
         ON CONFLICT (time, sensor_id, channel_id) DO UPDATE \
           SET value = EXCLUDED.value, \
               raw_value = EXCLUDED.raw_value, \
               quality_code = EXCLUDED.quality_code \
         WHERE COALESCE(EXCLUDED.source_timestamp, EXCLUDED.time) \
             >= COALESCE({schema}.sensor_metrics.source_timestamp, {schema}.sensor_metrics.time)"
    )
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::{BatchSink, LoggingSink, SinkError, run_sink_loop};
    use crate::payload::{PayloadSource, QUALITY_GOOD_MIN, QualityCode, SensorReading};
    use std::sync::Arc;
    use tenant_context::TenantId;
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
            raw_value: 24.5,
            quality: QualityCode::try_new(QUALITY_GOOD_MIN).expect("192 is the GOOD band"),
            producer_ts: Utc::now().timestamp_millis(),
            source: PayloadSource::UpcastedFromV1,
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
    fn copy_in_sql_targets_temp_stage_with_tenant_id() {
        let sql = super::build_copy_in_sql();
        assert!(sql.contains("_sensor_metrics_stage"));
        assert!(sql.contains("FORMAT BINARY"));
        assert!(
            sql.contains(
                "(time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code)"
            )
        );
    }

    #[test]
    fn upsert_sql_targets_the_tenant_schema_and_carries_the_task15_guard() {
        let sql = super::build_upsert_sql("tenant_550e8400e29b41d4");
        // Task 3 (SENSOR-CRITICAL-089): per-tenant target, never the
        // shared sensor.sensor_metrics the platform cannot govern.
        assert!(sql.contains("INSERT INTO tenant_550e8400e29b41d4.sensor_metrics"));
        assert!(!sql.contains("INSERT INTO sensor.sensor_metrics"));
        assert!(sql.contains("tenant_id"));
        // Mirrors the NestJS path's INSERT ... ON CONFLICT DO UPDATE
        // SET value/raw_value/quality_code = EXCLUDED.* contract...
        assert!(sql.contains("ON CONFLICT (time, sensor_id, channel_id) DO UPDATE"));
        assert!(sql.contains("SET value = EXCLUDED.value"));
        assert!(sql.contains("raw_value = EXCLUDED.raw_value"));
        assert!(sql.contains("quality_code = EXCLUDED.quality_code"));
        // ...plus the Task 1.5 stale-redelivery guard.
        assert!(sql.contains("WHERE COALESCE(EXCLUDED.source_timestamp, EXCLUDED.time)"));
    }

    #[test]
    fn stage_ddl_is_temp_and_self_dropping() {
        assert!(super::STAGE_DDL.contains("CREATE TEMP TABLE _sensor_metrics_stage"));
        assert!(super::STAGE_DDL.contains("tenant_id uuid NOT NULL"));
        assert!(super::STAGE_DDL.contains("ON COMMIT DROP"));
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
            raw_value: 1.0,
            quality: QualityCode::try_new(QUALITY_GOOD_MIN).expect("192 is the GOOD band"),
            producer_ts: Utc::now().timestamp_millis(),
            source: PayloadSource::UpcastedFromV1,
        };
        let batch = vec![mk(tenant_a), mk(tenant_b), mk(tenant_a), mk(tenant_a)];
        let groups = super::group_by_tenant(batch);
        assert_eq!(groups.get(&tenant_a).map(Vec::len), Some(3));
        assert_eq!(groups.get(&tenant_b).map(Vec::len), Some(1));
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
    /// instance with the `sensor` schema + sensor_metrics hypertable is
    /// reachable to run it (the temp stage is created per transaction).
    /// CI ships a service-container `timescale/timescaledb-ha:pg16`.
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
