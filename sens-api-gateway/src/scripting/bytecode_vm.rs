//! ST stack VM (Batch 151 Faz 3 / plan R-1).
//!
//! Module-level `#![allow(dead_code)]` is held because
//! Batch 151 lands the VM primitives + tests in isolation
//! — no production call-site wires `ScriptVm::run` yet.
//! Batch 152+ consumes the VM from
//! `scripting::engine::ScriptEngine` (scan-cycle dispatch)
//! + `commands::cmd_deploy_program` (compile + verify
//! roundtrip). Lifted the same way Batches 148 / 149 held
//! allow-dead until the next consumer landed.
//!
//! ## WHY
//!
//! Plan §3 R-1 + plan §5 Faz 3 specify a stack-based
//! bytecode interpreter with:
//! - Deterministic dispatch (fixed opcode count per
//!   tick via gas metering).
//! - Safe-state trip on runtime errors
//!   (divide-by-zero, gas exhaustion, type error).
//! - RbacGatedWriter integration for WriteTag opcode
//!   (future batch).
//! - ProcessImage integration for LoadTag/WriteTag
//!   (future batch).
//!
//! Batch 151 lands the CORE VM — arithmetic + logic +
//! control + safety primitives + stdlib dispatch +
//! local variable slots. Tag IO opcodes (LoadTag /
//! WriteTag) return a deterministic error
//! (`VmError::TagIoNotWired`) until the future batch
//! plumbs ProcessImage + RbacGatedWriter.
//!
//! ## Architectural shape
//!
//! - `ScriptVm` owns stack + locals + gas counter.
//! - `run(bc)` executes the bytecode's opcode vec
//!   starting at index 0 + returns on `Return` opcode
//!   OR error.
//! - `dispatch_one(&mut self, &Opcode)` handles a
//!   single opcode — separated for per-opcode
//!   unit-test access.
//! - Gas accounting: every opcode's `gas_cost()` is
//!   deducted BEFORE dispatch; trips SafeState on
//!   exhaustion. `GasTick` / `SafeStateTrip` bypass
//!   the deduction (their cost = 0) + respectively
//!   check gas AND explicit trip.
//!
//! ## Not in scope for Batch 151
//!
//! - LoadTag / WriteTag ProcessImage integration
//!   (Batch 152 — requires RbacGatedWriter trait
//!   design).
//! - StdlibCall actual invocation — Batch 151 stubs
//!   the dispatch to return `VmError::StdlibNotWired`.
//!   Batch 153 wires the 10 Batch-148 stdlib functions.
//! - FB invoke — Batch 154.
//! - String / Time value variants — Batch 153.

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use super::bytecode::{Bytecode, Opcode, StValue, StValueType};

/// EDGE-HIGH-016 — absolute upper bound on per-tick gas, enforced
/// INDEPENDENTLY of the operator/attacker-supplied,
/// signature-covered `Bytecode.max_gas_per_tick`.
///
/// The per-opcode fuel check in `run_internal` already bounds iteration
/// count (every jump backedge costs >= 1 gas), but the budget it counts
/// down from was taken verbatim from the deploy request body with no
/// clamp — a program declaring `max_gas_per_tick: u32::MAX` with a
/// self-jump body runs ~4.29 billion synchronous dispatch iterations,
/// blocking the tokio worker for tens of seconds. The async
/// `tokio::time::timeout` watchdog cannot interrupt that: the VM loop has
/// no `.await`, so the timeout future is never polled until the VM
/// returns on its own, and the CPU-bound grind starves the very reactor
/// that would fire the timer.
///
/// This ceiling makes the DoS structurally impossible (make-it-impossible,
/// Tier-1): it caps the worst-case synchronous burst to ~10-50 ms on a
/// 2-core ARM edge box (~100x headroom over the largest legitimate
/// in-tree budget of 10_000 gas), so control always returns to the
/// runtime well within one scan cycle and the timeout/shutdown selects
/// can actually observe their deadlines. Operator config may LOWER the
/// effective budget but can never RAISE it above this ceiling. The clamp
/// is applied to the runtime `gas_remaining` field, NOT to the signed
/// `max_gas_per_tick` field, so signatures stay valid.
pub const MAX_GAS_CEIL: u32 = 1_000_000;

/// PR935-MEDIUM-003: hard wall-clock budget for a single scan-tick VM run.
/// The gas ceiling bounds ITERATIONS; this bounds real occupancy of the
/// 2-worker runtime. Legitimate programs finish in well under a millisecond,
/// so 50 ms is a generous ceiling that still stops an IO-opcode-heavy program
/// from permanently draining a worker every tick.
pub const MAX_TICK_WALL: std::time::Duration = std::time::Duration::from_millis(50);

/// How many dispatches between wall-clock checks — amortizes the
/// `Instant::now()` cost while keeping the overshoot bounded.
const WALL_CHECK_STRIDE: u32 = 1024;

/// VM runtime failure taxonomy.
#[derive(Debug, Clone, PartialEq)]
pub enum VmError {
    /// Gas budget exhausted before dispatch.
    GasExhausted { remaining: u32, needed: u32 },
    /// PR935-MEDIUM-003: wall-clock tick budget exceeded. The gas ceiling
    /// bounds ITERATIONS, but IO opcodes (LoadTag/WriteTag/FbCall) cost
    /// µs-scale host work, so a signed program at the gas ceiling can still
    /// occupy a worker for hundreds of ms every scan tick. This bounds the
    /// hazard in its real unit (time), independent of gas-weight calibration.
    WallClockExceeded { elapsed_ms: u64, budget_ms: u64 },
    /// Stack pop with empty stack.
    StackUnderflow { opcode: String },
    /// Stack-top type doesn't match the opcode's
    /// expected operand type (e.g. AddInt on Real).
    TypeMismatch {
        opcode: String,
        expected: StValueType,
        got: StValueType,
    },
    /// Integer or real divide-by-zero.
    DivideByZero { opcode: String },
    /// Jump target opcode index out of range.
    BadJumpTarget { target: u32, opcode_count: usize },
    /// LoadLocal/StoreLocal index ≥ local_count.
    BadLocalIndex { index: u32, local_count: u32 },
    /// SafeStateTrip opcode executed.
    SafeStateTripped,
    /// LoadTag / WriteTag dispatched without a `TagIo`
    /// backend — the VM was constructed without an IO
    /// injection (e.g. in-proc unit tests that don't
    /// exercise tag reads/writes). Production code paths
    /// always plumb a backend via `run_with_io`.
    TagIoNotWired {
        tag: String,
        direction: &'static str,
    },
    /// Batch 159: the injected `TagIo` backend returned a
    /// structured error. The VM trips safe state on the
    /// calling consumer's behalf — a tag-read or tag-write
    /// failure at scan-cycle time is a PLC runtime fault.
    TagIoFailed {
        tag: String,
        direction: &'static str,
        reason: String,
    },
    /// StdlibCall not wired (historic — every Batch 148
    /// StdlibFunctionId now has dispatch per Batch 154).
    /// Variant retained so future StdlibFunctionId
    /// additions can return this error before their VM
    /// dispatch lands.
    StdlibNotWired { fn_id_wire_tag: u8 },
    /// Batch 156: `WriteTag` opcode targeted a tag NOT
    /// in `Bytecode.allowed_write_tags`. Compile-time
    /// whitelist enforcement per plan R-1 — the VM
    /// rejects dispatch rather than silently permitting
    /// the write.
    TagNotAllowed { tag: String },
    /// Batch 156: `WriteTag` opcode targeted a tag listed
    /// in `Bytecode.safe_state_pinned_tags`. Pinned tags
    /// hold operator-configured safe-state values and
    /// MUST NOT be overwritten by script logic — defense-
    /// in-depth even when the tag is also in the
    /// allowlist.
    SafeStatePinned { tag: String },
    /// Batch 180: FbCall / FbReadOutput dispatched
    /// without an FbIo backend injected. Matches the
    /// TagIoNotWired pattern (Batch 159).
    FbIoNotWired {
        fb_id: String,
        direction: &'static str,
    },
    /// Batch 180: FbIo backend returned an error.
    FbIoFailed {
        fb_id: String,
        direction: &'static str,
        reason: String,
    },
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GasExhausted { remaining, needed } => {
                write!(
                    f,
                    "vm: gas exhausted (remaining={}, needed={})",
                    remaining, needed
                )
            }
            Self::WallClockExceeded {
                elapsed_ms,
                budget_ms,
            } => {
                write!(
                    f,
                    "vm: wall-clock tick budget exceeded (elapsed={elapsed_ms}ms, budget={budget_ms}ms)"
                )
            }
            Self::StackUnderflow { opcode } => {
                write!(f, "vm: stack underflow on {}", opcode)
            }
            Self::TypeMismatch {
                opcode,
                expected,
                got,
            } => write!(
                f,
                "vm: type mismatch on {}: expected {:?}, got {:?}",
                opcode, expected, got
            ),
            Self::DivideByZero { opcode } => {
                write!(f, "vm: divide-by-zero on {}", opcode)
            }
            Self::BadJumpTarget {
                target,
                opcode_count,
            } => {
                write!(
                    f,
                    "vm: bad jump target {} (program has {} opcodes)",
                    target, opcode_count
                )
            }
            Self::BadLocalIndex { index, local_count } => {
                write!(
                    f,
                    "vm: bad local index {} (program declared {} locals)",
                    index, local_count
                )
            }
            Self::SafeStateTripped => f.write_str("vm: safe-state tripped"),
            Self::TagIoNotWired { tag, direction } => {
                write!(f, "vm: tag IO not wired ({} on {})", direction, tag)
            }
            Self::TagIoFailed {
                tag,
                direction,
                reason,
            } => {
                write!(
                    f,
                    "vm: tag IO failed ({} on `{}`): {}",
                    direction, tag, reason
                )
            }
            Self::StdlibNotWired { fn_id_wire_tag } => {
                write!(f, "vm: stdlib fn not wired (wire_tag={})", fn_id_wire_tag)
            }
            Self::TagNotAllowed { tag } => {
                write!(
                    f,
                    "vm: write to tag `{}` blocked — not in allowed_write_tags",
                    tag
                )
            }
            Self::SafeStatePinned { tag } => {
                write!(f, "vm: write to safe-state-pinned tag `{}` blocked", tag)
            }
            Self::FbIoNotWired { fb_id, direction } => {
                write!(f, "vm: FB IO not wired ({} on fb `{}`)", direction, fb_id)
            }
            Self::FbIoFailed {
                fb_id,
                direction,
                reason,
            } => write!(
                f,
                "vm: FB IO failed ({} on fb `{}`): {}",
                direction, fb_id, reason
            ),
        }
    }
}

