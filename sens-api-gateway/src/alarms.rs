//! Alarm Management Module (v1.2.4)
//!
//! Implements basic alarm management following IEC 62682 (Alarm Management):
//! - Alarm definition with priorities
//! - Alarm state machine (Normal, Active, Acknowledged, Shelved)
//! - Dead-band support for preventing alarm chatter
//! - Alarm journaling for historical records
//!
//! # IEC 62443 SL2 Compliance
//! - FR6: Timely Response to Events (alarm notification)
//! - FR7: Resource Availability (alarm tracking)
//!
//! # ARC-009 wire decision (Batch 19 — Faz 1 Step 8)
//!
//! **Decision:** WIRE-FULL. This module is NOT dead code — it is
//! actively invoked on every IO-poll tick AND from command handlers.
//!
//! **Runtime invocation paths verified Batch 19:**
//! - `AppState.alarm_manager: Arc<RwLock<AlarmManager>>` constructed
//!   in `AppState::new()` (main.rs).
//! - `cmd_register_atlas_alarms` (commands.rs ~line 3456) calls
//!   `AlarmDefinition::high_limit()` / `low_limit()` +
//!   `.with_priority()` + `AlarmManager::register()` to seed Atlas
//!   EZO pH/DO/temperature alarm definitions.
//! - `io_poll::poll_atlas_sensors()` (io_poll.rs:147) calls
//!   `AlarmManager::process_source(tag_name, value)` on every
//!   Atlas tag read. Hot-path invocation — cannot be dead code.
//!
//! **Why the blanket `#![allow(dead_code)]` was WRONG pre-Batch-19:**
//! The pre-Batch-19 comment ("API reserved for alarms feature")
//! described dead-code-reserved state, but the module has been
//! actively wired since io_poll v1.x. The allow-attribute was a
//! stale defensive override that masked legitimate dead-code
//! warnings on symbols that ARE reserved (AlarmType variants,
//! AlarmSummary aggregation helpers).
//!
//! **Batch 19 action:** Remove the blanket `#![allow(dead_code)]`
//! and replace with surgical `#[allow(dead_code)]` on the specific
//! items that are legitimately reserved for Sprint 6.x consumers:
//! - `AlarmSummary` + `AlarmManager::summary()` — reserved for MQTT
//!   aggregated-alarm-dashboard publish path (Sprint 6.x
//!   observability).
//! - `AlarmType::*` enum variants — reserved for declarative alarm
//!   config loader (Sprint 6.x config.yaml `alarms:` section); no
//!   current consumer.
//! - `AlarmInstance::unacknowledge`, `shelve`, `unshelve` — reserved
//!   for operator command handlers (Sprint 6.x
//!   cmd_alarm_acknowledge / cmd_alarm_shelve).
//!
//! **Observed issue:** See OBS-19-001 / OBS-19-002 in session-
//! observations.md. The stale blanket allow is a pattern worth
//! auditing in other modules (pre-existing tech-debt), but
//! removing it from alarms.rs revealed NO actual hot-path dead code
//! — every `pub fn` has a consumer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{debug, info};

/// Maximum number of alarms to keep in history
const MAX_ALARM_HISTORY: usize = 1000;

/// Alarm priority levels (IEC 62682)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlarmPriority {
    /// Diagnostic - informational only, no operator action required
    Diagnostic = 0,
    /// Low - action required within extended timeframe
    Low = 1,
    /// Medium - action required within normal timeframe
    Medium = 2,
    /// High - immediate action required
    High = 3,
    /// Critical - emergency, safety-related
    Critical = 4,
}

impl Default for AlarmPriority {
    fn default() -> Self {
        Self::Medium
    }
}

impl std::fmt::Display for AlarmPriority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlarmPriority::Diagnostic => write!(f, "DIAGNOSTIC"),
            AlarmPriority::Low => write!(f, "LOW"),
            AlarmPriority::Medium => write!(f, "MEDIUM"),
            AlarmPriority::High => write!(f, "HIGH"),
            AlarmPriority::Critical => write!(f, "CRITICAL"),
        }
    }
}

