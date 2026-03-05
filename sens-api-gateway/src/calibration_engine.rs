//! Calibration state machine for SCADA runtime.
//!
//! Manages sensor calibration workflows (one-point, two-point).
//! Tracks reading stability, computes slope/offset, logs to SQLite.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;
use serde::{Serialize, Deserialize};
use tracing::{info, warn};

use crate::scada_db::ScadaDb;

/// Calibration sensor configuration (from SCADA package)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibSensorConfig {
    pub tag: String,
    pub sensor_type: String,
    pub method: String,           // "one-point" or "two-point"
    pub points: Vec<CalibPointDef>,
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
    #[serde(default = "default_interval_days")]
    pub interval_days: u32,
    #[serde(default = "default_stability_window")]
    pub stability_window: u32,    // seconds
    #[serde(default = "default_stability_threshold")]
    pub stability_threshold: f64,
}

fn default_tolerance() -> f64 { 0.1 }
fn default_interval_days() -> u32 { 30 }
fn default_stability_window() -> u32 { 15 }
fn default_stability_threshold() -> f64 { 0.05 }

/// Calibration reference point definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibPointDef {
    pub label: String,
    pub reference_value: Option<f64>,  // None for air saturation (DO sensor)
}

/// Calibration result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibResult {
    pub slope: f64,
    pub offset: f64,
    pub r_squared: f64,
    pub next_calibration: Option<String>,
}

/// State message sent to WS clients
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibStateMsg {
    pub tag: String,
    pub state: String,
    pub step: u32,
    pub total_steps: u32,
    pub instruction: Option<String>,
    pub reference_value: Option<f64>,
    pub current_raw: Option<f64>,
    pub stable: bool,
    pub stable_progress: Option<String>,
    pub result: Option<CalibResult>,
    pub error: Option<String>,
}

/// Internal collected calibration point
#[derive(Debug, Clone)]
struct CollectedPoint {
    raw: f64,
    reference: f64,
}

/// Active calibration session
struct CalibSession {
    tag: String,
    sensor_type: String,
    method: String,
    points: Vec<CalibPointDef>,
    current_point: usize,
    collected: Vec<CollectedPoint>,
    stability_window: u32,
    stability_threshold: f64,
    tolerance: f64,
    interval_days: u32,
    readings: VecDeque<f64>,
    state: CalibPhase,
    started_at: Instant,
}

#[derive(Debug, Clone, PartialEq)]
enum CalibPhase {
    WaitingPoint,
    Done,
    Error(String),
}

/// Calibration engine
pub struct CalibrationEngine {
    db: Option<Arc<ScadaDb>>,
    sessions: HashMap<String, CalibSession>,
}

impl CalibrationEngine {
    pub fn new(db: Option<Arc<ScadaDb>>) -> Self {
        Self {
            db,
            sessions: HashMap::new(),
        }
    }

    /// Start calibration for a tag
    pub fn start(&mut self, config: &CalibSensorConfig) -> CalibStateMsg {
        // Guard: at least one calibration point is required
        let first_point = match config.points.first() {
            Some(p) => p,
            None => {
                warn!("Calibration rejected for tag {}: empty points list", config.tag);
                return CalibStateMsg {
                    tag: config.tag.clone(),
                    state: "error".to_string(),
                    step: 0,
                    total_steps: 0,
                    instruction: None,
                    reference_value: None,
                    current_raw: None,
                    stable: false,
                    stable_progress: None,
                    result: None,
                    error: Some("Calibration config has no reference points".to_string()),
                };
            }
        };

        let total_steps = (config.points.len() as u32) * 2 + 1; // wait+confirm per point + calculate

        let session = CalibSession {
            tag: config.tag.clone(),
            sensor_type: config.sensor_type.clone(),
            method: config.method.clone(),
            points: config.points.clone(),
            current_point: 0,
            collected: Vec::new(),
            stability_window: config.stability_window,
            stability_threshold: config.stability_threshold,
            tolerance: config.tolerance,
            interval_days: config.interval_days,
            readings: VecDeque::new(),
            state: CalibPhase::WaitingPoint,
            started_at: Instant::now(),
        };

        let instruction = format!(
            "{} çözeltisine/ortamına sensörü yerleştirin",
            first_point.label
        );

        self.sessions.insert(config.tag.clone(), session);

        info!("Calibration started for tag: {} ({})", config.tag, config.method);

        CalibStateMsg {
            tag: config.tag.clone(),
            state: "waiting_point".to_string(),
            step: 1,
            total_steps,
            instruction: Some(instruction),
            reference_value: first_point.reference_value,
            current_raw: None,
            stable: false,
            stable_progress: None,
            result: None,
            error: None,
        }
    }