impl std::error::Error for VmError {}

/// VM execution outcome.
#[derive(Debug, Clone, PartialEq)]
pub enum VmOutcome {
    /// Program hit a `Return` opcode — normal exit.
    Returned,
    /// Runtime error — VM halted + caller should trip
    /// SafeState at the consumer level (script engine)
    /// + disable the program.
    Error(VmError),
}

/// Tag read/write backend — Batch 159 Faz 3 (plan R-1).
///
/// The VM pauses on `LoadTag` / `WriteTag` opcodes and
/// calls into the injected backend. Separating this trait
/// from the VM decouples the runtime from ProcessImage,
/// MockTagStore (tests), RbacGatedWriter (future batch
/// wires RBAC enforcement at the write boundary), or an
/// OPC-UA bridge.
///
/// Implementors must return a structured `TagIoError`
/// rather than panicking — the VM converts errors to
/// `VmError::TagIoFailed` + halts the program so the
/// engine consumer can trip safe state.
pub trait TagIo {
    /// Read the current value of `tag_name`. Returns the
    /// stored `StValue` on success. Callers propagate a
    /// `NotFound` error when the tag is not present in
    /// the backend's catalog.
    fn read_tag(&self, tag_name: &str) -> Result<StValue, TagIoError>;

    /// Write `value` to `tag_name`. The VM has already
    /// cleared the Batch 156 allowlist + safe-state-
    /// pinned gates before calling this — the backend
    /// handles type validation against the tag's
    /// declared data type + any RBAC gating.
    fn write_tag(&self, tag_name: &str, value: StValue) -> Result<(), TagIoError>;
}

/// Structured tag-IO failure returned by `TagIo` impls.
/// The VM converts each variant to `VmError::TagIoFailed`
/// + halts the program so the engine consumer can trip
/// safe state without hiding the operator-visible cause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagIoError {
    /// Tag name not in the backend's catalog.
    NotFound { tag: String },
    /// Write-side type mismatch (backend's declared type
    /// differs from the value the VM is pushing).
    TypeMismatch {
        tag: String,
        expected: StValueType,
        got: StValueType,
    },
    /// RBAC / safety-policy layer rejected the write
    /// (e.g. caller lacks WriteTag permission for this
    /// tag, or the actuator class is locked).
    WriteDenied { tag: String, reason: String },
    /// Backend internal failure (e.g. ProcessImage lock
    /// poisoned, SQLCipher unavailable, OPC UA server
    /// disconnected). Free-form so backends can embed
    /// useful diagnostics without a fixed taxonomy.
    Internal { tag: String, reason: String },
}

impl TagIoError {
    fn tag(&self) -> &str {
        match self {
            Self::NotFound { tag }
            | Self::TypeMismatch { tag, .. }
            | Self::WriteDenied { tag, .. }
            | Self::Internal { tag, .. } => tag,
        }
    }

    fn into_vm_error(self, direction: &'static str) -> VmError {
        let tag = self.tag().to_string();
        let reason = match self {
            Self::NotFound { .. } => "tag not found in backend".to_string(),
            Self::TypeMismatch { expected, got, .. } => {
                format!("type mismatch: expected {:?}, got {:?}", expected, got)
            }
            Self::WriteDenied { reason, .. } => format!("write denied: {}", reason),
            Self::Internal { reason, .. } => format!("backend internal: {}", reason),
        };
        VmError::TagIoFailed {
            tag,
            direction,
            reason,
        }
    }
}

impl std::fmt::Display for TagIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { tag } => write!(f, "tag `{}` not found", tag),
            Self::TypeMismatch { tag, expected, got } => write!(
                f,
                "tag `{}`: type mismatch (expected {:?}, got {:?})",
                tag, expected, got
            ),
            Self::WriteDenied { tag, reason } => {
                write!(f, "tag `{}`: write denied — {}", tag, reason)
            }
            Self::Internal { tag, reason } => {
                write!(f, "tag `{}`: backend internal — {}", tag, reason)
            }
        }
    }
}

impl std::error::Error for TagIoError {}

/// Function-block I/O backend — Batch 180 Faz 3.
///
/// Mirrors the `TagIo` (Batch 159) abstraction: the VM
/// stays decoupled from the `FBRegistry` concrete type
/// so tests can drive a mock + production can plug the
/// real registry. Three operations cover the FB invoke
/// primitive:
/// - `set_input(fb_id, name, value)` → writes one FB
///   input pin before execution.
/// - `execute_fb(fb_id)` → runs the FB's state machine
///   once (timer tick, counter increment, PID step).
/// - `get_output(fb_id, name)` → reads one FB output
///   pin for `FbReadOutput` opcode.
///
/// All three return `FbIoError` on failure; the VM
/// converts each to the appropriate `VmError` variant.
pub trait FbIo {
    fn set_input(&self, fb_id: &str, input_name: &str, value: StValue) -> Result<(), FbIoError>;
    fn execute_fb(&self, fb_id: &str) -> Result<(), FbIoError>;
    fn get_output(&self, fb_id: &str, output_name: &str) -> Result<StValue, FbIoError>;
}

/// FB-IO failure taxonomy. Each variant maps to a
/// specific operator-facing situation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FbIoError {
    /// FB instance id not in the backend registry.
    NotFound { fb_id: String },
    /// Input / output pin name not declared on this
    /// FB type.
    PinNotFound { fb_id: String, pin: String },
    /// Type mismatch on set_input or get_output.
    TypeMismatch {
        fb_id: String,
        pin: String,
        expected: StValueType,
        got: StValueType,
    },
    /// Backend internal failure (state corruption, lock
    /// poison, etc).
    Internal { fb_id: String, reason: String },
}

impl FbIoError {
    fn fb_id(&self) -> &str {
        match self {
            Self::NotFound { fb_id }
            | Self::PinNotFound { fb_id, .. }
            | Self::TypeMismatch { fb_id, .. }
            | Self::Internal { fb_id, .. } => fb_id,
        }
    }

    fn into_vm_error(self, direction: &'static str) -> VmError {
        let fb_id = self.fb_id().to_string();
        let reason = match self {
            Self::NotFound { .. } => "FB instance not found".to_string(),
            Self::PinNotFound { pin, .. } => format!("pin `{}` not found", pin),
            Self::TypeMismatch {
                pin, expected, got, ..
            } => format!(
                "pin `{}`: type mismatch (expected {:?}, got {:?})",
                pin, expected, got
            ),
            Self::Internal { reason, .. } => format!("backend internal: {}", reason),
        };
        VmError::FbIoFailed {
            fb_id,
            direction,
            reason,
        }
    }
}

impl std::fmt::Display for FbIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { fb_id } => write!(f, "fb `{}` not found", fb_id),
            Self::PinNotFound { fb_id, pin } => {
                write!(f, "fb `{}`: pin `{}` not found", fb_id, pin)
            }
            Self::TypeMismatch {
                fb_id,
                pin,
                expected,
                got,
            } => write!(
                f,
                "fb `{}`: pin `{}`: type mismatch (expected {:?}, got {:?})",
                fb_id, pin, expected, got
            ),
            Self::Internal { fb_id, reason } => {
                write!(f, "fb `{}`: backend internal — {}", fb_id, reason)
            }
        }
    }
}

impl std::error::Error for FbIoError {}

/// Stack-based VM runtime state.
#[derive(Debug)]
pub struct ScriptVm {
    /// Evaluation stack. Grows as expressions push +
    /// shrinks as opcodes consume.
    stack: Vec<StValue>,
    /// Local variable slots. Indexed by `Bytecode.local_count`;
    /// bounds-checked on LoadLocal / StoreLocal.
    locals: Vec<StValue>,
    /// Per-tick gas budget, decremented at each
    /// opcode's `gas_cost()` before dispatch.
    gas_remaining: u32,
    /// Instruction pointer (index into `Bytecode.opcodes`).
    ip: usize,
    /// PR935-MEDIUM-003 / EDGE-HIGH-042: wall-clock budget for one run.
    /// Production VMs pin `MAX_TICK_WALL`; the guard is a VM property (not
    /// a global read inside the dispatch loop) so a test that proves the
    /// GAS ceiling can take this second, host-speed-dependent guard out of
    /// the race explicitly instead of losing to it on a slow debug runner.
    wall_budget: std::time::Duration,
}

impl ScriptVm {
    /// Construct a fresh VM for a bytecode program.
    /// Locals initialize to `StValue::Bool(false)` —
    /// the compiler + ST type-checker ensures locals
    /// are WRITTEN before read, but the zero-
    /// initialization provides a sane default.
    pub fn new(bc: &Bytecode) -> Self {
        // Default zero-init: Bool(false) for every local.
        // Batch 176: retain_vars declarations override
        // slots with type-correct zeros (Int(0) / Real(0.0))
        // so programs without an injected persistence
        // backend still see the right type on their RETAIN
        // slots. Non-RETAIN locals stay Bool(false); the
        // compiler-enforced write-before-read rule keeps
        // them from being read without prior StoreLocal.
        let mut locals = vec![StValue::Bool(false); bc.local_count as usize];
        for (_name, local_index, declared_type) in &bc.retain_vars {
            let idx = *local_index as usize;
            if idx < locals.len() {
                locals[idx] = match declared_type {
                    StValueType::Bool => StValue::Bool(false),
                    StValueType::Int => StValue::Int(0),
                    StValueType::Real => StValue::Real(0.0),
                };
            }
        }
        Self {
            stack: Vec::with_capacity(32),
            locals,
            // EDGE-HIGH-016: clamp the runtime budget to the hard ceiling.
            // The signed `bc.max_gas_per_tick` field is left untouched; the
            // VM simply refuses to honour a budget above MAX_GAS_CEIL, so an
            // unbounded per-tick declaration cannot translate into an
            // unbounded synchronous burst.
            gas_remaining: bc.max_gas_per_tick.min(MAX_GAS_CEIL),
            ip: 0,
            wall_budget: MAX_TICK_WALL,
        }
    }

    /// Construct a VM with an explicit wall-clock budget (EDGE-HIGH-042).
    /// The gas ceiling and the wall-clock guard are two independent
    /// termination bounds that race inside `run_internal`; which one wins
    /// for a pure-compute loop depends only on how fast the host executes a
    /// dispatch. A test that pins ONE of them must remove the other from
    /// the race, or it asserts host speed rather than the invariant.
    #[cfg(test)]
    pub(crate) fn with_wall_budget(bc: &Bytecode, wall_budget: std::time::Duration) -> Self {
        Self {
            wall_budget,
            ..Self::new(bc)
        }
    }

    /// Test helper — access the stack for invariant
    /// assertions.
    #[allow(dead_code)]
    pub(crate) fn stack(&self) -> &[StValue] {
        &self.stack
    }

