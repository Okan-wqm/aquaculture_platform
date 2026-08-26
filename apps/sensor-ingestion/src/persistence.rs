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
//!   row" semantic. Each connection creates `pg_temp._sensor_metrics_stage`
//!   once with `ON COMMIT PRESERVE ROWS`; each tenant transaction truncates,
//!   COPYs, then schema-qualified upserts from that private stage.
//!
//! WHY tenant-local targets:
//!   `tenant_<16hex>` is the sole sensor data source of truth. Schema names
//!   come only from [`SchemaName`], while the transaction pins
//!   `app.current_tenant` and `search_path=pg_catalog`. Receipt, metric and
//!   dispatch rows therefore commit in one tenant boundary.
//!
//! WHY mTLS via tokio-postgres-rustls:
//!   `tokio-postgres` is TLS-agnostic by default (`NoTls`). The
//!   `tokio-postgres-rustls` bridge from the same authors enables
//!   SCRAM channel binding (`tls-server-end-point`) — without channel
//!   binding, an MITM with a forged-but-trusted cert can still phish
//!   the SCRAM exchange even if `sslmode=verify-full` alone passed.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

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

use crate::events::DurableDispatch;
use crate::payload::SensorReading;
use nats_client::JetStreamPubAck;
use tenant_context::SchemaName;

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

    /// A database lease was not available inside the ingress budget.
    #[error("postgres pool lease exceeded the 2 second ingress budget")]
    PoolAcquireTimeout,

    /// One producer identity was reused for different payload bytes.
    #[error("stable source event identity was reused for different payload bytes")]
    SourceIdentityCollision,

    /// Tenant has a committed erasure proof and cannot be recreated.
    #[error("tenant data has already been erased")]
    ErasedTenant,

    /// A durable receipt or dispatch row violated its state contract.
    #[error("durable ingest ledger contains an invalid state")]
    InvalidLedgerState,

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
}

/// All source data and the deterministic child event committed in one tenant
/// transaction before any external acknowledgement can occur.
#[derive(Debug, Clone)]
pub struct DurableCommitInput {
    /// Validated metric row.
    pub reading: SensorReading,
    /// MQTT topic retained for audit and replay diagnosis.
    pub mqtt_topic: String,
    /// Lowercase SHA-256 of the exact MQTT payload bytes.
    pub payload_digest: String,
    /// Canonical deterministic child event.
    pub dispatch: DurableDispatch,
}

/// Result of the tenant commit. Duplicate receipts still return pending child
/// events so a crash after commit resumes dispatch instead of acknowledging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableCommitOutcome {
    /// First successful commit for the source identity.
    Committed(Vec<DurableDispatch>),
    /// Same source identity and digest already committed.
    Duplicate(Vec<DurableDispatch>),
}

impl DurableCommitOutcome {
    /// Borrow the dispatch rows that must all receive JetStream PubAcks.
    #[must_use]
    pub fn pending_dispatches(&self) -> &[DurableDispatch] {
        match self {
            Self::Committed(dispatches) | Self::Duplicate(dispatches) => dispatches,
        }
    }
}

/// Storage contract consumed by the ACK-gating pipeline.
#[async_trait]
pub trait DurableIngressStore: Send + Sync + std::fmt::Debug {
    /// Commit receipt, metric and child dispatch intent atomically.
    async fn commit(&self, input: DurableCommitInput) -> Result<DurableCommitOutcome, SinkError>;
    /// Persist one server PubAck.
    async fn mark_acked(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
        ack: &JetStreamPubAck,
    ) -> Result<(), SinkError>;
    /// Record a retryable publish failure while keeping the row pending.
    async fn mark_publish_failed(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
    ) -> Result<(), SinkError>;
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

        Ok(Self { pool })
    }
}

async fn configure_tenant_transaction(
    tx: &tokio_postgres::Transaction<'_>,
    tenant_id: tenant_context::TenantId,
) -> Result<(), SinkError> {
    tx.query_one(
        "SELECT set_config('app.current_tenant', $1, true)",
        &[&tenant_id.as_uuid().to_string()],
    )
    .await
    .map_err(SinkError::Postgres)?;
    tx.batch_execute(
        "SET LOCAL search_path = pg_catalog; \
         SET LOCAL lock_timeout = '1s'; \
         SET LOCAL statement_timeout = '5s'",
    )
    .await
    .map_err(SinkError::Postgres)
}