/// Alarm state machine states (IEC 62682)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlarmState {
    /// Normal - alarm condition not present
    Normal,
    /// Active - alarm condition present, not acknowledged
    Active,
    /// Acknowledged - alarm condition present, operator acknowledged
    Acknowledged,
    /// Returned to Normal Unacknowledged - condition cleared but not acknowledged
    ReturnedUnack,
    /// Shelved - temporarily suppressed by operator
    Shelved,
    /// Suppressed - suppressed by design (e.g., during maintenance)
    Suppressed,
    /// Out of Service - alarm point disabled
    OutOfService,
}

impl Default for AlarmState {
    fn default() -> Self {
        Self::Normal
    }
}

impl std::fmt::Display for AlarmState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlarmState::Normal => write!(f, "NORMAL"),
            AlarmState::Active => write!(f, "ACTIVE"),
            AlarmState::Acknowledged => write!(f, "ACKNOWLEDGED"),
            AlarmState::ReturnedUnack => write!(f, "RETURNED_UNACK"),
            AlarmState::Shelved => write!(f, "SHELVED"),
            AlarmState::Suppressed => write!(f, "SUPPRESSED"),
            AlarmState::OutOfService => write!(f, "OUT_OF_SERVICE"),
        }
    }
}

/// Alarm type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlarmType {
    /// High limit exceeded
    High,
    /// High-high limit exceeded (critical)
    HighHigh,
    /// Low limit exceeded
    Low,
    /// Low-low limit exceeded (critical)
    LowLow,
    /// Deviation from setpoint
    Deviation,
    /// Rate of change exceeded
    RateOfChange,
    /// Digital state change
    Digital,
    /// Equipment fault
    Fault,
    /// Communication failure
    Communication,
}

impl Default for AlarmType {
    fn default() -> Self {
        Self::High
    }
}

/// Alarm definition configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmDefinition {
    /// Unique alarm ID
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Description
    pub description: String,
    /// Alarm type
    pub alarm_type: AlarmType,
    /// Priority level
    pub priority: AlarmPriority,
    /// Source tag/variable
    pub source: String,
    /// Setpoint/limit value
    pub setpoint: f64,
    /// Dead-band for preventing chatter
    pub deadband: f64,
    /// Delay before alarm activates (ms)
    pub delay_ms: u64,
    /// Whether alarm is enabled
    pub enabled: bool,
    /// Whether alarm requires acknowledgment
    pub require_ack: bool,
}

impl AlarmDefinition {
    /// Create a high limit alarm
    pub fn high_limit(id: impl Into<String>, source: impl Into<String>, limit: f64) -> Self {
        let source_str = source.into();
        Self {
            id: id.into(),
            name: format!("{} High", source_str),
            description: String::new(),
            alarm_type: AlarmType::High,
            priority: AlarmPriority::Medium,
            source: source_str,
            setpoint: limit,
            deadband: 0.0,
            delay_ms: 0,
            enabled: true,
            require_ack: true,
        }
    }

    /// Create a low limit alarm
    pub fn low_limit(id: impl Into<String>, source: impl Into<String>, limit: f64) -> Self {
        let source_str = source.into();
        Self {
            id: id.into(),
            name: format!("{} Low", source_str),
            description: String::new(),
            alarm_type: AlarmType::Low,
            priority: AlarmPriority::Medium,
            source: source_str,
            setpoint: limit,
            deadband: 0.0,
            delay_ms: 0,
            enabled: true,
            require_ack: true,
        }
    }

    /// Set priority
    pub fn with_priority(mut self, priority: AlarmPriority) -> Self {
        self.priority = priority;
        self
    }

    /// Set dead-band
    pub fn with_deadband(mut self, deadband: f64) -> Self {
        self.deadband = deadband.abs();
        self
    }

    /// Set delay
    pub fn with_delay_ms(mut self, delay_ms: u64) -> Self {
        self.delay_ms = delay_ms;
        self
    }

