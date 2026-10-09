// Fixture (ARIA-MEDIUM-392): a Rust tier-1 claim naming a concrete
// mechanism must pass the gate. Not compiled; scanned only.
// tier-1: newtype SensorId + exhaustive match on Command with #[non_exhaustive]
pub struct SensorId(u32);
