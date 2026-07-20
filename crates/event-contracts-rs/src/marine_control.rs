//! Marine Explorer worker control-plane contracts.
//!
//! Farm owns the authoritative job, credential, usage, and result
//! state. The Rust worker exchanges the types in this module over seven
//! certificate-authorized Core NATS request-reply subjects. Every wire
//! struct rejects unknown fields so a rolling deployment cannot
//! silently ignore a contract change.

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::OnceLock};
use uuid::Uuid;

use crate::{
    MarineAnalysisJobKind, MarineAnalysisProvider, RequestFingerprint,
    marine::{
        deserialize_marine_timestamp, deserialize_optional_marine_timestamp,
        serialize_marine_timestamp, serialize_optional_marine_timestamp,
    },
};

/// Largest integer that TypeScript can represent without precision loss.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Maximum result or single artifact size in bytes.
pub const MAX_MARINE_RESULT_BYTES: u64 = 268_435_456;

/// Maximum scratch-space allowance in bytes.
pub const MAX_MARINE_SCRATCH_BYTES: u64 = 1_073_741_824;

/// Maximum tolerated future issuance skew for a lease-bearing reply.
pub const MARINE_MAX_CLOCK_SKEW_SECONDS: i64 = 5;

/// Schema version of the immutable CMEMS selection catalog.
pub const MARINE_SELECTION_CATALOG_SCHEMA_VERSION: u8 = 2;

/// Version of the immutable CMEMS selection catalog.
pub const MARINE_SELECTION_CATALOG_VERSION: &str = "2026-07-19.2";

/// SHA-256 revision of the immutable CMEMS selection catalog source bytes.
pub const MARINE_SELECTION_CATALOG_REVISION: &str =
    "6776655b7961f860ec5b88ce02e6b5b41b18296367da07229f8ff5c17d339e5b";

const CMEMS_SELECTION_LOCK_SCHEMA_VERSION: u8 = 1;
const CMEMS_SELECTION_LOCK_GENERATOR: &str =
    "libs/event-contracts/tools/cmems-resolved-selection-lock.ts";
const CMEMS_SELECTION_LOCK_SOURCE: &str =
    "apps/farm-service/src/marine-explorer/catalog/copernicus-catalog-lock.v2.json";
const CMEMS_SELECTION_LOCK_JSON: &str = include_str!(
    "../../../libs/event-contracts/src/catalog/cmems-resolved-selection-lock.v2.generated.json"
);

/// Integer whose inclusive range is enforced during deserialization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct BoundedU64<const MINIMUM: u64, const MAXIMUM: u64>(u64);

impl<const MINIMUM: u64, const MAXIMUM: u64> BoundedU64<MINIMUM, MAXIMUM> {
    /// Validate and construct a bounded integer.
    ///
    /// # Errors
    /// Returns an error when the value falls outside the inclusive range.
    pub const fn try_new(value: u64) -> Result<Self, &'static str> {
        if value < MINIMUM || value > MAXIMUM {
            return Err("integer is outside its contract range");
        }
        Ok(Self(value))
    }

    /// Return the validated integer.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<'de, const MINIMUM: u64, const MAXIMUM: u64> Deserialize<'de>
    for BoundedU64<MINIMUM, MAXIMUM>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u64::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

/// Positive JavaScript-safe generation or fencing epoch.
pub type MarineSafePositiveInteger = BoundedU64<1, MAX_SAFE_INTEGER>;

/// Non-negative JavaScript-safe byte counter.
pub type MarineSafeNonNegativeInteger = BoundedU64<0, MAX_SAFE_INTEGER>;

/// Usage-ledger attempt number.
pub type MarineUsageAttempt = BoundedU64<1, 1_000>;

/// Worker cell-count ceiling.
pub type MarineMaxCells = BoundedU64<1, 1_000_000>;

/// Worker time-step ceiling.
pub type MarineMaxTimeSteps = BoundedU64<1, 366>;

/// Worker result-size ceiling.
pub type MarineMaxOutputBytes = BoundedU64<1, MAX_MARINE_RESULT_BYTES>;

/// Worker scratch-size ceiling.
pub type MarineMaxScratchBytes = BoundedU64<1, MAX_MARINE_SCRATCH_BYTES>;

/// Provider-operation duration in milliseconds.
pub type MarineOperationDurationMs = BoundedU64<0, 86_400_000>;

/// Renewal interval returned by Farm.
pub type MarineRenewAfterSeconds = BoundedU64<1, 20>;

/// Single artifact length accepted by the capability contract.
pub type MarineArtifactByteLength = BoundedU64<1, MAX_MARINE_RESULT_BYTES>;

macro_rules! validated_string_type {
    ($(#[$meta:meta])* $name:ident, $validator:ident, $message:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Validate and construct the wire value.
            ///
            /// # Errors
            /// Returns an error when the value violates its contract pattern or bound.
            pub fn try_new(value: impl Into<String>) -> Result<Self, &'static str> {
                let value = value.into();
                if !$validator(&value) {
                    return Err($message);
                }
                Ok(Self(value))
            }

            /// Borrow the validated wire value.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Self::try_new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

fn is_valid_nonce(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_valid_failure_code(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

#[derive(Deserialize)]
#[serde(transparent)]
struct MarinePosition([f64; 2]);

impl MarinePosition {
    fn is_valid(&self) -> bool {
        let [longitude, latitude] = self.0;
        longitude.is_finite()
            && latitude.is_finite()
            && (-180.0..=180.0).contains(&longitude)
            && (-90.0..=90.0).contains(&latitude)
    }

    fn write_canonical_json(&self, output: &mut String) {
        let [longitude, latitude] = self.0;
        output.push('[');
        output.push_str(&canonical_json_number(longitude));
        output.push(',');
        output.push_str(&canonical_json_number(latitude));
        output.push(']');
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum MarineAreaGeometry {
    #[serde(rename = "Polygon")]
    Polygon {
        coordinates: Vec<Vec<MarinePosition>>,
    },
    #[serde(rename = "MultiPolygon")]
    MultiPolygon {
        coordinates: Vec<Vec<Vec<MarinePosition>>>,
    },
}

impl MarineAreaGeometry {
    fn is_valid(&self) -> bool {
        match self {
            Self::Polygon { coordinates } => is_valid_polygon(coordinates),
            Self::MultiPolygon { coordinates } => {
                !coordinates.is_empty()
                    && coordinates.iter().all(|polygon| is_valid_polygon(polygon))
            }
        }
    }

    fn canonical_json(&self) -> String {
        let mut output = String::new();
        match self {
            Self::Polygon { coordinates } => {
                output.push_str("{\"type\":\"Polygon\",\"coordinates\":");
                write_polygon_json(coordinates, &mut output);
            }
            Self::MultiPolygon { coordinates } => {
                output.push_str("{\"type\":\"MultiPolygon\",\"coordinates\":[");
                for (index, polygon) in coordinates.iter().enumerate() {
                    if index != 0 {
                        output.push(',');
                    }
                    write_polygon_json(polygon, &mut output);
                }
                output.push(']');
            }
        }
        output.push('}');
        output
    }
}

fn canonical_json_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.abs() < 0.000_001 {
        return format!("{value:e}");
    }
    value.to_string()
}

fn write_polygon_json(polygon: &[Vec<MarinePosition>], output: &mut String) {
    output.push('[');
    for (ring_index, ring) in polygon.iter().enumerate() {
        if ring_index != 0 {
            output.push(',');
        }
        output.push('[');
        for (position_index, position) in ring.iter().enumerate() {
            if position_index != 0 {
                output.push(',');
            }
            position.write_canonical_json(output);
        }
        output.push(']');
    }
    output.push(']');
}

fn is_valid_ring(ring: &[MarinePosition]) -> bool {
    ring.len() >= 4
        && ring.iter().all(MarinePosition::is_valid)
        && ring.first().map(|position| position.0) == ring.last().map(|position| position.0)
}

fn is_valid_polygon(polygon: &[Vec<MarinePosition>]) -> bool {
    !polygon.is_empty() && polygon.iter().all(|ring| is_valid_ring(ring))
}

fn is_valid_geo_json(value: &str) -> bool {
    if value.is_empty() || value.len() > 262_144 {
        return false;
    }
    if count_raw_json_property(value, "type") != 1
        || count_raw_json_property(value, "coordinates") != 1
    {
        return false;
    }
    serde_json::from_str::<MarineAreaGeometry>(value)
        .ok()
        .is_some_and(|geometry| geometry.is_valid() && geometry.canonical_json() == value)
}

fn count_raw_json_property(value: &str, property: &str) -> usize {
    let pattern = format!("\"{property}\"");
    value
        .match_indices(&pattern)
        .filter(|(offset, _)| {
            value
                .get(offset + pattern.len()..)
                .is_some_and(|remainder| remainder.trim_start().starts_with(':'))
        })
        .count()
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn is_valid_provider_request_id(value: &str) -> bool {
    (1..=512).contains(&value.chars().count())
}

fn deserialize_credential_identifier<'de, D>(deserializer: D) -> Result<SecretString, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_secret(deserializer, 512)
}

fn deserialize_credential_secret<'de, D>(deserializer: D) -> Result<SecretString, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_secret(deserializer, 4_096)
}

fn deserialize_bounded_secret<'de, D>(
    deserializer: D,
    maximum_characters: usize,
) -> Result<SecretString, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.chars().count() > maximum_characters {
        return Err(serde::de::Error::custom(
            "credential component is outside its contract length",
        ));
    }
    Ok(value.into())
}

validated_string_type!(
    /// Retry-stable control-plane nonce.
    MarineNonce,
    is_valid_nonce,
    "nonce must contain 16..=128 ASCII letters, digits, '_' or '-'"
);

validated_string_type!(
    /// Stable upper-snake-case failure code.
    MarineFailureCode,
    is_valid_failure_code,
    "failure code violates the platform failure-code contract"
);

validated_string_type!(
    /// Canonical approved-area GeoJSON bounded by the control contract.
    MarineAreaGeoJson,
    is_valid_geo_json,
    "marine area GeoJSON must be one bounded canonical Polygon or MultiPolygon"
);

validated_string_type!(
    /// Bounded provider request identifier.
    MarineProviderRequestId,
    is_valid_provider_request_id,
    "provider request id must contain 1..=512 characters"
);

/// Depth in meters bounded to the Copernicus catalog contract.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct MarineDepthMeters(f64);

impl MarineDepthMeters {
    /// Return the validated depth.
    #[must_use]
    pub const fn get(self) -> f64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for MarineDepthMeters {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = f64::deserialize(deserializer)?;
        if !(0.0..=12_000.0).contains(&value) {
            return Err(serde::de::Error::custom(
                "depth must be between 0 and 12000 meters",
            ));
        }
        Ok(Self(value))
    }
}

/// Provider processing units bounded to JavaScript's safe integer ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct MarineProcessingUnits(f64);

impl MarineProcessingUnits {
    /// Return the validated processing-unit value.
    #[must_use]
    pub const fn get(self) -> f64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for MarineProcessingUnits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = f64::deserialize(deserializer)?;
        if !(0.0..=9_007_199_254_740_991.0).contains(&value) {
            return Err(serde::de::Error::custom(
                "processingUnits is outside the contract range",
            ));
        }
        Ok(Self(value))
    }
}

/// Subject used to claim the immutable specification for an execution.
pub const MARINE_EXECUTION_LEASE_SUBJECT: &str = "request.farm.marineExecutionLease";

/// Subject used to renew or stop a fenced execution lease.
pub const MARINE_EXECUTION_RENEW_SUBJECT: &str = "request.farm.marineExecutionRenew";

/// Subject used to obtain a short-lived provider credential lease.
pub const MARINE_CREDENTIAL_LEASE_SUBJECT: &str = "request.farm.marineCredentialLease";

/// Subject used to obtain a short-lived read or write artifact capability.
pub const MARINE_ARTIFACT_LEASE_SUBJECT: &str = "request.farm.marineArtifactLease";

/// Subject used to reserve an external provider operation before I/O.
pub const MARINE_USAGE_RESERVE_SUBJECT: &str = "request.farm.marineUsageReserve";

/// Subject used to finalize an external provider operation after I/O.
pub const MARINE_USAGE_FINALIZE_SUBJECT: &str = "request.farm.marineUsageFinalize";

/// Subject used to persist the terminal execution result before ack.
pub const MARINE_EXECUTION_FINALIZE_SUBJECT: &str = "request.farm.marineExecutionFinalize";

/// All Core NATS subjects used by the Marine worker control connection.
pub const MARINE_WORKER_CONTROL_SUBJECTS: [&str; 7] = [
    MARINE_EXECUTION_LEASE_SUBJECT,
    MARINE_EXECUTION_RENEW_SUBJECT,
    MARINE_CREDENTIAL_LEASE_SUBJECT,
    MARINE_USAGE_RESERVE_SUBJECT,
    MARINE_USAGE_FINALIZE_SUBJECT,
    MARINE_ARTIFACT_LEASE_SUBJECT,
    MARINE_EXECUTION_FINALIZE_SUBJECT,
];

/// Broker-authorized reply namespace; `async-nats` appends its NUID.
pub const MARINE_WORKER_SCOPED_INBOX_PREFIX: &str = "_INBOXMARINEANALYSIS";

/// Scientific time role of a catalog dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineDataRole {
    /// Model analysis.
    Analysis,
    /// Model forecast.
    Forecast,
    /// Model reanalysis.
    Reanalysis,
    /// Historical model hindcast.
    Hindcast,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CmemsResolvedSelectionLock {
    schema_version: u8,
    generated_by: String,
    source_path: String,
    source_catalog: CmemsSelectionCatalogIdentity,
    resolved_selections: Vec<CmemsResolvedSelection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CmemsSelectionCatalogIdentity {
    schema_version: u8,
    catalog_version: String,
    catalog_revision: RequestFingerprint,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CmemsResolvedSelection {
    data_role: MarineDataRole,
    selection_provenance: serde_json::Value,
}

static CMEMS_RESOLVED_SELECTION_LOCK: OnceLock<Result<CmemsResolvedSelectionLock, &'static str>> =
    OnceLock::new();

fn cmems_resolved_selection_lock() -> Result<&'static CmemsResolvedSelectionLock, &'static str> {
    CMEMS_RESOLVED_SELECTION_LOCK
        .get_or_init(|| {
            let lock: CmemsResolvedSelectionLock = serde_json::from_str(CMEMS_SELECTION_LOCK_JSON)
                .map_err(|_| "embedded CMEMS selection lock is not valid JSON")?;
            if lock.schema_version != CMEMS_SELECTION_LOCK_SCHEMA_VERSION
                || lock.generated_by != CMEMS_SELECTION_LOCK_GENERATOR
                || lock.source_path != CMEMS_SELECTION_LOCK_SOURCE
                || lock.source_catalog.schema_version != MARINE_SELECTION_CATALOG_SCHEMA_VERSION
                || lock.source_catalog.catalog_version != MARINE_SELECTION_CATALOG_VERSION
                || lock.source_catalog.catalog_revision.as_str()
                    != MARINE_SELECTION_CATALOG_REVISION
                || lock.resolved_selections.is_empty()
            {
                return Err("embedded CMEMS selection lock identity is invalid");
            }

            let mut catalog_entry_ids = HashSet::new();
            for resolved in &lock.resolved_selections {
                let Some(provenance) = resolved.selection_provenance.as_object() else {
                    return Err("embedded CMEMS selection provenance is not an object");
                };
                let Some(catalog_entry_id) = provenance
                    .get("catalogEntryId")
                    .and_then(serde_json::Value::as_str)
                else {
                    return Err("embedded CMEMS selection provenance has no catalog entry id");
                };
                if !catalog_entry_ids.insert(catalog_entry_id)
                    || provenance.get("catalogSchemaVersion")
                        != Some(&serde_json::json!(MARINE_SELECTION_CATALOG_SCHEMA_VERSION))
                    || provenance.get("catalogVersion")
                        != Some(&serde_json::json!(MARINE_SELECTION_CATALOG_VERSION))
                    || provenance.get("catalogRevision")
                        != Some(&serde_json::json!(MARINE_SELECTION_CATALOG_REVISION))
                    || provenance.get("provider") != Some(&serde_json::json!("CMEMS"))
                {
                    return Err("embedded CMEMS selection provenance identity is invalid");
                }
            }
            Ok(lock)
        })
        .as_ref()
        .map_err(|error| *error)
}

/// Exact CMEMS dataset selection resolved from the generated catalog lock.
///
/// The value is intentionally opaque: deserialization succeeds only for one
/// structurally exact entry in the language-neutral generated lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct MarineSelectionProvenance(serde_json::Value);

impl MarineSelectionProvenance {
    fn matches_data_role(&self, data_role: MarineDataRole) -> bool {
        cmems_resolved_selection_lock().is_ok_and(|lock| {
            lock.resolved_selections.iter().any(|resolved| {
                resolved.data_role == data_role && resolved.selection_provenance == self.0
            })
        })
    }

    /// Borrow the exact generated-lock JSON value.
    #[must_use]
    pub const fn as_json(&self) -> &serde_json::Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MarineSelectionProvenance {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let lock = cmems_resolved_selection_lock().map_err(serde::de::Error::custom)?;
        if !lock
            .resolved_selections
            .iter()
            .any(|resolved| resolved.selection_provenance == value)
        {
            return Err(serde::de::Error::custom(
                "selection provenance does not exactly match the generated CMEMS lock",
            ));
        }
        Ok(Self(value))
    }
}

fn has_bounded_lease_window(issued_at: &DateTime<Utc>, expires_at: &DateTime<Utc>) -> bool {
    expires_at > issued_at && expires_at.signed_duration_since(issued_at) <= Duration::seconds(60)
}

fn lease_is_fresh_at(
    issued_at: &DateTime<Utc>,
    expires_at: &DateTime<Utc>,
    now: &DateTime<Utc>,
) -> bool {
    let issuance_is_not_too_far_ahead = now
        .checked_add_signed(Duration::seconds(MARINE_MAX_CLOCK_SKEW_SECONDS))
        .is_none_or(|latest_accepted_issuance| issued_at <= &latest_accepted_issuance);
    expires_at > now && issuance_is_not_too_far_ahead
}

/// Why a structurally valid lease-bearing reply is unusable at a supplied time.
#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum MarineLeaseFreshnessError {
    /// The lease expired or its issuance exceeds the tolerated clock skew.
    #[error("lease is expired or issued beyond the tolerated clock skew")]
    OutsideFreshnessWindow,
}

/// Kind of provider credential returned by the credential lease RPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineCredentialKind {
    /// Copernicus Marine username and password.
    CmemsUsernamePassword,
}

/// External provider operation recorded in the usage ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineUsageOperationType {
    /// Copernicus Marine dataset-description call.
    CmemsDescribe,
    /// Copernicus Marine direct data retrieval call.
    CmemsGet,
    /// Copernicus Marine Toolbox subset call.
    CmemsSubset,
}