    /// Check if value triggers this alarm.
    ///
    /// All value/threshold/deadband comparison math is delegated to the shared
    /// `alarm-core` kernel — the SAME predicates the edge `alarm_engine.rs` and
    /// the NestJS SCADA runtime use — so this IEC 62682 engine cannot drift on
    /// the canonical semantics (epsilon equality, EXCLUSIVE deadband clear
    /// boundaries, no hidden floor). Only this engine's own concerns stay local:
    /// the `enabled` gate, the trigger-vs-clear edge selection driven by
    /// `current_state`, the `Deviation` band derivation, and (below) the 7-state
    /// machine.
    pub fn is_triggered(&self, value: f64, current_state: AlarmState) -> bool {
        if !self.enabled {
            return false;
        }

        let is_active = matches!(current_state, AlarmState::Active | AlarmState::Acknowledged);

        match self.alarm_type {
            // Directional limits: trigger when the raw condition holds; once
            // active, stay latched until the value is STRICTLY past the deadband
            // margin (clear = outside deadband ⇒ not triggered).
            AlarmType::High | AlarmType::HighHigh => {
                if is_active {
                    !alarm_core::is_outside_deadband(">", value, self.setpoint, self.deadband)
                } else {
                    alarm_core::evaluate_condition(
                        ">",
                        value,
                        self.setpoint,
                        alarm_core::DEFAULT_EPSILON,
                    )
                }
            }
            AlarmType::Low | AlarmType::LowLow => {
                if is_active {
                    !alarm_core::is_outside_deadband("<", value, self.setpoint, self.deadband)
                } else {
                    alarm_core::evaluate_condition(
                        "<",
                        value,
                        self.setpoint,
                        alarm_core::DEFAULT_EPSILON,
                    )
                }
            }
            // Deviation-from-setpoint with a two-level hysteresis band that is
            // this engine's own policy: trigger when the deviation exceeds the
            // full deadband, clear only once it falls back within HALF the band.
            // The derived deviation magnitude and half-band are local; the
            // comparison operator is routed through the kernel.
            AlarmType::Deviation => {
                let deviation = (value - self.setpoint).abs();
                let band = if is_active {
                    self.deadband / 2.0
                } else {
                    self.deadband
                };
                alarm_core::evaluate_condition(">", deviation, band, alarm_core::DEFAULT_EPSILON)
            }
            _ => false, // Other types need special handling
        }
    }
}

/// Runtime alarm instance
#[derive(Debug, Clone)]
pub struct AlarmInstance {
    /// Alarm definition
    pub definition: AlarmDefinition,
    /// Current state
    pub state: AlarmState,
    /// Current value
    pub current_value: f64,
    /// Time alarm became active
    pub activated_at: Option<Instant>,
    /// Time alarm was acknowledged
    pub acknowledged_at: Option<Instant>,
    /// Time alarm returned to normal
    pub returned_at: Option<Instant>,
    /// Pending activation time (for delay)
    pending_since: Option<Instant>,
    /// Shelve expiration time
    shelve_until: Option<Instant>,
    /// Acknowledge operator ID
    pub ack_operator: Option<String>,
}

impl AlarmInstance {
    /// Create new alarm instance from definition
    pub fn new(definition: AlarmDefinition) -> Self {
        Self {
            definition,
            state: AlarmState::Normal,
            current_value: 0.0,
            activated_at: None,
            acknowledged_at: None,
            returned_at: None,
            pending_since: None,
            shelve_until: None,
            ack_operator: None,
        }
    }