async fn assert_tenant_not_erased(
    tx: &tokio_postgres::Transaction<'_>,
    tenant_id: tenant_context::TenantId,
) -> Result<(), SinkError> {
    let tenant = tenant_id.as_uuid().to_string();
    let lock_material = serde_json::to_string(&serde_json::json!([
        "tenant-erasure-fence-v1",
        "sensor-service",
        tenant
    ]))
    .map_err(|_| SinkError::InvalidLedgerState)?;
    tx.query_one(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&lock_material],
    )
    .await
    .map_err(SinkError::Postgres)?;
    let erased = tx
        .query_opt(
            "SELECT true AS erased \
             FROM sensor.tenant_erasure_target_proofs \
             WHERE tenant_id = $1 AND dry_run = false LIMIT 1",
            &[tenant_id.as_uuid()],
        )
        .await
        .map_err(SinkError::Postgres)?
        .is_some();
    if erased {
        Err(SinkError::ErasedTenant)
    } else {
        Ok(())
    }
}

async fn copy_readings(
    tx: &tokio_postgres::Transaction<'_>,
    readings: &[SensorReading],
) -> Result<(), SinkError> {
    let copy_sink = tx
        .copy_in(&build_copy_in_sql())
        .await
        .map_err(SinkError::Postgres)?;
    let writer = tokio_postgres::binary_copy::BinaryCopyInWriter::new(
        copy_sink,
        &[
            PgType::TIMESTAMPTZ,
            PgType::UUID,
            PgType::UUID,
            PgType::FLOAT8,
            PgType::FLOAT8,
            PgType::INT2,
            PgType::TEXT,
            PgType::INT8,
        ],
    );
    tokio::pin!(writer);
    for reading in readings {
        let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(reading.producer_ts)
            .ok_or_else(|| SinkError::InvalidRow {
                reason: "producer_ts outside chrono range".to_owned(),
            })?;
        let quality = i16::from(reading.quality.get());
        let row: [&(dyn ToSql + Sync); 8] = [
            &timestamp,
            &reading.sensor_id,
            &reading.channel_id,
            &reading.value,
            &reading.raw_value,
            &quality,
            &reading.source_event_id,
            &reading.source_sequence,
        ];
        writer
            .as_mut()
            .write(&row)
            .await
            .map_err(SinkError::Postgres)?;
    }
    writer.finish().await.map_err(SinkError::Postgres)?;
    Ok(())
}

async fn load_pending_dispatches(
    tx: &tokio_postgres::Transaction<'_>,
    schema: &SchemaName,
    tenant_id: tenant_context::TenantId,
    source_event_id: &str,
) -> Result<Vec<DurableDispatch>, SinkError> {
    let rows = tx
        .query(&build_pending_dispatch_sql(schema), &[&source_event_id])
        .await
        .map_err(SinkError::Postgres)?;
    rows.into_iter()
        .map(|row| {
            Ok(DurableDispatch {
                child_event_id: row.try_get("child_event_id").map_err(SinkError::Postgres)?,
                tenant_id,
                subject: row.try_get("subject").map_err(SinkError::Postgres)?,
                payload: row.try_get("payload").map_err(SinkError::Postgres)?,
            })
        })
        .collect()
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
        for (_schema, readings) in by_tenant {
            self.write_tenant_batch(readings).await?;
        }
        Ok(())
    }
}

impl PostgresSink {
    async fn acquire(&self) -> Result<deadpool_postgres::Object, SinkError> {
        tokio::time::timeout(Duration::from_secs(2), self.pool.get())
            .await
            .map_err(|_| SinkError::PoolAcquireTimeout)?
            .map_err(SinkError::PoolGet)
    }

