//! Script Conflict Detection (v2.0)
//!
//! Detects when multiple scripts attempt to write different values
//! to the same GPIO pin or Modbus register in the same execution cycle.

use std::collections::HashMap;
use tracing::warn;

/// Pending write operation for conflict detection
#[derive(Debug, Clone)]
pub struct PendingWrite {
    pub script_id: String,
    pub value: WriteValue,
}

/// Value being written
#[derive(Debug, Clone, PartialEq)]
pub enum WriteValue {
    Bool(bool),
    U16(u16),
}

/// Conflict detection result
#[derive(Debug)]
pub enum ConflictResult {
    /// No conflict, proceed with write
    NoConflict,
    /// Conflict detected, provides warning message
    Conflict { message: String },
    /// Same value, can be deduplicated
    Duplicate,
}

/// Conflict detector for GPIO and Modbus writes
///
/// Tracks pending writes within an execution cycle to detect
/// when multiple scripts try to write different values to the same target.
pub struct ConflictDetector {
    /// Pending GPIO writes: pin -> (script_id, value)
    gpio_writes: HashMap<u8, PendingWrite>,
    /// Pending Modbus register writes: (device, address) -> (script_id, value)
    modbus_writes: HashMap<(String, u16), PendingWrite>,
    /// Pending Modbus coil writes: (device, address) -> (script_id, value)
    coil_writes: HashMap<(String, u16), PendingWrite>,
}

impl ConflictDetector {
    /// Create a new conflict detector
    pub fn new() -> Self {
        Self {
            gpio_writes: HashMap::new(),
            modbus_writes: HashMap::new(),
            coil_writes: HashMap::new(),
        }
    }

    /// Reset detector for a new execution cycle
    pub fn reset(&mut self) {
        self.gpio_writes.clear();
        self.modbus_writes.clear();
        self.coil_writes.clear();
    }

    /// Check and register a GPIO write
    ///
    /// Returns ConflictResult indicating if there's a conflict
    pub fn check_gpio_write(&mut self, script_id: &str, pin: u8, value: bool) -> ConflictResult {
        let new_write = PendingWrite {
            script_id: script_id.to_string(),
            value: WriteValue::Bool(value),
        };

        if let Some(existing) = self.gpio_writes.get(&pin) {
            // Same script updating same pin is OK
            if existing.script_id == script_id {
                self.gpio_writes.insert(pin, new_write);
                return ConflictResult::NoConflict;
            }

            // Different script - check value
            if existing.value == WriteValue::Bool(value) {
                // Same value from different scripts - duplicate
                return ConflictResult::Duplicate;
            }

            // Different value from different scripts - CONFLICT!
            let conflict_value = match &existing.value {
                WriteValue::Bool(v) => {
                    if *v {
                        "HIGH"
                    } else {
                        "LOW"
                    }
                }
                _ => "unknown",
            };
            let new_value = if value { "HIGH" } else { "LOW" };

            let message = format!(
                "GPIO CONFLICT: Pin {} - Script '{}' wants {}, but '{}' already set {}",
                pin, script_id, new_value, existing.script_id, conflict_value
            );

            warn!("{}", message);

            // Still register the new write (last-write-wins policy)
            self.gpio_writes.insert(pin, new_write);

            return ConflictResult::Conflict { message };
        }

        // No existing write, register it
        self.gpio_writes.insert(pin, new_write);
        ConflictResult::NoConflict
    }

    /// Check and register a Modbus register write
    pub fn check_modbus_write(
        &mut self,
        script_id: &str,
        device: &str,
        address: u16,
        value: u16,
    ) -> ConflictResult {
        let key = (device.to_string(), address);
        let new_write = PendingWrite {
            script_id: script_id.to_string(),
            value: WriteValue::U16(value),
        };

        if let Some(existing) = self.modbus_writes.get(&key) {
            if existing.script_id == script_id {
                self.modbus_writes.insert(key, new_write);
                return ConflictResult::NoConflict;
            }

            if existing.value == WriteValue::U16(value) {
                return ConflictResult::Duplicate;
            }

            let existing_val = match &existing.value {
                WriteValue::U16(v) => *v,
                _ => 0,
            };

            let message = format!(
                "MODBUS CONFLICT: {}:{} - Script '{}' wants {}, but '{}' already set {}",
                device, address, script_id, value, existing.script_id, existing_val
            );

            warn!("{}", message);

            self.modbus_writes.insert(key, new_write);
            return ConflictResult::Conflict { message };
        }

        self.modbus_writes.insert(key, new_write);
        ConflictResult::NoConflict
    }