    /// Process a new value and update state
    pub fn process_value(&mut self, value: f64) -> Option<AlarmEvent> {
        self.current_value = value;

        // Check if shelve has expired
        if let Some(until) = self.shelve_until {
            if Instant::now() >= until {
                self.shelve_until = None;
                if self.state == AlarmState::Shelved {
                    self.state = AlarmState::Normal;
                }
            }
        }

        // Skip processing if out of service or shelved
        if matches!(
            self.state,
            AlarmState::OutOfService | AlarmState::Shelved | AlarmState::Suppressed
        ) {
            return None;
        }

        let is_triggered = self.definition.is_triggered(value, self.state);

        match (self.state, is_triggered) {
            // Normal -> Active (with delay support)
            (AlarmState::Normal, true) => {
                if self.definition.delay_ms > 0 {
                    if let Some(pending) = self.pending_since {
                        let elapsed_ms = pending.elapsed().as_millis() as u64;
                        if alarm_core::delay_elapsed(elapsed_ms, self.definition.delay_ms) {
                            self.state = AlarmState::Active;
                            self.activated_at = Some(Instant::now());
                            self.pending_since = None;
                            return Some(AlarmEvent::Activated {
                                alarm_id: self.definition.id.clone(),
                                value,
                                priority: self.definition.priority,
                            });
                        }
                    } else {
                        self.pending_since = Some(Instant::now());
                    }
                } else {
                    self.state = AlarmState::Active;
                    self.activated_at = Some(Instant::now());
                    return Some(AlarmEvent::Activated {
                        alarm_id: self.definition.id.clone(),
                        value,
                        priority: self.definition.priority,
                    });
                }
            }

            // Normal -> Normal (clear pending)
            (AlarmState::Normal, false) => {
                self.pending_since = None;
            }

            // Active -> Normal (return to normal unacknowledged)
            (AlarmState::Active, false) => {
                if self.definition.require_ack {
                    self.state = AlarmState::ReturnedUnack;
                } else {
                    self.state = AlarmState::Normal;
                }
                self.returned_at = Some(Instant::now());
                return Some(AlarmEvent::Returned {
                    alarm_id: self.definition.id.clone(),
                    value,
                });
            }

            // Acknowledged -> Normal
            (AlarmState::Acknowledged, false) => {
                self.state = AlarmState::Normal;
                self.returned_at = Some(Instant::now());
                self.acknowledged_at = None;
                self.ack_operator = None;
                return Some(AlarmEvent::Cleared {
                    alarm_id: self.definition.id.clone(),
                });
            }

            // ReturnedUnack stays until acknowledged
            (AlarmState::ReturnedUnack, true) => {
                // Condition returned - back to Active
                self.state = AlarmState::Active;
                self.returned_at = None;
                return Some(AlarmEvent::Reactivated {
                    alarm_id: self.definition.id.clone(),
                    value,
                });
            }

            _ => {}
        }

        None
    }

    /// Acknowledge the alarm
    pub fn acknowledge(&mut self, operator: impl Into<String>) -> Option<AlarmEvent> {
        let operator = operator.into();

        match self.state {
            AlarmState::Active => {
                self.state = AlarmState::Acknowledged;
                self.acknowledged_at = Some(Instant::now());
                self.ack_operator = Some(operator.clone());
                Some(AlarmEvent::Acknowledged {
                    alarm_id: self.definition.id.clone(),
                    operator,
                })
            }
            AlarmState::ReturnedUnack => {
                self.state = AlarmState::Normal;
                self.acknowledged_at = Some(Instant::now());
                self.ack_operator = Some(operator.clone());
                let event = AlarmEvent::Cleared {
                    alarm_id: self.definition.id.clone(),
                };
                // Clear tracking
                self.activated_at = None;
                self.returned_at = None;
                Some(event)
            }
            _ => None,
        }
    }

    /// Shelve the alarm for a duration
    pub fn shelve(
        &mut self,
        duration: Duration,
        operator: impl Into<String>,
    ) -> Option<AlarmEvent> {
        if matches!(self.state, AlarmState::OutOfService) {
            return None;
        }

        self.shelve_until = Some(Instant::now() + duration);
        self.state = AlarmState::Shelved;

        Some(AlarmEvent::Shelved {
            alarm_id: self.definition.id.clone(),
            duration_secs: duration.as_secs(),
            operator: operator.into(),
        })
    }

    /// Unshelve the alarm
    pub fn unshelve(&mut self) -> Option<AlarmEvent> {
        if self.state != AlarmState::Shelved {
            return None;
        }

        self.shelve_until = None;
        self.state = AlarmState::Normal;

        Some(AlarmEvent::Unshelved {
            alarm_id: self.definition.id.clone(),
        })
    }

    /// Put alarm out of service
    pub fn out_of_service(&mut self) {
        self.state = AlarmState::OutOfService;
    }

    /// Return alarm to service
    pub fn return_to_service(&mut self) {
        if self.state == AlarmState::OutOfService {
            self.state = AlarmState::Normal;
        }
    }

    /// Check if alarm needs attention
    pub fn needs_attention(&self) -> bool {
        matches!(self.state, AlarmState::Active | AlarmState::ReturnedUnack)
    }
}