/// Terminal outcome of a provider usage operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineUsageOutcome {
    /// Provider operation completed successfully.
    Succeeded,
    /// Provider operation failed.
    Failed,
    /// Provider operation was cancelled.
    Cancelled,
}

/// Namespace of the provider status code recorded in the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineProviderStatusKind {
    /// HTTP response status.
    Http,
    /// Copernicus Marine Toolbox process exit status.
    ToolExit,
    /// No provider status was available.
    NotAvailable,
}

/// Terminal state persisted for a Marine execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineExecutionTerminalState {
    /// Execution and manifest verification succeeded.
    Succeeded,
    /// Execution failed.
    Failed,
    /// Execution was cancelled.
    Cancelled,
}

/// Current stage reported during an execution heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineExecutionStage {
    /// Worker is validating and preparing immutable inputs.
    Preparing,
    /// Worker is performing an external provider call.
    ProviderCall,
    /// Worker is processing provider data locally.
    Processing,
    /// Worker is uploading an artifact through a leased capability.
    Uploading,
    /// Worker is finalizing usage and result state.
    Finalizing,
}

/// Farm-owned reason that an execution must stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineExecutionStopReason {
    /// A user requested cancellation.
    CancelRequested,
    /// The server-side feature flag no longer authorizes execution.
    FeatureDisabled,
    /// The provider credential generation was revoked.
    CredentialRevoked,
    /// Another execution claim owns the fencing epoch.
    LeaseFenced,
    /// The immutable execution deadline elapsed.
    DeadlineExceeded,
}

/// Fenced heartbeat request for a running execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineExecutionRenewRequest {
    /// Tenant that owns the job.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub job_id: Uuid,
    /// Worker execution attempt id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_id: Uuid,
    /// Current execution lease id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_lease_id: Uuid,
    /// Stable fencing epoch for the claim.
    pub lease_version: MarineSafePositiveInteger,
    /// Retry-stable heartbeat nonce.
    pub nonce: MarineNonce,
    /// Current execution stage.
    pub stage: MarineExecutionStage,
}

/// Farm's decision for a fenced execution heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "decision", deny_unknown_fields)]
pub enum MarineExecutionRenewReply {
    /// The current claim remains authoritative and may continue.
    #[serde(rename = "CONTINUE")]
    Continue {
        /// Current execution lease id.
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        /// Stable fencing epoch for the claim.
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        /// Timestamp at which Farm issued this lease window.
        #[serde(rename = "issuedAt")]
        #[serde(serialize_with = "serialize_marine_timestamp")]
        issued_at: DateTime<Utc>,
        /// Extended lease expiry in UTC.
        #[serde(rename = "expiresAt")]
        #[serde(serialize_with = "serialize_marine_timestamp")]
        expires_at: DateTime<Utc>,
    },
    /// Farm revoked or fenced the execution; the worker must stop.
    #[serde(rename = "STOP")]
    Stop {
        /// Current execution lease id.
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        /// Stable fencing epoch observed by Farm.
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        /// Authoritative stop reason.
        reason: MarineExecutionStopReason,
    },
}

#[derive(Deserialize)]
#[serde(tag = "decision", deny_unknown_fields)]
enum MarineExecutionRenewReplyWire {
    #[serde(rename = "CONTINUE")]
    Continue {
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        #[serde(rename = "issuedAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        issued_at: DateTime<Utc>,
        #[serde(rename = "expiresAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        expires_at: DateTime<Utc>,
    },
    #[serde(rename = "STOP")]
    Stop {
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        reason: MarineExecutionStopReason,
    },
}

impl<'de> Deserialize<'de> for MarineExecutionRenewReply {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match MarineExecutionRenewReplyWire::deserialize(deserializer)? {
            MarineExecutionRenewReplyWire::Continue {
                execution_lease_id,
                lease_version,
                issued_at,
                expires_at,
            } => {
                if !has_bounded_lease_window(&issued_at, &expires_at) {
                    return Err(serde::de::Error::custom(
                        "execution renewal expiry is outside its bounded issuance window",
                    ));
                }
                Ok(Self::Continue {
                    execution_lease_id,
                    lease_version,
                    issued_at,
                    expires_at,
                })
            }
            MarineExecutionRenewReplyWire::Stop {
                execution_lease_id,
                lease_version,
                reason,
            } => Ok(Self::Stop {
                execution_lease_id,
                lease_version,
                reason,
            }),
        }
    }
}

/// Why a non-artifact control reply was incompatible with its request.
#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum MarineControlCompatibilityError {
    /// Execution-lease identity or immutable fingerprint did not match.
    #[error("execution lease reply does not match request identity and fingerprint")]
    ExecutionLeaseMismatch,
    /// Execution-renew lease id or fencing version did not match.
    #[error("execution renewal reply does not match request lease fencing")]
    ExecutionRenewMismatch,
    /// Credential reply generation did not match the requested generation.
    #[error("credential generation does not match requested generation")]
    CredentialGenerationMismatch,
    /// Usage reply operation id did not match the request.
    #[error("usage reply operation id does not match request")]
    UsageOperationMismatch,
    /// Usage finalization state did not match the requested outcome.
    #[error("usage finalization state does not match requested outcome")]
    UsageOutcomeMismatch,
    /// Execution finalization identity did not match the request.
    #[error("execution finalization reply does not match request identity")]
    ExecutionFinalizeIdentityMismatch,
    /// Execution finalization state did not match the requested terminal state.
    #[error("execution finalization state does not match requested terminal state")]
    ExecutionFinalizeStateMismatch,
}

/// Why a lease-bearing control exchange cannot be used by the caller.
#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum MarineControlLeaseValidationError {
    /// The reply does not correlate to the originating request.
    #[error(transparent)]
    Compatibility(#[from] MarineControlCompatibilityError),
    /// The reply is not fresh at the caller-supplied time.
    #[error(transparent)]
    Freshness(#[from] MarineLeaseFreshnessError),
}

impl MarineExecutionRenewReply {
    /// Validate lease freshness at a caller-supplied instant.
    ///
    /// `STOP` is an authoritative non-lease decision and therefore bypasses
    /// freshness checks.
    ///
    /// # Errors
    /// Rejects an expired `CONTINUE` lease or issuance more than five seconds ahead.
    pub fn validate_at(&self, now: DateTime<Utc>) -> Result<(), MarineLeaseFreshnessError> {
        if let Self::Continue {
            issued_at,
            expires_at,
            ..
        } = self
            && !lease_is_fresh_at(issued_at, expires_at, &now)
        {
            return Err(MarineLeaseFreshnessError::OutsideFreshnessWindow);
        }
        Ok(())
    }

    /// Validate the returned lease fencing against the heartbeat request.
    ///
    /// # Errors
    /// Rejects a reply for another lease or fencing epoch.
    pub fn validate_for(
        &self,
        request: &MarineExecutionRenewRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        let (execution_lease_id, lease_version) = match self {
            Self::Continue {
                execution_lease_id,
                lease_version,
                ..
            }
            | Self::Stop {
                execution_lease_id,
                lease_version,
                ..
            } => (*execution_lease_id, *lease_version),
        };
        if execution_lease_id != request.execution_lease_id
            || lease_version != request.lease_version
        {
            return Err(MarineControlCompatibilityError::ExecutionRenewMismatch);
        }
        Ok(())
    }

    /// Validate both heartbeat correlation and deterministic lease freshness.
    ///
    /// # Errors
    /// Rejects mismatched fencing or an unusable `CONTINUE` lease.
    pub fn validate_for_at(
        &self,
        request: &MarineExecutionRenewRequest,
        now: DateTime<Utc>,
    ) -> Result<(), MarineControlLeaseValidationError> {
        self.validate_for(request)?;
        self.validate_at(now)?;
        Ok(())
    }
}

/// Immutable artifact type whose object key is owned by Farm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineArtifactKind {
    /// Raw provider subset in Zarr form.
    SourceZarr,
    /// Analysis-ready cloud-optimized GeoTIFF.
    RasterCog,
    /// Display-only PNG rendering.
    DisplayPng,
    /// Derived vector data encoded as JSON.
    VectorJson,
    /// AOI statistics encoded as JSON.
    StatisticsJson,
    /// Time-series result encoded as JSON.
    TimeSeriesJson,
    /// Immutable result manifest.
    Manifest,
}

impl MarineArtifactKind {
    /// Return the canonical Farm-owned leaf name for this artifact type.
    #[must_use]
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::SourceZarr => "source.zarr.zip",
            Self::RasterCog => "raster.cog.tif",
            Self::DisplayPng => "display.png",
            Self::VectorJson => "vector.json",
            Self::StatisticsJson => "statistics.json",
            Self::TimeSeriesJson => "time-series.json",
            Self::Manifest => "manifest.json",
        }
    }
}

fn is_valid_media_type(value: &str) -> bool {
    let Some((media_type, media_subtype)) = value.split_once('/') else {
        return false;
    };
    if media_subtype.contains('/') {
        return false;
    }
    let valid_section = |section: &str| {
        (1..=127).contains(&section.len())
            && section
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && section.bytes().skip(1).all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    valid_section(media_type) && valid_section(media_subtype)
}

validated_string_type!(
    /// Bounded IANA-style media type carried by a write lease request.
    MarineArtifactMediaType,
    is_valid_media_type,
    "artifact media type violates the control-plane contract"
);

/// Farm-derived artifact object key.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct MarineArtifactObjectKey(String);

impl MarineArtifactObjectKey {
    /// Borrow the validated object key.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn try_new(value: String) -> Result<Self, &'static str> {
        if value.len() > 1_024 {
            return Err("artifact object key violates the canonical marine path");
        }
        let segments = value.split('/').collect::<Vec<_>>();
        let [root, tenant_id, site_id, job_id, content_sha256, filename] = segments.as_slice()
        else {
            return Err("artifact object key violates the canonical marine path");
        };
        if *root != "marine"
            || crate::parse_canonical_uuid(tenant_id).is_err()
            || crate::parse_canonical_uuid(site_id).is_err()
            || crate::parse_canonical_uuid(job_id).is_err()
            || RequestFingerprint::try_new(*content_sha256).is_err()
            || !matches!(
                *filename,
                "source.zarr.zip"
                    | "raster.cog.tif"
                    | "display.png"
                    | "vector.json"
                    | "statistics.json"
                    | "time-series.json"
                    | "manifest.json"
            )
        {
            return Err("artifact object key violates the canonical marine path");
        }
        Ok(Self(value))
    }

    fn tenant_id(&self) -> Option<Uuid> {
        self.0
            .split('/')
            .nth(1)
            .and_then(|value| crate::parse_canonical_uuid(value).ok())
    }

    fn job_id(&self) -> Option<Uuid> {
        self.0
            .split('/')
            .nth(3)
            .and_then(|value| crate::parse_canonical_uuid(value).ok())
    }

    fn site_id(&self) -> Option<Uuid> {
        self.0
            .split('/')
            .nth(2)
            .and_then(|value| crate::parse_canonical_uuid(value).ok())
    }

    fn content_sha256(&self) -> &str {
        self.0.split('/').nth(4).unwrap_or_default()
    }

    fn filename(&self) -> &str {
        self.0.split('/').nth(5).unwrap_or_default()
    }
}

impl<'de> Deserialize<'de> for MarineArtifactObjectKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

/// Secret HTTPS capability URL returned by Farm.
#[derive(Debug, Clone)]
pub struct MarineHttpsCapability(SecretString);

impl MarineHttpsCapability {
    /// Borrow the secret URL wrapper without exposing its contents.
    #[must_use]
    pub const fn as_secret(&self) -> &SecretString {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MarineHttpsCapability {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        let has_raw_authority = value
            .strip_prefix("https://")
            .and_then(|remainder| remainder.split(['/', '?', '#']).next())
            .is_some_and(|authority| !authority.is_empty());
        let valid_url = !value.is_empty()
            && value.len() <= 4_096
            && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            && has_raw_authority
            && url::Url::parse(&value)
                .ok()
                .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some());
        if !valid_url {
            return Err(serde::de::Error::custom(
                "artifact capability must be a bounded HTTPS URL",
            ));
        }
        Ok(Self(value.into()))
    }
}

/// Empty header set required by a GET capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarineArtifactGetHeaders {}

/// Decimal artifact length transported as an HTTP header string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarineArtifactContentLength(String);

impl MarineArtifactContentLength {
    /// Borrow the validated decimal header value.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn value(&self) -> Option<u64> {
        self.0.parse().ok()
    }
}

