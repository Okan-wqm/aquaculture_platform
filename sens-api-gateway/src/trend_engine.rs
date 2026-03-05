//! Trend data recording engine for SCADA runtime.
//!
//! Records ProcessImage tag values to SQLite at configurable intervals.
//! Manages data retention with rolling window cleanup.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use chrono::Utc;
use tracing::{debug, info, warn};

use crate::scada_db::ScadaDb;
use crate::process_image::TagValue;

/// Trend recording configuration
#[derive(Debug, Clone)]
pub struct TrendConfig {
    pub retention_days: u32,
    pub sample_interval_sec: u32,
    pub tags: Vec<String>,
}

impl Default for TrendConfig {
    fn default() -> Self {
        Self {
            retention_days: 7,
            sample_interval_sec: 10,
            tags: Vec::new(),
        }
    }
}

/// Trend recording engine
pub struct TrendEngine {
    db: Arc<ScadaDb>,
    config: TrendConfig,
    last_sample: Instant,
    last_cleanup: Instant,
    cleanup_interval: Duration,
}

impl TrendEngine {
    /// Create a new trend engine
    pub fn new(db: Arc<ScadaDb>, config: TrendConfig) -> Self {
        info!(
            "Trend engine initialized: {} tags, {}s interval, {}d retention",
            config.tags.len(),
            config.sample_interval_sec,
            config.retention_days
        );

        Self {
            db,
            config,
            last_sample: Instant::now() - Duration::from_secs(999), // Force immediate first sample
            last_cleanup: Instant::now(),
            cleanup_interval: Duration::from_secs(3600), // Cleanup every hour
        }
    }

    /// Update configuration (when new SCADA package deployed)
    pub fn update_config(&mut self, config: TrendConfig) {
        info!(
            "Trend engine config updated: {} tags, {}s interval, {}d retention",
            config.tags.len(),
            config.sample_interval_sec,
            config.retention_days
        );
        self.config = config;
    }

    /// Record current tag values (called from io_poll loop)
    ///
    /// Only records if enough time has elapsed since last sample.
    pub fn record(&mut self, tags: &HashMap<String, TagValue>) {
        let now = Instant::now();
        let interval = Duration::from_secs(self.config.sample_interval_sec as u64);

        // Check if it's time to sample
        if now.duration_since(self.last_sample) < interval {
            return;
        }
        self.last_sample = now;

        if self.config.tags.is_empty() {
            return;
        }

        let timestamp = Utc::now().timestamp_millis();
        let mut batch: Vec<(String, i64, f64, u8)> = Vec::new();

        for tag_name in &self.config.tags {
            if let Some(tv) = tags.get(tag_name) {
                batch.push((
                    tag_name.clone(),
                    timestamp,
                    tv.value,
                    tv.quality.to_quality_code(),
                ));
            }
        }

        if !batch.is_empty() {
            match self.db.insert_trend_batch(&batch) {
                Ok(()) => {
                    debug!("Trend recorded: {} tags at {}", batch.len(), timestamp);
                }
                Err(e) => {
                    warn!("Failed to record trend data: {}", e);
                }
            }
        }

        // Periodic cleanup
        if now.duration_since(self.last_cleanup) >= self.cleanup_interval {
            self.last_cleanup = now;
            self.cleanup();
        }
    }

    /// Delete old trend data beyond retention period
    pub fn cleanup(&self) {
        match self.db.cleanup_old_trends(self.config.retention_days) {
            Ok(deleted) => {
                if deleted > 0 {
                    info!("Trend cleanup: deleted {} old records", deleted);
                }
            }
            Err(e) => {
                warn!("Trend cleanup failed: {}", e);
            }
        }
    }

    /// Query trend data for a tag within a time range
    pub fn query(&self, tag: &str, from: i64, to: i64) -> Result<Vec<crate::scada_db::TrendPoint>, String> {
        self.db.query_trend(tag, from, to)
    }

    /// Get configured tag list
    pub fn tags(&self) -> &[String] {
        &self.config.tags
    }
}