/// Alarm events for journaling and notification
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AlarmEvent {
    /// Alarm activated
    Activated {
        alarm_id: String,
        value: f64,
        priority: AlarmPriority,
    },
    /// Alarm acknowledged
    Acknowledged { alarm_id: String, operator: String },
    /// Alarm returned to normal
    Returned { alarm_id: String, value: f64 },
    /// Alarm cleared (acknowledged and returned)
    Cleared { alarm_id: String },
    /// Alarm reactivated after returning
    Reactivated { alarm_id: String, value: f64 },
    /// Alarm shelved
    Shelved {
        alarm_id: String,
        duration_secs: u64,
        operator: String,
    },
    /// Alarm unshelved
    Unshelved { alarm_id: String },
}

impl AlarmEvent {
    /// Get the alarm ID from the event
    pub fn alarm_id(&self) -> &str {
        match self {
            AlarmEvent::Activated { alarm_id, .. } => alarm_id,
            AlarmEvent::Acknowledged { alarm_id, .. } => alarm_id,
            AlarmEvent::Returned { alarm_id, .. } => alarm_id,
            AlarmEvent::Cleared { alarm_id } => alarm_id,
            AlarmEvent::Reactivated { alarm_id, .. } => alarm_id,
            AlarmEvent::Shelved { alarm_id, .. } => alarm_id,
            AlarmEvent::Unshelved { alarm_id } => alarm_id,
        }
    }
}

/// Alarm journal entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmJournalEntry {
    /// Timestamp (ISO 8601)
    pub timestamp: String,
    /// The alarm event
    pub event: AlarmEvent,
    /// Alarm name at time of event
    pub alarm_name: String,
    /// Priority at time of event
    pub priority: AlarmPriority,
}

/// Alarm manager for handling multiple alarms
pub struct AlarmManager {
    /// Registered alarms
    alarms: HashMap<String, AlarmInstance>,
    /// Event journal
    journal: Vec<AlarmJournalEntry>,
    /// Maximum journal size
    max_journal_size: usize,
}

impl AlarmManager {
    /// Create a new alarm manager
    pub fn new() -> Self {
        Self {
            alarms: HashMap::new(),
            journal: Vec::with_capacity(MAX_ALARM_HISTORY),
            max_journal_size: MAX_ALARM_HISTORY,
        }
    }

    /// Set maximum journal size
    pub fn with_max_journal_size(mut self, size: usize) -> Self {
        self.max_journal_size = size.max(10);
        self
    }

    /// Register a new alarm
    pub fn register(&mut self, definition: AlarmDefinition) {
        let id = definition.id.clone();
        info!(alarm_id = %id, name = %definition.name, "Registered alarm");
        self.alarms.insert(id, AlarmInstance::new(definition));
    }

    /// Unregister an alarm
    pub fn unregister(&mut self, alarm_id: &str) -> bool {
        self.alarms.remove(alarm_id).is_some()
    }

    /// Process a value for an alarm
    pub fn process_value(&mut self, alarm_id: &str, value: f64) -> Option<AlarmEvent> {
        let (event, alarm_name, priority) = {
            let alarm = self.alarms.get_mut(alarm_id)?;
            let event = alarm.process_value(value)?;
            let name = alarm.definition.name.clone();
            let prio = alarm.definition.priority;
            (event, name, prio)
        };
        self.add_journal_entry(event.clone(), alarm_name, priority);
        Some(event)
    }

    /// Process values for multiple alarms by source
    pub fn process_source(&mut self, source: &str, value: f64) -> Vec<AlarmEvent> {
        let mut events = Vec::new();
        let alarm_ids: Vec<String> = self
            .alarms
            .iter()
            .filter(|(_, a)| a.definition.source == source)
            .map(|(id, _)| id.clone())
            .collect();

        for alarm_id in alarm_ids {
            if let Some(event) = self.process_value(&alarm_id, value) {
                events.push(event);
            }
        }

        events
    }

    /// Acknowledge an alarm
    pub fn acknowledge(&mut self, alarm_id: &str, operator: &str) -> Option<AlarmEvent> {
        let (event, alarm_name, priority) = {
            let alarm = self.alarms.get_mut(alarm_id)?;
            let event = alarm.acknowledge(operator)?;
            let name = alarm.definition.name.clone();
            let prio = alarm.definition.priority;
            (event, name, prio)
        };
        self.add_journal_entry(event.clone(), alarm_name, priority);
        Some(event)
    }