impl<'de> Deserialize<'de> for MarineArtifactContentLength {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || value.len() > 9
            || value.starts_with('0')
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(serde::de::Error::custom(
                "artifact content-length header is invalid",
            ));
        }
        Ok(Self(value))
    }
}

/// Standard padded base64 SHA-256 checksum header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarineArtifactChecksumSha256(String);

impl MarineArtifactChecksumSha256 {
    /// Borrow the validated padded-base64 checksum.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for MarineArtifactChecksumSha256 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        let valid = value.len() == 44
            && value.ends_with('=')
            && value
                .bytes()
                .take(43)
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'));
        if !valid {
            return Err(serde::de::Error::custom(
                "artifact checksum header is not padded base64 SHA-256",
            ));
        }
        Ok(Self(value))
    }
}

/// Literal `*` used to make artifact writes create-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarineArtifactIfNoneMatch;

impl<'de> Deserialize<'de> for MarineArtifactIfNoneMatch {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "*" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(
                "artifact if-none-match header must equal '*'",
            ))
        }
    }
}

/// Exact four-header contract required by a PUT capability.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarineArtifactPutHeaders {
    /// Media type bound into the presigned request.
    #[serde(rename = "content-type")]
    pub content_type: MarineArtifactMediaType,
    /// Decimal artifact length bound into the presigned request.
    #[serde(rename = "content-length")]
    pub content_length: MarineArtifactContentLength,
    /// Base64 SHA-256 bound into the presigned request.
    #[serde(rename = "x-amz-checksum-sha256")]
    pub checksum_sha256: MarineArtifactChecksumSha256,
    /// Create-only precondition.
    #[serde(rename = "if-none-match")]
    pub if_none_match: MarineArtifactIfNoneMatch,
}

/// Read or write capability request for a Farm-owned object key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", deny_unknown_fields)]
pub enum MarineArtifactLeaseRequest {
    /// Request a read capability for an immutable source artifact.
    #[serde(rename = "READ")]
    Read {
        /// Tenant that owns the job.
        #[serde(rename = "tenantId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        tenant_id: Uuid,
        /// Job performing the read.
        #[serde(rename = "jobId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        job_id: Uuid,
        /// Site used in the canonical object-key lineage.
        #[serde(rename = "siteId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        site_id: Uuid,
        /// Worker execution attempt id.
        #[serde(rename = "executionId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_id: Uuid,
        /// Lease that authorizes the execution.
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        /// Fencing epoch of the execution lease.
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        /// Retry-stable request nonce.
        nonce: MarineNonce,
        /// Requested artifact type.
        #[serde(rename = "artifactKind")]
        artifact_kind: MarineArtifactKind,
        /// Snapshot job that owns the immutable source artifact.
        #[serde(rename = "sourceSnapshotJobId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        source_snapshot_job_id: Uuid,
        /// Expected SHA-256 of the source artifact.
        #[serde(rename = "artifactSha256")]
        artifact_sha256: RequestFingerprint,
    },
    /// Request a write capability for a bounded result artifact.
    #[serde(rename = "WRITE")]
    Write {
        /// Tenant that owns the job.
        #[serde(rename = "tenantId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        tenant_id: Uuid,
        /// Job performing the write.
        #[serde(rename = "jobId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        job_id: Uuid,
        /// Site used in the canonical object-key lineage.
        #[serde(rename = "siteId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        site_id: Uuid,
        /// Worker execution attempt id.
        #[serde(rename = "executionId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_id: Uuid,
        /// Lease that authorizes the execution.
        #[serde(rename = "executionLeaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        execution_lease_id: Uuid,
        /// Fencing epoch of the execution lease.
        #[serde(rename = "leaseVersion")]
        lease_version: MarineSafePositiveInteger,
        /// Retry-stable request nonce.
        nonce: MarineNonce,
        /// Result artifact type.
        #[serde(rename = "artifactKind")]
        artifact_kind: MarineArtifactKind,
        /// Artifact media type.
        #[serde(rename = "mediaType")]
        media_type: MarineArtifactMediaType,
        /// Exact artifact length in bytes.
        #[serde(rename = "byteLength")]
        byte_length: MarineArtifactByteLength,
        /// SHA-256 of the bytes that will be uploaded.
        #[serde(rename = "contentSha256")]
        content_sha256: RequestFingerprint,
    },
}

impl MarineArtifactLeaseRequest {
    fn tenant_id(&self) -> Uuid {
        match self {
            Self::Read { tenant_id, .. } | Self::Write { tenant_id, .. } => *tenant_id,
        }
    }

    fn object_job_id(&self) -> Uuid {
        match self {
            Self::Read {
                source_snapshot_job_id,
                ..
            } => *source_snapshot_job_id,
            Self::Write { job_id, .. } => *job_id,
        }
    }

    fn site_id(&self) -> Uuid {
        match self {
            Self::Read { site_id, .. } | Self::Write { site_id, .. } => *site_id,
        }
    }

    fn artifact_kind(&self) -> MarineArtifactKind {
        match self {
            Self::Read { artifact_kind, .. } | Self::Write { artifact_kind, .. } => *artifact_kind,
        }
    }

    fn content_sha256(&self) -> &str {
        match self {
            Self::Read {
                artifact_sha256, ..
            } => artifact_sha256.as_str(),
            Self::Write { content_sha256, .. } => content_sha256.as_str(),
        }
    }
}

/// Secret, short-lived artifact capability returned by Farm.
#[derive(Debug, Clone)]
pub enum MarineArtifactLeaseReply {
    /// HTTPS read capability.
    Get {
        /// Artifact lease id.
        lease_id: Uuid,
        /// Timestamp at which Farm issued the artifact lease.
        issued_at: DateTime<Utc>,
        /// Secret presigned HTTPS URL.
        url: MarineHttpsCapability,
        /// Exact Farm-derived object key.
        object_key: MarineArtifactObjectKey,
        /// Capability expiry in UTC.
        expires_at: DateTime<Utc>,
        /// Bounded headers required by the object store.
        required_headers: MarineArtifactGetHeaders,
    },
    /// HTTPS write capability.
    Put {
        /// Artifact lease id.
        lease_id: Uuid,
        /// Timestamp at which Farm issued the artifact lease.
        issued_at: DateTime<Utc>,
        /// Secret presigned HTTPS URL.
        url: MarineHttpsCapability,
        /// Exact Farm-derived object key.
        object_key: MarineArtifactObjectKey,
        /// Capability expiry in UTC.
        expires_at: DateTime<Utc>,
        /// Bounded headers required by the object store.
        required_headers: MarineArtifactPutHeaders,
    },
}

#[derive(Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
enum MarineArtifactLeaseReplyWire {
    #[serde(rename = "GET")]
    Get {
        #[serde(rename = "leaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        lease_id: Uuid,
        #[serde(rename = "issuedAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        issued_at: DateTime<Utc>,
        url: MarineHttpsCapability,
        #[serde(rename = "objectKey")]
        object_key: MarineArtifactObjectKey,
        #[serde(rename = "expiresAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        expires_at: DateTime<Utc>,
        #[serde(rename = "requiredHeaders")]
        required_headers: MarineArtifactGetHeaders,
    },
    #[serde(rename = "PUT")]
    Put {
        #[serde(rename = "leaseId")]
        #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
        lease_id: Uuid,
        #[serde(rename = "issuedAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        issued_at: DateTime<Utc>,
        url: MarineHttpsCapability,
        #[serde(rename = "objectKey")]
        object_key: MarineArtifactObjectKey,
        #[serde(rename = "expiresAt")]
        #[serde(deserialize_with = "deserialize_marine_timestamp")]
        expires_at: DateTime<Utc>,
        #[serde(rename = "requiredHeaders")]
        required_headers: MarineArtifactPutHeaders,
    },
}

impl<'de> Deserialize<'de> for MarineArtifactLeaseReply {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match MarineArtifactLeaseReplyWire::deserialize(deserializer)? {
            MarineArtifactLeaseReplyWire::Get {
                lease_id,
                issued_at,
                url,
                object_key,
                expires_at,
                required_headers,
            } => {
                if !has_bounded_lease_window(&issued_at, &expires_at) {
                    return Err(serde::de::Error::custom(
                        "artifact expiry is outside its bounded issuance window",
                    ));
                }
                Ok(Self::Get {
                    lease_id,
                    issued_at,
                    url,
                    object_key,
                    expires_at,
                    required_headers,
                })
            }
            MarineArtifactLeaseReplyWire::Put {
                lease_id,
                issued_at,
                url,
                object_key,
                expires_at,
                required_headers,
            } => {
                if !has_bounded_lease_window(&issued_at, &expires_at) {
                    return Err(serde::de::Error::custom(
                        "artifact expiry is outside its bounded issuance window",
                    ));
                }
                Ok(Self::Put {
                    lease_id,
                    issued_at,
                    url,
                    object_key,
                    expires_at,
                    required_headers,
                })
            }
        }
    }
}

/// Why an artifact reply was incompatible with its request.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum MarineArtifactLeaseCompatibilityError {
    /// READ must receive GET and WRITE must receive PUT.
    #[error("artifact capability method does not match request mode")]
    MethodMismatch,
    /// Farm returned an object key outside the request tenant/job/hash lineage.
    #[error("artifact object key does not match request lineage")]
    ObjectKeyMismatch,
    /// PUT headers do not bind the declared media type, length, and hash.
    #[error("artifact PUT headers do not match request metadata")]
    PutHeadersMismatch,
}

/// Why an artifact lease exchange cannot be used by the caller.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum MarineArtifactLeaseValidationError {
    /// Capability method, lineage, or bound headers did not match the request.
    #[error(transparent)]
    Compatibility(#[from] MarineArtifactLeaseCompatibilityError),
    /// The capability is not fresh at the caller-supplied time.
    #[error(transparent)]
    Freshness(#[from] MarineLeaseFreshnessError),
}

impl MarineArtifactLeaseReply {
    /// Validate capability freshness at a caller-supplied instant.
    ///
    /// # Errors
    /// Rejects an expired capability or issuance more than five seconds ahead.
    pub fn validate_at(&self, now: DateTime<Utc>) -> Result<(), MarineLeaseFreshnessError> {
        let (issued_at, expires_at) = match self {
            Self::Get {
                issued_at,
                expires_at,
                ..
            }
            | Self::Put {
                issued_at,
                expires_at,
                ..
            } => (issued_at, expires_at),
        };
        if !lease_is_fresh_at(issued_at, expires_at, &now) {
            return Err(MarineLeaseFreshnessError::OutsideFreshnessWindow);
        }
        Ok(())
    }

    /// Validate method and object-key lineage against the originating request.
    ///
    /// # Errors
    /// Rejects a method mismatch or an object key outside the request lineage.
    pub fn validate_for(
        &self,
        request: &MarineArtifactLeaseRequest,
    ) -> Result<(), MarineArtifactLeaseCompatibilityError> {
        let (method_matches, object_key) = match (request, self) {
            (MarineArtifactLeaseRequest::Read { .. }, Self::Get { object_key, .. })
            | (MarineArtifactLeaseRequest::Write { .. }, Self::Put { object_key, .. }) => {
                (true, object_key)
            }
            (_, Self::Get { object_key, .. } | Self::Put { object_key, .. }) => (false, object_key),
        };
        if !method_matches {
            return Err(MarineArtifactLeaseCompatibilityError::MethodMismatch);
        }
        if object_key.tenant_id() != Some(request.tenant_id())
            || object_key.site_id() != Some(request.site_id())
            || object_key.job_id() != Some(request.object_job_id())
            || object_key.content_sha256() != request.content_sha256()
            || object_key.filename() != request.artifact_kind().file_name()
        {
            return Err(MarineArtifactLeaseCompatibilityError::ObjectKeyMismatch);
        }
        if let (
            MarineArtifactLeaseRequest::Write {
                media_type,
                byte_length,
                content_sha256,
                ..
            },
            Self::Put {
                required_headers, ..
            },
        ) = (request, self)
        {
            let expected_checksum = hex::decode(content_sha256.as_str())
                .ok()
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
            if required_headers.content_type.as_str() != media_type.as_str()
                || required_headers.content_length.value() != Some(byte_length.get())
                || expected_checksum.as_deref() != Some(required_headers.checksum_sha256.as_str())
            {
                return Err(MarineArtifactLeaseCompatibilityError::PutHeadersMismatch);
            }
        }
        Ok(())
    }

    /// Validate capability correlation and deterministic freshness together.
    ///
    /// # Errors
    /// Rejects an incompatible request binding or unusable capability lease.
    pub fn validate_for_at(
        &self,
        request: &MarineArtifactLeaseRequest,
        now: DateTime<Utc>,
    ) -> Result<(), MarineArtifactLeaseValidationError> {
        self.validate_for(request)?;
        self.validate_at(now)?;
        Ok(())
    }
}

/// Claim request bound to the immutable fingerprint from the event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineExecutionLeaseRequest {
    /// Tenant that owns the job.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub job_id: Uuid,
    /// Worker execution attempt id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_id: Uuid,
    /// Retry-stable request nonce.
    pub nonce: MarineNonce,
    /// Fingerprint carried by the durable event.
    pub request_fingerprint: RequestFingerprint,
    /// Immutable user-request timestamp carried by the durable job state.
    #[serde(
        serialize_with = "serialize_marine_timestamp",
        deserialize_with = "deserialize_marine_timestamp"
    )]
    pub requested_at: DateTime<Utc>,
}