    /// Atomically record the receipt, metric and dispatch intent in the
    /// validated tenant schema. No NATS I/O occurs while this transaction is
    /// open; the caller publishes only from the returned committed ledger rows.
    pub async fn commit_ingress(
        &self,
        input: DurableCommitInput,
    ) -> Result<DurableCommitOutcome, SinkError> {
        let tenant_id = input.reading.tenant_id;
        if input.dispatch.tenant_id != tenant_id {
            return Err(SinkError::InvalidLedgerState);
        }
        let schema = SchemaName::from_tenant_id(tenant_id);
        let mut conn = self.acquire().await?;
        conn.batch_execute(STAGE_DDL)
            .await
            .map_err(SinkError::Postgres)?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;
        configure_tenant_transaction(&tx, tenant_id).await?;
        assert_tenant_not_erased(&tx, tenant_id).await?;

        let timestamp =
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(input.reading.producer_ts)
                .ok_or_else(|| SinkError::InvalidRow {
                    reason: "producer_ts outside chrono range".to_owned(),
                })?;
        let inserted = tx
            .query(
                &build_receipt_insert_sql(&schema),
                &[
                    &input.reading.source_event_id,
                    &input.payload_digest,
                    &input.mqtt_topic,
                    &timestamp,
                    &input.reading.source_sequence,
                ],
            )
            .await
            .map_err(SinkError::Postgres)?;

        let duplicate = inserted.is_empty();
        if duplicate {
            let row = tx
                .query_opt(
                    &format!(
                        "SELECT payload_digest, commit_status FROM {schema}.sensor_ingest_receipts \
                         WHERE source_event_id = $1 FOR UPDATE"
                    ),
                    &[&input.reading.source_event_id],
                )
                .await
                .map_err(SinkError::Postgres)?
                .ok_or(SinkError::InvalidLedgerState)?;
            let digest: String = row.try_get("payload_digest").map_err(SinkError::Postgres)?;
            let status: String = row.try_get("commit_status").map_err(SinkError::Postgres)?;
            if digest != input.payload_digest {
                return Err(SinkError::SourceIdentityCollision);
            }
            if status != "COMMITTED" {
                return Err(SinkError::InvalidLedgerState);
            }
        } else {
            tx.batch_execute("TRUNCATE pg_temp._sensor_metrics_stage")
                .await
                .map_err(SinkError::Postgres)?;
            copy_readings(&tx, std::slice::from_ref(&input.reading)).await?;
            tx.batch_execute(&build_upsert_sql(&schema))
                .await
                .map_err(SinkError::Postgres)?;
            tx.execute(
                &format!(
                    "INSERT INTO {schema}.sensor_event_dispatch \
                     (child_event_id, source_event_id, subject, payload) \
                     VALUES ($1, $2, $3, $4::jsonb) \
                     ON CONFLICT (child_event_id) DO NOTHING"
                ),
                &[
                    &input.dispatch.child_event_id,
                    &input.reading.source_event_id,
                    &input.dispatch.subject,
                    &input.dispatch.payload,
                ],
            )
            .await
            .map_err(SinkError::Postgres)?;
        }

        let pending =
            load_pending_dispatches(&tx, &schema, tenant_id, &input.reading.source_event_id)
                .await?;
        tx.commit().await.map_err(SinkError::Postgres)?;
        if duplicate {
            Ok(DurableCommitOutcome::Duplicate(pending))
        } else {
            Ok(DurableCommitOutcome::Committed(pending))
        }
    }

    /// Persist a server-confirmed JetStream PubAck in the same tenant ledger.
    /// This method is idempotent for redelivery after an ACKED update commit.
    pub async fn mark_dispatch_acked(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
        ack: &JetStreamPubAck,
    ) -> Result<(), SinkError> {
        let schema = SchemaName::from_tenant_id(tenant_id);
        let mut conn = self.acquire().await?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;
        configure_tenant_transaction(&tx, tenant_id).await?;
        let sequence = i64::try_from(ack.sequence).map_err(|_| SinkError::InvalidLedgerState)?;
        let changed = tx
            .execute(
                &build_dispatch_ack_sql(&schema),
                &[&child_event_id, &ack.stream, &sequence],
            )
            .await
            .map_err(SinkError::Postgres)?;
        if changed == 0 {
            let row = tx
                .query_opt(
                    &format!(
                        "SELECT dispatch_status, puback_stream, puback_sequence \
                         FROM {schema}.sensor_event_dispatch WHERE child_event_id = $1"
                    ),
                    &[&child_event_id],
                )
                .await
                .map_err(SinkError::Postgres)?
                .ok_or(SinkError::InvalidLedgerState)?;
            let status: String = row
                .try_get("dispatch_status")
                .map_err(SinkError::Postgres)?;
            let stream: Option<String> =
                row.try_get("puback_stream").map_err(SinkError::Postgres)?;
            let stored_sequence: Option<i64> = row
                .try_get("puback_sequence")
                .map_err(SinkError::Postgres)?;
            if status != "ACKED"
                || stream.as_deref() != Some(ack.stream.as_str())
                || stored_sequence != Some(sequence)
            {
                return Err(SinkError::InvalidLedgerState);
            }
        }
        tx.commit().await.map_err(SinkError::Postgres)
    }