    /// Tick with current raw reading (call every ~1 second)
    pub fn tick(&mut self, tag: &str, current_raw: f64) -> Option<CalibStateMsg> {
        let session = self.sessions.get_mut(tag)?;

        if session.state != CalibPhase::WaitingPoint {
            return None;
        }

        // Add reading to stability buffer
        session.readings.push_back(current_raw);
        let window = session.stability_window as usize;
        while session.readings.len() > window {
            session.readings.pop_front();
        }

        // Check stability
        let stable = if session.readings.len() >= window {
            let mean: f64 = session.readings.iter().sum::<f64>() / session.readings.len() as f64;
            let variance: f64 = session.readings.iter()
                .map(|v| (v - mean).powi(2))
                .sum::<f64>() / session.readings.len() as f64;
            let std_dev = variance.sqrt();
            std_dev < session.stability_threshold
        } else {
            false
        };

        let progress = format!("{}/{}s", session.readings.len(), window);
        let total_steps = (session.points.len() as u32) * 2 + 1;
        let step = (session.current_point as u32) * 2 + 1;

        Some(CalibStateMsg {
            tag: tag.to_string(),
            state: "waiting_point".to_string(),
            step,
            total_steps,
            instruction: None,
            reference_value: session.points.get(session.current_point)
                .and_then(|p| p.reference_value),
            current_raw: Some(current_raw),
            stable,
            stable_progress: Some(progress),
            result: None,
            error: None,
        })
    }

    /// Confirm current calibration point
    pub fn confirm_point(&mut self, tag: &str, _point_index: usize) -> Result<CalibStateMsg, String> {
        let session = self.sessions.get_mut(tag)
            .ok_or_else(|| format!("No calibration session for {}", tag))?;

        if session.state != CalibPhase::WaitingPoint {
            return Err("Not in waiting state".to_string());
        }

        // Get the stable reading (mean of last window)
        let raw = if session.readings.is_empty() {
            return Err("No readings collected".to_string());
        } else {
            session.readings.iter().sum::<f64>() / session.readings.len() as f64
        };

        let reference = session.points.get(session.current_point)
            .and_then(|p| p.reference_value)
            .unwrap_or(raw); // For one-point/air calibration, use raw as reference

        session.collected.push(CollectedPoint { raw, reference });
        session.current_point += 1;
        session.readings.clear();

        let total_steps = (session.points.len() as u32) * 2 + 1;

        info!(
            "Calibration point confirmed for {}: raw={:.4}, ref={:.4} ({}/{})",
            tag, raw, reference, session.collected.len(), session.points.len()
        );

        // Check if all points are collected
        if session.current_point >= session.points.len() {
            // Calculate
            return self.calculate(tag);
        }

        // Move to next point
        let next_point = &session.points[session.current_point];
        let step = (session.current_point as u32) * 2 + 1;

        Ok(CalibStateMsg {
            tag: tag.to_string(),
            state: "waiting_point".to_string(),
            step,
            total_steps,
            instruction: Some(format!(
                "Sensörü temiz suyla yıkayıp {} ortamına yerleştirin",
                next_point.label
            )),
            reference_value: next_point.reference_value,
            current_raw: None,
            stable: false,
            stable_progress: None,
            result: None,
            error: None,
        })
    }