    #[allow(dead_code)]
    pub(crate) fn locals(&self) -> &[StValue] {
        &self.locals
    }

    /// Mutable access to the locals slice — Batch 176
    /// Faz 3 wire. Used by `bytecode_retain::load_retain_
    /// vars` to restore persisted RETAIN values into the
    /// VM's slots BEFORE `run_with_io` dispatches the
    /// program. Bounds-checking is the caller's
    /// responsibility; retain-bridge catches bad indexes
    /// + returns `RetainError::BadLocalIndex`.
    pub fn locals_mut(&mut self) -> &mut [StValue] {
        &mut self.locals
    }

    #[allow(dead_code)]
    pub(crate) fn gas_remaining(&self) -> u32 {
        self.gas_remaining
    }

    /// Execute the full bytecode program WITHOUT a tag IO
    /// backend. LoadTag / WriteTag opcodes trip
    /// `VmError::TagIoNotWired`. Retained for in-proc
    /// tests + programs that genuinely do no tag IO.
    pub fn run(&mut self, bc: &Bytecode) -> VmOutcome {
        self.run_internal(bc, None, None)
    }

    /// Execute the full bytecode program with an injected
    /// tag IO backend. Production engine consumer uses
    /// this path — LoadTag reads through `io.read_tag`,
    /// WriteTag (after Batch 156 allowlist + pinned gates)
    /// writes through `io.write_tag`.
    pub fn run_with_io(&mut self, bc: &Bytecode, io: &dyn TagIo) -> VmOutcome {
        self.run_internal(bc, Some(io), None)
    }

    /// Execute with both tag IO + function block backends
    /// (Batch 180 Faz 3). Programs that invoke FB blocks
    /// (TON, TOF, CTU, PID, etc) use this path; pure-
    /// expression programs can stick with `run_with_io`.
    pub fn run_with_io_and_fb(
        &mut self,
        bc: &Bytecode,
        io: &dyn TagIo,
        fb: &dyn FbIo,
    ) -> VmOutcome {
        self.run_internal(bc, Some(io), Some(fb))
    }

    fn run_internal(
        &mut self,
        bc: &Bytecode,
        io: Option<&dyn TagIo>,
        fb: Option<&dyn FbIo>,
    ) -> VmOutcome {
        self.ip = 0;
        // PR935-MEDIUM-003: wall-clock tick budget. Checked every
        // WALL_CHECK_STRIDE dispatches so the Instant::now() cost is amortized.
        let tick_start = std::time::Instant::now();
        let mut dispatched: u32 = 0;
        loop {
            // Wall-clock guard: bounds the tick in real time even if the gas
            // budget would allow hundreds of ms of IO-opcode host work.
            dispatched = dispatched.wrapping_add(1);
            if dispatched % WALL_CHECK_STRIDE == 0 {
                let elapsed = tick_start.elapsed();
                if elapsed > self.wall_budget {
                    return VmOutcome::Error(VmError::WallClockExceeded {
                        elapsed_ms: elapsed.as_millis() as u64,
                        budget_ms: self.wall_budget.as_millis() as u64,
                    });
                }
            }
            // Safety: ip bounds check on every
            // iteration. A runaway bytecode that walks
            // past the end without Return gets halted
            // here instead of OOB reading.
            let Some(opcode) = bc.opcodes.get(self.ip) else {
                return VmOutcome::Error(VmError::BadJumpTarget {
                    target: self.ip as u32,
                    opcode_count: bc.opcodes.len(),
                });
            };

            // Gas accounting BEFORE dispatch. GasTick +
            // SafeStateTrip have zero cost (they ENFORCE
            // exhaustion + error paths).
            let cost = opcode.gas_cost();
            if cost > self.gas_remaining {
                return VmOutcome::Error(VmError::GasExhausted {
                    remaining: self.gas_remaining,
                    needed: cost,
                });
            }
            self.gas_remaining -= cost;

            match self.dispatch_one(opcode, bc, io, fb) {
                Ok(DispatchStep::Advance) => {
                    self.ip += 1;
                }
                Ok(DispatchStep::Jumped) => {
                    // IP already updated by the jump
                    // handler.
                }
                Ok(DispatchStep::Returned) => {
                    return VmOutcome::Returned;
                }
                Err(e) => {
                    return VmOutcome::Error(e);
                }
            }
        }
    }

    /// Dispatch a single opcode. Kept separate from
    /// `run` so per-opcode unit tests can exercise
    /// dispatch logic without driving the full loop.
    fn dispatch_one(
        &mut self,
        opcode: &Opcode,
        bc: &Bytecode,
        io: Option<&dyn TagIo>,
        fb: Option<&dyn FbIo>,
    ) -> Result<DispatchStep, VmError> {
        match opcode {
            // Stack ops
            Opcode::PushConst { value } => {
                self.stack.push(*value);
                Ok(DispatchStep::Advance)
            }
            Opcode::Pop => {
                self.pop("Pop")?;
                Ok(DispatchStep::Advance)
            }
            Opcode::Dup => {
                let top = *self.peek("Dup")?;
                self.stack.push(top);
                Ok(DispatchStep::Advance)
            }

            // Integer arithmetic
            Opcode::AddInt => self.binop_int("AddInt", |a, b| Some(a.wrapping_add(b))),
            Opcode::SubInt => self.binop_int("SubInt", |a, b| Some(a.wrapping_sub(b))),
            Opcode::MulInt => self.binop_int("MulInt", |a, b| Some(a.wrapping_mul(b))),
            Opcode::DivInt => self.binop_int("DivInt", |a, b| {
                if b == 0 {
                    None
                } else {
                    Some(a.wrapping_div(b))
                }
            }),
            Opcode::NegInt => {
                let v = self.pop_int("NegInt")?;
                self.stack.push(StValue::Int(v.wrapping_neg()));
                Ok(DispatchStep::Advance)
            }

            // Real arithmetic
            Opcode::AddReal => self.binop_real("AddReal", |a, b| a + b),
            Opcode::SubReal => self.binop_real("SubReal", |a, b| a - b),
            Opcode::MulReal => self.binop_real("MulReal", |a, b| a * b),
            Opcode::DivReal => {
                let b = self.pop_real("DivReal")?;
                let a = self.pop_real("DivReal")?;
                if b == 0.0 {
                    return Err(VmError::DivideByZero {
                        opcode: "DivReal".to_string(),
                    });
                }
                self.stack.push(StValue::Real(a / b));
                Ok(DispatchStep::Advance)
            }
            Opcode::NegReal => {
                let v = self.pop_real("NegReal")?;
                self.stack.push(StValue::Real(-v));
                Ok(DispatchStep::Advance)
            }

            // Type cast — Batch 153
            Opcode::CastIntToReal => {
                let v = self.pop_int("CastIntToReal")?;
                // i64 → f64 — lossy for magnitudes beyond
                // 2^53, but matches IEC 61131-3 implicit
                // promotion semantic where loss of low-bit
                // precision is accepted for mixed arithmetic.
                self.stack.push(StValue::Real(v as f64));
                Ok(DispatchStep::Advance)
            }

            // Comparison
            Opcode::Eq => {
                let b = self.pop("Eq")?;
                let a = self.pop("Eq")?;
                let eq = match (a, b) {
                    (StValue::Bool(x), StValue::Bool(y)) => x == y,
                    (StValue::Int(x), StValue::Int(y)) => x == y,
                    (StValue::Real(x), StValue::Real(y)) => x == y,
                    (x, y) => {
                        return Err(VmError::TypeMismatch {
                            opcode: "Eq".to_string(),
                            expected: x_type(&x),
                            got: x_type(&y),
                        });
                    }
                };
                self.stack.push(StValue::Bool(eq));
                Ok(DispatchStep::Advance)
            }
            Opcode::LtInt => {
                let b = self.pop_int("LtInt")?;
                let a = self.pop_int("LtInt")?;
                self.stack.push(StValue::Bool(a < b));
                Ok(DispatchStep::Advance)
            }
            Opcode::LtReal => {
                let b = self.pop_real("LtReal")?;
                let a = self.pop_real("LtReal")?;
                self.stack.push(StValue::Bool(a < b));
                Ok(DispatchStep::Advance)
            }

            // Logic
            Opcode::And => {
                let b = self.pop_bool("And")?;
                let a = self.pop_bool("And")?;
                self.stack.push(StValue::Bool(a && b));
                Ok(DispatchStep::Advance)
            }
            Opcode::Or => {
                let b = self.pop_bool("Or")?;
                let a = self.pop_bool("Or")?;
                self.stack.push(StValue::Bool(a || b));
                Ok(DispatchStep::Advance)
            }
            Opcode::Not => {
                let v = self.pop_bool("Not")?;
                self.stack.push(StValue::Bool(!v));
                Ok(DispatchStep::Advance)
            }

            // Control
            Opcode::Jump { target } => {
                self.jump_to(*target, bc)?;
                Ok(DispatchStep::Jumped)
            }
            Opcode::JumpIfFalse { target } => {
                let cond = self.pop_bool("JumpIfFalse")?;
                if cond {
                    Ok(DispatchStep::Advance)
                } else {
                    self.jump_to(*target, bc)?;
                    Ok(DispatchStep::Jumped)
                }
            }
            Opcode::Return => Ok(DispatchStep::Returned),

            // Memory
            Opcode::LoadLocal { index } => {
                let idx = *index;
                let v = self.locals.get(idx as usize).copied().ok_or_else(|| {
                    VmError::BadLocalIndex {
                        index: idx,
                        local_count: self.locals.len() as u32,
                    }
                })?;
                self.stack.push(v);
                Ok(DispatchStep::Advance)
            }
            Opcode::StoreLocal { index } => {
                let idx = *index as usize;
                if idx >= self.locals.len() {
                    return Err(VmError::BadLocalIndex {
                        index: *index,
                        local_count: self.locals.len() as u32,
                    });
                }
                let v = self.pop("StoreLocal")?;
                self.locals[idx] = v;
                Ok(DispatchStep::Advance)
            }

            // Tag IO — Batch 156 layers the tier-1
            // security gates (safe-state-pinned +
            // allowlist) in FRONT of the backend call.
            // Batch 159 injects an optional `TagIo`
            // backend so production code reads + writes
            // through ProcessImage / RbacGatedWriter
            // while in-proc tests can run without IO
            // (legacy `run` entry returns TagIoNotWired
            // on tag opcodes).
            Opcode::LoadTag { name } => match io {
                None => Err(VmError::TagIoNotWired {
                    tag: name.clone(),
                    direction: "load",
                }),
                Some(io) => match io.read_tag(name) {
                    Ok(value) => {
                        self.stack.push(value);
                        Ok(DispatchStep::Advance)
                    }
                    Err(e) => Err(e.into_vm_error("load")),
                },
            },
            Opcode::WriteTag { name } => {
                // Defense-in-depth ordering: safe-state-
                // pinned is checked BEFORE the allowlist
                // so an operator-error that simultaneously
                // allows + pins a tag still rejects at
                // the pinned layer (matches plan R-1
                // wording: "refuses WriteTag even when
                // name IS in allowed_write_tags").
                if bc.safe_state_pinned_tags.iter().any(|t| t == name) {
                    return Err(VmError::SafeStatePinned { tag: name.clone() });
                }
                if !bc.allowed_write_tags.iter().any(|t| t == name) {
                    return Err(VmError::TagNotAllowed { tag: name.clone() });
                }
                // Allowlist + pinned gates cleared.
                // Without an IO backend, the VM retains
                // the Batch 156 behavior — value stays on
                // the stack + a not-wired error surfaces
                // so the engine consumer can observe the
                // attempt. With an IO backend, pop the
                // value + write through.
                match io {
                    None => Err(VmError::TagIoNotWired {
                        tag: name.clone(),
                        direction: "write",
                    }),
                    Some(io) => {
                        let value = self.pop("WriteTag")?;
                        match io.write_tag(name, value) {
                            Ok(()) => Ok(DispatchStep::Advance),
                            Err(e) => Err(e.into_vm_error("write")),
                        }
                    }
                }
            }

            // Stdlib — Batch 154 wires the 10 Batch 148
            // numeric functions. Each variant pops its
            // declared arg count in reverse (stack top
            // is the rightmost arg) + pushes the single
            // result. Runtime faults (SQRT of negative,
            // LN of non-positive) trip SafeState per
            // IEC 61131-3 fault semantic.
            Opcode::StdlibCall { fn_id } => self.dispatch_stdlib(*fn_id),

            // Safety
            Opcode::GasTick => {
                // Explicit tick — zero-cost opcode that
                // checks gas exhaustion. Compilers can
                // emit this at loop backedges or scan-
                // cycle boundaries for tighter bounds
                // than the per-opcode accounting.
                if self.gas_remaining == 0 {
                    return Err(VmError::GasExhausted {
                        remaining: 0,
                        needed: 0,
                    });
                }
                Ok(DispatchStep::Advance)
            }
            Opcode::SafeStateTrip => Err(VmError::SafeStateTripped),

            // Batch 180 — FB invoke.
            Opcode::FbCall { fb_id, input_names } => match fb {
                None => Err(VmError::FbIoNotWired {
                    fb_id: fb_id.clone(),
                    direction: "call",
                }),
                Some(fb) => {
                    // Pop arguments in REVERSE push
                    // order. Compiler emission pushes
                    // left-to-right; stack top = last
                    // argument. Iterate input_names in
                    // reverse so pop order matches
                    // name order.
                    let mut values: Vec<StValue> = Vec::with_capacity(input_names.len());
                    for _ in 0..input_names.len() {
                        values.push(self.pop("FbCall")?);
                    }
                    values.reverse();
                    for (name, value) in input_names.iter().zip(values.into_iter()) {
                        if let Err(e) = fb.set_input(fb_id, name, value) {
                            return Err(e.into_vm_error("set_input"));
                        }
                    }
                    if let Err(e) = fb.execute_fb(fb_id) {
                        return Err(e.into_vm_error("execute"));
                    }
                    Ok(DispatchStep::Advance)
                }
            },
            Opcode::FbReadOutput { fb_id, output_name } => match fb {
                None => Err(VmError::FbIoNotWired {
                    fb_id: fb_id.clone(),
                    direction: "read",
                }),
                Some(fb) => match fb.get_output(fb_id, output_name) {
                    Ok(v) => {
                        self.stack.push(v);
                        Ok(DispatchStep::Advance)
                    }
                    Err(e) => Err(e.into_vm_error("read")),
                },
            },
        }
    }