/// Secret-free immutable execution specification returned by Farm.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineExecutionLeaseReply {
    /// Execution lease id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub lease_id: Uuid,
    /// Stable fencing epoch for the current execution claim.
    pub lease_version: MarineSafePositiveInteger,
    /// Timestamp at which Farm issued the lease window.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub issued_at: DateTime<Utc>,
    /// Lease expiry in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub expires_at: DateTime<Utc>,
    /// Heartbeat interval selected by Farm.
    pub renew_after_seconds: MarineRenewAfterSeconds,
    /// Tenant that owns the job.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub job_id: Uuid,
    /// Worker execution attempt id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_id: Uuid,
    /// Canonical request fingerprint.
    pub request_fingerprint: RequestFingerprint,
    /// Immutable user-request timestamp carried by the durable job state.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub requested_at: DateTime<Utc>,
    /// Site whose approved area bounds the request.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub site_id: Uuid,
    /// Approved Marine area id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub marine_area_id: Uuid,
    /// Approved-area revision claimed by this execution.
    pub marine_area_revision: MarineSafePositiveInteger,
    /// SHA-256 of the approved-area representation.
    pub marine_area_sha256: RequestFingerprint,
    /// Canonical GeoJSON for the approved area.
    pub marine_area_geo_json: MarineAreaGeoJson,
    /// Provider used by this execution.
    pub provider: MarineAnalysisProvider,
    /// Requested analysis kind.
    pub job_kind: MarineAnalysisJobKind,
    /// Credential generation Farm authorizes for the job.
    pub credential_generation: MarineSafePositiveInteger,
    /// Exact generated-lock CMEMS selection selected for the job.
    pub selection_provenance: MarineSelectionProvenance,
    /// Scientific time role of the selected dataset.
    pub data_role: MarineDataRole,
    /// Immutable analysis/forecast partition boundary.
    #[serde(serialize_with = "serialize_optional_marine_timestamp")]
    pub temporal_partition_boundary_at: Option<DateTime<Utc>>,
    /// Start of provider coverage observed when selection became immutable.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub provider_coverage_start: DateTime<Utc>,
    /// End of provider coverage observed when selection became immutable.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub provider_coverage_end: DateTime<Utc>,
    /// Inclusive requested time start.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub time_start: DateTime<Utc>,
    /// Inclusive requested time end.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub time_end: DateTime<Utc>,
    /// Optional minimum depth in meters.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub depth_min_meters: Option<MarineDepthMeters>,
    /// Optional maximum depth in meters.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub depth_max_meters: Option<MarineDepthMeters>,
    /// Source snapshot job for derived work.
    #[serde(deserialize_with = "crate::deserialize_optional_canonical_uuid")]
    pub source_snapshot_job_id: Option<Uuid>,
    /// Maximum grid cells the worker may materialize.
    pub max_cells: MarineMaxCells,
    /// Maximum time steps the worker may materialize.
    pub max_time_steps: MarineMaxTimeSteps,
    /// Maximum result bytes the worker may emit.
    pub max_output_bytes: MarineMaxOutputBytes,
    /// Maximum scratch bytes the worker may allocate.
    pub max_scratch_bytes: MarineMaxScratchBytes,
    /// Absolute execution deadline in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub deadline_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineExecutionLeaseReplyWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    lease_id: Uuid,
    lease_version: MarineSafePositiveInteger,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    issued_at: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    expires_at: DateTime<Utc>,
    renew_after_seconds: MarineRenewAfterSeconds,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    tenant_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    request_fingerprint: RequestFingerprint,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    requested_at: DateTime<Utc>,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    site_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    marine_area_id: Uuid,
    marine_area_revision: MarineSafePositiveInteger,
    marine_area_sha256: RequestFingerprint,
    marine_area_geo_json: MarineAreaGeoJson,
    provider: MarineAnalysisProvider,
    job_kind: MarineAnalysisJobKind,
    credential_generation: MarineSafePositiveInteger,
    selection_provenance: MarineSelectionProvenance,
    data_role: MarineDataRole,
    #[serde(deserialize_with = "deserialize_optional_marine_timestamp")]
    temporal_partition_boundary_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    provider_coverage_start: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    provider_coverage_end: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    time_start: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    time_end: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_required_option")]
    depth_min_meters: Option<MarineDepthMeters>,
    #[serde(deserialize_with = "deserialize_required_option")]
    depth_max_meters: Option<MarineDepthMeters>,
    #[serde(deserialize_with = "crate::deserialize_optional_canonical_uuid")]
    source_snapshot_job_id: Option<Uuid>,
    max_cells: MarineMaxCells,
    max_time_steps: MarineMaxTimeSteps,
    max_output_bytes: MarineMaxOutputBytes,
    max_scratch_bytes: MarineMaxScratchBytes,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    deadline_at: DateTime<Utc>,
}

impl MarineExecutionLeaseReplyWire {
    fn validate(&self) -> Result<(), &'static str> {
        if !has_bounded_lease_window(&self.issued_at, &self.expires_at) {
            return Err("execution lease expiry is outside its bounded issuance window");
        }
        let next_renewal_at =
            i64::try_from(self.renew_after_seconds.get())
                .ok()
                .and_then(|seconds| {
                    self.issued_at
                        .checked_add_signed(Duration::seconds(seconds))
                });
        if next_renewal_at.is_none_or(|next_renewal_at| next_renewal_at >= self.expires_at) {
            return Err("execution lease renewal interval does not precede expiry");
        }
        if !self.selection_provenance.matches_data_role(self.data_role) {
            return Err("execution lease data role does not match its CMEMS selection provenance");
        }
        let marine_area_digest = hex::encode(Sha256::digest(
            self.marine_area_geo_json.as_str().as_bytes(),
        ));
        if marine_area_digest != self.marine_area_sha256.as_str() {
            return Err("execution lease marine area bytes do not match marine area SHA-256");
        }
        let source_snapshot_is_valid = match self.job_kind {
            MarineAnalysisJobKind::Snapshot => self.source_snapshot_job_id.is_none(),
            MarineAnalysisJobKind::AoiStats | MarineAnalysisJobKind::TimeSeries => {
                self.source_snapshot_job_id.is_some()
            }
        };
        if !source_snapshot_is_valid {
            return Err("execution lease source snapshot does not match its job kind");
        }
        let depth_range_is_valid = match (self.depth_min_meters, self.depth_max_meters) {
            (None, None) => true,
            (Some(minimum), Some(maximum)) => minimum.get() <= maximum.get(),
            (None, Some(_)) | (Some(_), None) => false,
        };
        if !depth_range_is_valid {
            return Err("execution lease depth endpoints must form one ordered range");
        }
        if self.time_start > self.time_end {
            return Err("execution lease acquisition time range is reversed");
        }
        if self.provider_coverage_start > self.provider_coverage_end
            || self.time_start < self.provider_coverage_start
            || self.time_end > self.provider_coverage_end
        {
            return Err("execution lease time range is outside the observed provider coverage");
        }
        if !self.has_valid_temporal_partition() {
            return Err("execution lease temporal partition does not match its data role");
        }
        if self.deadline_at <= self.issued_at
            || self.deadline_at.signed_duration_since(self.issued_at) > Duration::seconds(600)
        {
            return Err("execution lease deadline is outside its bounded issuance window");
        }
        Ok(())
    }

    fn has_valid_temporal_partition(&self) -> bool {
        match self.data_role {
            MarineDataRole::Analysis => {
                self.temporal_partition_boundary_at
                    .as_ref()
                    .is_some_and(|boundary_at| {
                        boundary_at == &self.requested_at && self.time_end <= *boundary_at
                    })
            }
            MarineDataRole::Forecast => {
                self.temporal_partition_boundary_at
                    .as_ref()
                    .is_some_and(|boundary_at| {
                        boundary_at == &self.requested_at && self.time_start > *boundary_at
                    })
            }
            MarineDataRole::Reanalysis | MarineDataRole::Hindcast => {
                self.temporal_partition_boundary_at.is_none()
            }
        }
    }
}

impl<'de> Deserialize<'de> for MarineExecutionLeaseReply {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineExecutionLeaseReplyWire::deserialize(deserializer)?;
        wire.validate().map_err(serde::de::Error::custom)?;
        Ok(Self {
            lease_id: wire.lease_id,
            lease_version: wire.lease_version,
            issued_at: wire.issued_at,
            expires_at: wire.expires_at,
            renew_after_seconds: wire.renew_after_seconds,
            tenant_id: wire.tenant_id,
            job_id: wire.job_id,
            execution_id: wire.execution_id,
            request_fingerprint: wire.request_fingerprint,
            requested_at: wire.requested_at,
            site_id: wire.site_id,
            marine_area_id: wire.marine_area_id,
            marine_area_revision: wire.marine_area_revision,
            marine_area_sha256: wire.marine_area_sha256,
            marine_area_geo_json: wire.marine_area_geo_json,
            provider: wire.provider,
            job_kind: wire.job_kind,
            credential_generation: wire.credential_generation,
            selection_provenance: wire.selection_provenance,
            data_role: wire.data_role,
            temporal_partition_boundary_at: wire.temporal_partition_boundary_at,
            provider_coverage_start: wire.provider_coverage_start,
            provider_coverage_end: wire.provider_coverage_end,
            time_start: wire.time_start,
            time_end: wire.time_end,
            depth_min_meters: wire.depth_min_meters,
            depth_max_meters: wire.depth_max_meters,
            source_snapshot_job_id: wire.source_snapshot_job_id,
            max_cells: wire.max_cells,
            max_time_steps: wire.max_time_steps,
            max_output_bytes: wire.max_output_bytes,
            max_scratch_bytes: wire.max_scratch_bytes,
            deadline_at: wire.deadline_at,
        })
    }
}

impl MarineExecutionLeaseReply {
    /// Validate lease freshness at a caller-supplied instant.
    ///
    /// # Errors
    /// Rejects an expired lease or issuance more than five seconds ahead.
    pub fn validate_at(&self, now: DateTime<Utc>) -> Result<(), MarineLeaseFreshnessError> {
        if !lease_is_fresh_at(&self.issued_at, &self.expires_at, &now) {
            return Err(MarineLeaseFreshnessError::OutsideFreshnessWindow);
        }
        Ok(())
    }

    /// Validate request identity and fingerprint against the claimed specification.
    ///
    /// # Errors
    /// Rejects a reply correlated to a different tenant, job, execution, or request.
    pub fn validate_for(
        &self,
        request: &MarineExecutionLeaseRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        if self.tenant_id != request.tenant_id
            || self.job_id != request.job_id
            || self.execution_id != request.execution_id
            || self.request_fingerprint != request.request_fingerprint
            || self.requested_at != request.requested_at
        {
            return Err(MarineControlCompatibilityError::ExecutionLeaseMismatch);
        }
        Ok(())
    }

    /// Validate both claim correlation and deterministic lease freshness.
    ///
    /// # Errors
    /// Rejects a mismatched claim or unusable execution lease.
    pub fn validate_for_at(
        &self,
        request: &MarineExecutionLeaseRequest,
        now: DateTime<Utc>,
    ) -> Result<(), MarineControlLeaseValidationError> {
        self.validate_for(request)?;
        self.validate_at(now)?;
        Ok(())
    }
}

/// Credential request authorized from Farm job state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineCredentialLeaseRequest {
    /// Tenant that owns the job.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub job_id: Uuid,
    /// Worker execution attempt id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_id: Uuid,
    /// Lease that authorizes the execution.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub execution_lease_id: Uuid,
    /// Fencing epoch of the execution lease.
    pub lease_version: MarineSafePositiveInteger,
    /// Provider whose credential is required.
    pub provider: MarineAnalysisProvider,
    /// Exact credential generation authorized by the execution specification.
    pub credential_generation: MarineSafePositiveInteger,
    /// Retry-stable request nonce.
    pub nonce: MarineNonce,
}

/// Secret Copernicus Marine credential value.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineCmemsCredentialValue {
    /// Copernicus Marine username, redacted by `Debug`.
    #[serde(deserialize_with = "deserialize_credential_identifier")]
    pub username: SecretString,
    /// Copernicus Marine password, redacted by `Debug`.
    #[serde(deserialize_with = "deserialize_credential_secret")]
    pub password: SecretString,
}

/// Short-lived provider credential reply.
///
/// This type intentionally implements `Deserialize` but not `Serialize`:
/// the worker may receive a credential lease, but generic serialization
/// cannot accidentally persist or republish its secret value.
#[derive(Debug, Clone)]
pub struct MarineCredentialLeaseReply {
    /// Credential lease id.
    pub lease_id: Uuid,
    /// Sole CMEMS credential kind.
    pub kind: MarineCredentialKind,
    /// Secret credential value.
    pub value: MarineCmemsCredentialValue,
    /// Timestamp at which Farm issued the credential lease.
    pub issued_at: DateTime<Utc>,
    /// Lease expiry in UTC.
    pub expires_at: DateTime<Utc>,
    /// Credential generation selected by Farm.
    pub generation: MarineSafePositiveInteger,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineCredentialLeaseReplyWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    lease_id: Uuid,
    kind: MarineCredentialKind,
    value: MarineCmemsCredentialValue,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    issued_at: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    expires_at: DateTime<Utc>,
    generation: MarineSafePositiveInteger,
}

impl<'de> Deserialize<'de> for MarineCredentialLeaseReply {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineCredentialLeaseReplyWire::deserialize(deserializer)?;
        if !has_bounded_lease_window(&wire.issued_at, &wire.expires_at) {
            return Err(serde::de::Error::custom(
                "credential expiry is outside its bounded issuance window",
            ));
        }
        Ok(Self {
            lease_id: wire.lease_id,
            kind: wire.kind,
            value: wire.value,
            issued_at: wire.issued_at,
            expires_at: wire.expires_at,
            generation: wire.generation,
        })
    }
}

impl MarineCredentialLeaseReply {
    /// Validate lease freshness at a caller-supplied instant.
    ///
    /// # Errors
    /// Rejects an expired lease or issuance more than five seconds ahead.
    pub fn validate_at(&self, now: DateTime<Utc>) -> Result<(), MarineLeaseFreshnessError> {
        if !lease_is_fresh_at(&self.issued_at, &self.expires_at, &now) {
            return Err(MarineLeaseFreshnessError::OutsideFreshnessWindow);
        }
        Ok(())
    }

    /// Validate the returned credential generation against the request.
    ///
    /// # Errors
    /// Rejects a credential from a different generation.
    pub fn validate_for(
        &self,
        request: &MarineCredentialLeaseRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        if self.generation != request.credential_generation {
            return Err(MarineControlCompatibilityError::CredentialGenerationMismatch);
        }
        Ok(())
    }

    /// Validate both generation correlation and deterministic lease freshness.
    ///
    /// # Errors
    /// Rejects the wrong credential generation or an unusable credential lease.
    pub fn validate_for_at(
        &self,
        request: &MarineCredentialLeaseRequest,
        now: DateTime<Utc>,
    ) -> Result<(), MarineControlLeaseValidationError> {
        self.validate_for(request)?;
        self.validate_at(now)?;
        Ok(())
    }
}

/// Stable lineage reservation written before a provider call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarineUsageReserveRequest {
    /// Tenant that owns the job.
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    pub job_id: Uuid,
    /// Worker execution attempt id.
    pub execution_id: Uuid,
    /// Lease that authorizes the execution.
    pub execution_lease_id: Uuid,
    /// Fencing epoch of the execution lease.
    pub lease_version: MarineSafePositiveInteger,
    /// Stable provider operation id.
    pub operation_id: Uuid,
    /// Idempotency key for this reservation lineage.
    pub idempotency_key: Uuid,
    /// Provider called by the operation.
    pub provider: MarineAnalysisProvider,
    /// Provider operation type.
    pub operation_type: MarineUsageOperationType,
    /// Fingerprint of the provider request.
    pub request_fingerprint: RequestFingerprint,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineUsageReserveRequestWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    tenant_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_lease_id: Uuid,
    lease_version: MarineSafePositiveInteger,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    operation_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    idempotency_key: Uuid,
    provider: MarineAnalysisProvider,
    operation_type: MarineUsageOperationType,
    request_fingerprint: RequestFingerprint,
}

impl<'de> Deserialize<'de> for MarineUsageReserveRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineUsageReserveRequestWire::deserialize(deserializer)?;
        Ok(Self {
            tenant_id: wire.tenant_id,
            job_id: wire.job_id,
            execution_id: wire.execution_id,
            execution_lease_id: wire.execution_lease_id,
            lease_version: wire.lease_version,
            operation_id: wire.operation_id,
            idempotency_key: wire.idempotency_key,
            provider: wire.provider,
            operation_type: wire.operation_type,
            request_fingerprint: wire.request_fingerprint,
        })
    }
}

/// State returned after reserving a usage operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarineUsageReservationState {
    /// Operation is durably reserved.
    Reserved,
}

/// Reply returned after reserving a provider operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineUsageReserveReply {
    /// Stable provider operation id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub operation_id: Uuid,
    /// Reservation state, always `RESERVED`.
    pub state: MarineUsageReservationState,
    /// Attempt count for this operation lineage.
    pub attempt: MarineUsageAttempt,
    /// Reservation timestamp in UTC.
    #[serde(
        serialize_with = "serialize_marine_timestamp",
        deserialize_with = "deserialize_marine_timestamp"
    )]
    pub reserved_at: DateTime<Utc>,
    /// Whether Farm replayed an existing reservation.
    pub replayed: bool,
}

impl MarineUsageReserveReply {
    /// Validate the operation id against the originating reservation.
    ///
    /// # Errors
    /// Rejects a reply for another provider operation.
    pub fn validate_for(
        &self,
        request: &MarineUsageReserveRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        if self.operation_id != request.operation_id {
            return Err(MarineControlCompatibilityError::UsageOperationMismatch);
        }
        Ok(())
    }
}

