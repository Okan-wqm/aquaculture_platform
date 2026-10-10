// Fixture (ARIA-MEDIUM-392): the bare word "clippy" is not a mechanism; a
// claim must name the lint (`clippy::unwrap_used`) to be checkable.
// tier-3: clippy catches this
pub struct SensorId(u32);
