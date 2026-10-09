// Fixture (ARIA-MEDIUM-392): prose that merely contains the word "never"
// names no mechanism and must fail R7 — only the TypeScript never-TYPE form
// (`state: never`) counts.
// tier-1: careful code, never panics
pub struct SensorId(u32);