    /// Acknowledge all active alarms
    pub fn acknowledge_all(&mut self, operator: &str) -> Vec<AlarmEvent> {
        let alarm_ids: Vec<String> = self
            .alarms
            .iter()
            .filter(|(_, a)| a.needs_attention())
            .map(|(id, _)| id.clone())
            .collect();

        let mut events = Vec::new();
        for alarm_id in alarm_ids {
            if let Some(event) = self.acknowledge(&alarm_id, operator) {
                events.push(event);
            }
        }

        events
    }

    /// Shelve an alarm
    pub fn shelve(
        &mut self,
        alarm_id: &str,
        duration: Duration,
        operator: &str,
    ) -> Option<AlarmEvent> {
        let (event, alarm_name, priority) = {
            let alarm = self.alarms.get_mut(alarm_id)?;
            let event = alarm.shelve(duration, operator)?;
            let name = alarm.definition.name.clone();
            let prio = alarm.definition.priority;
            (event, name, prio)
        };
        self.add_journal_entry(event.clone(), alarm_name, priority);
        Some(event)
    }

    /// Unshelve an alarm
    pub fn unshelve(&mut self, alarm_id: &str) -> Option<AlarmEvent> {
        let (event, alarm_name, priority) = {
            let alarm = self.alarms.get_mut(alarm_id)?;
            let event = alarm.unshelve()?;
            let name = alarm.definition.name.clone();
            let prio = alarm.definition.priority;
            (event, name, prio)
        };
        self.add_journal_entry(event.clone(), alarm_name, priority);
        Some(event)
    }

    /// Get alarm by ID
    pub fn get(&self, alarm_id: &str) -> Option<&AlarmInstance> {
        self.alarms.get(alarm_id)
    }

    /// Get all alarms
    pub fn all(&self) -> impl Iterator<Item = &AlarmInstance> {
        self.alarms.values()
    }

    /// Get active alarms (needing attention)
    pub fn active(&self) -> impl Iterator<Item = &AlarmInstance> {
        self.alarms.values().filter(|a| a.needs_attention())
    }

    /// Get alarm count
    pub fn count(&self) -> usize {
        self.alarms.len()
    }

    /// Get active alarm count
    pub fn active_count(&self) -> usize {
        self.alarms.values().filter(|a| a.needs_attention()).count()
    }

    /// Get alarm summary by priority
    pub fn summary(&self) -> AlarmSummary {
        let mut summary = AlarmSummary::default();

        for alarm in self.alarms.values() {
            if alarm.needs_attention() {
                match alarm.definition.priority {
                    AlarmPriority::Critical => summary.critical += 1,
                    AlarmPriority::High => summary.high += 1,
                    AlarmPriority::Medium => summary.medium += 1,
                    AlarmPriority::Low => summary.low += 1,
                    AlarmPriority::Diagnostic => summary.diagnostic += 1,
                }
            }
        }

        summary.total_registered = self.alarms.len();
        summary.total_active = self.active_count();
        summary
    }

    /// Get journal entries
    pub fn journal(&self) -> &[AlarmJournalEntry] {
        &self.journal
    }

    /// Get recent journal entries
    pub fn recent_journal(&self, count: usize) -> &[AlarmJournalEntry] {
        let start = self.journal.len().saturating_sub(count);
        &self.journal[start..]
    }

    /// Clear journal
    pub fn clear_journal(&mut self) {
        self.journal.clear();
    }

    /// Add journal entry
    fn add_journal_entry(
        &mut self,
        event: AlarmEvent,
        alarm_name: String,
        priority: AlarmPriority,
    ) {
        // Trim journal if needed
        if self.journal.len() >= self.max_journal_size {
            self.journal.remove(0);
        }

        debug!(
            alarm_id = %event.alarm_id(),
            event_type = ?std::mem::discriminant(&event),
            "Alarm event recorded"
        );

        self.journal.push(AlarmJournalEntry {
            timestamp: chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
            event,
            alarm_name,
            priority,
        });
    }
}