    /// Calculate slope and offset from collected points
    fn calculate(&mut self, tag: &str) -> Result<CalibStateMsg, String> {
        let session = self.sessions.get_mut(tag)
            .ok_or_else(|| format!("No session for {}", tag))?;

        let total_steps = (session.points.len() as u32) * 2 + 1;

        let (slope, offset, r_squared) = match session.collected.len() {
            1 => {
                // One-point calibration: offset only
                let p = &session.collected[0];
                (1.0, p.reference - p.raw, 1.0)
            }
            2 => {
                // Two-point calibration: slope + offset
                let p1 = &session.collected[0];
                let p2 = &session.collected[1];
                let raw_diff = p2.raw - p1.raw;
                if raw_diff.abs() < f64::EPSILON {
                    session.state = CalibPhase::Error("Raw values are identical".to_string());
                    return Ok(CalibStateMsg {
                        tag: tag.to_string(),
                        state: "error".to_string(),
                        step: total_steps,
                        total_steps,
                        instruction: None,
                        reference_value: None,
                        current_raw: None,
                        stable: false,
                        stable_progress: None,
                        result: None,
                        error: Some("Ham değerler aynı, kalibrasyon yapılamıyor".to_string()),
                    });
                }
                let slope = (p2.reference - p1.reference) / raw_diff;
                let offset = p1.reference - slope * p1.raw;
                (slope, offset, 1.0) // R² = 1.0 for 2-point (always perfect fit)
            }
            n => {
                // Multi-point: linear regression
                let n_f = n as f64;
                let sum_x: f64 = session.collected.iter().map(|p| p.raw).sum();
                let sum_y: f64 = session.collected.iter().map(|p| p.reference).sum();
                let sum_xy: f64 = session.collected.iter().map(|p| p.raw * p.reference).sum();
                let sum_x2: f64 = session.collected.iter().map(|p| p.raw.powi(2)).sum();

                let denom = n_f * sum_x2 - sum_x.powi(2);
                if denom.abs() < f64::EPSILON {
                    session.state = CalibPhase::Error("Degenerate data".to_string());
                    return Err("Cannot compute regression".to_string());
                }

                let slope = (n_f * sum_xy - sum_x * sum_y) / denom;
                let offset = (sum_y - slope * sum_x) / n_f;

                // R² calculation
                let mean_y = sum_y / n_f;
                let ss_tot: f64 = session.collected.iter().map(|p| (p.reference - mean_y).powi(2)).sum();
                let ss_res: f64 = session.collected.iter().map(|p| {
                    let predicted = slope * p.raw + offset;
                    (p.reference - predicted).powi(2)
                }).sum();
                let r2 = if ss_tot > f64::EPSILON { 1.0 - ss_res / ss_tot } else { 1.0 };

                (slope, offset, r2)
            }
        };

        // Tolerance check
        for point in &session.collected {
            let calculated = slope * point.raw + offset;
            let error = (calculated - point.reference).abs();
            if error > session.tolerance {
                warn!(
                    "Calibration tolerance exceeded for {}: calculated={:.4}, ref={:.4}, error={:.4}, tolerance={:.4}",
                    tag, calculated, point.reference, error, session.tolerance
                );
            }
        }

        let next_cal = chrono::Utc::now()
            .checked_add_signed(chrono::Duration::days(session.interval_days as i64))
            .map(|d| d.format("%Y-%m-%d").to_string());

        let result = CalibResult {
            slope,
            offset,
            r_squared,
            next_calibration: next_cal.clone(),
        };

        // Log to SQLite
        if let Some(ref db) = self.db {
            let points_json = serde_json::to_string(&session.collected.iter().map(|p| {
                serde_json::json!({"raw": p.raw, "reference": p.reference})
            }).collect::<Vec<_>>()).unwrap_or_default();

            let cal_record = crate::scada_db::CalibrationRecord {
                id: uuid::Uuid::new_v4().to_string(),
                tag_name: tag.to_string(),
                sensor_type: session.sensor_type.clone(),
                method: session.method.clone(),
                points_json,
                slope: Some(slope),
                offset_val: Some(offset),
                r_squared: Some(r_squared),
                prev_slope: None,
                prev_offset: None,
                calibrated_at: chrono::Utc::now().timestamp_millis(),
                calibrated_by: None,
                next_due_at: next_cal.as_ref().and_then(|d| {
                    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()
                        .and_then(|nd| nd.and_hms_opt(0, 0, 0))
                        .map(|ndt| ndt.and_utc().timestamp_millis())
                }),
                synced: false,
            };

            if let Err(e) = db.insert_calibration(&cal_record) {
                warn!("Failed to log calibration: {}", e);
            }
        }

        session.state = CalibPhase::Done;

        info!(
            "Calibration complete for {}: slope={:.6}, offset={:.6}, R²={:.4}",
            tag, slope, offset, r_squared
        );

        Ok(CalibStateMsg {
            tag: tag.to_string(),
            state: "done".to_string(),
            step: total_steps,
            total_steps,
            instruction: None,
            reference_value: None,
            current_raw: None,
            stable: false,
            stable_progress: None,
            result: Some(result),
            error: None,
        })
    }

    /// Cancel an active calibration
    pub fn cancel(&mut self, tag: &str) {
        if self.sessions.remove(tag).is_some() {
            info!("Calibration cancelled for {}", tag);
        }
    }

    /// Get current calibration state
    pub fn get_state(&self, tag: &str) -> Option<CalibStateMsg> {
        let session = self.sessions.get(tag)?;
        let total_steps = (session.points.len() as u32) * 2 + 1;
        let step = (session.current_point as u32) * 2 + 1;

        Some(CalibStateMsg {
            tag: tag.to_string(),
            state: match &session.state {
                CalibPhase::WaitingPoint => "waiting_point",
                CalibPhase::Done => "done",
                CalibPhase::Error(_) => "error",
            }.to_string(),
            step,
            total_steps,
            instruction: None,
            reference_value: session.points.get(session.current_point)
                .and_then(|p| p.reference_value),
            current_raw: session.readings.back().copied(),
            stable: false,
            stable_progress: None,
            result: None,
            error: match &session.state {
                CalibPhase::Error(msg) => Some(msg.clone()),
                _ => None,
            },
        })
    }

    /// Check if a calibration is active for a tag
    pub fn is_active(&self, tag: &str) -> bool {
        self.sessions.contains_key(tag)
    }
}