/// Final accounting for a provider operation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarineUsageFinalizeRequest {
    /// Tenant that owns the job.
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    pub job_id: Uuid,
    /// Worker execution attempt id.
    pub execution_id: Uuid,
    /// Lease that authorizes the execution.
    pub execution_lease_id: Uuid,
    /// Fencing epoch of the execution lease.
    pub lease_version: MarineSafePositiveInteger,
    /// Stable provider operation id.
    pub operation_id: Uuid,
    /// Idempotency key used for the reservation.
    pub idempotency_key: Uuid,
    /// Terminal provider operation outcome.
    pub outcome: MarineUsageOutcome,
    /// Namespace of the provider status code.
    pub provider_status_kind: MarineProviderStatusKind,
    /// HTTP or process status code when available.
    pub provider_status_code: Option<u16>,
    /// Provider request id when returned.
    pub provider_request_id: Option<MarineProviderRequestId>,
    /// Provider processing units when returned.
    pub processing_units: Option<MarineProcessingUnits>,
    /// Bytes read from the provider.
    pub bytes_in: MarineSafeNonNegativeInteger,
    /// Bytes written by the worker.
    pub bytes_out: MarineSafeNonNegativeInteger,
    /// Provider operation duration in milliseconds.
    pub duration_ms: MarineOperationDurationMs,
    /// Stable failure code when the operation failed.
    pub failure_code: Option<MarineFailureCode>,
    /// Completion timestamp in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub finished_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineUsageFinalizeRequestWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    tenant_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_lease_id: Uuid,
    lease_version: MarineSafePositiveInteger,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    operation_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    idempotency_key: Uuid,
    outcome: MarineUsageOutcome,
    provider_status_kind: MarineProviderStatusKind,
    #[serde(deserialize_with = "deserialize_required_option")]
    provider_status_code: Option<u16>,
    #[serde(deserialize_with = "deserialize_required_option")]
    provider_request_id: Option<MarineProviderRequestId>,
    #[serde(deserialize_with = "deserialize_required_option")]
    processing_units: Option<MarineProcessingUnits>,
    bytes_in: MarineSafeNonNegativeInteger,
    bytes_out: MarineSafeNonNegativeInteger,
    duration_ms: MarineOperationDurationMs,
    #[serde(deserialize_with = "deserialize_required_option")]
    failure_code: Option<MarineFailureCode>,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    finished_at: DateTime<Utc>,
}

impl<'de> Deserialize<'de> for MarineUsageFinalizeRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineUsageFinalizeRequestWire::deserialize(deserializer)?;
        let status_is_valid = match wire.provider_status_kind {
            MarineProviderStatusKind::Http => wire
                .provider_status_code
                .is_some_and(|code| (100..=599).contains(&code)),
            MarineProviderStatusKind::ToolExit => {
                wire.provider_status_code.is_some_and(|code| code <= 255)
            }
            MarineProviderStatusKind::NotAvailable => wire.provider_status_code.is_none(),
        };
        if !status_is_valid {
            return Err(serde::de::Error::custom(
                "provider status code does not match its kind",
            ));
        }
        let successful_status_is_valid = match wire.outcome {
            MarineUsageOutcome::Succeeded => match wire.provider_status_kind {
                MarineProviderStatusKind::Http => wire
                    .provider_status_code
                    .is_some_and(|code| (200..=299).contains(&code)),
                MarineProviderStatusKind::ToolExit => wire.provider_status_code == Some(0),
                MarineProviderStatusKind::NotAvailable => false,
            },
            MarineUsageOutcome::Failed | MarineUsageOutcome::Cancelled => true,
        };
        if !successful_status_is_valid {
            return Err(serde::de::Error::custom(
                "successful usage outcome does not carry a successful provider status",
            ));
        }
        let failure_is_valid = match wire.outcome {
            MarineUsageOutcome::Succeeded => wire.failure_code.is_none(),
            MarineUsageOutcome::Failed | MarineUsageOutcome::Cancelled => {
                wire.failure_code.is_some()
            }
        };
        if !failure_is_valid {
            return Err(serde::de::Error::custom(
                "failure code does not match usage outcome",
            ));
        }
        Ok(Self {
            tenant_id: wire.tenant_id,
            job_id: wire.job_id,
            execution_id: wire.execution_id,
            execution_lease_id: wire.execution_lease_id,
            lease_version: wire.lease_version,
            operation_id: wire.operation_id,
            idempotency_key: wire.idempotency_key,
            outcome: wire.outcome,
            provider_status_kind: wire.provider_status_kind,
            provider_status_code: wire.provider_status_code,
            provider_request_id: wire.provider_request_id,
            processing_units: wire.processing_units,
            bytes_in: wire.bytes_in,
            bytes_out: wire.bytes_out,
            duration_ms: wire.duration_ms,
            failure_code: wire.failure_code,
            finished_at: wire.finished_at,
        })
    }
}

/// Reply returned after finalizing a provider operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarineUsageFinalizeReply {
    /// Stable provider operation id.
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    pub operation_id: Uuid,
    /// Terminal provider operation state.
    pub state: MarineUsageOutcome,
    /// Attempt count for this operation lineage.
    pub attempt: MarineUsageAttempt,
    /// Finalization timestamp in UTC.
    #[serde(
        serialize_with = "serialize_marine_timestamp",
        deserialize_with = "deserialize_marine_timestamp"
    )]
    pub finalized_at: DateTime<Utc>,
    /// Whether Farm replayed an existing finalization.
    pub replayed: bool,
}

impl MarineUsageFinalizeReply {
    /// Validate operation lineage and terminal outcome against the request.
    ///
    /// # Errors
    /// Rejects a reply for another operation or a different terminal outcome.
    pub fn validate_for(
        &self,
        request: &MarineUsageFinalizeRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        if self.operation_id != request.operation_id {
            return Err(MarineControlCompatibilityError::UsageOperationMismatch);
        }
        if self.state != request.outcome {
            return Err(MarineControlCompatibilityError::UsageOutcomeMismatch);
        }
        Ok(())
    }
}

/// Canonical immutable manifest key returned by a successful execution.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct MarineResultManifestKey(String);

impl MarineResultManifestKey {
    /// Borrow the validated object key.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn try_new(value: String) -> Result<Self, &'static str> {
        let segments = value.split('/').collect::<Vec<_>>();
        let [root, tenant_id, site_id, job_id, manifest_sha256, filename] = segments.as_slice()
        else {
            return Err("result manifest key violates the canonical marine path");
        };
        if *root != "marine"
            || crate::parse_canonical_uuid(tenant_id).is_err()
            || crate::parse_canonical_uuid(site_id).is_err()
            || crate::parse_canonical_uuid(job_id).is_err()
            || RequestFingerprint::try_new(*manifest_sha256).is_err()
            || *filename != "manifest.json"
        {
            return Err("result manifest key violates the canonical marine path");
        }
        Ok(Self(value))
    }

    fn matches_lineage(
        &self,
        tenant_id: Uuid,
        job_id: Uuid,
        manifest_sha256: &RequestFingerprint,
    ) -> bool {
        let mut segments = self.0.split('/');
        let key_tenant_id = segments
            .nth(1)
            .and_then(|value| crate::parse_canonical_uuid(value).ok());
        let key_job_id = segments
            .nth(1)
            .and_then(|value| crate::parse_canonical_uuid(value).ok());
        let key_sha256 = segments.next();
        key_tenant_id == Some(tenant_id)
            && key_job_id == Some(job_id)
            && key_sha256 == Some(manifest_sha256.as_str())
    }
}

impl<'de> Deserialize<'de> for MarineResultManifestKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::try_new(value).map_err(serde::de::Error::custom)
    }
}

/// Terminal execution state written before the durable event is acked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarineExecutionFinalizeRequest {
    /// Tenant that owns the job.
    pub tenant_id: Uuid,
    /// Authoritative Farm job id.
    pub job_id: Uuid,
    /// Worker execution attempt id.
    pub execution_id: Uuid,
    /// Lease that authorizes the execution.
    pub execution_lease_id: Uuid,
    /// Fencing epoch of the execution lease.
    pub lease_version: MarineSafePositiveInteger,
    /// Idempotency key for terminal persistence.
    pub idempotency_key: Uuid,
    /// Canonical request fingerprint.
    pub request_fingerprint: RequestFingerprint,
    /// Requested terminal state.
    pub terminal_state: MarineExecutionTerminalState,
    /// Result manifest object key on success.
    pub result_manifest_key: Option<MarineResultManifestKey>,
    /// SHA-256 of the result manifest on success.
    pub result_manifest_sha256: Option<RequestFingerprint>,
    /// Stable failure code on failure.
    pub failure_code: Option<MarineFailureCode>,
    /// Whether Farm may schedule another execution.
    pub retryable: bool,
    /// Completion timestamp in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub finished_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineExecutionFinalizeRequestWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    tenant_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_lease_id: Uuid,
    lease_version: MarineSafePositiveInteger,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    idempotency_key: Uuid,
    request_fingerprint: RequestFingerprint,
    terminal_state: MarineExecutionTerminalState,
    #[serde(deserialize_with = "deserialize_required_option")]
    result_manifest_key: Option<MarineResultManifestKey>,
    #[serde(deserialize_with = "deserialize_required_option")]
    result_manifest_sha256: Option<RequestFingerprint>,
    #[serde(deserialize_with = "deserialize_required_option")]
    failure_code: Option<MarineFailureCode>,
    retryable: bool,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    finished_at: DateTime<Utc>,
}

impl<'de> Deserialize<'de> for MarineExecutionFinalizeRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineExecutionFinalizeRequestWire::deserialize(deserializer)?;
        match wire.terminal_state {
            MarineExecutionTerminalState::Succeeded => {
                let (Some(key), Some(sha256)) = (
                    wire.result_manifest_key.as_ref(),
                    wire.result_manifest_sha256.as_ref(),
                ) else {
                    return Err(serde::de::Error::custom(
                        "successful execution requires manifest key and SHA-256",
                    ));
                };
                if wire.failure_code.is_some()
                    || wire.retryable
                    || !key.matches_lineage(wire.tenant_id, wire.job_id, sha256)
                {
                    return Err(serde::de::Error::custom(
                        "successful execution manifest lineage or terminal fields are invalid",
                    ));
                }
            }
            MarineExecutionTerminalState::Failed | MarineExecutionTerminalState::Cancelled => {
                if wire.result_manifest_key.is_some()
                    || wire.result_manifest_sha256.is_some()
                    || wire.failure_code.is_none()
                    || (wire.terminal_state == MarineExecutionTerminalState::Cancelled
                        && wire.retryable)
                {
                    return Err(serde::de::Error::custom(
                        "unsuccessful execution terminal fields are invalid",
                    ));
                }
            }
        }
        Ok(Self {
            tenant_id: wire.tenant_id,
            job_id: wire.job_id,
            execution_id: wire.execution_id,
            execution_lease_id: wire.execution_lease_id,
            lease_version: wire.lease_version,
            idempotency_key: wire.idempotency_key,
            request_fingerprint: wire.request_fingerprint,
            terminal_state: wire.terminal_state,
            result_manifest_key: wire.result_manifest_key,
            result_manifest_sha256: wire.result_manifest_sha256,
            failure_code: wire.failure_code,
            retryable: wire.retryable,
            finished_at: wire.finished_at,
        })
    }
}

/// Reply returned after persisting terminal execution state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarineExecutionFinalizeReply {
    /// Authoritative Farm job id.
    pub job_id: Uuid,
    /// Worker execution attempt id.
    pub execution_id: Uuid,
    /// Persisted terminal state.
    pub state: MarineExecutionTerminalState,
    /// Finalization timestamp in UTC.
    #[serde(serialize_with = "serialize_marine_timestamp")]
    pub finalized_at: DateTime<Utc>,
    /// Whether Farm verified the referenced manifest.
    pub manifest_verified: bool,
    /// Whether Farm replayed an existing finalization.
    pub replayed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarineExecutionFinalizeReplyWire {
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    job_id: Uuid,
    #[serde(deserialize_with = "crate::deserialize_canonical_uuid")]
    execution_id: Uuid,
    state: MarineExecutionTerminalState,
    #[serde(deserialize_with = "deserialize_marine_timestamp")]
    finalized_at: DateTime<Utc>,
    manifest_verified: bool,
    replayed: bool,
}

impl<'de> Deserialize<'de> for MarineExecutionFinalizeReply {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = MarineExecutionFinalizeReplyWire::deserialize(deserializer)?;
        let verification_is_valid = match wire.state {
            MarineExecutionTerminalState::Succeeded => wire.manifest_verified,
            MarineExecutionTerminalState::Failed | MarineExecutionTerminalState::Cancelled => {
                !wire.manifest_verified
            }
        };
        if !verification_is_valid {
            return Err(serde::de::Error::custom(
                "manifest verification does not match execution state",
            ));
        }
        Ok(Self {
            job_id: wire.job_id,
            execution_id: wire.execution_id,
            state: wire.state,
            finalized_at: wire.finalized_at,
            manifest_verified: wire.manifest_verified,
            replayed: wire.replayed,
        })
    }
}