    /// Check and register a Modbus coil write
    pub fn check_coil_write(
        &mut self,
        script_id: &str,
        device: &str,
        address: u16,
        value: bool,
    ) -> ConflictResult {
        let key = (device.to_string(), address);
        let new_write = PendingWrite {
            script_id: script_id.to_string(),
            value: WriteValue::Bool(value),
        };

        if let Some(existing) = self.coil_writes.get(&key) {
            if existing.script_id == script_id {
                self.coil_writes.insert(key, new_write);
                return ConflictResult::NoConflict;
            }

            if existing.value == WriteValue::Bool(value) {
                return ConflictResult::Duplicate;
            }

            let existing_val = match &existing.value {
                WriteValue::Bool(v) => *v,
                _ => false,
            };

            let message = format!(
                "COIL CONFLICT: {}:{} - Script '{}' wants {}, but '{}' already set {}",
                device, address, script_id, value, existing.script_id, existing_val
            );

            warn!("{}", message);

            self.coil_writes.insert(key, new_write);
            return ConflictResult::Conflict { message };
        }

        self.coil_writes.insert(key, new_write);
        ConflictResult::NoConflict
    }

    /// Get summary of all pending writes (for debugging)
    pub fn get_pending_summary(&self) -> String {
        let gpio_count = self.gpio_writes.len();
        let modbus_count = self.modbus_writes.len();
        let coil_count = self.coil_writes.len();

        format!(
            "Pending writes: {} GPIO, {} Modbus registers, {} coils",
            gpio_count, modbus_count, coil_count
        )
    }
}

impl Default for ConflictDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_conflict_single_script() {
        let mut detector = ConflictDetector::new();

        let result = detector.check_gpio_write("script1", 17, true);
        assert!(matches!(result, ConflictResult::NoConflict));

        // Same script can update same pin
        let result = detector.check_gpio_write("script1", 17, false);
        assert!(matches!(result, ConflictResult::NoConflict));
    }

    #[test]
    fn test_conflict_different_scripts_different_values() {
        let mut detector = ConflictDetector::new();

        // Script1 sets pin 17 to HIGH
        let result = detector.check_gpio_write("script1", 17, true);
        assert!(matches!(result, ConflictResult::NoConflict));

        // Script2 tries to set pin 17 to LOW - CONFLICT!
        let result = detector.check_gpio_write("script2", 17, false);
        assert!(matches!(result, ConflictResult::Conflict { .. }));
    }

    #[test]
    fn test_duplicate_same_value() {
        let mut detector = ConflictDetector::new();

        // Script1 sets pin 17 to HIGH
        detector.check_gpio_write("script1", 17, true);

        // Script2 also wants to set pin 17 to HIGH - duplicate, not conflict
        let result = detector.check_gpio_write("script2", 17, true);
        assert!(matches!(result, ConflictResult::Duplicate));
    }

    #[test]
    fn test_modbus_conflict() {
        let mut detector = ConflictDetector::new();

        detector.check_modbus_write("script1", "PLC-1", 100, 1234);

        let result = detector.check_modbus_write("script2", "PLC-1", 100, 5678);
        assert!(matches!(result, ConflictResult::Conflict { .. }));
    }

    #[test]
    fn test_reset_clears_state() {
        let mut detector = ConflictDetector::new();

        detector.check_gpio_write("script1", 17, true);
        detector.reset();

        // After reset, no conflict should exist
        let result = detector.check_gpio_write("script2", 17, false);
        assert!(matches!(result, ConflictResult::NoConflict));
    }
}
