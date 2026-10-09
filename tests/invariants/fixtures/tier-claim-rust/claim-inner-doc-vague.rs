//! Fixture (ARIA-MEDIUM-392): a module-level claim in an inner doc comment
//! must be scanned like any other; this one names no mechanism (R7).
//! tier-1: this module is safe because it is careful
pub struct SensorId(u32);