    fn pop(&mut self, op_label: &str) -> Result<StValue, VmError> {
        self.stack.pop().ok_or_else(|| VmError::StackUnderflow {
            opcode: op_label.to_string(),
        })
    }

    fn peek(&self, op_label: &str) -> Result<&StValue, VmError> {
        self.stack.last().ok_or_else(|| VmError::StackUnderflow {
            opcode: op_label.to_string(),
        })
    }

    fn pop_int(&mut self, op_label: &str) -> Result<i64, VmError> {
        match self.pop(op_label)? {
            StValue::Int(n) => Ok(n),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Int,
                got: x_type(&other),
            }),
        }
    }

    fn pop_real(&mut self, op_label: &str) -> Result<f64, VmError> {
        match self.pop(op_label)? {
            StValue::Real(n) => Ok(n),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Real,
                got: x_type(&other),
            }),
        }
    }

    fn pop_bool(&mut self, op_label: &str) -> Result<bool, VmError> {
        match self.pop(op_label)? {
            StValue::Bool(b) => Ok(b),
            other => Err(VmError::TypeMismatch {
                opcode: op_label.to_string(),
                expected: StValueType::Bool,
                got: x_type(&other),
            }),
        }
    }

    fn binop_int(
        &mut self,
        op_label: &str,
        f: impl FnOnce(i64, i64) -> Option<i64>,
    ) -> Result<DispatchStep, VmError> {
        let b = self.pop_int(op_label)?;
        let a = self.pop_int(op_label)?;
        let result = f(a, b).ok_or_else(|| VmError::DivideByZero {
            opcode: op_label.to_string(),
        })?;
        self.stack.push(StValue::Int(result));
        Ok(DispatchStep::Advance)
    }

    fn binop_real(
        &mut self,
        op_label: &str,
        f: impl FnOnce(f64, f64) -> f64,
    ) -> Result<DispatchStep, VmError> {
        let b = self.pop_real(op_label)?;
        let a = self.pop_real(op_label)?;
        self.stack.push(StValue::Real(f(a, b)));
        Ok(DispatchStep::Advance)
    }

    /// Dispatch a single stdlib function call (Batch
    /// 154). Assumes args are already on the stack (left
    /// to right). Pops the declared arg count + pushes
    /// exactly one result.
    ///
    /// Runtime fault policy:
    /// - SQRT(negative) → `VmError::SafeStateTripped`.
    /// - LN(x ≤ 0)      → `VmError::SafeStateTripped`.
    /// - Integer ABS on i64::MIN wraps per Batch 151
    ///   arithmetic discipline (wrapping_abs). PLC
    ///   operators see a deterministic value on overflow
    ///   rather than SafeState — matches Batch 151
    ///   AddInt/SubInt/MulInt wrapping behavior.
    fn dispatch_stdlib(
        &mut self,
        fn_id: super::bytecode::StdlibFunctionId,
    ) -> Result<DispatchStep, VmError> {
        use super::bytecode::StdlibFunctionId as F;

        match fn_id {
            F::AbsInt => {
                let x = self.pop_int("Stdlib::AbsInt")?;
                self.stack.push(StValue::Int(x.wrapping_abs()));
            }
            F::AbsReal => {
                let x = self.pop_real("Stdlib::AbsReal")?;
                self.stack.push(StValue::Real(x.abs()));
            }
            F::SqrtReal => {
                let x = self.pop_real("Stdlib::SqrtReal")?;
                if x < 0.0 {
                    // IEC 61131-3 fault on SQRT(negative)
                    // → trip safe state. Operator sees a
                    // deterministic fault rather than NaN
                    // contamination of downstream tags.
                    return Err(VmError::SafeStateTripped);
                }
                self.stack.push(StValue::Real(x.sqrt()));
            }
            F::LimitReal => {
                // LIMIT(mn, in, mx) → args pushed in
                // that order, so stack top = mx.
                let mx = self.pop_real("Stdlib::LimitReal")?;
                let in_val = self.pop_real("Stdlib::LimitReal")?;
                let mn = self.pop_real("Stdlib::LimitReal")?;
                // Explicit clamp — NaN-safe: if mn > mx
                // (operator-supplied nonsense) result is
                // mn per Rust f64::clamp panic avoidance.
                let clamped = if mn > mx { mn } else { in_val.clamp(mn, mx) };
                self.stack.push(StValue::Real(clamped));
            }
            F::MinReal => {
                let b = self.pop_real("Stdlib::MinReal")?;
                let a = self.pop_real("Stdlib::MinReal")?;
                // f64::min carries NaN-min semantic per
                // IEEE 754 — NaN vs x → x. Acceptable for
                // numeric IEC types.
                self.stack.push(StValue::Real(a.min(b)));
            }
            F::MaxReal => {
                let b = self.pop_real("Stdlib::MaxReal")?;
                let a = self.pop_real("Stdlib::MaxReal")?;
                self.stack.push(StValue::Real(a.max(b)));
            }
            F::SelReal => {
                // SEL(cond: Bool, if_false: Real, if_true: Real)
                // Args pushed left-to-right → stack top =
                // if_true. Pop order: if_true, if_false,
                // cond. IEC 61131-3: cond=TRUE selects
                // if_true (argument 2), cond=FALSE selects
                // if_false (argument 1).
                let if_true = self.pop_real("Stdlib::SelReal")?;
                let if_false = self.pop_real("Stdlib::SelReal")?;
                let cond = self.pop_bool("Stdlib::SelReal")?;
                self.stack
                    .push(StValue::Real(if cond { if_true } else { if_false }));
            }
            F::LnReal => {
                let x = self.pop_real("Stdlib::LnReal")?;
                if x <= 0.0 {
                    // LN domain is (0, ∞). x≤0 is a PLC
                    // runtime fault → safe state.
                    return Err(VmError::SafeStateTripped);
                }
                self.stack.push(StValue::Real(x.ln()));
            }
            F::ExpReal => {
                let x = self.pop_real("Stdlib::ExpReal")?;
                self.stack.push(StValue::Real(x.exp()));
            }
            F::PowReal => {
                let exp_arg = self.pop_real("Stdlib::PowReal")?;
                let base = self.pop_real("Stdlib::PowReal")?;
                self.stack.push(StValue::Real(base.powf(exp_arg)));
            }
        }
        Ok(DispatchStep::Advance)
    }

    fn jump_to(&mut self, target: u32, bc: &Bytecode) -> Result<(), VmError> {
        let idx = target as usize;
        if idx >= bc.opcodes.len() {
            return Err(VmError::BadJumpTarget {
                target,
                opcode_count: bc.opcodes.len(),
            });
        }
        self.ip = idx;
        Ok(())
    }
}

/// Per-opcode dispatch result. Separates "advance IP"
/// from "jump-taken (IP already updated)" from "program
/// returned".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchStep {
    Advance,
    Jumped,
    Returned,
}

