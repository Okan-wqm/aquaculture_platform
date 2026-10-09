// Fixture (ARIA-MEDIUM-392): a tier claim that names no mechanism must
// fail R7 — the gate must actually scan .rs content, not skip it.
// tier-1: this is safe because the code is careful
pub struct SensorId(u32);