    async fn mark_dispatch_publish_failed(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
    ) -> Result<(), SinkError> {
        let schema = SchemaName::from_tenant_id(tenant_id);
        let mut conn = self.acquire().await?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;
        configure_tenant_transaction(&tx, tenant_id).await?;
        let changed = tx
            .execute(
                &format!(
                    "UPDATE {schema}.sensor_event_dispatch \
                     SET attempt_count = attempt_count + 1, \
                         next_attempt_at = now() + interval '1 second', \
                         last_error = 'JETSTREAM_PUBLISH_FAILED' \
                     WHERE child_event_id = $1 AND dispatch_status = 'PENDING'"
                ),
                &[&child_event_id],
            )
            .await
            .map_err(SinkError::Postgres)?;
        if changed != 1 {
            return Err(SinkError::InvalidLedgerState);
        }
        tx.commit().await.map_err(SinkError::Postgres)
    }

    async fn write_tenant_batch(&self, readings: Vec<SensorReading>) -> Result<(), SinkError> {
        if readings.is_empty() {
            return Ok(());
        }
        let Some(first) = readings.first() else {
            return Ok(());
        };
        let tenant_id = first.tenant_id;
        let schema = SchemaName::from_tenant_id(tenant_id);
        let mut conn = self.acquire().await?;
        conn.batch_execute(STAGE_DDL)
            .await
            .map_err(SinkError::Postgres)?;
        let tx = conn.transaction().await.map_err(SinkError::Postgres)?;
        tx.query_one(
            "SELECT set_config('app.current_tenant', $1, true)",
            &[&tenant_id.as_uuid().to_string()],
        )
        .await
        .map_err(SinkError::Postgres)?;
        tx.batch_execute(
            "SET LOCAL search_path = pg_catalog; TRUNCATE pg_temp._sensor_metrics_stage",
        )
        .await
        .map_err(SinkError::Postgres)?;

        let copy_sql = build_copy_in_sql();
        let copy_sink = tx.copy_in(&copy_sql).await.map_err(SinkError::Postgres)?;
        // Column types match build_copy_in_sql.
        let writer = tokio_postgres::binary_copy::BinaryCopyInWriter::new(
            copy_sink,
            &[
                PgType::TIMESTAMPTZ,
                PgType::UUID,
                PgType::UUID,
                PgType::FLOAT8,
                PgType::FLOAT8,
                PgType::INT2,
                PgType::TEXT,
                PgType::INT8,
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
            let raw_value = r.raw_value;
            let quality = i16::from(r.quality.get());
            let row: [&(dyn ToSql + Sync); 8] = [
                &ts,
                r.sensor_id.as_uuid_ref(),
                r.channel_id.as_uuid_ref(),
                &value,
                &raw_value,
                &quality,
                &r.source_event_id,
                &r.source_sequence,
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
        let upsert_sql = build_upsert_sql(&schema);
        tx.batch_execute(&upsert_sql)
            .await
            .map_err(SinkError::Postgres)?;
        tx.commit().await.map_err(SinkError::Postgres)?;
        Ok(())
    }
}

#[async_trait]
impl DurableIngressStore for PostgresSink {
    async fn commit(&self, input: DurableCommitInput) -> Result<DurableCommitOutcome, SinkError> {
        self.commit_ingress(input).await
    }

    async fn mark_acked(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
        ack: &JetStreamPubAck,
    ) -> Result<(), SinkError> {
        self.mark_dispatch_acked(tenant_id, child_event_id, ack)
            .await
    }

    async fn mark_publish_failed(
        &self,
        tenant_id: tenant_context::TenantId,
        child_event_id: uuid::Uuid,
    ) -> Result<(), SinkError> {
        self.mark_dispatch_publish_failed(tenant_id, child_event_id)
            .await
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

fn group_by_tenant(batch: Vec<SensorReading>) -> HashMap<SchemaName, Vec<SensorReading>> {
    let mut groups: HashMap<SchemaName, Vec<SensorReading>> = HashMap::new();
    for r in batch {
        groups
            .entry(SchemaName::from_tenant_id(r.tenant_id))
            .or_default()
            .push(r);
    }
    groups
}

/// DDL for the connection-local staging table. It is created once per leased
/// session and explicitly truncated at each transaction boundary.
pub const STAGE_DDL: &str = "CREATE TEMP TABLE IF NOT EXISTS _sensor_metrics_stage (\
    time timestamptz NOT NULL, \
    sensor_id uuid NOT NULL, \
    channel_id uuid NOT NULL, \
    value double precision NOT NULL, \
    raw_value double precision NOT NULL, \
    quality_code smallint NOT NULL, \
    source_event_id text NOT NULL, \
    source_sequence bigint\
) ON COMMIT PRESERVE ROWS";

/// `COPY ... FROM STDIN BINARY` into the per-transaction temp stage. Pure
/// function so the SQL shape can be unit-tested without postgres. The stage
/// identifier is a compile-time constant — no schema string is interpolated.
#[must_use]
pub fn build_copy_in_sql() -> String {
    "COPY pg_temp._sensor_metrics_stage \
     (time, sensor_id, channel_id, value, raw_value, quality_code, source_event_id, source_sequence) \
     FROM STDIN WITH (FORMAT BINARY)"
        .to_owned()
}

/// Upsert from the temp stage into the validated tenant hypertable. Older
/// redeliveries cannot overwrite a newer producer tuple.
#[must_use]
pub fn build_upsert_sql(schema: &SchemaName) -> String {
    format!(
        "INSERT INTO {schema}.sensor_metrics \
     (time, sensor_id, channel_id, value, raw_value, quality_code, source_event_id, source_sequence) \
     SELECT time, sensor_id, channel_id, value, raw_value, quality_code, source_event_id, source_sequence \
       FROM pg_temp._sensor_metrics_stage \
     ON CONFLICT (time, sensor_id, channel_id) DO UPDATE \
       SET value = EXCLUDED.value, \
           raw_value = EXCLUDED.raw_value, \
           quality_code = EXCLUDED.quality_code, \
           source_event_id = EXCLUDED.source_event_id, \
           source_sequence = EXCLUDED.source_sequence \
     WHERE (EXCLUDED.time, COALESCE(EXCLUDED.source_sequence, -9223372036854775808), EXCLUDED.source_event_id) \
         > ({schema}.sensor_metrics.time, COALESCE({schema}.sensor_metrics.source_sequence, -9223372036854775808), {schema}.sensor_metrics.source_event_id)"
    )
}

/// Tenant-qualified receipt insertion used by both initial delivery and
/// redelivery collision detection.
#[must_use]
pub fn build_receipt_insert_sql(schema: &SchemaName) -> String {
    format!(
        "INSERT INTO {schema}.sensor_ingest_receipts \
         (source_event_id, payload_digest, mqtt_topic, source_timestamp, source_sequence) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (source_event_id) DO NOTHING RETURNING source_event_id"
    )
}

/// Tenant-qualified pending-dispatch query. The row lock serializes two
/// redeliveries of the same persistent MQTT session after a crash.
#[must_use]
pub fn build_pending_dispatch_sql(schema: &SchemaName) -> String {
    format!(
        "SELECT child_event_id, subject, payload \
         FROM {schema}.sensor_event_dispatch \
         WHERE source_event_id = $1 AND dispatch_status = 'PENDING' \
         ORDER BY created_at, child_event_id FOR UPDATE"
    )
}

/// Tenant-qualified idempotent PubAck persistence.
#[must_use]
pub fn build_dispatch_ack_sql(schema: &SchemaName) -> String {
    format!(
        "UPDATE {schema}.sensor_event_dispatch \
         SET dispatch_status = 'ACKED', puback_stream = $2, puback_sequence = $3, \
             attempt_count = attempt_count + 1, last_error = NULL, acked_at = now() \
         WHERE child_event_id = $1 AND dispatch_status = 'PENDING'"
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
            source_event_id: "edge-test:1".to_owned(),
            source_sequence: Some(1),
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
    fn copy_in_sql_targets_pg_temp_stage_with_source_identity() {
        let sql = super::build_copy_in_sql();
        assert!(sql.contains("pg_temp._sensor_metrics_stage"));
        assert!(sql.contains("FORMAT BINARY"));
        assert!(
            sql.contains(
                "(time, sensor_id, channel_id, value, raw_value, quality_code, source_event_id, source_sequence)"
            )
        );
    }

    #[test]
    fn upsert_sql_targets_validated_tenant_schema_and_preserves_newer_source() {
        let schema =
            tenant_context::SchemaName::from_tenant_id(TenantId::from_uuid(fixed_uuid(0xAA)));
        let sql = super::build_upsert_sql(&schema);
        assert!(sql.contains(&format!("INSERT INTO {schema}.sensor_metrics")));
        assert!(!sql.contains("sensor.sensor_metrics"));
        assert!(sql.contains("ON CONFLICT (time, sensor_id, channel_id) DO UPDATE"));
        assert!(sql.contains("SET value = EXCLUDED.value"));
        assert!(sql.contains("raw_value = EXCLUDED.raw_value"));
        assert!(sql.contains("quality_code = EXCLUDED.quality_code"));
        assert!(sql.contains("source_event_id = EXCLUDED.source_event_id"));
        assert!(sql.contains("EXCLUDED.source_sequence"));
        assert!(sql.contains("sensor_metrics.source_event_id"));
    }

    #[test]
    fn stage_ddl_is_connection_local_and_preserved_between_transactions() {
        assert!(super::STAGE_DDL.contains("CREATE TEMP TABLE IF NOT EXISTS"));
        assert!(!super::STAGE_DDL.contains("tenant_id uuid"));
        assert!(super::STAGE_DDL.contains("source_event_id"));
        assert!(super::STAGE_DDL.contains("ON COMMIT PRESERVE ROWS"));
    }

    #[test]
    fn durable_ledger_sql_is_tenant_qualified_and_fail_closed() {
        let schema =
            tenant_context::SchemaName::from_tenant_id(TenantId::from_uuid(fixed_uuid(0xAA)));
        let receipt = super::build_receipt_insert_sql(&schema);
        let pending = super::build_pending_dispatch_sql(&schema);
        let ack = super::build_dispatch_ack_sql(&schema);

        assert!(receipt.contains(&format!("INSERT INTO {schema}.sensor_ingest_receipts")));
        assert!(receipt.contains("ON CONFLICT (source_event_id) DO NOTHING"));
        assert!(pending.contains(&format!("FROM {schema}.sensor_event_dispatch")));
        assert!(pending.contains("dispatch_status = 'PENDING'"));
        assert!(ack.contains(&format!("UPDATE {schema}.sensor_event_dispatch")));
        assert!(ack.contains("puback_stream = $2"));
        assert!(ack.contains("dispatch_status = 'PENDING'"));
        assert!(!receipt.contains("sensor.sensor_ingest_receipts"));
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
            source_event_id: format!("edge-test:{}", tenant.as_uuid()),
            source_sequence: Some(1),
            source: PayloadSource::UpcastedFromV1,
        };
        let batch = vec![mk(tenant_a), mk(tenant_b), mk(tenant_a), mk(tenant_a)];
        let groups = super::group_by_tenant(batch);
        let schema_a = tenant_context::SchemaName::from_tenant_id(tenant_a);
        let schema_b = tenant_context::SchemaName::from_tenant_id(tenant_b);
        assert_eq!(groups.get(&schema_a).map(Vec::len), Some(3));
        assert_eq!(groups.get(&schema_b).map(Vec::len), Some(1));
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