fn x_type(v: &StValue) -> StValueType {
    match v {
        StValue::Bool(_) => StValueType::Bool,
        StValue::Int(_) => StValueType::Int,
        StValue::Real(_) => StValueType::Real,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bc(opcodes: Vec<Opcode>, locals: u32) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1_000_000,
            local_count: locals,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes,
        }
    }

    // ====================================================================
    // Arithmetic
    // ====================================================================

    #[test]
    fn run_int_add_leaves_sum_on_stack() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(2),
                },
                Opcode::PushConst {
                    value: StValue::Int(3),
                },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(5)]);
    }

    #[test]
    fn run_real_mul() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(2.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(3.5),
                },
                Opcode::MulReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(7.0)]);
    }

    #[test]
    fn run_int_divide_by_zero_trips_error() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(10),
                },
                Opcode::PushConst {
                    value: StValue::Int(0),
                },
                Opcode::DivInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        match vm.run(&b) {
            VmOutcome::Error(VmError::DivideByZero { opcode }) => {
                assert_eq!(opcode, "DivInt");
            }
            other => panic!("expected DivideByZero, got {:?}", other),
        }
    }

    #[test]
    fn run_real_divide_by_zero_trips_error() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(0.0),
                },
                Opcode::DivReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::DivideByZero { .. })
        ));
    }

    // ====================================================================
    // Locals
    // ====================================================================

    #[test]
    fn run_store_and_load_local() {
        // 42 → local[0]; LoadLocal[0] → stack
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(42),
                },
                Opcode::StoreLocal { index: 0 },
                Opcode::LoadLocal { index: 0 },
                Opcode::Return,
            ],
            1,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(42)]);
    }

    #[test]
    fn run_bad_local_index_trips_error() {
        let b = bc(vec![Opcode::LoadLocal { index: 99 }, Opcode::Return], 1);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::BadLocalIndex {
                index: 99,
                local_count: 1
            })
        ));
    }

    // ====================================================================
    // Control flow
    // ====================================================================

    #[test]
    fn run_jump_if_false_with_true_advances() {
        // true; JumpIfFalse→3; PushConst(99); Return
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(true),
                },
                Opcode::JumpIfFalse { target: 3 },
                Opcode::PushConst {
                    value: StValue::Int(99),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(99)]);
    }

    #[test]
    fn run_jump_if_false_with_false_skips() {
        // false; JumpIfFalse→3; PushConst(99); Return
        // With false, should SKIP the PushConst.
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(false),
                },
                Opcode::JumpIfFalse { target: 3 },
                Opcode::PushConst {
                    value: StValue::Int(99),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert!(vm.stack().is_empty());
    }

    #[test]
    fn run_jump_past_end_is_bad_target() {
        let b = bc(vec![Opcode::Jump { target: 99 }, Opcode::Return], 0);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::BadJumpTarget { target: 99, .. })
        ));
    }

    // ====================================================================
    // Gas metering
    // ====================================================================

    #[test]
    fn run_gas_exhaustion_trips_error() {
        let mut b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(1),
                },
                Opcode::PushConst {
                    value: StValue::Int(2),
                },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        b.max_gas_per_tick = 2; // 3 opcodes at 1 gas each → exhaust
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::GasExhausted { .. })
        ));
    }

    // EDGE-HIGH-016: the runtime gas budget is clamped to MAX_GAS_CEIL so an
    // attacker-declared unbounded budget cannot become an unbounded
    // synchronous burst — regardless of async-watchdog behaviour.

    #[test]
    fn new_clamps_gas_to_ceiling() {
        let mut b = bc(vec![Opcode::Return], 0);
        b.max_gas_per_tick = u32::MAX;
        let vm = ScriptVm::new(&b);
        assert_eq!(
            vm.gas_remaining(),
            MAX_GAS_CEIL,
            "an over-ceiling declared budget must be clamped to MAX_GAS_CEIL"
        );
    }

    #[test]
    fn new_preserves_gas_below_ceiling() {
        let mut b = bc(vec![Opcode::Return], 0);
        b.max_gas_per_tick = 1000;
        let vm = ScriptVm::new(&b);
        assert_eq!(
            vm.gas_remaining(),
            1000,
            "a legitimate under-ceiling budget must be preserved verbatim"
        );
    }

    #[test]
    fn run_infinite_jump_loop_terminates_via_gas_ceiling() {
        // A self-jump with an unbounded declared budget. Every backedge burns
        // >= 1 gas, and the runtime budget is clamped to MAX_GAS_CEIL, so this
        // MUST terminate with GasExhausted rather than hanging. The test
        // returning at all is the proof of termination.
        //
        // EDGE-HIGH-042: the wall-clock guard is taken out of the race on
        // purpose. MAX_GAS_CEIL dispatches of a bare jump take ~30 ms on a
        // fast host and >50 ms on a loaded debug-build CI runner, so with the
        // production MAX_TICK_WALL this assertion measured host speed: the
        // guard that fired first was whichever the runner happened to reach.
        // Only the gas bound is under test here; the wall-clock guard has its
        // own proof in `wall_clock_guard_halts_a_slow_io_loop_within_budget`.
        let mut b = bc(vec![Opcode::Jump { target: 0 }], 0);
        b.max_gas_per_tick = u32::MAX;
        let mut vm = ScriptVm::with_wall_budget(&b, std::time::Duration::MAX);
        let outcome = vm.run(&b);
        assert!(
            matches!(outcome, VmOutcome::Error(VmError::GasExhausted { .. })),
            "expected GasExhausted from the clamped budget, got {outcome:?}"
        );
        assert_eq!(
            vm.gas_remaining(),
            0,
            "the clamped budget must be fully spent"
        );
    }

    #[test]
    fn wall_budget_is_a_vm_property_that_can_preempt_the_gas_bound() {
        // EDGE-HIGH-042: the same pure-compute loop, with the wall budget
        // pinned below what a single check stride can cost, must halt on
        // the wall-clock guard — the field, not a global, decides the race.
        let mut b = bc(vec![Opcode::Jump { target: 0 }], 0);
        b.max_gas_per_tick = u32::MAX;
        let mut vm = ScriptVm::with_wall_budget(&b, std::time::Duration::ZERO);
        let outcome = vm.run(&b);
        assert!(
            matches!(outcome, VmOutcome::Error(VmError::WallClockExceeded { .. })),
            "expected WallClockExceeded from a zero wall budget, got {outcome:?}"
        );
        assert!(
            vm.gas_remaining() > 0,
            "the wall guard must fire before the gas budget is spent"
        );
    }

    #[test]
    fn run_safe_state_trip_halts_with_error() {
        let b = bc(vec![Opcode::SafeStateTrip], 0);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::SafeStateTripped)
        ));
    }

    // ====================================================================
    // Stack hygiene
    // ====================================================================

    #[test]
    fn run_pop_from_empty_is_underflow() {
        let b = bc(vec![Opcode::Pop, Opcode::Return], 0);
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::StackUnderflow { .. })
        ));
    }

    #[test]
    fn run_type_mismatch_on_add_int() {
        // Push Real then Int then AddInt → pops Int ok,
        // then tries to pop another Int but finds Real.
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::PushConst {
                    value: StValue::Int(2),
                },
                Opcode::AddInt,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TypeMismatch { .. })
        ));
    }

    // ====================================================================
    // Type cast (Batch 153)
    // ====================================================================

    #[test]
    fn run_cast_int_to_real_promotes_to_f64() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(7),
                },
                Opcode::CastIntToReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(7.0)]);
    }

    #[test]
    fn run_cast_int_to_real_on_non_int_is_type_mismatch() {
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.5),
                },
                Opcode::CastIntToReal,
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TypeMismatch { .. })
        ));
    }

    #[test]
    fn run_compiled_sqrt_roundtrip() {
        // Batch 155 Faz 3 end-to-end: compile + execute
        // a program that calls SQRT(9.0) + stores into a
        // Real local.
        //
        // PROGRAM p  VAR r: REAL; END_VAR  r := SQRT(9.0);
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::FunctionCall {
                    name: "SQRT".into(),
                    args: vec![Expression::RealLiteral(9.0)],
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(3.0));
    }

    #[test]
    fn run_compiled_limit_with_int_literal_promotion() {
        // r := LIMIT(0, 5, 10);  — all Int literals
        // promoted to Real per stdlib signature.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::FunctionCall {
                    name: "LIMIT".into(),
                    args: vec![
                        Expression::IntLiteral(0),
                        Expression::IntLiteral(5),
                        Expression::IntLiteral(10),
                    ],
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(5.0));
    }

    #[test]
    fn run_compiled_int_plus_real_roundtrip() {
        // PROGRAM p  VAR r: REAL; END_VAR  r := 2 + 3.5;
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "r".into(),
                    data_type: DataType::Real,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("r".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::IntLiteral(2)),
                    op: BinaryOp::Add,
                    right: Box::new(Expression::RealLiteral(3.5)),
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Real(5.5));
    }

    // ====================================================================
    // Stub / future-wire opcodes
    // ====================================================================

    #[test]
    fn run_load_tag_stub_returns_not_wired() {
        let b = bc(
            vec![Opcode::LoadTag { name: "t1".into() }, Opcode::Return],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TagIoNotWired { .. })
        ));
    }

    // ====================================================================
    // Batch 156 — WriteTag tier-1 security gates
    // ====================================================================

    fn bc_with_tag_rules(
        opcodes: Vec<Opcode>,
        locals: u32,
        allowed: Vec<String>,
        pinned: Vec<String>,
    ) -> Bytecode {
        Bytecode {
            program_id: "t".into(),
            program_name: "t".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1_000_000,
            local_count: locals,
            retain_vars: vec![],
            allowed_write_tags: allowed,
            safe_state_pinned_tags: pinned,
            opcodes,
        }
    }

    #[test]
    fn run_write_tag_blocked_when_not_in_allowlist() {
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag {
                    name: "rogue_tag".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["safe_tag".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::TagNotAllowed { tag }) => {
                assert_eq!(tag, "rogue_tag");
            }
            other => panic!("expected TagNotAllowed, got {:?}", other),
        }
    }

    #[test]
    fn run_write_tag_blocked_when_safe_state_pinned() {
        // Even with the tag in the allowlist, pinned
        // status must win.
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag {
                    name: "aerator_on".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["aerator_on".into()],
            vec!["aerator_on".into()],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::SafeStatePinned { tag }) => {
                assert_eq!(tag, "aerator_on");
            }
            other => panic!("expected SafeStatePinned, got {:?}", other),
        }
    }

    #[test]
    fn run_write_tag_allowed_passes_gates_then_hits_io_stub() {
        // Tag in allowlist + not pinned → both gates
        // cleared; the opcode surfaces TagIoNotWired
        // (future ProcessImage wiring replaces this).
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(2.5),
                },
                Opcode::WriteTag {
                    name: "feeder_rate".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["feeder_rate".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        let outcome = vm.run(&b);
        match outcome {
            VmOutcome::Error(VmError::TagIoNotWired { tag, direction }) => {
                assert_eq!(tag, "feeder_rate");
                assert_eq!(direction, "write");
            }
            other => panic!(
                "expected TagIoNotWired after gates cleared, got {:?}",
                other
            ),
        }
        // Value must remain on the stack so the engine
        // consumer can observe the attempt during the
        // not-yet-wired phase.
        assert_eq!(vm.stack(), &[StValue::Real(2.5)]);
    }

    // ====================================================================
    // Batch 159 — TagIo trait + LoadTag/WriteTag wiring
    // ====================================================================

    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Minimal HashMap-backed TagIo impl for tests.
    /// Production code uses ProcessImage + RbacGatedWriter.
    #[derive(Debug, Default)]
    struct MockTagStore {
        values: RefCell<HashMap<String, StValue>>,
    }

    impl MockTagStore {
        fn with(pairs: &[(&str, StValue)]) -> Self {
            let mut m = HashMap::new();
            for (k, v) in pairs {
                m.insert((*k).to_string(), *v);
            }
            Self {
                values: RefCell::new(m),
            }
        }
    }

    impl TagIo for MockTagStore {
        fn read_tag(&self, tag_name: &str) -> Result<StValue, TagIoError> {
            self.values
                .borrow()
                .get(tag_name)
                .copied()
                .ok_or_else(|| TagIoError::NotFound {
                    tag: tag_name.to_string(),
                })
        }

        fn write_tag(&self, tag_name: &str, value: StValue) -> Result<(), TagIoError> {
            self.values.borrow_mut().insert(tag_name.to_string(), value);
            Ok(())
        }
    }

    /// Mock that always fails writes with a supplied error.
    struct FailingWriter {
        reason: String,
    }

    impl TagIo for FailingWriter {
        fn read_tag(&self, tag_name: &str) -> Result<StValue, TagIoError> {
            Err(TagIoError::NotFound {
                tag: tag_name.to_string(),
            })
        }

        fn write_tag(&self, tag_name: &str, _value: StValue) -> Result<(), TagIoError> {
            Err(TagIoError::WriteDenied {
                tag: tag_name.to_string(),
                reason: self.reason.clone(),
            })
        }
    }

    #[test]
    fn run_with_io_load_tag_reads_value_from_backend() {
        let store = MockTagStore::with(&[("water_temp", StValue::Real(22.5))]);
        let b = bc(
            vec![
                Opcode::LoadTag {
                    name: "water_temp".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io(&b, &store), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(22.5)]);
    }

    #[test]
    fn run_with_io_load_tag_not_found_trips_tag_io_failed() {
        let store = MockTagStore::default();
        let b = bc(
            vec![
                Opcode::LoadTag {
                    name: "missing".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        match vm.run_with_io(&b, &store) {
            VmOutcome::Error(VmError::TagIoFailed {
                tag,
                direction,
                reason,
            }) => {
                assert_eq!(tag, "missing");
                assert_eq!(direction, "load");
                assert!(reason.contains("not found"));
            }
            other => panic!("expected TagIoFailed, got {:?}", other),
        }
    }

    /// A TagIo whose writes are slow (host-call-like), to exercise the
    /// wall-clock guard: gas alone would allow a long-running IO loop.
    struct SlowWriter;
    impl TagIo for SlowWriter {
        fn read_tag(&self, _tag: &str) -> Result<StValue, TagIoError> {
            Ok(StValue::Real(0.0))
        }
        fn write_tag(&self, _tag: &str, _value: StValue) -> Result<(), TagIoError> {
            std::thread::sleep(std::time::Duration::from_micros(30));
            Ok(())
        }
    }

    #[test]
    fn wall_clock_guard_halts_a_slow_io_loop_within_budget() {
        // PR935-MEDIUM-003: an infinite WriteTag loop with a full gas budget
        // (1M) but slow IO opcodes must be halted by the wall-clock guard, not
        // run for the ~hundreds-of-ms the gas budget would otherwise permit.
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag { name: "t".into() },
                Opcode::Jump { target: 0 }, // loop forever
            ],
            0,
            vec!["t".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        let start = std::time::Instant::now();
        let outcome = vm.run_with_io(&b, &SlowWriter);
        let elapsed = start.elapsed();

        assert!(
            matches!(outcome, VmOutcome::Error(VmError::WallClockExceeded { .. })),
            "expected WallClockExceeded, got {outcome:?}"
        );
        // The guard must actually bound the tick — generous ceiling to absorb
        // the check stride + a slow CI box, but far below the seconds a full
        // gas budget of slow writes would take.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "wall-clock guard did not bound the tick: {elapsed:?}"
        );
    }

    #[test]
    fn run_with_io_write_tag_persists_value_to_backend() {
        let store = MockTagStore::with(&[("feeder_rate", StValue::Real(0.0))]);
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(2.5),
                },
                Opcode::WriteTag {
                    name: "feeder_rate".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["feeder_rate".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io(&b, &store), VmOutcome::Returned);
        assert_eq!(
            store.values.borrow().get("feeder_rate"),
            Some(&StValue::Real(2.5))
        );
        // Value was popped by successful write path.
        assert!(vm.stack().is_empty());
    }

    #[test]
    fn run_with_io_write_tag_backend_denial_trips_tag_io_failed() {
        let store = FailingWriter {
            reason: "RBAC: missing WriteTag permission".into(),
        };
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag {
                    name: "feeder_rate".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["feeder_rate".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        match vm.run_with_io(&b, &store) {
            VmOutcome::Error(VmError::TagIoFailed {
                tag,
                direction,
                reason,
            }) => {
                assert_eq!(tag, "feeder_rate");
                assert_eq!(direction, "write");
                assert!(reason.contains("RBAC: missing WriteTag permission"));
            }
            other => panic!("expected TagIoFailed, got {:?}", other),
        }
    }

    #[test]
    fn run_with_io_write_tag_pinned_still_blocks_before_backend_call() {
        // Batch 156 pinned gate still wins even with IO
        // backend present — the backend is never called.
        let store = MockTagStore::default();
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag {
                    name: "e_stop".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["e_stop".into()],
            vec!["e_stop".into()],
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run_with_io(&b, &store),
            VmOutcome::Error(VmError::SafeStatePinned { .. })
        ));
        // Backend must NOT have been called.
        assert!(store.values.borrow().is_empty());
    }

    #[test]
    fn run_with_io_read_modify_write_roundtrip() {
        // LoadTag(water_temp) → push 20.0
        // PushConst 5.0
        // AddReal → 25.0
        // WriteTag(setpoint) → backend gets 25.0
        let store = MockTagStore::with(&[
            ("water_temp", StValue::Real(20.0)),
            ("setpoint", StValue::Real(0.0)),
        ]);
        let b = bc_with_tag_rules(
            vec![
                Opcode::LoadTag {
                    name: "water_temp".into(),
                },
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
                Opcode::AddReal,
                Opcode::WriteTag {
                    name: "setpoint".into(),
                },
                Opcode::Return,
            ],
            0,
            vec!["setpoint".into()],
            vec![],
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io(&b, &store), VmOutcome::Returned);
        assert_eq!(
            store.values.borrow().get("setpoint"),
            Some(&StValue::Real(25.0))
        );
    }

    #[test]
    fn run_without_io_still_returns_not_wired_on_load_tag() {
        // Legacy `run` path (no IO) keeps the Batch 151
        // TagIoNotWired behavior for in-proc unit tests
        // that never exercise tag IO.
        let b = bc(
            vec![Opcode::LoadTag { name: "x".into() }, Opcode::Return],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::TagIoNotWired {
                direction: "load",
                ..
            })
        ));
    }

    // ====================================================================
    // Batch 180 — FbIo trait + FbCall / FbReadOutput dispatch
    // ====================================================================

    #[derive(Debug, Default)]
    struct MockFbStore {
        inputs: RefCell<HashMap<String, HashMap<String, StValue>>>,
        outputs: RefCell<HashMap<String, HashMap<String, StValue>>>,
        execution_count: RefCell<HashMap<String, u32>>,
    }

    impl MockFbStore {
        fn with_fb(fb_id: &str) -> Self {
            let mut inputs = HashMap::new();
            inputs.insert(fb_id.to_string(), HashMap::new());
            let mut outputs = HashMap::new();
            outputs.insert(fb_id.to_string(), HashMap::new());
            Self {
                inputs: RefCell::new(inputs),
                outputs: RefCell::new(outputs),
                execution_count: RefCell::new(HashMap::new()),
            }
        }

        fn set_output(&self, fb_id: &str, output_name: &str, value: StValue) {
            self.outputs
                .borrow_mut()
                .entry(fb_id.to_string())
                .or_default()
                .insert(output_name.to_string(), value);
        }

        fn input(&self, fb_id: &str, name: &str) -> Option<StValue> {
            self.inputs
                .borrow()
                .get(fb_id)
                .and_then(|m| m.get(name).cloned())
        }

        fn exec_count(&self, fb_id: &str) -> u32 {
            self.execution_count
                .borrow()
                .get(fb_id)
                .copied()
                .unwrap_or(0)
        }
    }

    impl TagIo for MockFbStore {
        fn read_tag(&self, _tag_name: &str) -> Result<StValue, TagIoError> {
            Err(TagIoError::NotFound { tag: String::new() })
        }
        fn write_tag(&self, _tag_name: &str, _value: StValue) -> Result<(), TagIoError> {
            Ok(())
        }
    }

    impl FbIo for MockFbStore {
        fn set_input(
            &self,
            fb_id: &str,
            input_name: &str,
            value: StValue,
        ) -> Result<(), FbIoError> {
            if !self.inputs.borrow().contains_key(fb_id) {
                return Err(FbIoError::NotFound {
                    fb_id: fb_id.to_string(),
                });
            }
            self.inputs
                .borrow_mut()
                .get_mut(fb_id)
                .unwrap()
                .insert(input_name.to_string(), value);
            Ok(())
        }

        fn execute_fb(&self, fb_id: &str) -> Result<(), FbIoError> {
            if !self.inputs.borrow().contains_key(fb_id) {
                return Err(FbIoError::NotFound {
                    fb_id: fb_id.to_string(),
                });
            }
            *self
                .execution_count
                .borrow_mut()
                .entry(fb_id.to_string())
                .or_insert(0) += 1;
            Ok(())
        }

        fn get_output(&self, fb_id: &str, output_name: &str) -> Result<StValue, FbIoError> {
            self.outputs
                .borrow()
                .get(fb_id)
                .and_then(|m| m.get(output_name).cloned())
                .ok_or_else(|| FbIoError::PinNotFound {
                    fb_id: fb_id.to_string(),
                    pin: output_name.to_string(),
                })
        }
    }

    #[test]
    fn run_fb_call_not_wired_without_backend() {
        let b = bc(
            vec![
                Opcode::FbCall {
                    fb_id: "timer1".into(),
                    input_names: vec![],
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::FbIoNotWired {
                direction: "call",
                ..
            })
        ));
    }

    #[test]
    fn run_fb_read_output_not_wired_without_backend() {
        let b = bc(
            vec![
                Opcode::FbReadOutput {
                    fb_id: "timer1".into(),
                    output_name: "Q".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::FbIoNotWired {
                direction: "read",
                ..
            })
        ));
    }

    #[test]
    fn run_fb_call_with_inputs_sets_pins_and_executes() {
        // FbCall(timer1, [IN, PT]) consumes 2 stack args
        // (in push order, so top = PT).
        let fb = MockFbStore::with_fb("timer1");
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(true),
                }, // IN
                Opcode::PushConst {
                    value: StValue::Int(5000),
                }, // PT (ms)
                Opcode::FbCall {
                    fb_id: "timer1".into(),
                    input_names: vec!["IN".into(), "PT".into()],
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io_and_fb(&b, &fb, &fb), VmOutcome::Returned);
        assert_eq!(fb.input("timer1", "IN"), Some(StValue::Bool(true)));
        assert_eq!(fb.input("timer1", "PT"), Some(StValue::Int(5000)));
        assert_eq!(fb.exec_count("timer1"), 1);
        // No return value pushed — stack is empty.
        assert!(vm.stack().is_empty());
    }

    #[test]
    fn run_fb_read_output_pushes_value() {
        let fb = MockFbStore::with_fb("timer1");
        fb.set_output("timer1", "Q", StValue::Bool(true));
        let b = bc(
            vec![
                Opcode::FbReadOutput {
                    fb_id: "timer1".into(),
                    output_name: "Q".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io_and_fb(&b, &fb, &fb), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Bool(true)]);
    }

    #[test]
    fn run_fb_call_unknown_fb_returns_fb_io_failed() {
        let fb = MockFbStore::with_fb("known_fb");
        let b = bc(
            vec![
                Opcode::FbCall {
                    fb_id: "ghost_fb".into(),
                    input_names: vec![],
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        match vm.run_with_io_and_fb(&b, &fb, &fb) {
            VmOutcome::Error(VmError::FbIoFailed { fb_id, reason, .. }) => {
                assert_eq!(fb_id, "ghost_fb");
                assert!(reason.contains("not found"));
            }
            other => panic!("expected FbIoFailed, got {:?}", other),
        }
    }

    #[test]
    fn run_fb_read_output_unknown_pin_returns_fb_io_failed() {
        let fb = MockFbStore::with_fb("timer1");
        // output "Q" never set, so get_output returns
        // PinNotFound.
        let b = bc(
            vec![
                Opcode::FbReadOutput {
                    fb_id: "timer1".into(),
                    output_name: "Q".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run_with_io_and_fb(&b, &fb, &fb),
            VmOutcome::Error(VmError::FbIoFailed { .. })
        ));
    }

    #[test]
    fn run_fb_call_then_read_roundtrip() {
        // Call(FB, [IN]) then read output — full loop.
        let fb = MockFbStore::with_fb("timer1");
        fb.set_output("timer1", "Q", StValue::Bool(false));
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(true),
                },
                Opcode::FbCall {
                    fb_id: "timer1".into(),
                    input_names: vec!["IN".into()],
                },
                Opcode::FbReadOutput {
                    fb_id: "timer1".into(),
                    output_name: "Q".into(),
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run_with_io_and_fb(&b, &fb, &fb), VmOutcome::Returned);
        // Q pushed on stack from FbReadOutput.
        assert_eq!(vm.stack(), &[StValue::Bool(false)]);
        assert_eq!(fb.input("timer1", "IN"), Some(StValue::Bool(true)));
        assert_eq!(fb.exec_count("timer1"), 1);
    }

    #[test]
    fn run_write_tag_pinned_check_runs_before_allowlist_check() {
        // Tag NOT in allowlist AND also pinned. Pinned
        // check runs first (order-independent from the
        // allowlist outcome) so the operator-visible
        // error points at the pinned rule.
        let b = bc_with_tag_rules(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::WriteTag {
                    name: "e_stop".into(),
                },
                Opcode::Return,
            ],
            0,
            vec![], // not in allowlist
            vec!["e_stop".into()],
        );
        let mut vm = ScriptVm::new(&b);
        assert!(matches!(
            vm.run(&b),
            VmOutcome::Error(VmError::SafeStatePinned { .. })
        ));
    }

    // ====================================================================
    // Stdlib dispatch (Batch 154)
    // ====================================================================

    #[test]
    fn run_stdlib_abs_int_negates_negative() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Int(-7),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::AbsInt,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Int(7)]);
    }

    #[test]
    fn run_stdlib_abs_real_returns_magnitude() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(-3.25),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::AbsReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.25)]);
    }

    #[test]
    fn run_stdlib_sqrt_real_returns_root() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(9.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::SqrtReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.0)]);
    }

    #[test]
    fn run_stdlib_sqrt_real_negative_trips_safe_state() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(-1.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::SqrtReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Error(VmError::SafeStateTripped));
    }

    #[test]
    fn run_stdlib_limit_real_clamps_above_max() {
        use super::super::bytecode::StdlibFunctionId;
        // LIMIT(0, 10, 5) → 5 (clamped to max).
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(0.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(10.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LimitReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(5.0)]);
    }

    #[test]
    fn run_stdlib_limit_real_clamps_below_min() {
        use super::super::bytecode::StdlibFunctionId;
        // LIMIT(2, -1, 5) → 2 (clamped to min).
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(2.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(-1.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LimitReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(2.0)]);
    }

    #[test]
    fn run_stdlib_limit_real_passthrough_within_range() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(0.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(3.5),
                },
                Opcode::PushConst {
                    value: StValue::Real(10.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LimitReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.5)]);
    }

    #[test]
    fn run_stdlib_min_max_real_picks_extrema() {
        use super::super::bytecode::StdlibFunctionId;
        let b_min = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(3.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::MinReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_min);
        assert_eq!(vm.run(&b_min), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(3.0)]);

        let b_max = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(5.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(3.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::MaxReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_max);
        assert_eq!(vm.run(&b_max), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(5.0)]);
    }

    #[test]
    fn run_stdlib_sel_real_picks_by_cond() {
        use super::super::bytecode::StdlibFunctionId;
        // SEL(cond=TRUE, if_false=1.0, if_true=9.0) → 9.0.
        let b_true = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(true),
                },
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(9.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::SelReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_true);
        assert_eq!(vm.run(&b_true), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(9.0)]);

        // SEL(cond=FALSE, if_false=1.0, if_true=9.0) → 1.0.
        let b_false = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Bool(false),
                },
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(9.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::SelReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_false);
        assert_eq!(vm.run(&b_false), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(1.0)]);
    }

    #[test]
    fn run_stdlib_ln_real_returns_log() {
        use super::super::bytecode::StdlibFunctionId;
        // LN(e) = 1.0
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(std::f64::consts::E),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LnReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        let top = vm.stack()[0];
        if let StValue::Real(v) = top {
            assert!((v - 1.0).abs() < 1e-12);
        } else {
            panic!("expected Real, got {:?}", top);
        }
    }

    #[test]
    fn run_stdlib_ln_real_non_positive_trips_safe_state() {
        use super::super::bytecode::StdlibFunctionId;
        let b_zero = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(0.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LnReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_zero);
        assert_eq!(vm.run(&b_zero), VmOutcome::Error(VmError::SafeStateTripped));

        let b_neg = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(-0.5),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::LnReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b_neg);
        assert_eq!(vm.run(&b_neg), VmOutcome::Error(VmError::SafeStateTripped));
    }

    #[test]
    fn run_stdlib_exp_real_returns_e_to_the_x() {
        use super::super::bytecode::StdlibFunctionId;
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(1.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::ExpReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        if let StValue::Real(v) = vm.stack()[0] {
            assert!((v - std::f64::consts::E).abs() < 1e-12);
        } else {
            panic!("expected Real");
        }
    }

    #[test]
    fn run_stdlib_pow_real_returns_base_to_exp() {
        use super::super::bytecode::StdlibFunctionId;
        // 2 ^ 10 = 1024
        let b = bc(
            vec![
                Opcode::PushConst {
                    value: StValue::Real(2.0),
                },
                Opcode::PushConst {
                    value: StValue::Real(10.0),
                },
                Opcode::StdlibCall {
                    fn_id: StdlibFunctionId::PowReal,
                },
                Opcode::Return,
            ],
            0,
        );
        let mut vm = ScriptVm::new(&b);
        assert_eq!(vm.run(&b), VmOutcome::Returned);
        assert_eq!(vm.stack(), &[StValue::Real(1024.0)]);
    }

    // ====================================================================
    // Integration with compiler (end-to-end)
    // ====================================================================

    #[test]
    fn run_compiled_case_range_label_matches_any_value_in_range() {
        // Batch 178 end-to-end: parse ST source with
        // a CASE range label, compile, execute, verify
        // the runtime matches ANY value inside the
        // declared range.
        //
        // PROGRAM p
        //   VAR n: INT; out: INT; END_VAR
        //   n := 7;
        //   CASE n OF
        //     0:    out := 100;
        //     5..10: out := 200;
        //     20:   out := 300;
        //   END_CASE
        // END_PROGRAM
        //
        // n=7 falls into the `5..10` range → out=200.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::parse_st;

        let source = r#"
            PROGRAM p
            VAR
                n : INT;
                out : INT;
            END_VAR

            n := 7;
            CASE n OF
                0: out := 100;
                5..10: out := 200;
                20: out := 300;
            END_CASE;
            END_PROGRAM
        "#;
        let prog = parse_st(source).expect("parse");
        let bc = compile_program(&prog, &[], "p".into(), 100_000).expect("compile");
        let mut vm = ScriptVm::new(&bc);
        assert_eq!(vm.run(&bc), VmOutcome::Returned);
        // Locate locals by name via the VAR order:
        // slot 0 = n, slot 1 = out. n=7, out=200.
        assert_eq!(vm.locals()[0], StValue::Int(7));
        assert_eq!(vm.locals()[1], StValue::Int(200));
    }

    #[test]
    fn run_compiled_case_statement_dispatches_to_matched_branch() {
        // PROGRAM p
        //   VAR state: INT; out: INT; END_VAR
        //   state := 2;
        //   CASE state OF
        //     0: out := 10;
        //     1: out := 20;
        //     2: out := 30;
        //     ELSE out := 99;
        //   END_CASE
        // END_PROGRAM
        // Expected: out = 30 (selector matched branch 2).
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "case_test".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "state".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "out".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                Statement::Assignment {
                    target: Expression::Variable("state".into(), None),
                    value: Expression::IntLiteral(2),
                    span: None,
                },
                Statement::Case {
                    expr: Expression::Variable("state".into(), None),
                    branches: vec![
                        (
                            vec![Expression::IntLiteral(0)],
                            vec![Statement::Assignment {
                                target: Expression::Variable("out".into(), None),
                                value: Expression::IntLiteral(10),
                                span: None,
                            }],
                        ),
                        (
                            vec![Expression::IntLiteral(1)],
                            vec![Statement::Assignment {
                                target: Expression::Variable("out".into(), None),
                                value: Expression::IntLiteral(20),
                                span: None,
                            }],
                        ),
                        (
                            vec![Expression::IntLiteral(2)],
                            vec![Statement::Assignment {
                                target: Expression::Variable("out".into(), None),
                                value: Expression::IntLiteral(30),
                                span: None,
                            }],
                        ),
                    ],
                    else_body: Some(vec![Statement::Assignment {
                        target: Expression::Variable("out".into(), None),
                        value: Expression::IntLiteral(99),
                        span: None,
                    }]),
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 100_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // slot 0 = state, slot 1 = out.
        assert_eq!(vm.locals()[0], StValue::Int(2));
        assert_eq!(vm.locals()[1], StValue::Int(30));
    }

    #[test]
    fn run_compiled_case_else_path_hit_when_no_match() {
        // CASE state OF 0: out:=1; 1: out:=2; ELSE out:=99;
        // state = 5 → else path → out = 99.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "case_else".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "state".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "out".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                Statement::Assignment {
                    target: Expression::Variable("state".into(), None),
                    value: Expression::IntLiteral(5),
                    span: None,
                },
                Statement::Case {
                    expr: Expression::Variable("state".into(), None),
                    branches: vec![
                        (
                            vec![Expression::IntLiteral(0)],
                            vec![Statement::Assignment {
                                target: Expression::Variable("out".into(), None),
                                value: Expression::IntLiteral(1),
                                span: None,
                            }],
                        ),
                        (
                            vec![Expression::IntLiteral(1)],
                            vec![Statement::Assignment {
                                target: Expression::Variable("out".into(), None),
                                value: Expression::IntLiteral(2),
                                span: None,
                            }],
                        ),
                    ],
                    else_body: Some(vec![Statement::Assignment {
                        target: Expression::Variable("out".into(), None),
                        value: Expression::IntLiteral(99),
                        span: None,
                    }]),
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 100_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[1], StValue::Int(99));
    }

    #[test]
    fn run_compiled_case_multi_value_branch_matches_any() {
        // CASE n OF 1, 3, 5: out := 100; END_CASE
        // n = 3 → matches → out = 100.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "case_multi".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "n".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "out".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                Statement::Assignment {
                    target: Expression::Variable("n".into(), None),
                    value: Expression::IntLiteral(3),
                    span: None,
                },
                Statement::Case {
                    expr: Expression::Variable("n".into(), None),
                    branches: vec![(
                        vec![
                            Expression::IntLiteral(1),
                            Expression::IntLiteral(3),
                            Expression::IntLiteral(5),
                        ],
                        vec![Statement::Assignment {
                            target: Expression::Variable("out".into(), None),
                            value: Expression::IntLiteral(100),
                            span: None,
                        }],
                    )],
                    else_body: None,
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 100_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[1], StValue::Int(100));
    }

    #[test]
    fn run_compiled_for_loop_sums_one_through_five() {
        // Batch 162 end-to-end:
        // PROGRAM p
        //   VAR i: INT; sum: INT; END_VAR
        //   sum := 0;
        //   FOR i := 1 TO 5 DO sum := sum + i; END_FOR
        // END_PROGRAM
        //
        // Expected: sum = 1+2+3+4+5 = 15, i = 6 after loop.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "for_sum".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "i".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "sum".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                // sum := 0;
                Statement::Assignment {
                    target: Expression::Variable("sum".into(), None),
                    value: Expression::IntLiteral(0),
                    span: None,
                },
                // FOR i := 1 TO 5 DO sum := sum + i END_FOR
                Statement::For {
                    variable: "i".into(),
                    from: Expression::IntLiteral(1),
                    to: Expression::IntLiteral(5),
                    by: None,
                    body: vec![Statement::Assignment {
                        target: Expression::Variable("sum".into(), None),
                        value: Expression::BinaryOp {
                            left: Box::new(Expression::Variable("sum".into(), None)),
                            op: BinaryOp::Add,
                            right: Box::new(Expression::Variable("i".into(), None)),
                        },
                        span: None,
                    }],
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // i = 0 (slot 0), sum = 1 (slot 1) per declaration order.
        // After the loop: i exited at 6 (first value >5), sum = 15.
        assert_eq!(vm.locals()[0], StValue::Int(6));
        assert_eq!(vm.locals()[1], StValue::Int(15));
    }

    #[test]
    fn run_compiled_for_loop_exit_halts_early() {
        // FOR i := 1 TO 10 DO
        //   IF i = 4 THEN EXIT END_IF;
        //   sum := sum + 1;
        // END_FOR
        // Expected: sum = 3 (i = 1, 2, 3 before EXIT at i=4).
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "for_exit".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "i".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "sum".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                Statement::Assignment {
                    target: Expression::Variable("sum".into(), None),
                    value: Expression::IntLiteral(0),
                    span: None,
                },
                Statement::For {
                    variable: "i".into(),
                    from: Expression::IntLiteral(1),
                    to: Expression::IntLiteral(10),
                    by: None,
                    body: vec![
                        Statement::If {
                            condition: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("i".into(), None)),
                                op: BinaryOp::Eq,
                                right: Box::new(Expression::IntLiteral(4)),
                            },
                            then_body: vec![Statement::Exit { span: None }],
                            elsif_branches: vec![],
                            else_body: None,
                            span: None,
                        },
                        Statement::Assignment {
                            target: Expression::Variable("sum".into(), None),
                            value: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("sum".into(), None)),
                                op: BinaryOp::Add,
                                right: Box::new(Expression::IntLiteral(1)),
                            },
                            span: None,
                        },
                    ],
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // i reached 4 (when EXIT fired), sum = 3.
        assert_eq!(vm.locals()[0], StValue::Int(4));
        assert_eq!(vm.locals()[1], StValue::Int(3));
    }

    #[test]
    fn run_compiled_while_loop_counts_to_three() {
        // Batch 152 Faz 3 end-to-end test — compile +
        // run a WHILE loop through the Batch 151 VM.
        //
        // PROGRAM p
        //   VAR i: INT; flag: BOOL; END_VAR
        //   i := 0;
        //   flag := TRUE;
        //   WHILE flag DO
        //     i := i + 1;
        //     IF i = 3 THEN flag := FALSE; END_IF;
        //   END_WHILE
        // END_PROGRAM
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![
                    VarDeclaration {
                        name: "i".into(),
                        data_type: DataType::Int,
                        initial_value: None,
                        span: None,
                    },
                    VarDeclaration {
                        name: "flag".into(),
                        data_type: DataType::Bool,
                        initial_value: None,
                        span: None,
                    },
                ],
                span: None,
            }],
            body: vec![
                // i := 0;
                Statement::Assignment {
                    target: Expression::Variable("i".into(), None),
                    value: Expression::IntLiteral(0),
                    span: None,
                },
                // flag := TRUE;
                Statement::Assignment {
                    target: Expression::Variable("flag".into(), None),
                    value: Expression::BoolLiteral(true),
                    span: None,
                },
                // WHILE flag DO ... END_WHILE
                Statement::While {
                    condition: Expression::Variable("flag".into(), None),
                    body: vec![
                        // i := i + 1;
                        Statement::Assignment {
                            target: Expression::Variable("i".into(), None),
                            value: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("i".into(), None)),
                                op: BinaryOp::Add,
                                right: Box::new(Expression::IntLiteral(1)),
                            },
                            span: None,
                        },
                        // IF i = 3 THEN flag := FALSE; END_IF
                        Statement::If {
                            condition: Expression::BinaryOp {
                                left: Box::new(Expression::Variable("i".into(), None)),
                                op: BinaryOp::Eq,
                                right: Box::new(Expression::IntLiteral(3)),
                            },
                            then_body: vec![Statement::Assignment {
                                target: Expression::Variable("flag".into(), None),
                                value: Expression::BoolLiteral(false),
                                span: None,
                            }],
                            elsif_branches: vec![],
                            else_body: None,
                            span: None,
                        },
                    ],
                    span: None,
                },
            ],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // After loop: i = 3, flag = false.
        assert_eq!(vm.locals()[0], StValue::Int(3));
        assert_eq!(vm.locals()[1], StValue::Bool(false));
    }

    #[test]
    fn run_compiled_repeat_loop_runs_at_least_once() {
        // REPEAT i := 42; UNTIL TRUE END_REPEAT
        // Even though UNTIL is true on first check,
        // REPEAT executes body at least once.
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "i".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Repeat {
                body: vec![Statement::Assignment {
                    target: Expression::Variable("i".into(), None),
                    value: Expression::IntLiteral(42),
                    span: None,
                }],
                condition: Expression::BoolLiteral(true),
                span: None,
            }],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        assert_eq!(vm.locals()[0], StValue::Int(42));
    }

    #[test]
    fn run_compiled_program_assignment_roundtrip() {
        use super::super::bytecode_compiler::compile_program;
        use crate::st_validator::{
            DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        // x: INT; x := 5 + 3;
        let prog = Program {
            name: "p".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: false,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "x".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("x".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::IntLiteral(5)),
                    op: crate::st_validator::BinaryOp::Add,
                    right: Box::new(Expression::IntLiteral(3)),
                },
                span: None,
            }],
            span: None,
        };
        let bc_compiled = compile_program(&prog, &[], "p".into(), 1_000).expect("compile");
        let mut vm = ScriptVm::new(&bc_compiled);
        assert_eq!(vm.run(&bc_compiled), VmOutcome::Returned);
        // local[0] = x = 8
        assert_eq!(vm.locals()[0], StValue::Int(8));
    }
}
