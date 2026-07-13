use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, warn};

use crate::process_image::TagValue;
use crate::scada_db::ScadaDb;

/// Alarm rule from SCADA package
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRule {
    pub id: String,
    pub tag: String,
    pub condition: String, // "<", ">", "==", "!=", "<=", ">="
    pub value: f64,
    pub severity: AlarmSeverity,
    pub message: String,
    #[serde(default)]
    pub deadband: Option<f64>,
    #[serde(default)]
    pub delay: Option<u32>, // seconds
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlarmSeverity {
    Critical,
    High,
    Warning,
    Info,
}

/// Active alarm instance
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAlarm {
    pub alarm_id: String,
    pub rule_id: String,
    pub tag: String,
    pub severity: AlarmSeverity,
    pub message: String,
    pub triggered_at: String,
    pub value_at_trigger: f64,
    pub acknowledged: bool,
    pub acked_at: Option<String>,
    pub acked_by: Option<String>,
}

/// Events produced by alarm evaluation
#[derive(Debug, Clone)]
pub enum AlarmEvent {
    Triggered(ActiveAlarm),
    Cleared {
        alarm_id: String,
        rule_id: String,
        tag: String,
    },
    Acknowledged {
        alarm_id: String,
    },
}

/// Alarm engine
pub struct AlarmEngine {
    rules: Vec<AlarmRule>,
    active_alarms: HashMap<String, ActiveAlarm>, // rule_id → ActiveAlarm
    delay_start: HashMap<String, Instant>,       // rule_id → when condition first became true
    db: Option<Arc<ScadaDb>>,
}

impl AlarmEngine {
    pub fn new(db: Option<Arc<ScadaDb>>) -> Self {
        Self {
            rules: Vec::new(),
            active_alarms: HashMap::new(),
            delay_start: HashMap::new(),
            db,
        }
    }

    /// Update alarm rules (called when new SCADA package is deployed)
    pub fn update_rules(&mut self, rules: Vec<AlarmRule>) {
        info!("Alarm engine: updating {} rules", rules.len());
        // Clear alarms for rules that no longer exist
        let new_rule_ids: std::collections::HashSet<_> =
            rules.iter().map(|r| r.id.clone()).collect();
        self.active_alarms
            .retain(|rule_id, _| new_rule_ids.contains(rule_id));
        self.delay_start
            .retain(|rule_id, _| new_rule_ids.contains(rule_id));
        self.rules = rules;
    }

    /// Evaluate all rules against current tag values
    pub fn evaluate(&mut self, tags: &HashMap<String, TagValue>) -> Vec<AlarmEvent> {
        let mut events = Vec::new();

        for rule in &self.rules {
            let tag_value = match tags.get(&rule.tag) {
                Some(tv) => tv.value,
                None => continue, // Tag not in process image, skip
            };

            let condition_met = alarm_core::evaluate_condition(
                &rule.condition,
                tag_value,
                rule.value,
                alarm_core::DEFAULT_EPSILON,
            );
            let deadband = rule.deadband.unwrap_or(0.0);
            let delay_secs = rule.delay.unwrap_or(0);

            let is_active = self.active_alarms.contains_key(&rule.id);

            if condition_met && !is_active {
                // Condition met and alarm not yet active
                // Check deadband: if alarm was previously cleared, require value to cross
                // threshold + deadband before re-triggering

                // Check delay — millisecond precision via the shared kernel (no
                // integer-second truncation). The rule stores whole seconds; the
                // monotonic elapsed time is measured in ms.
                if delay_secs > 0 {
                    let start = self
                        .delay_start
                        .entry(rule.id.clone())
                        .or_insert_with(Instant::now);
                    let elapsed_ms = start.elapsed().as_millis() as u64;
                    let delay_ms = u64::from(delay_secs) * 1000;
                    if !alarm_core::delay_elapsed(elapsed_ms, delay_ms) {
                        continue; // Not enough time elapsed
                    }
                }

                // Trigger alarm
                let alarm_id = uuid::Uuid::new_v4().to_string();
                let now = Utc::now();
                let alarm = ActiveAlarm {
                    alarm_id: alarm_id.clone(),
                    rule_id: rule.id.clone(),
                    tag: rule.tag.clone(),
                    severity: rule.severity,
                    message: rule.message.clone(),
                    triggered_at: now.to_rfc3339(),
                    value_at_trigger: tag_value,
                    acknowledged: false,
                    acked_at: None,
                    acked_by: None,
                };

                // Log to SQLite
                if let Some(ref db) = self.db {
                    if let Err(e) = db.insert_alarm(
                        &alarm_id,
                        &rule.tag,
                        &rule.id,
                        &format!("{:?}", rule.severity).to_lowercase(),
                        &rule.message,
                        tag_value,
                    ) {
                        warn!("Failed to log alarm to DB: {}", e);
                    }
                }

                info!(
                    "ALARM TRIGGERED: {} - {} (tag={}, value={:.2})",
                    rule.id, rule.message, rule.tag, tag_value
                );

                self.active_alarms.insert(rule.id.clone(), alarm.clone());
                self.delay_start.remove(&rule.id);
                events.push(AlarmEvent::Triggered(alarm));
            } else if !condition_met && is_active {
                // Check deadband for clearing via the shared kernel: the value
                // must be STRICTLY past threshold ± deadband (exclusive
                // hysteresis; no hidden floor; deadband 0 clears immediately).
                let clear = alarm_core::is_outside_deadband(
                    &rule.condition,
                    tag_value,
                    rule.value,
                    deadband,
                );

                if clear {
                    if let Some(alarm) = self.active_alarms.remove(&rule.id) {
                        // Update SQLite
                        if let Some(ref db) = self.db {
                            if let Err(e) = db.clear_alarm(&alarm.alarm_id) {
                                warn!("Failed to clear alarm in DB: {}", e);
                            }
                        }

                        info!(
                            "ALARM CLEARED: {} - {} (tag={}, value={:.2})",
                            rule.id, rule.message, rule.tag, tag_value
                        );

                        events.push(AlarmEvent::Cleared {
                            alarm_id: alarm.alarm_id,
                            rule_id: rule.id.clone(),
                            tag: rule.tag.clone(),
                        });
                    }
                }
            } else if !condition_met {
                // Reset delay timer if condition is not met
                self.delay_start.remove(&rule.id);
            }
        }

        events
    }

    /// Acknowledge an active alarm
    pub fn acknowledge(&mut self, alarm_id: &str, acked_by: &str) -> Result<(), String> {
        // Find the alarm by alarm_id (not rule_id)
        let rule_id = self
            .active_alarms
            .iter()
            .find(|(_, a)| a.alarm_id == alarm_id)
            .map(|(rid, _)| rid.clone())
            .ok_or_else(|| format!("Alarm {} not found", alarm_id))?;

        if let Some(alarm) = self.active_alarms.get_mut(&rule_id) {
            alarm.acknowledged = true;
            alarm.acked_at = Some(Utc::now().to_rfc3339());
            alarm.acked_by = Some(acked_by.to_string());

            if let Some(ref db) = self.db {
                if let Err(e) = db.ack_alarm(alarm_id, acked_by) {
                    warn!("Failed to ack alarm in DB: {}", e);
                }
            }

            info!("ALARM ACKNOWLEDGED: {} by {}", alarm_id, acked_by);
            Ok(())
        } else {
            Err(format!("Alarm {} not found", alarm_id))
        }
    }

    /// Get all active alarms
    pub fn get_active_alarms(&self) -> Vec<ActiveAlarm> {
        self.active_alarms.values().cloned().collect()
    }

    /// Get active alarm count
    pub fn active_count(&self) -> usize {
        self.active_alarms.len()
    }

    /// Get active alarms by severity
    pub fn critical_count(&self) -> usize {
        self.active_alarms
            .values()
            .filter(|a| matches!(a.severity, AlarmSeverity::Critical))
            .count()
    }
}