impl MarineExecutionFinalizeReply {
    /// Validate identity and terminal state against the originating request.
    ///
    /// # Errors
    /// Rejects a reply for another job/execution or a different terminal state.
    pub fn validate_for(
        &self,
        request: &MarineExecutionFinalizeRequest,
    ) -> Result<(), MarineControlCompatibilityError> {
        if self.job_id != request.job_id || self.execution_id != request.execution_id {
            return Err(MarineControlCompatibilityError::ExecutionFinalizeIdentityMismatch);
        }
        if self.state != request.terminal_state {
            return Err(MarineControlCompatibilityError::ExecutionFinalizeStateMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret;
    use serde::{Serialize, de::DeserializeOwned};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use super::{
        MARINE_ARTIFACT_LEASE_SUBJECT, MARINE_CREDENTIAL_LEASE_SUBJECT,
        MARINE_EXECUTION_FINALIZE_SUBJECT, MARINE_EXECUTION_LEASE_SUBJECT,
        MARINE_EXECUTION_RENEW_SUBJECT, MARINE_USAGE_FINALIZE_SUBJECT,
        MARINE_USAGE_RESERVE_SUBJECT, MARINE_WORKER_CONTROL_SUBJECTS,
        MARINE_WORKER_SCOPED_INBOX_PREFIX, MarineArtifactLeaseReply, MarineArtifactLeaseRequest,
        MarineCredentialLeaseReply, MarineExecutionFinalizeReply, MarineExecutionFinalizeRequest,
        MarineExecutionLeaseReply, MarineExecutionLeaseRequest, MarineExecutionRenewReply,
        MarineExecutionRenewRequest, MarineUsageFinalizeReply, MarineUsageFinalizeRequest,
        MarineUsageReserveReply, MarineUsageReserveRequest,
    };

    const EXECUTION_LEASE_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-execution-lease-request.json");
    const EXECUTION_LEASE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-execution-lease-reply.json");
    const EXECUTION_RENEW_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-execution-renew-request.json");
    const EXECUTION_RENEW_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-execution-renew-reply.json");
    const CREDENTIAL_LEASE_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-credential-lease-request.json");
    const CREDENTIAL_LEASE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-credential-lease-reply.json");
    const USAGE_RESERVE_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-usage-reserve-request.json");
    const USAGE_RESERVE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-usage-reserve-reply.json");
    const USAGE_FINALIZE_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-usage-finalize-request.json");
    const USAGE_FINALIZE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-usage-finalize-reply.json");
    const ARTIFACT_LEASE_REQUEST: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-artifact-lease-request.json");
    const ARTIFACT_LEASE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-artifact-lease-reply.json");
    const EXECUTION_FINALIZE_REQUEST: &str = include_str!(
        "../../../libs/event-contracts/fixtures/marine-execution-finalize-request.json"
    );
    const EXECUTION_FINALIZE_REPLY: &str =
        include_str!("../../../libs/event-contracts/fixtures/marine-execution-finalize-reply.json");
    const CMEMS_SELECTION_LOCK: &str = include_str!(
        "../../../libs/event-contracts/src/catalog/cmems-resolved-selection-lock.v2.generated.json"
    );

    fn decode<T: DeserializeOwned>(fixture: &str) -> T {
        serde_json::from_str(fixture).unwrap()
    }

    fn sha256_utf8(value: &str) -> String {
        hex::encode(Sha256::digest(value.as_bytes()))
    }

    fn set_marine_area(reply: &mut Value, geo_json: &str) {
        reply["marineAreaSha256"] = json!(sha256_utf8(geo_json));
        reply["marineAreaGeoJson"] = json!(geo_json);
    }

    fn selection_for_role(data_role: &str) -> Value {
        let lock: Value = serde_json::from_str(CMEMS_SELECTION_LOCK).unwrap();
        lock["resolvedSelections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|selection| selection["dataRole"] == data_role)
            .unwrap()["selectionProvenance"]
            .clone()
    }

    fn set_data_role(reply: &mut Value, data_role: &str) {
        reply["dataRole"] = json!(data_role);
        reply["selectionProvenance"] = selection_for_role(data_role);
    }

    fn assert_rejects_noncanonical_timestamps<T>(fixture: &str, fields: &[&str])
    where
        T: DeserializeOwned,
    {
        let fixture: Value = serde_json::from_str(fixture).unwrap();
        for field in fields {
            for invalid in [
                "2026-07-19T12:00:00Z",
                "2026-07-19T12:00:00.0000Z",
                "2026-07-19T12:00:00.000+00:00",
                "2026-07-19T12:00:60.000Z",
            ] {
                let mut payload = fixture.clone();
                payload[*field] = json!(invalid);
                assert!(
                    serde_json::from_value::<T>(payload).is_err(),
                    "accepted non-canonical {field} timestamp {invalid}"
                );
            }
        }
    }

    fn assert_round_trip<T>(fixture: &str)
    where
        T: DeserializeOwned + Serialize,
    {
        let expected: Value = serde_json::from_str(fixture).unwrap();
        let decoded: T = decode(fixture);
        let actual = serde_json::to_value(decoded).unwrap();

        assert_wire_equivalent(&expected, &actual);
    }

    fn assert_wire_equivalent(expected: &Value, actual: &Value) {
        match (expected, actual) {
            (Value::Object(expected), Value::Object(actual)) => {
                assert_eq!(actual.len(), expected.len());
                for (key, expected_value) in expected {
                    assert_wire_equivalent(expected_value, actual.get(key).unwrap());
                }
            }
            (Value::Array(expected), Value::Array(actual)) => {
                assert_eq!(actual.len(), expected.len());
                for (expected_value, actual_value) in expected.iter().zip(actual) {
                    assert_wire_equivalent(expected_value, actual_value);
                }
            }
            (Value::Number(expected), Value::Number(actual)) => {
                assert_eq!(actual.as_f64(), expected.as_f64());
            }
            (Value::String(expected), Value::String(actual)) => {
                if let (Ok(expected_date), Ok(actual_date)) = (
                    chrono::DateTime::parse_from_rfc3339(expected),
                    chrono::DateTime::parse_from_rfc3339(actual),
                ) {
                    assert_eq!(actual_date, expected_date);
                } else {
                    assert_eq!(actual, expected);
                }
            }
            _ => {
                assert_eq!(
                    actual, expected,
                    "golden fixture and Rust wire value differ"
                );
            }
        }
    }

    #[test]
    fn subjects_and_scoped_reply_prefix_match_the_typescript_contract() {
        assert_eq!(
            MARINE_WORKER_CONTROL_SUBJECTS,
            [
                MARINE_EXECUTION_LEASE_SUBJECT,
                MARINE_EXECUTION_RENEW_SUBJECT,
                MARINE_CREDENTIAL_LEASE_SUBJECT,
                MARINE_USAGE_RESERVE_SUBJECT,
                MARINE_USAGE_FINALIZE_SUBJECT,
                MARINE_ARTIFACT_LEASE_SUBJECT,
                MARINE_EXECUTION_FINALIZE_SUBJECT,
            ]
        );
        assert_eq!(
            MARINE_EXECUTION_LEASE_SUBJECT,
            "request.farm.marineExecutionLease"
        );
        assert_eq!(MARINE_WORKER_SCOPED_INBOX_PREFIX, "_INBOXMARINEANALYSIS");
    }

    #[test]
    fn all_non_secret_types_decode_and_round_trip_typescript_golden_fixtures() {
        assert_round_trip::<MarineExecutionLeaseRequest>(EXECUTION_LEASE_REQUEST);
        assert_round_trip::<MarineExecutionLeaseReply>(EXECUTION_LEASE_REPLY);
        assert_round_trip::<MarineExecutionRenewRequest>(EXECUTION_RENEW_REQUEST);
        assert_round_trip::<MarineExecutionRenewReply>(EXECUTION_RENEW_REPLY);
        assert_round_trip::<super::MarineCredentialLeaseRequest>(CREDENTIAL_LEASE_REQUEST);
        assert_round_trip::<MarineUsageReserveRequest>(USAGE_RESERVE_REQUEST);
        assert_round_trip::<MarineUsageReserveReply>(USAGE_RESERVE_REPLY);
        assert_round_trip::<MarineUsageFinalizeRequest>(USAGE_FINALIZE_REQUEST);
        assert_round_trip::<MarineUsageFinalizeReply>(USAGE_FINALIZE_REPLY);
        assert_round_trip::<MarineArtifactLeaseRequest>(ARTIFACT_LEASE_REQUEST);
        assert_round_trip::<MarineExecutionFinalizeRequest>(EXECUTION_FINALIZE_REQUEST);
        assert_round_trip::<MarineExecutionFinalizeReply>(EXECUTION_FINALIZE_REPLY);
    }

    #[test]
    fn artifact_fixtures_decode_validate_and_redact_the_capability_url() {
        let request: MarineArtifactLeaseRequest = decode(ARTIFACT_LEASE_REQUEST);
        let reply: MarineArtifactLeaseReply = decode(ARTIFACT_LEASE_REPLY);
        let debug = format!("{reply:?}");

        assert!(reply.validate_for(&request).is_ok());
        assert!(!debug.contains("minio.example.invalid"));
        assert!(!debug.contains("marine-artifact-capability"));
    }

    #[test]
    fn credential_fixture_decodes_but_debug_and_serialization_are_secret_safe() {
        let reply: MarineCredentialLeaseReply = decode(CREDENTIAL_LEASE_REPLY);
        let debug = format!("{reply:?}");

        assert!(!debug.contains("fixture-user-not-a-real-account"));
        assert!(!debug.contains("fixture-value-not-a-real-secret"));

        assert_eq!(
            reply.value.username.expose_secret(),
            "fixture-user-not-a-real-account"
        );
        assert_eq!(
            reply.value.password.expose_secret(),
            "fixture-value-not-a-real-secret"
        );
        assert_eq!(reply.generation.get(), 3);
    }

    #[test]
    fn every_control_shape_rejects_unknown_fields() {
        let mut request: Value = serde_json::from_str(EXECUTION_LEASE_REQUEST).unwrap();
        request["authenticatedIdentity"] = json!("untrusted-header");
        assert!(serde_json::from_value::<MarineExecutionLeaseRequest>(request).is_err());

        let mut reply: Value = serde_json::from_str(CREDENTIAL_LEASE_REPLY).unwrap();
        reply["accessToken"] = json!("must-not-be-accepted");
        assert!(serde_json::from_value::<MarineCredentialLeaseReply>(reply).is_err());
    }

    #[test]
    fn every_control_timestamp_requires_exact_utc_millisecond_wire_form() {
        assert_rejects_noncanonical_timestamps::<MarineExecutionLeaseRequest>(
            EXECUTION_LEASE_REQUEST,
            &["requestedAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineExecutionLeaseReply>(
            EXECUTION_LEASE_REPLY,
            &[
                "issuedAt",
                "expiresAt",
                "requestedAt",
                "temporalPartitionBoundaryAt",
                "providerCoverageStart",
                "providerCoverageEnd",
                "timeStart",
                "timeEnd",
                "deadlineAt",
            ],
        );
        assert_rejects_noncanonical_timestamps::<MarineExecutionRenewReply>(
            EXECUTION_RENEW_REPLY,
            &["issuedAt", "expiresAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineCredentialLeaseReply>(
            CREDENTIAL_LEASE_REPLY,
            &["issuedAt", "expiresAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineUsageReserveReply>(
            USAGE_RESERVE_REPLY,
            &["reservedAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineUsageFinalizeRequest>(
            USAGE_FINALIZE_REQUEST,
            &["finishedAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineUsageFinalizeReply>(
            USAGE_FINALIZE_REPLY,
            &["finalizedAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineArtifactLeaseReply>(
            ARTIFACT_LEASE_REPLY,
            &["issuedAt", "expiresAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineExecutionFinalizeRequest>(
            EXECUTION_FINALIZE_REQUEST,
            &["finishedAt"],
        );
        assert_rejects_noncanonical_timestamps::<MarineExecutionFinalizeReply>(
            EXECUTION_FINALIZE_REPLY,
            &["finalizedAt"],
        );
    }

    #[test]
    fn every_required_nullable_field_rejects_omission_but_accepts_explicit_null() {
        let execution_fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        for field in [
            "temporalPartitionBoundaryAt",
            "depthMinMeters",
            "depthMaxMeters",
            "sourceSnapshotJobId",
        ] {
            let mut without_field = execution_fixture.clone();
            without_field.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(without_field).is_err(),
                "accepted omitted execution field {field}"
            );
        }
        let mut explicit_execution_nulls = execution_fixture.clone();
        set_data_role(&mut explicit_execution_nulls, "REANALYSIS");
        explicit_execution_nulls["temporalPartitionBoundaryAt"] = Value::Null;
        explicit_execution_nulls["depthMinMeters"] = Value::Null;
        explicit_execution_nulls["depthMaxMeters"] = Value::Null;
        explicit_execution_nulls["sourceSnapshotJobId"] = Value::Null;
        assert!(
            serde_json::from_value::<MarineExecutionLeaseReply>(explicit_execution_nulls).is_ok()
        );

        let mut missing_recipe_null = execution_fixture;
        missing_recipe_null["selectionProvenance"]
            .as_object_mut()
            .unwrap()
            .remove("recipeSha256");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(missing_recipe_null).is_err());

        let usage_fixture: Value = serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
        for field in [
            "providerStatusCode",
            "providerRequestId",
            "processingUnits",
            "failureCode",
        ] {
            let mut without_field = usage_fixture.clone();
            without_field.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MarineUsageFinalizeRequest>(without_field).is_err(),
                "accepted omitted usage field {field}"
            );
        }
        assert!(serde_json::from_value::<MarineUsageFinalizeRequest>(usage_fixture).is_ok());

        let finalize_fixture: Value = serde_json::from_str(EXECUTION_FINALIZE_REQUEST).unwrap();
        for field in ["resultManifestKey", "resultManifestSha256", "failureCode"] {
            let mut without_field = finalize_fixture.clone();
            without_field.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MarineExecutionFinalizeRequest>(without_field).is_err(),
                "accepted omitted execution-finalize field {field}"
            );
        }
        assert!(serde_json::from_value::<MarineExecutionFinalizeRequest>(finalize_fixture).is_ok());
    }

    #[test]
    fn canonical_uuid_nonce_identifier_and_numeric_bounds_match_typescript() {
        let mut request: Value = serde_json::from_str(EXECUTION_LEASE_REQUEST).unwrap();
        request["tenantId"] = json!("22222222-2222-4222-8222-22222222222A");
        assert!(serde_json::from_value::<MarineExecutionLeaseRequest>(request).is_err());

        let mut request: Value = serde_json::from_str(EXECUTION_LEASE_REQUEST).unwrap();
        request["jobId"] = json!("{33333333-3333-4333-8333-333333333333}");
        assert!(serde_json::from_value::<MarineExecutionLeaseRequest>(request).is_err());

        let mut request: Value = serde_json::from_str(EXECUTION_LEASE_REQUEST).unwrap();
        request["nonce"] = json!("too-short");
        assert!(serde_json::from_value::<MarineExecutionLeaseRequest>(request).is_err());

        let mut reply: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        reply["leaseVersion"] = json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());

        let mut reply: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        reply["renewAfterSeconds"] = json!(21);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());

        let mut reserve: Value = serde_json::from_str(USAGE_RESERVE_REPLY).unwrap();
        reserve["attempt"] = json!(1_001);
        assert!(serde_json::from_value::<MarineUsageReserveReply>(reserve).is_err());
    }

    #[test]
    fn execution_spec_rejects_geojson_depth_and_resource_cap_drift() {
        for (field, value) in [
            ("marineAreaGeoJson", json!("")),
            ("depthMaxMeters", json!(12_001)),
            ("maxCells", json!(1_000_001)),
            ("maxTimeSteps", json!(367)),
            ("maxOutputBytes", json!(268_435_457)),
            ("maxScratchBytes", json!(1_073_741_825)),
        ] {
            let mut reply: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
            reply[field] = value;
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err(),
                "accepted invalid {field}"
            );
        }
    }

    #[test]
    fn execution_area_accepts_only_closed_two_dimensional_polygon_geometry() {
        let fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        let valid_multi_polygon = "{\"type\":\"MultiPolygon\",\"coordinates\":[[[[10,60],[11,60],[11,61],[10,60]]],[[[12,62],[13,62],[13,63],[12,62]]]]}";
        let mut valid = fixture.clone();
        set_marine_area(&mut valid, valid_multi_polygon);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(valid).is_ok());

        let canonical_small_exponent =
            "{\"type\":\"Polygon\",\"coordinates\":[[[1e-7,0],[0,0],[0,1],[1e-7,0]]]}";
        let mut valid = fixture.clone();
        set_marine_area(&mut valid, canonical_small_exponent);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(valid).is_ok());

        let invalid_geometries = [
            "not-json".to_owned(),
            json!({"type": "Point", "coordinates": [10, 60]}).to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[10, 60], [11, 60], [11, 61], [10, 60]]],
                "extra": true
            })
            .to_string(),
            json!({"type": "Polygon", "coordinates": []}).to_string(),
            json!({"type": "MultiPolygon", "coordinates": []}).to_string(),
            json!({"type": "MultiPolygon", "coordinates": [[]]}).to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[10, 60], [11, 60], [10, 60]]]
            })
            .to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[10, 60], [11, 60], [11, 61], [10, 61]]]
            })
            .to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[10, 60, 1], [11, 60], [11, 61], [10, 60, 1]]]
            })
            .to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[181, 60], [11, 60], [11, 61], [181, 60]]]
            })
            .to_string(),
            json!({
                "type": "Polygon",
                "coordinates": [[[10, 91], [11, 60], [11, 61], [10, 91]]]
            })
            .to_string(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[1e309,0],[0,0],[0,1],[1e309,0]]]}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[NaN,0],[0,0],[0,1],[NaN,0]]]}".to_owned(),
            "{\"type\":\"Point\",\"t\\u0079pe\":\"Polygon\",\"coordinates\":[[[10,60],[11,60],[11,61],[10,60]]]}".to_owned(),
            "{ \"type\": \"Polygon\", \"coordinates\": [[[10,60],[11,60],[11,61],[10,60]]] }".to_owned(),
            "{\"coordinates\":[[[10,60],[11,60],[11,61],[10,60]]],\"type\":\"Polygon\"}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[10.0,60],[11,60],[11,61],[10.0,60]]]}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[-0,60],[11,60],[11,61],[-0,60]]]}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[1e1,60],[11,60],[11,61],[1e1,60]]]}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[0.0000001,0],[0,0],[0,1],[0.0000001,0]]]}".to_owned(),
            "{\"type\":\"Polygon\",\"coordinates\":[[[1e-6,0],[0,0],[0,1],[1e-6,0]]]}".to_owned(),
            json!({
                "type": "Polygon",
                "coordinates": [[[[10, 60], [11, 60], [11, 61], [10, 60]]]]
            })
            .to_string(),
            format!(
                "{}{}",
                json!({
                    "type": "Polygon",
                    "coordinates": [[[10, 60], [11, 60], [11, 61], [10, 60]]]
                }),
                " ".repeat(262_145)
            ),
        ];
        for geometry in invalid_geometries {
            let mut reply = fixture.clone();
            set_marine_area(&mut reply, &geometry);
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());
        }

        for duplicate_key_geometry in [
            "{\"type\":\"Polygon\",\"type\":\"Polygon\",\"coordinates\":[[[10,60],[11,60],[11,61],[10,60]]]}",
            "{\"type\":\"Polygon\",\"coordinates\":[[[10,60],[11,60],[11,61],[10,60]]],\"coordinates\":[[[10,60],[11,60],[11,61],[10,60]]]}",
        ] {
            let mut reply = fixture.clone();
            set_marine_area(&mut reply, duplicate_key_geometry);
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());
        }

        let mut digest_mismatch = fixture;
        digest_mismatch["marineAreaSha256"] =
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(digest_mismatch).is_err());
    }

    #[test]
    fn execution_spec_semantic_couplings_match_typescript() {
        let subject_fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();

        let mut analysis = subject_fixture.clone();
        set_data_role(&mut analysis, "ANALYSIS");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(analysis).is_ok());

        let mut forecast = subject_fixture.clone();
        set_data_role(&mut forecast, "FORECAST");
        forecast["providerCoverageEnd"] = json!("2026-07-20T00:00:00.000Z");
        forecast["timeStart"] = json!("2026-07-19T12:00:00.001Z");
        forecast["timeEnd"] = json!("2026-07-19T12:00:00.001Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(forecast).is_ok());

        for data_role in ["REANALYSIS", "HINDCAST"] {
            let mut reply = subject_fixture.clone();
            set_data_role(&mut reply, data_role);
            reply["temporalPartitionBoundaryAt"] = Value::Null;
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_ok());
        }

        let mut reply = subject_fixture.clone();
        reply["provider"] = json!("CDSE");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());

        let mut observation = subject_fixture.clone();
        observation["dataRole"] = json!("OBSERVATION");
        observation["temporalPartitionBoundaryAt"] = Value::Null;
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(observation).is_err());

        let mut cross_spliced_role = subject_fixture.clone();
        cross_spliced_role["dataRole"] = json!("FORECAST");
        cross_spliced_role["providerCoverageEnd"] = json!("2026-07-20T00:00:00.000Z");
        cross_spliced_role["timeStart"] = json!("2026-07-19T12:00:00.001Z");
        cross_spliced_role["timeEnd"] = json!("2026-07-19T12:00:00.001Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(cross_spliced_role).is_err());

        let mut reply = subject_fixture.clone();
        reply["sourceSnapshotJobId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());
        for job_kind in ["AOI_STATS", "TIME_SERIES"] {
            let mut missing_source = subject_fixture.clone();
            missing_source["jobKind"] = json!(job_kind);
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(missing_source).is_err());

            let mut with_source = subject_fixture.clone();
            with_source["jobKind"] = json!(job_kind);
            with_source["sourceSnapshotJobId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(with_source).is_ok());
        }

        for (minimum, maximum) in [
            (json!(null), json!(1)),
            (json!(0), json!(null)),
            (json!(2), json!(1)),
        ] {
            let mut reply = subject_fixture.clone();
            reply["depthMinMeters"] = minimum;
            reply["depthMaxMeters"] = maximum;
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reply).is_err());
        }
        let mut no_depth = subject_fixture.clone();
        no_depth["depthMinMeters"] = Value::Null;
        no_depth["depthMaxMeters"] = Value::Null;
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(no_depth).is_ok());

        let mut deadline_at_issuance = subject_fixture.clone();
        deadline_at_issuance["deadlineAt"] = deadline_at_issuance["issuedAt"].clone();
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(deadline_at_issuance).is_err());
        let mut deadline_too_far = subject_fixture;
        deadline_too_far["deadlineAt"] = json!("2026-07-19T12:10:00.001Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(deadline_too_far).is_err());
    }

    #[test]
    fn selection_provenance_requires_exact_generated_entry_and_role_correlation() {
        fn mutate(value: &Value) -> Value {
            match value {
                Value::Null => json!("mutation"),
                Value::Bool(value) => json!(!value),
                Value::Number(value) => json!(value.as_f64().unwrap() + 1.0),
                Value::String(value) => json!(format!("{value}.mutation")),
                Value::Array(value) => {
                    let mut mutated = value.clone();
                    mutated.push(Value::Null);
                    Value::Array(mutated)
                }
                Value::Object(value) => {
                    let mut mutated = value.clone();
                    mutated.insert("mutation".to_owned(), Value::Bool(true));
                    Value::Object(mutated)
                }
            }
        }

        let fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        let provenance = fixture["selectionProvenance"].as_object().unwrap();
        for (field, value) in provenance {
            let mut changed = fixture.clone();
            changed["selectionProvenance"][field] = mutate(value);
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(changed).is_err(),
                "accepted mutated selection provenance field {field}"
            );

            let mut omitted = fixture.clone();
            omitted["selectionProvenance"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(omitted).is_err(),
                "accepted omitted selection provenance field {field}"
            );
        }

        let forecast = selection_for_role("FORECAST");
        let mut cross_spliced = fixture.clone();
        cross_spliced["selectionProvenance"]["catalogEntryId"] = forecast["catalogEntryId"].clone();
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(cross_spliced).is_err());

        for old_field in [
            "catalogRevision",
            "datasetId",
            "datasetVersion",
            "variableIds",
            "recipeId",
            "recipeSha256",
        ] {
            let mut legacy = fixture.clone();
            legacy[old_field] = json!("legacy");
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(legacy).is_err(),
                "accepted legacy top-level field {old_field}"
            );
        }
    }

    #[test]
    fn display_selection_is_exact_lock_data_and_never_an_inferred_wmts_layer() {
        let fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        let lock: Value = serde_json::from_str(CMEMS_SELECTION_LOCK).unwrap();
        let catalog_entry_id = fixture["selectionProvenance"]["catalogEntryId"]
            .as_str()
            .unwrap();
        let locked_provenance = lock["resolvedSelections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|selection| {
                selection["selectionProvenance"]["catalogEntryId"] == catalog_entry_id
            })
            .unwrap()["selectionProvenance"]
            .clone();

        assert_eq!(
            fixture["selectionProvenance"]["display"],
            locked_provenance["display"]
        );
        assert_eq!(
            fixture["selectionProvenance"]["display"]["variable"],
            json!("sea_water_velocity")
        );
        assert_ne!(
            fixture["selectionProvenance"]["display"]["variable"],
            fixture["selectionProvenance"]["variables"][0]["id"]
        );

        let mut omitted = fixture.clone();
        omitted["selectionProvenance"]
            .as_object_mut()
            .unwrap()
            .remove("display");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(omitted).is_err());

        for (field, value) in [
            (
                "wmtsCapabilitiesUrl",
                json!("https://wmts.marine.copernicus.eu/inferred"),
            ),
            ("variable", json!("uo")),
        ] {
            let mut changed = fixture.clone();
            changed["selectionProvenance"]["display"][field] = value;
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(changed).is_err(),
                "accepted inferred display field {field}"
            );
        }

        let mut inferred_layer = fixture;
        inferred_layer["selectionProvenance"]["display"]["wmtsLayer"] =
            json!("dataset_version_variable");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(inferred_layer).is_err());
    }

    #[test]
    fn attribution_selection_is_exact_lock_data_and_never_inferred_from_product_ids() {
        let fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        let lock: Value = serde_json::from_str(CMEMS_SELECTION_LOCK).unwrap();
        let catalog_entry_id = fixture["selectionProvenance"]["catalogEntryId"]
            .as_str()
            .unwrap();
        let locked_attribution = lock["resolvedSelections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|selection| {
                selection["selectionProvenance"]["catalogEntryId"].as_str()
                    == Some(catalog_entry_id)
            })
            .unwrap()["selectionProvenance"]["attribution"]
            .clone();

        assert_eq!(
            fixture["selectionProvenance"]["attribution"],
            locked_attribution
        );
        assert_eq!(
            fixture["selectionProvenance"]["attribution"]["requiredTemplateVariables"],
            json!(["ACCESSED_ON"])
        );

        let mut omitted = fixture.clone();
        omitted["selectionProvenance"]
            .as_object_mut()
            .unwrap()
            .remove("attribution");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(omitted).is_err());

        for (field, value) in [
            ("provider", json!("CMEMS")),
            ("requiredTemplateVariables", json!([])),
            ("doi", json!("10.48670/inferred-from-product")),
            (
                "sourceUrl",
                json!("https://data.marine.copernicus.eu/product/inferred"),
            ),
        ] {
            let mut changed = fixture.clone();
            changed["selectionProvenance"]["attribution"][field] = value;
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(changed).is_err(),
                "accepted inferred attribution field {field}"
            );
        }

        let mut inferred_template = fixture;
        inferred_template["selectionProvenance"]["attribution"]["inferredFromProductId"] =
            Value::Bool(true);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(inferred_template).is_err());
    }

    #[test]
    fn execution_time_selection_is_bounded_by_coverage_and_temporal_partition() {
        let subject_fixture: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        let mut reversed_time = subject_fixture.clone();
        reversed_time["timeStart"] = json!("2026-07-19T00:00:00.000Z");
        reversed_time["timeEnd"] = json!("2026-07-18T00:00:00.000Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(reversed_time).is_err());

        for (field, value) in [
            ("providerCoverageStart", json!("2026-07-19T00:00:00.001Z")),
            ("providerCoverageEnd", json!("2026-07-17T23:59:59.999Z")),
        ] {
            let mut outside_coverage = subject_fixture.clone();
            outside_coverage[field] = value;
            assert!(serde_json::from_value::<MarineExecutionLeaseReply>(outside_coverage).is_err());
        }

        for (data_role, boundary, time_start, time_end) in [
            (
                "ANALYSIS",
                Value::Null,
                json!("2026-07-18T00:00:00.000Z"),
                json!("2026-07-18T00:00:00.000Z"),
            ),
            (
                "ANALYSIS",
                json!("2026-07-19T11:59:59.999Z"),
                json!("2026-07-18T00:00:00.000Z"),
                json!("2026-07-18T00:00:00.000Z"),
            ),
            (
                "ANALYSIS",
                json!("2026-07-19T12:00:00.000Z"),
                json!("2026-07-19T12:00:00.001Z"),
                json!("2026-07-19T12:00:00.001Z"),
            ),
            (
                "FORECAST",
                json!("2026-07-19T12:00:00.000Z"),
                json!("2026-07-19T12:00:00.000Z"),
                json!("2026-07-19T12:00:00.000Z"),
            ),
            (
                "REANALYSIS",
                json!("2026-07-19T12:00:00.000Z"),
                json!("2026-07-18T00:00:00.000Z"),
                json!("2026-07-18T00:00:00.000Z"),
            ),
        ] {
            let mut invalid_partition = subject_fixture.clone();
            set_data_role(&mut invalid_partition, data_role);
            invalid_partition["temporalPartitionBoundaryAt"] = boundary;
            invalid_partition["providerCoverageEnd"] = json!("2026-07-20T00:00:00.000Z");
            invalid_partition["timeStart"] = time_start;
            invalid_partition["timeEnd"] = time_end;
            assert!(
                serde_json::from_value::<MarineExecutionLeaseReply>(invalid_partition).is_err()
            );
        }
    }

    #[test]
    fn every_lease_reply_deserializer_enforces_the_sixty_second_window() {
        let mut execution: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        execution["expiresAt"] = json!("2026-07-19T12:01:00.001Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(execution).is_err());
        let mut execution: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        execution["expiresAt"] = execution["issuedAt"].clone();
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(execution).is_err());

        let mut renewal: Value = serde_json::from_str(EXECUTION_RENEW_REPLY).unwrap();
        renewal["expiresAt"] = json!("2026-07-19T12:01:10.001Z");
        assert!(serde_json::from_value::<MarineExecutionRenewReply>(renewal).is_err());

        let mut credential: Value = serde_json::from_str(CREDENTIAL_LEASE_REPLY).unwrap();
        credential["expiresAt"] = json!("2026-07-19T12:01:00.001Z");
        assert!(serde_json::from_value::<MarineCredentialLeaseReply>(credential).is_err());
        let mut cdse_credential: Value = serde_json::from_str(CREDENTIAL_LEASE_REPLY).unwrap();
        cdse_credential["kind"] = json!("CDSE_CLIENT_CREDENTIALS");
        cdse_credential["value"] = json!({
            "clientId": "fixture-client-not-a-real-account",
            "clientSecret": "fixture-value-not-a-real-secret"
        });
        cdse_credential["expiresAt"] = json!("2026-07-19T12:01:00.001Z");
        assert!(serde_json::from_value::<MarineCredentialLeaseReply>(cdse_credential).is_err());

        let mut artifact: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        artifact["expiresAt"] = json!("2026-07-19T12:01:00.001Z");
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(artifact).is_err());
        let mut get_artifact: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        get_artifact["method"] = json!("GET");
        get_artifact["requiredHeaders"] = json!({});
        get_artifact["expiresAt"] = json!("2026-07-19T12:01:00.001Z");
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(get_artifact).is_err());

        let stop = json!({
            "decision": "STOP",
            "executionLeaseId": "77777777-7777-4777-8777-777777777777",
            "leaseVersion": 1,
            "reason": "LEASE_FENCED"
        });
        assert!(serde_json::from_value::<MarineExecutionRenewReply>(stop).is_ok());
    }

    #[test]
    fn execution_renewal_interval_must_strictly_precede_lease_expiry() {
        let mut exact_boundary: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        exact_boundary["expiresAt"] = json!("2026-07-19T12:00:10.000Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(exact_boundary).is_err());

        let mut after_boundary: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        after_boundary["expiresAt"] = json!("2026-07-19T12:00:10.001Z");
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(after_boundary).is_ok());

        let mut one_second_lease: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        one_second_lease["expiresAt"] = json!("2026-07-19T12:00:01.000Z");
        one_second_lease["renewAfterSeconds"] = json!(20);
        assert!(serde_json::from_value::<MarineExecutionLeaseReply>(one_second_lease).is_err());
    }

    #[test]
    fn deterministic_freshness_checks_cover_expiry_and_clock_skew_boundaries() {
        fn timestamp(value: &str) -> chrono::DateTime<chrono::Utc> {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .with_timezone(&chrono::Utc)
        }

        let execution: MarineExecutionLeaseReply = decode(EXECUTION_LEASE_REPLY);
        let renewal: MarineExecutionRenewReply = decode(EXECUTION_RENEW_REPLY);
        let credential: MarineCredentialLeaseReply = decode(CREDENTIAL_LEASE_REPLY);
        let artifact: MarineArtifactLeaseReply = decode(ARTIFACT_LEASE_REPLY);
        let execution_request: MarineExecutionLeaseRequest = decode(EXECUTION_LEASE_REQUEST);
        let renewal_request: MarineExecutionRenewRequest = decode(EXECUTION_RENEW_REQUEST);
        let credential_request: super::MarineCredentialLeaseRequest =
            decode(CREDENTIAL_LEASE_REQUEST);
        let artifact_request: MarineArtifactLeaseRequest = decode(ARTIFACT_LEASE_REQUEST);

        let exact_skew_boundary = timestamp("2026-07-19T11:59:55.000Z");
        assert!(execution.validate_at(exact_skew_boundary).is_ok());
        assert!(credential.validate_at(exact_skew_boundary).is_ok());
        assert!(artifact.validate_at(exact_skew_boundary).is_ok());
        assert!(
            execution
                .validate_for_at(&execution_request, exact_skew_boundary)
                .is_ok()
        );
        assert!(
            credential
                .validate_for_at(&credential_request, exact_skew_boundary)
                .is_ok()
        );
        assert!(
            artifact
                .validate_for_at(&artifact_request, exact_skew_boundary)
                .is_ok()
        );
        let renewal_exact_skew_boundary = timestamp("2026-07-19T12:00:05.000Z");
        assert!(renewal.validate_at(renewal_exact_skew_boundary).is_ok());
        assert!(
            renewal
                .validate_for_at(&renewal_request, renewal_exact_skew_boundary)
                .is_ok()
        );

        let beyond_skew = timestamp("2026-07-19T11:59:54.999Z");
        assert!(execution.validate_at(beyond_skew).is_err());
        assert!(credential.validate_at(beyond_skew).is_err());
        assert!(artifact.validate_at(beyond_skew).is_err());
        assert!(
            execution
                .validate_for_at(&execution_request, beyond_skew)
                .is_err()
        );
        let renewal_beyond_skew = timestamp("2026-07-19T12:00:04.999Z");
        assert!(renewal.validate_at(renewal_beyond_skew).is_err());

        let immediately_before_expiry = timestamp("2026-07-19T12:00:59.999Z");
        assert!(execution.validate_at(immediately_before_expiry).is_ok());
        assert!(credential.validate_at(immediately_before_expiry).is_ok());
        assert!(artifact.validate_at(immediately_before_expiry).is_ok());
        let at_expiry = timestamp("2026-07-19T12:01:00.000Z");
        assert!(execution.validate_at(at_expiry).is_err());
        assert!(credential.validate_at(at_expiry).is_err());
        assert!(artifact.validate_at(at_expiry).is_err());

        let renewal_before_expiry = timestamp("2026-07-19T12:01:09.999Z");
        assert!(renewal.validate_at(renewal_before_expiry).is_ok());
        let renewal_at_expiry = timestamp("2026-07-19T12:01:10.000Z");
        assert!(renewal.validate_at(renewal_at_expiry).is_err());

        let stop: MarineExecutionRenewReply = serde_json::from_value(json!({
            "decision": "STOP",
            "executionLeaseId": "77777777-7777-4777-8777-777777777777",
            "leaseVersion": 1,
            "reason": "LEASE_FENCED"
        }))
        .unwrap();
        assert!(
            stop.validate_at(timestamp("2100-01-01T00:00:00.000Z"))
                .is_ok()
        );
    }

    #[test]
    fn every_control_exchange_requires_explicit_request_reply_correlation() {
        let execution_request: MarineExecutionLeaseRequest = decode(EXECUTION_LEASE_REQUEST);
        let execution_reply: MarineExecutionLeaseReply = decode(EXECUTION_LEASE_REPLY);
        assert!(execution_reply.validate_for(&execution_request).is_ok());
        for field in ["tenantId", "jobId", "executionId"] {
            let mut mismatched: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
            mismatched[field] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            let mismatched: MarineExecutionLeaseReply = serde_json::from_value(mismatched).unwrap();
            assert!(mismatched.validate_for(&execution_request).is_err());
        }
        let mut mismatched: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        mismatched["requestFingerprint"] =
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        let mismatched: MarineExecutionLeaseReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&execution_request).is_err());
        let mut mismatched: Value = serde_json::from_str(EXECUTION_LEASE_REPLY).unwrap();
        mismatched["requestedAt"] = json!("2026-07-19T11:59:59.999Z");
        mismatched["temporalPartitionBoundaryAt"] = mismatched["requestedAt"].clone();
        let mismatched: MarineExecutionLeaseReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&execution_request).is_err());

        let renewal_request: MarineExecutionRenewRequest = decode(EXECUTION_RENEW_REQUEST);
        let renewal_reply: MarineExecutionRenewReply = decode(EXECUTION_RENEW_REPLY);
        assert!(renewal_reply.validate_for(&renewal_request).is_ok());
        for (field, value) in [
            (
                "executionLeaseId",
                json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ),
            ("leaseVersion", json!(2)),
        ] {
            let mut mismatched: Value = serde_json::from_str(EXECUTION_RENEW_REPLY).unwrap();
            mismatched[field] = value;
            let mismatched: MarineExecutionRenewReply = serde_json::from_value(mismatched).unwrap();
            assert!(mismatched.validate_for(&renewal_request).is_err());
        }

        let credential_reply: MarineCredentialLeaseReply = decode(CREDENTIAL_LEASE_REPLY);
        let credential_request: super::MarineCredentialLeaseRequest =
            decode(CREDENTIAL_LEASE_REQUEST);
        assert!(credential_reply.validate_for(&credential_request).is_ok());
        let mut wrong_provider: Value = serde_json::from_str(CREDENTIAL_LEASE_REQUEST).unwrap();
        wrong_provider["provider"] = json!("CDSE");
        assert!(
            serde_json::from_value::<super::MarineCredentialLeaseRequest>(wrong_provider).is_err()
        );
        let mut cdse_reply: Value = serde_json::from_str(CREDENTIAL_LEASE_REPLY).unwrap();
        cdse_reply["kind"] = json!("CDSE_CLIENT_CREDENTIALS");
        cdse_reply["value"] = json!({
            "clientId": "fixture-client-not-a-real-account",
            "clientSecret": "fixture-value-not-a-real-secret"
        });
        assert!(serde_json::from_value::<MarineCredentialLeaseReply>(cdse_reply).is_err());
        let mut wrong_generation: Value = serde_json::from_str(CREDENTIAL_LEASE_REQUEST).unwrap();
        wrong_generation["credentialGeneration"] = json!(4);
        let wrong_generation: super::MarineCredentialLeaseRequest =
            serde_json::from_value(wrong_generation).unwrap();
        assert!(credential_reply.validate_for(&wrong_generation).is_err());

        let reserve_request: MarineUsageReserveRequest = decode(USAGE_RESERVE_REQUEST);
        let reserve_reply: MarineUsageReserveReply = decode(USAGE_RESERVE_REPLY);
        assert!(reserve_reply.validate_for(&reserve_request).is_ok());
        let mut mismatched: Value = serde_json::from_str(USAGE_RESERVE_REPLY).unwrap();
        mismatched["operationId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let mismatched: MarineUsageReserveReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&reserve_request).is_err());

        let usage_finalize_request: MarineUsageFinalizeRequest = decode(USAGE_FINALIZE_REQUEST);
        let usage_finalize_reply: MarineUsageFinalizeReply = decode(USAGE_FINALIZE_REPLY);
        assert!(
            usage_finalize_reply
                .validate_for(&usage_finalize_request)
                .is_ok()
        );
        let mut mismatched: Value = serde_json::from_str(USAGE_FINALIZE_REPLY).unwrap();
        mismatched["operationId"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let mismatched: MarineUsageFinalizeReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&usage_finalize_request).is_err());
        let mut mismatched: Value = serde_json::from_str(USAGE_FINALIZE_REPLY).unwrap();
        mismatched["state"] = json!("FAILED");
        let mismatched: MarineUsageFinalizeReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&usage_finalize_request).is_err());
    }

    #[test]
    fn execution_finalize_reply_requires_identity_and_terminal_state_correlation() {
        let request: MarineExecutionFinalizeRequest = decode(EXECUTION_FINALIZE_REQUEST);
        let reply: MarineExecutionFinalizeReply = decode(EXECUTION_FINALIZE_REPLY);
        assert!(reply.validate_for(&request).is_ok());
        for field in ["jobId", "executionId"] {
            let mut mismatched: Value = serde_json::from_str(EXECUTION_FINALIZE_REPLY).unwrap();
            mismatched[field] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            let mismatched: MarineExecutionFinalizeReply =
                serde_json::from_value(mismatched).unwrap();
            assert!(mismatched.validate_for(&request).is_err());
        }
        let mut mismatched: Value = serde_json::from_str(EXECUTION_FINALIZE_REPLY).unwrap();
        mismatched["state"] = json!("FAILED");
        mismatched["manifestVerified"] = json!(false);
        let mismatched: MarineExecutionFinalizeReply = serde_json::from_value(mismatched).unwrap();
        assert!(mismatched.validate_for(&request).is_err());
    }

    #[test]
    fn credential_and_usage_semantics_are_fail_closed() {
        let mut credential: Value = serde_json::from_str(CREDENTIAL_LEASE_REPLY).unwrap();
        credential["value"]["password"] = json!("");
        assert!(serde_json::from_value::<MarineCredentialLeaseReply>(credential).is_err());

        let mut reserve: Value = serde_json::from_str(USAGE_RESERVE_REQUEST).unwrap();
        reserve["provider"] = json!("CDSE");
        assert!(serde_json::from_value::<MarineUsageReserveRequest>(reserve).is_err());

        let mut reserve: Value = serde_json::from_str(USAGE_RESERVE_REQUEST).unwrap();
        reserve["operationType"] = json!("CMEMS_WMTS");
        assert!(serde_json::from_value::<MarineUsageReserveRequest>(reserve).is_err());

        let mut finalize: Value = serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
        finalize["providerStatusKind"] = json!("HTTP");
        finalize["providerStatusCode"] = json!(99);
        assert!(serde_json::from_value::<MarineUsageFinalizeRequest>(finalize).is_err());

        let mut finalize: Value = serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
        finalize["outcome"] = json!("FAILED");
        assert!(serde_json::from_value::<MarineUsageFinalizeRequest>(finalize).is_err());
    }

    #[test]
    fn successful_usage_requires_a_successful_provider_status() {
        for (status_kind, status_code) in [
            ("TOOL_EXIT", json!(255)),
            ("HTTP", json!(500)),
            ("NOT_AVAILABLE", Value::Null),
        ] {
            let mut request: Value = serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
            request["providerStatusKind"] = json!(status_kind);
            request["providerStatusCode"] = status_code;
            assert!(
                serde_json::from_value::<MarineUsageFinalizeRequest>(request).is_err(),
                "accepted successful usage with {status_kind} status"
            );
        }

        let mut successful_http: Value = serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
        successful_http["providerStatusKind"] = json!("HTTP");
        successful_http["providerStatusCode"] = json!(200);
        assert!(serde_json::from_value::<MarineUsageFinalizeRequest>(successful_http).is_ok());

        let mut failed_http_two_hundred: Value =
            serde_json::from_str(USAGE_FINALIZE_REQUEST).unwrap();
        failed_http_two_hundred["outcome"] = json!("FAILED");
        failed_http_two_hundred["providerStatusKind"] = json!("HTTP");
        failed_http_two_hundred["providerStatusCode"] = json!(200);
        failed_http_two_hundred["failureCode"] = json!("PROVIDER_FAILURE");
        assert!(
            serde_json::from_value::<MarineUsageFinalizeRequest>(failed_http_two_hundred).is_ok()
        );
    }

    #[test]
    fn execution_terminal_state_enforces_manifest_and_verification_coupling() {
        let mut request: Value = serde_json::from_str(EXECUTION_FINALIZE_REQUEST).unwrap();
        request["resultManifestSha256"] =
            json!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
        assert!(serde_json::from_value::<MarineExecutionFinalizeRequest>(request).is_err());

        let mut request: Value = serde_json::from_str(EXECUTION_FINALIZE_REQUEST).unwrap();
        request["retryable"] = json!(true);
        assert!(serde_json::from_value::<MarineExecutionFinalizeRequest>(request).is_err());

        let mut cancelled: Value = serde_json::from_str(EXECUTION_FINALIZE_REQUEST).unwrap();
        cancelled["terminalState"] = json!("CANCELLED");
        cancelled["resultManifestKey"] = Value::Null;
        cancelled["resultManifestSha256"] = Value::Null;
        cancelled["failureCode"] = json!("CANCEL_REQUESTED");
        cancelled["retryable"] = json!(true);
        assert!(
            serde_json::from_value::<MarineExecutionFinalizeRequest>(cancelled.clone()).is_err()
        );
        cancelled["retryable"] = json!(false);
        assert!(serde_json::from_value::<MarineExecutionFinalizeRequest>(cancelled).is_ok());

        let mut reply: Value = serde_json::from_str(EXECUTION_FINALIZE_REPLY).unwrap();
        reply["manifestVerified"] = json!(false);
        assert!(serde_json::from_value::<MarineExecutionFinalizeReply>(reply).is_err());
    }

    #[test]
    fn artifact_contract_rejects_bad_capabilities_and_metadata_mismatch() {
        let mut request: Value = serde_json::from_str(ARTIFACT_LEASE_REQUEST).unwrap();
        request["mediaType"] = json!("application/json; charset=utf-8");
        assert!(serde_json::from_value::<MarineArtifactLeaseRequest>(request).is_err());

        let mut request: Value = serde_json::from_str(ARTIFACT_LEASE_REQUEST).unwrap();
        request["byteLength"] = json!(268_435_457);
        assert!(serde_json::from_value::<MarineArtifactLeaseRequest>(request).is_err());

        let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        reply["url"] = json!("http://minio.example.invalid/not-https");
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(reply).is_err());

        for invalid_url in [
            "HTTPS://minio.example.invalid/uppercase-scheme",
            "https://",
            "https:///path-without-host",
            "https://minio.example.invalid/non-ascii-é",
            "https://minio.example.invalid/control-\n",
            "https://minio.example.invalid/space here",
        ] {
            let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
            reply["url"] = json!(invalid_url);
            assert!(
                serde_json::from_value::<MarineArtifactLeaseReply>(reply).is_err(),
                "accepted invalid capability URL {invalid_url:?}"
            );
        }

        let url_prefix = "https://minio.example.invalid/";
        let exact_maximum_url = format!("{url_prefix}{}", "a".repeat(4_096 - url_prefix.len()));
        let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        reply["url"] = json!(exact_maximum_url);
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(reply).is_ok());
        let over_maximum_url = format!("{url_prefix}{}", "a".repeat(4_097 - url_prefix.len()));
        let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        reply["url"] = json!(over_maximum_url);
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(reply).is_err());

        let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        reply["requiredHeaders"]["authorization"] = json!("forbidden");
        assert!(serde_json::from_value::<MarineArtifactLeaseReply>(reply).is_err());

        let request: MarineArtifactLeaseRequest = decode(ARTIFACT_LEASE_REQUEST);
        let mut reply: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        reply["requiredHeaders"]["content-type"] = json!("image/png");
        let reply: MarineArtifactLeaseReply = serde_json::from_value(reply).unwrap();
        assert!(reply.validate_for(&request).is_err());

        let mut wrong_method: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        wrong_method["method"] = json!("GET");
        wrong_method["requiredHeaders"] = json!({});
        let wrong_method: MarineArtifactLeaseReply = serde_json::from_value(wrong_method).unwrap();
        assert!(wrong_method.validate_for(&request).is_err());

        let mut wrong_lineage: Value = serde_json::from_str(ARTIFACT_LEASE_REPLY).unwrap();
        wrong_lineage["objectKey"] = json!(
            "marine/22222222-2222-4222-8222-222222222222/55555555-5555-4555-8555-555555555555/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/statistics.json"
        );
        let wrong_lineage: MarineArtifactLeaseReply =
            serde_json::from_value(wrong_lineage).unwrap();
        assert!(wrong_lineage.validate_for(&request).is_err());
    }
}