impl Default for AlarmManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Alarm summary statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AlarmSummary {
    /// Total registered alarms
    pub total_registered: usize,
    /// Total active alarms
    pub total_active: usize,
    /// Critical priority active
    pub critical: usize,
    /// High priority active
    pub high: usize,
    /// Medium priority active
    pub medium: usize,
    /// Low priority active
    pub low: usize,
    /// Diagnostic active
    pub diagnostic: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_alarm_activation() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit(
            "temp_high",
            "temperature",
            80.0,
        ));

        // Below threshold - no activation
        let event = manager.process_value("temp_high", 75.0);
        assert!(event.is_none());

        // Above threshold - activate
        let event = manager.process_value("temp_high", 85.0);
        assert!(matches!(event, Some(AlarmEvent::Activated { .. })));

        let alarm = manager.get("temp_high").unwrap();
        assert_eq!(alarm.state, AlarmState::Active);
    }

    #[test]
    fn test_alarm_acknowledgment() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit(
            "temp_high",
            "temperature",
            80.0,
        ));

        // Activate
        manager.process_value("temp_high", 85.0);

        // Acknowledge
        let event = manager.acknowledge("temp_high", "operator1");
        assert!(matches!(event, Some(AlarmEvent::Acknowledged { .. })));

        let alarm = manager.get("temp_high").unwrap();
        assert_eq!(alarm.state, AlarmState::Acknowledged);
        assert_eq!(alarm.ack_operator, Some("operator1".to_string()));
    }

    #[test]
    fn test_alarm_return_to_normal() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit(
            "temp_high",
            "temperature",
            80.0,
        ));

        // Activate
        manager.process_value("temp_high", 85.0);

        // Return to normal (not acknowledged)
        let event = manager.process_value("temp_high", 75.0);
        assert!(matches!(event, Some(AlarmEvent::Returned { .. })));

        let alarm = manager.get("temp_high").unwrap();
        assert_eq!(alarm.state, AlarmState::ReturnedUnack);

        // Acknowledge the returned alarm
        let event = manager.acknowledge("temp_high", "operator1");
        assert!(matches!(event, Some(AlarmEvent::Cleared { .. })));

        let alarm = manager.get("temp_high").unwrap();
        assert_eq!(alarm.state, AlarmState::Normal);
    }

    #[test]
    fn test_alarm_deadband() {
        let mut manager = AlarmManager::new();

        manager.register(
            AlarmDefinition::high_limit("temp_high", "temperature", 80.0).with_deadband(5.0),
        );

        // Activate at 85
        manager.process_value("temp_high", 85.0);
        assert_eq!(manager.get("temp_high").unwrap().state, AlarmState::Active);

        // Drop to 76 (within deadband of 80-5=75) - should stay active
        manager.process_value("temp_high", 76.0);
        assert_eq!(manager.get("temp_high").unwrap().state, AlarmState::Active);

        // Drop to 74 (below deadband) - should return
        let event = manager.process_value("temp_high", 74.0);
        assert!(matches!(event, Some(AlarmEvent::Returned { .. })));
    }

    #[test]
    fn test_alarm_deadband_clear_boundary_is_exclusive() {
        // High alarm at 80, deadband 5 → the clear-band edge is exactly 75.0.
        let mut manager = AlarmManager::new();
        manager.register(
            AlarmDefinition::high_limit("temp_high", "temperature", 80.0).with_deadband(5.0),
        );

        // Activate at 85.
        manager.process_value("temp_high", 85.0);
        assert_eq!(manager.get("temp_high").unwrap().state, AlarmState::Active);

        // Exactly at the band edge (80 - 5 = 75.0): the shared kernel clears on
        // EXCLUSIVE boundaries, so the alarm STAYS active here (a previous
        // hand-rolled inclusive `>` would have cleared). No event, still Active.
        let event = manager.process_value("temp_high", 75.0);
        assert!(event.is_none());
        assert_eq!(manager.get("temp_high").unwrap().state, AlarmState::Active);

        // Strictly past the edge clears.
        let event = manager.process_value("temp_high", 74.999);
        assert!(matches!(event, Some(AlarmEvent::Returned { .. })));
    }

    #[test]
    fn test_deviation_alarm_two_level_hysteresis() {
        // Deviation alarm: trigger when |value - setpoint| exceeds the full
        // deadband; clear only once it falls back within HALF the deadband.
        let mut manager = AlarmManager::new();
        manager.register(AlarmDefinition {
            id: "dev1".to_string(),
            name: "ph deviation".to_string(),
            description: String::new(),
            alarm_type: AlarmType::Deviation,
            priority: AlarmPriority::Medium,
            source: "ph".to_string(),
            setpoint: 7.0,
            deadband: 1.0,
            delay_ms: 0,
            enabled: true,
            require_ack: false,
        });

        // deviation 0.5 (< deadband 1.0) — no trigger.
        assert!(manager.process_value("dev1", 7.5).is_none());
        // deviation 1.5 (> deadband) — trigger.
        assert!(matches!(
            manager.process_value("dev1", 8.5),
            Some(AlarmEvent::Activated { .. })
        ));
        // deviation 0.6 (> deadband/2 = 0.5) — stays active (upper hysteresis band).
        assert!(manager.process_value("dev1", 7.6).is_none());
        assert_eq!(manager.get("dev1").unwrap().state, AlarmState::Active);
        // deviation 0.4 (< deadband/2) — clears.
        assert!(matches!(
            manager.process_value("dev1", 7.4),
            Some(AlarmEvent::Returned { .. })
        ));
    }

    #[test]
    fn test_alarm_shelving() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit(
            "temp_high",
            "temperature",
            80.0,
        ));

        // Shelve
        let event = manager.shelve("temp_high", Duration::from_secs(3600), "operator1");
        assert!(matches!(event, Some(AlarmEvent::Shelved { .. })));

        let alarm = manager.get("temp_high").unwrap();
        assert_eq!(alarm.state, AlarmState::Shelved);

        // Value changes should not trigger while shelved
        let event = manager.process_value("temp_high", 85.0);
        assert!(event.is_none());

        // Unshelve
        let event = manager.unshelve("temp_high");
        assert!(matches!(event, Some(AlarmEvent::Unshelved { .. })));
    }

    #[test]
    fn test_low_alarm() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::low_limit("temp_low", "temperature", 20.0));

        // Above threshold - no activation
        let event = manager.process_value("temp_low", 25.0);
        assert!(event.is_none());

        // Below threshold - activate
        let event = manager.process_value("temp_low", 15.0);
        assert!(matches!(event, Some(AlarmEvent::Activated { .. })));
    }

    #[test]
    fn test_alarm_summary() {
        let mut manager = AlarmManager::new();

        manager.register(
            AlarmDefinition::high_limit("crit1", "temp", 100.0)
                .with_priority(AlarmPriority::Critical),
        );
        manager.register(
            AlarmDefinition::high_limit("high1", "pressure", 50.0)
                .with_priority(AlarmPriority::High),
        );
        manager.register(AlarmDefinition::high_limit("med1", "level", 80.0));

        // Activate some
        manager.process_value("crit1", 105.0);
        manager.process_value("high1", 55.0);

        let summary = manager.summary();
        assert_eq!(summary.total_registered, 3);
        assert_eq!(summary.total_active, 2);
        assert_eq!(summary.critical, 1);
        assert_eq!(summary.high, 1);
        assert_eq!(summary.medium, 0);
    }

    #[test]
    fn test_journal() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit("temp", "temperature", 80.0));

        manager.process_value("temp", 85.0); // Activate
        manager.acknowledge("temp", "op1"); // Acknowledge
        manager.process_value("temp", 75.0); // Clear

        let journal = manager.journal();
        assert_eq!(journal.len(), 3);
    }

    #[test]
    fn test_acknowledge_all() {
        let mut manager = AlarmManager::new();

        manager.register(AlarmDefinition::high_limit("temp1", "t1", 80.0));
        manager.register(AlarmDefinition::high_limit("temp2", "t2", 80.0));

        manager.process_value("temp1", 85.0);
        manager.process_value("temp2", 85.0);

        assert_eq!(manager.active_count(), 2);

        let events = manager.acknowledge_all("operator");
        assert_eq!(events.len(), 2);
        assert_eq!(manager.active_count(), 0);
    }
}
