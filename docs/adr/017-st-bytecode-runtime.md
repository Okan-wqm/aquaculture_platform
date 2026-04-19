# ADR-017: ST Execution Runtime — Bytecode Compiler + Stack VM with Gas Metering

**Status:** Proposed (opened 2026-04-19; revised post-audit 2026-04-19; target Accepted 2026-05-03 after ADR-021 (DEC-008) reaches Proposed minimum)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + edge-expert + edge-industrial-auditor + security-auditor
**Owner:** Okan (until edge-lead hire; PROC-001 tracks the TBD sweep)
**Deadline:** 2026-05-03 for ADR→Accepted (blocked on ADR-021)
**Related findings:** DEC-001 RESOLVED (bu ADR), ARC-005 (st_validator AST exists without runtime), DEC-008 (ADR-021 key ceremony), DEC-017 (ADR-023 SL-3 upgrade path)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §5 Faz 3, §3 R-1; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.1 D-1 revision
**Supersedes:** Plan A'nın AST walker interpreter kararı (pure-tickling-crescent.md §5.1)

---

## Context (WHY)

### Problem
SaaS tenant UI'da yazılan IEC 61131-3 Structured Text (ST) programları edge agent'a imzalı olarak deploy edilip deterministik scan cycle'larda çalıştırılmalı — CODESYS/TwinCAT alternatifi. Mevcut durum:

- `sens-api-gateway/src/st_validator.rs` (3551 satır) — lexer + parser + AST + type checker **mevcut, çalışır**
- Ama hiçbir runtime yok — AST oluşturuluyor ama execute eden bileşen sıfır
- `src/deploy_orchestrator.rs` Yol A (RustEngine) sadece önceden JSON'a çevrilmiş scriptleri kabul ediyor

### Seçim matrisi

**Alt-1 AST walker (reddedildi):** recursive visitor, gas metering belirsiz, tamper surface, RBAC bypass riski. Tokio async'te 10ms altına inemez.

**Alt-2 WASM (bu sürümde reddedildi):** `wasmi` 2025 baseline ARM'da ~1-3 MB (önceki rakam güncellendi) ama supply-chain review scope iki katına çıkar, debug source-map ST→WASM→Stack trace kompleks. **Yeniden değerlendirme tetikleyicisi:** ADR-023 SL-3 upgrade path (Faz 11) VE fleet 500+ cihaz ölçeklenir — ikisi birden gerçekleşirse Faz 10'da karar yenilenir.

**Alt-3 LLVM IR + JIT (reddedildi):** aşırı mühendislik, JIT compile time unpredictable, binary +10 MB.

### 3-bağımsız-agent validasyonu + post-audit düzeltmeleri

Plan B V1→V2 sırasında 3 agent AST walker'ı reddetti; bu ADR'ın ilk taslağı 3 agent tarafından tekrar audit edildi, 3 CRITICAL + 5 HIGH + 5 MEDIUM bulgusu **bu revizyonda kapatıldı** (section 6'da kapama eşleştirmesi).

---

## Decision (WHAT)

**ST → Bytecode → Stack VM with gas metering + RBAC-gated writer + immutable signed artifact + lifecycle management.**

### 1. Compilation pipeline

```
ST Source (.st)
  ↓ st_validator.rs (MEVCUT, 3551 satır — DEĞİŞMEZ, additive API genişletme)
AST + TypeCheck (Statement + Expression variants — §2 opcode tablosu complete mapping)
  ↓ st_compiler.rs (YENİ, ~1500-2000 satır, Faz 3)
Closed Opcode Set (IEC 61131-3 ST subset — §2'de listelenir, genişletme ADR amendment gerektirir)
  ↓ Platform-side sign (ed25519, program_signing_key — DEC-008'de tanımlanacak 4. HSM slot)
Signed .stbc Artifact (immutable; verify-once-execute-many)
  ↓ MQTT deploy_program {format: "stbc", ...} (Permission::DeployProgram + two-person integrity)
Edge verify + load (ed25519 verify, policy_version + tenant_id match, size bound check BEFORE deserialize)
  ↓ Scheduler handoff (TickScope pattern — §3)
Stack VM execute (gas-metered, watchdog-bounded, panic-safe via catch_unwind)
  ↓ scripting/function_blocks/* via FunctionBlockVm trait (YENİ, §5)
SR/RS/TON/TOF/PID primitives (reuse via typed bridge, not JSON-Value)
```

### 2. Closed Opcode Set — tam mapping tablosu (AUDIT-001 kapama)

Opcode set IEC 61131-3 ST subset altında **KAPALIDIR**. Genişletme ADR amendment + invariant test `tests/invariants/st_opcode_set_closed.rs` güncellemesi + `version: u16` header bump gerektirir.

#### Statement → Opcode mapping (st_validator.rs:388-446 her variant kapsanır)

| Statement variant | Lowered opcodes |
|---|---|
| `Assignment { target, value }` | Evaluate `value` → `StoreLocal(id)` veya `WriteTag(id)` veya `ArrayIndexStore` veya `MemberStore` (target shape'e göre) |
| `If { condition, then, elsif[], else }` | `<cond>` → `JumpIfFalse(L_elsif_or_else)` → `<then>` → `Jump(L_end)` → L_elsif: recursive → L_end |
| `Case { expr, branches[], else }` | `<expr>` → `StoreLocal(tmp)` → per branch: `LoadLocal(tmp)` + `PushConst(val)` + `EqInt/Real` + `JumpIfFalse(next)` + `<body>` + `Jump(L_end)` |
| `For { var, from, to, by, body }` | init: eval `from` → `StoreLocal(var)`; test: `LoadLocal(var)` + `LoadLocal(to_bound)` + `LeInt/GeInt` + `JumpIfFalse(L_end)`; body: `<body>` + `GasTick`; step: `LoadLocal(var)` + eval `by` (default 1) + `AddInt` + `StoreLocal(var)` + `Jump(L_test)` |
| `While { cond, body }` | L_test: `<cond>` + `JumpIfFalse(L_end)` + `<body>` + `GasTick` + `Jump(L_test)` + L_end |
| `Repeat { body, cond }` | L_start: `<body>` + `GasTick` + `<cond>` + `JumpIfFalse(L_start)` |
| `FunctionBlockCall { fb_name, assignments }` | For each (input, expr): eval `<expr>` + `FbSetInput(instance_id, input_slot)`; then `FbInvoke { instance_id }` |
| `FunctionCall { name, args }` | For each arg: eval; then `StdlibCall(FnId)` (compile-time resolved) OR `Call { fn_id, arg_count, ret_count }` (user-defined FUNCTION) |
| `Return { value: Some(e) }` | eval `<e>` + `ReturnValue` |
| `Return { value: None }` | `ReturnVoid` |
| `Exit` | `Jump(L_enclosing_loop_end)` — compiler-resolved offset |
| `Continue` | `Jump(L_enclosing_loop_test)` — compiler-resolved offset |
| `Empty` | no-op (compile drops) |

#### Expression → Opcode mapping (st_validator.rs:450-479 her variant kapsanır)

| Expression variant | Lowered opcodes |
|---|---|
| `IntLiteral(i64)` | `PushIntConst(ConstId)` — i64 constant pool |
| `RealLiteral(f64)` | `PushRealConst(ConstId)` — f64 constant pool |
| `StringLiteral(String)` | `PushStringConst(ConstId)` — interned string pool (`max_len 1024` bytes) |
| `BoolLiteral(bool)` | `PushBoolConst(bool)` — 1-byte opcode |
| `TimeLiteral(String)` | compile-time parse → `PushIntConst` (ms as i64) |
| `Variable(name, _)` | `LoadLocal(id)` veya `LoadGlobal(id)` veya `LoadRetain(id)` veya `LoadTag(id)` (symbol table'dan resolve) |
| `ArrayAccess { array, index }` | eval `array` base addr + eval `index` + `ArrayIndexLoad` (runtime bounds check → `SafeState::trip()` on OOB) |
| `MemberAccess { object, member }` | eval `object` (FB handle) + `FbGetOutput(instance_id, output_slot)` (compile-time resolved) |
| `UnaryOp { Neg, expr }` | eval + `NegInt` veya `NegReal` (tip-spesifik) |
| `UnaryOp { Not, expr }` | eval + `Not` |
| `BinaryOp { Add/Sub/Mul/Div/Mod/Power/Eq/Neq/Lt/Gt/Le/Ge/And/Or/Xor }` | eval left, right + tip-spesifik opcode (`AddInt` vs `AddReal` vb.) |
| `FunctionCall { name, args }` | (Statement variant ile aynı) |
| `Parenthesized(expr)` | no-op (compile drops — sadece precedence hint) |

#### Full opcode enum

```rust
// INVARIANT: Opcode set closed under IEC 61131-3 ST subset.
//            Extension requires ADR-017 amendment + tests/invariants/st_opcode_set_closed.rs update.
// WHY: Flat u8-discriminated match → O(1) dispatch; bytecode portable across host arch.
// WHAT: Stack-based IR; every opcode has deterministic gas cost; no hidden allocation.
#[repr(u8)]
pub enum Opcode {
    // ── Stack management (gas: 1) ──
    PushIntConst(ConstId),   PushRealConst(ConstId),
    PushStringConst(ConstId), PushBoolConst(bool),
    Pop, Dup, Swap,

    // ── Arithmetic (gas: 1; DivInt/DivReal/ModInt runtime div-by-zero → SafeState::trip) ──
    AddInt, AddReal, SubInt, SubReal, MulInt, MulReal,
    DivInt, DivReal, ModInt, PowReal, NegInt, NegReal,

    // ── Comparison (gas: 1) ──
    EqInt, EqReal, EqBool, NeqInt, NeqReal, NeqBool,
    LtInt, LtReal, GtInt, GtReal, LeInt, LeReal, GeInt, GeReal,

    // ── Logic (gas: 1) ──
    And, Or, Xor, Not,

    // ── Control flow (gas: 2) ──
    Jump(CodeOffset),        // i32 signed offset from current pc
    JumpIfFalse(CodeOffset),
    Halt,                    // INVARIANT: emitted as final opcode by compiler; pc-overflow = compiler bug

    // ── Call frames (gas: 5 for Call, 2 for Return*) ──
    EnterFrame(u16),         // reserves N locals on locals-stack
    LeaveFrame,
    LoadArg(u8), StoreArg(u8),
    Call { fn_id: FnId, arg_count: u8, ret_count: u8 },
    ReturnValue, ReturnVoid,

    // ── Memory — local/global/retain/tag (gas: 2, WriteTag 5) ──
    LoadLocal(LocalId),  StoreLocal(LocalId),
    LoadGlobal(GlobalId), StoreGlobal(GlobalId),
    LoadRetain(RetainId), StoreRetain(RetainId),
    LoadTag(TagId),      // ProcessImage::get_tag — read-only path
    WriteTag(TagId),     // INVARIANT: compiled ONLY for tags in header.allowed_write_tags;
                         //            dispatched exclusively to RbacGatedWriter::write (§4)

    // ── Composite access (gas: 3, bounds-check on ArrayIndex*) ──
    ArrayIndexLoad,  ArrayIndexStore,  // runtime OOB → SafeState::trip
    // (MemberLoad/Store handled via FbGetOutput/FbSetInput below — explicit FB boundary)

    // ── Function Block bridge (gas: FbInvoke 10, Get/Set 3) ──
    FbSetInput  { instance_id: FbInstanceId, input_slot: u8 },
    FbGetOutput { instance_id: FbInstanceId, output_slot: u8 },
    FbInvoke    { instance_id: FbInstanceId },

    // ── Stdlib — compile-time resolved FnId → dispatch table (gas: per-fn 5-20) ──
    StdlibCall(StdlibFnId),

    // ── Safety (gas: GasTick 1, SafeStateTrip 0) ──
    GasTick,           // MANDATORY inside every loop body (compiler-enforced); bounds termination
    SafeStateTrip,     // explicit trigger; returns VmError::SafeStateTripped

    // ── Debug (gas: 1 — NOT zero; prevents tight-breakpoint DoS per audit CRITICAL-006) ──
    Breakpoint(BpId),  // Permission::DebugStep gated at dispatch; BpId into debug_meta table
}
```

### 3. Scheduler handoff + lock discipline (AUDIT-CRITICAL-002 kapama)

ADR önceki sürümünde `RbacGatedWriter` `std::sync::RwLock::write().map_err(PoisonError)` örneği verdi — `process_image.rs:149` `tokio::sync::RwLock` kullandığı için derlenmez. Post-audit karar: **Option A — Scheduler holds write-lock for tick duration**.

```rust
// WHY: ST VM synchronous dispatch loop (gas-metered, zero-await) + tokio::sync::RwLock
//      async API = uyumsuz. Option A: scheduler tick öncesi write-lock alır, tick bitince bırakır.
//      Tick içinde ProcessImage mutations sync; inter-tick scheduler yield noktası.
// WHAT: TickScope<'a> newtype, ProcessImage::take_tick_scope() ile tek yerden üretilir.
//        VM sadece TickScope<'a> alır; bypass imkansız (pub(in crate::scripting::vm)).
pub struct TickScope<'a> {
    // INVARIANT: `'a` lifetime = 1 tick süresi; drop'ta write-guard release edilir.
    image_guard: tokio::sync::RwLockWriteGuard<'a, ProcessImageInner>,
    // INVARIANT: bu struct dışarıya leak etmez; RbacGatedWriter sadece bu struct'tan construct edilir.
    allowed_tags: &'a [TagId],
    safe_state_pinned: &'a [TagId],
}

impl ProcessImage {
    // WHY: tokio::sync::RwLock::write_owned() yerine borrow-based; tick sonunda Drop rilis.
    // WHAT: Scheduler task başına (multi-task Faz 4'te) ayrı TickScope; task starvation
    //        Faz 4 scheduler SLO-tier fairness tarafından yönetilir.
    pub async fn take_tick_scope<'a>(
        &'a self,
        allowed: &'a [TagId],
        pinned: &'a [TagId],
    ) -> TickScope<'a> {
        TickScope {
            image_guard: self.inner.write().await,
            allowed_tags: allowed,
            safe_state_pinned: pinned,
        }
    }
}

impl<'a> TickScope<'a> {
    // WHY: VM sadece bu yoldan writer alır; RbacGatedWriter constructor `pub(super)` — sınır dışı erişim yok.
    pub(in crate::scripting::vm) fn writer(&mut self, ctx: &'a AuthorizedContext) -> RbacGatedWriter<'_, 'a> {
        RbacGatedWriter::new(ctx, &mut self.image_guard, self.allowed_tags, self.safe_state_pinned)
    }
}

// Scheduler tick loop (Faz 4 multi-task scheduler'da):
// for task in scheduler.ready_tasks() {
//     let mut scope = process_image.take_tick_scope(&task.allowed, &task.pinned).await;
//     let outcome = tokio::task::spawn_blocking(move || {  // sync VM in blocking pool
//         match std::panic::catch_unwind(AssertUnwindSafe(|| {
//             st_vm.execute_tick(&task.program, &mut scope, &task.ctx, task.watchdog_deadline)
//         })) {
//             Ok(result) => result,
//             Err(_panic) => Err(VmError::Panicked),
//         }
//     }).await.expect("spawn_blocking join");
//     // scope dropped here → write-guard released
//     if outcome.is_err() { safe_state_manager.apply().await; }
// }
```

Acceptance test: `tests/invariants/st_vm_never_unwinds.rs` panicking opcode-path'i fuzz eder, scheduler-level `catch_unwind` fires + safe-state apply watchdog bütçesi içinde tamamlanır.

### 4. RbacGatedWriter — module-boundary INVARIANT

```rust
// INVARIANT (AUDIT-001 kapaması — explicit module boundary spec):
//   ProcessImageInner::update is pub(in crate::process_image);
//   exposed only to RbacGatedWriter via &mut TickScope granted by scheduler.
//   tests/invariants/process_image_inner_visibility.rs: compile-time grep invariant;
//   any other module importing ProcessImageInner or calling ::update directly → CI fail.
// WHY: Tier-1 make-it-impossible ONLY if module-visibility discipline is codified.
//      CODEOWNERS: crate::authz/**, crate::scripting/vm/**, crate::process_image/** —
//      any PR touching these requires security-auditor review (.github/CODEOWNERS line).
// WHAT: WriteTag opcode → ONLY path → RbacGatedWriter::write → 3 invariant checks → persist.
pub struct RbacGatedWriter<'scope, 'ctx> {
    // Constructor `pub(super)` — scope crate::scripting::vm::tick_scope (2-file module).
    ctx: &'ctx AuthorizedContext,
    image: &'scope mut ProcessImageInner,
    allowed: &'scope [TagId],
    pinned: &'scope [TagId],
}

impl<'s, 'c> RbacGatedWriter<'s, 'c> {
    pub(in crate::scripting::vm::tick_scope) fn new(
        ctx: &'c AuthorizedContext,
        image: &'s mut ProcessImageInner,
        allowed: &'s [TagId],
        pinned: &'s [TagId],
    ) -> Self { Self { ctx, image, allowed, pinned } }

    pub fn write(&mut self, tag: TagId, value: TagValue) -> Result<(), WriteError> {
        // INVARIANT 1: declared allowlist (bytecode header signed)
        if !self.allowed.contains(&tag) { return Err(WriteError::NotInAllowlist(tag)); }

        // INVARIANT 2: runtime permission (AuthorizedContext from ADR-018)
        if !self.ctx.has(Permission::WriteTag { tag_id: tag }) {
            return Err(WriteError::PermissionDenied(tag));
        }

        // INVARIANT 3: safe-state pinned tag immutable
        if self.pinned.contains(&tag) { return Err(WriteError::SafeStatePinned(tag)); }

        // Tier-1 kapısı geçti → sync mutate via write-guarded reference (no async here)
        self.image.update_sync(tag, value, TagSource::StVm)
            .map_err(WriteError::Storage)?;
        Ok(())
    }
}
```

### 5. FunctionBlockVm trait — typed bridge (AUDIT-HIGH-013 kapama)

Mevcut `FunctionBlock` trait `serde_json::Value` + string-name I/O — JSON scripts için legit kalır, ama VM bytecode bridge'i için yeni trait:

```rust
// WHY: VM stack → JSON Value dönüşümü allocation + type-erasure; VM deterministik iddiası bozulur.
// WHAT: FunctionBlockVm trait index-based + tip-güvenli I/O; mevcut FB'ler port edilir Faz 3.
// INVARIANT: Compile-time FbInvoke opcode yalnız FunctionBlockVm-implementing FB'lere karşı emit edilebilir.
pub trait FunctionBlockVm: Send {
    fn input_count(&self) -> u8;
    fn output_count(&self) -> u8;
    fn set_input(&mut self, slot: u8, value: StackValue) -> Result<(), FbError>;
    fn get_output(&self, slot: u8) -> Result<StackValue, FbError>;
    fn execute(&mut self, ctx: &FbExecCtx) -> Result<(), FbError>;
    fn serialize_state(&self) -> Result<Vec<u8>, FbError>;
    fn deserialize_state(&mut self, bytes: &[u8]) -> Result<(), FbError>;
}

// Faz 3 Sprint 11.2 acceptance:
//   - TON, TOF, TP, CTU, CTD, SR, RS, PID implement FunctionBlockVm
//   - Legacy FunctionBlock JSON trait kalır (backward compat — JSON scripts path)
//   - tests/fb_vm_parity_test.rs — VM path + JSON path aynı girdi için aynı state yield eder
```

### 6. Bytecode artifact format — signed + size-bounded (AUDIT-HIGH-011 kapama)

```rust
// WHY: Attacker with signing key compromise signing 200 MB bytecode OOMs RPi 4 before
//      gas metering engages. Fix: size bounds in signed header, verified BEFORE deserialize.
// WHAT: Header fields signed; pre-deserialize edge enforces EDGE_HARD_MAX_* constants.
#[derive(Serialize, Deserialize)]
pub struct StBytecodeHeader {
    pub magic: [u8; 4],               // "STBC"
    pub format_version: u16,          // STRATEGY A: edge accepts CURRENT || CURRENT-1 only
    pub program_id: [u8; 32],         // SHA-256 of source
    pub program_name: String,         // MAX 128 bytes ASCII (pre-deserialize check)
    pub tenant_id: [u8; 16],          // UUID bytes (network order); ADR-018 tenant binding
    pub policy_version: u64,          // monotonic — downgrade reject
    pub compile_timestamp_unix_ms: i64,  // unix milliseconds (signed for monotonic diff math)

    // Resource bounds — SIGNED + enforced pre-deserialize
    pub max_gas_per_tick: u32,        // CPU bound per tick
    pub max_opcodes: u32,             // EDGE_HARD_MAX_OPCODES = 100_000
    pub max_stack_depth: u16,         // compiler static-analysis result
    pub max_retain_bytes: u32,        // EDGE_HARD_MAX_RETAIN_BYTES = 64KB
    pub max_string_pool_bytes: u32,   // EDGE_HARD_MAX_STRINGS = 16KB
    pub total_bytecode_bytes: u32,    // EDGE_HARD_MAX_BYTECODE_BYTES = 256KB

    // Safety bounds — SIGNED; VM runtime-enforced
    pub allowed_write_tags: Vec<TagId>,   // INVARIANT: WriteTag opcode bu liste dışına emit edilemez
    pub safe_state_pinned_tags: Vec<TagId>, // INVARIANT: pinned tag'e WriteTag → runtime reject

    // Variable tables
    pub int_constants: Vec<i64>,
    pub real_constants: Vec<f64>,
    pub string_constants: Vec<String>,
    pub retain_vars: Vec<(String, DataType)>,
    pub fb_instances: Vec<(FbInstanceId, FbType, FbInitConfig)>,

    // Priority (AUDIT-LOW-015 — conflict detector integration)
    pub priority: ScriptPriority,     // Normal default; bytecode declares higher explicitly
}

#[derive(Serialize, Deserialize)]
pub struct StBytecode {
    pub header: StBytecodeHeader,
    pub opcodes: Vec<Opcode>,                       // Length verified against header.max_opcodes
    pub debug_meta: Option<DebugMetadata>,          // BpId → source span mapping (optional)
    pub signature: [u8; 64],                        // ed25519 over (bincode(header) || bincode(opcodes) || bincode(debug_meta))
}

// Verify pipeline (edge):
// 1. Read header only (fixed-size prefix) — refuse if header.total_bytecode_bytes > EDGE_HARD_MAX_BYTECODE_BYTES
// 2. Refuse if format_version not in [CURRENT, CURRENT-1]
// 3. Refuse if tenant_id != signature-bound config.tenant_id (ADR-018 FINDING-001 via ADR-019 sealed binding)
// 4. Refuse if policy_version <= persisted highest_seen_version (ADR-018 monotonic storage)
// 5. ed25519 verify over full serialized form (program_signing_key — DEC-008 to define 4th HSM slot)
// 6. Deserialize opcodes (Vec<Opcode>); refuse if len > header.max_opcodes
// 7. Compiler invariants spot-check: every loop body contains GasTick; every WriteTag target in allowed_write_tags
// 8. Store bytecode + register with scheduler
```

### 7. TickOutcome semantics (AUDIT-HIGH-006 kapama)

```rust
// WHY: Önceki taslak "GasExhausted" ile "clean end" ayrımı yapmıyordu → scheduler'da doğru
//      davranış seçilemez; debug 0-gas DoS açığı.
// WHAT: Explicit discriminator + Breakpoint gas=1 (zero-gas opcode yasak).
pub enum TickOutcome {
    /// Program reached `Halt` opcode (compiler-emitted terminator); normal completion.
    /// Scheduler advances to next scheduled tick at `period_ms` interval.
    Completed,

    /// Gas exhausted mid-flow; program state saved (locals + pc).
    /// Scheduler re-enters at saved pc next tick (non-yielding programs prohibited: GasTick
    /// opcode in every loop body bounds re-entry; max resumption chain = max_gas_per_tick).
    /// If chain exceeds tick-budget-grace (default 3 ticks), SafeState::trip().
    GasExhausted { saved_pc: usize, locals_snapshot: LocalsSnapshot },

    /// Explicit yield (Breakpoint hit + DebugStep mode); awaits platform step command.
    Yielded { saved_pc: usize, reason: YieldReason },

    /// Explicit safe-state trigger from program (rare; operator-authored fault response).
    SafeStateTripped,
}

// Gas ordering (deduct BEFORE dispatch):
//   gas_remaining = gas_remaining.saturating_sub(op.gas_cost());
//   if gas_remaining == 0 && !op.is_terminal() { return Ok(GasExhausted { ... }); }
//   dispatch(op);  // single opcode may legitimately consume last unit
//   pc = next_pc;
//
// Terminal opcodes (Halt, ReturnVoid, ReturnValue, SafeStateTrip) — always dispatch even if gas==0.
```

### 8. Retain variable storage — schema extension (AUDIT-HIGH-004 kapama)

`scripting/persistence.rs` mevcut şema: `retain_variables(script_id TEXT, var_name TEXT, var_value TEXT, UNIQUE(script_id, var_name))`.

**Migration (Faz 3 Sprint 12.1):**

```sql
-- WHY: JSON scripts "{script_uuid}:{var_name}" vs ST bytecode "{prog_sha256}:{var_name}"
--      script_id kolonunda çakışabilir (statistical + adversarial program_name collision riski).
-- WHAT: program_kind kolonu + UNIQUE indexe dahil; tier-1 tip ayrımı.
ALTER TABLE retain_variables
  ADD COLUMN program_kind TEXT NOT NULL DEFAULT 'json_script'
  CHECK(program_kind IN ('json_script', 'st_bytecode'));

-- Mevcut UNIQUE constraint replace (migration):
DROP INDEX idx_retain_unique;
CREATE UNIQUE INDEX idx_retain_unique
  ON retain_variables(program_kind, script_id, var_name);
```

**Runtime discipline:**
- `persistence.rs` API'si `fn save(program_kind, script_id, var_name, value)` — mevcut kullanıcılar `program_kind = 'json_script'` default parametreyle devam eder (backward compat; additive)
- ST bytecode path `program_kind = 'st_bytecode'`, `script_id = hex(program_id)` kullanır
- Invariant: `tests/invariants/retain_namespace_disjoint.rs` — JSON script UUID'si hex-encoded SHA-256 ile uzunluk farkı var (36 vs 64 char); kolonda çakışma yapısal olarak imkansız
- Undeploy path (§10) `program_kind + script_id` ile `clear_script` çağırır; cross-kind kapsamlı silme yasak

### 9. JSON coexistence — format discriminator (AUDIT-HIGH-005 kapama)

`deploy_program` MQTT wire protocol:

```json
{
  "program_id": "uuid",
  "format": "json" | "stbc",
  "payload": { ... }   // JSON → ProgramDefinition; stbc → base64(StBytecode)
}
```

**cmd_deploy_program dispatch:**

```rust
// WHY: Big-bang cutover HC-1 backward compat kırar; per-format branch + deprecation window.
// WHAT: format alanı zorunlu; discriminator'a göre ayrı handler; ProgramState ProgramKind enum taşır.
match msg.format {
    Format::Json => {
        let prog_def: ProgramDefinition = serde_json::from_value(msg.payload)?;
        deploy_json_program(prog_def, ctx).await?  // existing path; unchanged
    }
    Format::Stbc => {
        let bytecode_bytes = base64::decode(&msg.payload_b64)?;
        // pre-deserialize size check
        if bytecode_bytes.len() > EDGE_HARD_MAX_BYTECODE_BYTES { return Err(DeployError::TooLarge); }
        let bytecode = deserialize_and_verify(&bytecode_bytes, &ctx.tenant_id, &highest_seen_version)?;
        deploy_st_bytecode(bytecode, ctx).await?  // new path
    }
}

// ProgramState (state file):
// {
//   "current": { "kind": "json_script" | "st_bytecode", "program": <data> },
//   "previous": { ... } | null,   // rollback target
//   "policy_version_at_deploy": u64
// }
```

**Deprecation horizon (tracked, not silent):**
- Faz 5 JSON runtime freeze date: `2026-07-15` (tracked as DEC-018 in finding board)
- Faz 10 JSON runtime removal evaluation: `2026-09-30`
- Silent removal yasak — DEC-018 state machine `OPEN → IN-PROGRESS → RESOLVED`

### 10. Program lifecycle — deploy/rollback/undeploy (AUDIT-HIGH-008 kapama)

```
┌─────────┐  deploy  ┌─────────┐  activate  ┌─────────┐
│ Absent  ├─────────►│ Staged  ├───────────►│ Active  │
└─────────┘          └─────────┘            └──┬───┬──┘
                          ▲                    │   │
                          │     rollback        │   │ undeploy (explicit)
                          └─────────────────────┘   │
                                                    ▼
                                              ┌──────────────┐
                                              │ Tombstoned   │
                                              │ (retain      │
                                              │  cleared;    │
                                              │  row kept 30d│
                                              │  for audit)  │
                                              └──────────────┘

INVARIANTS:
  - Deploy with new prog_id while old prog_id Active → REFUSE (must undeploy first)
  - Operator override `force_replace: true` → explicit audit event + two-person integrity gate
  - Undeploy → atomic SQLCipher transaction: tombstone program_state row + clear_script(prog_kind, prog_id)
  - Rollback → if previous.program_id == current.program_id same rev, swap retain to saved snapshot
            → if previous.program_id != current.program_id, REFUSE rollback (use deploy previous explicitly)
  - Retain-var leak impossible: invariant test tests/invariants/retain_var_no_orphans.rs
```

New MQTT commands (Permission::DeployProgram + two-person):
- `deploy_program { format, payload, force_replace: bool }`
- `rollback_program { program_id }`
- `undeploy_program { program_id, reason: String }` — new; currently absent

### 11. Versioning strategy — STRATEGY A (AUDIT-HIGH-007 kapama)

**Decision: No in-place upcasting.** Bytecode is immutable signed artifact; upgrade path = platform recompiles source + re-signs + redeploys.

```
format_version bump triggers:
  1. Platform signing pipeline compiles to new format_version
  2. Old edges (running CURRENT_VERSION - 1) still accept new bytecode IFF format_version ∈ {CURRENT, CURRENT-1}
  3. Fleet rolls over 1 format version per edge release; max 2-version-window
  4. Silent bumps BANNED — amendment + DEC-XXX finding ID + deadline required
```

**Why not Strategy B (in-place upcaster):** Upcaster itself would need signing = 6th key in ceremony; blast radius expands; ADR-018 3-key segregation tartışılır. Strategy A keeps trust root tight.

**Source retention:** Platform stores ST source + compile metadata per program_id; re-compile deterministic via signed toolchain (`SOURCE_DATE_EPOCH` + cargo-auditable baseline — Plan §4.4).

### 12. Key ceremony dependency — ADR-021 (DEC-008)

Bytecode signing uses a **4th ed25519 keypair** `program_signing_key`, distinct from firmware/rbac_manifest/command/emergency keys. **ADR-017 cannot move to `Accepted` until ADR-021 (DEC-008) reaches `Proposed` minimum** with:
- `program_signing_key` HSM slot allocated
- Rotation policy (180-day)
- Rescue path (compromise response)
- Revocation propagation window (target <30 min)

This is tracked: DEC-008 Faz 0 deadline 2026-05-03.

### 13. Debug mode + DoS closure (AUDIT-CRITICAL-006 kapama)

- `Breakpoint(BpId)` **gas cost 1** (not 0) — tight breakpoint loop bounded like any opcode
- Debug-mode watchdog extension: scheduler sets `watchdog_deadline = now + 30s` during single-step; **not** gas-zero'ing
- `Permission::DebugStep` REQUIRED to dispatch `Breakpoint` opcode; unauthorized → skip (opcode no-op) + audit

---

## Consequences

### Positive
- **Determinizm:** tick başına kesin opcode sayısı; `max_gas_per_tick` deploy-time signed
- **RBAC bypass impossibility:** `WriteTag` → `RbacGatedWriter::write` + module-boundary invariant test — tier-1 + tier-3 hybrid, module-visibility codified
- **Resource bounds:** `max_opcodes / max_bytecode_size / max_retain_bytes / max_stack_depth` signed + pre-deserialize enforced
- **Immutable artifact:** STRATEGY A upcaster-free; blast radius 1 key (program_signing) not compounding
- **Safety invariants:** allowed_write_tags + safe_state_pinned bytecode header'da; VM reject bypass edilemez
- **Panic-safe:** `catch_unwind` + scheduler safe-state trip; `tests/invariants/st_vm_never_unwinds.rs`
- **Lifecycle complete:** deploy/rollback/undeploy + retain cleanup invariant

### Negative
- **Implementation kod:** `st_compiler.rs` ~1500-2000 satır (opcode set complete mapping); `st_vm.rs` ~1000-1500 satır (dispatch + stack + frame + panic hook)
- **Migration yükü:** SQLite `program_kind` kolon migration + `deploy_program` format discriminator + legacy JSON path paralel bakım Faz 5'e kadar
- **FB bridge fork:** `FunctionBlockVm` trait yeni; mevcut 8 FB (TON/TOF/TP/CTU/CTD/SR/RS/PID) port edilir

### Blocks / dependencies
- **ADR-017 → Accepted** requires: ADR-021 (DEC-008) at ≥ Proposed; ADR-018 at Accepted (tenant_id trust root); ADR-019 (DEC-002) at ≥ Proposed (sealed tenant binding)
- **Faz 3 start** requires: ADR-017 Accepted

---

## 6. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-017-FINDING-001 | CRITICAL | §2 closed opcode set | Every Statement/Expression variant mapped; "genişler" prose removed |
| ADR-017-FINDING-002 | CRITICAL | §3 TickScope pattern | tokio::sync::RwLock + sync VM reconciled via write-guarded scope |
| ADR-017-FINDING-003 | CRITICAL | §12 ADR-021 dep | Explicit blocker; DEC-008 annotation on every forward ref |
| ADR-017-FINDING-004 | HIGH | §8 retain schema | `program_kind` column + invariant test |
| ADR-017-FINDING-005 | HIGH | §9 JSON coexistence | `format` discriminator + DEC-018 deprecation horizon |
| ADR-017-FINDING-006 | HIGH | §7 TickOutcome + §13 debug gas=1 | Terminal opcodes dispatch at gas=0; Breakpoint non-zero gas |
| ADR-017-FINDING-007 | HIGH | §11 Strategy A | In-place upcaster rejected; platform recompile + 2-version window |
| ADR-017-FINDING-008 | HIGH | §10 lifecycle | Tombstone + retain clear; undeploy_program command; invariant test |
| ADR-017-FINDING-009 | MEDIUM | Owner: Okan | PROC-001 tracks fleet TBD sweep; opcode-set header retitled; Option<_> patch hint replaced by FunctionBlockVm separate trait |
| ADR-017-FINDING-010 | MEDIUM | Alt-2 rewrite | WASM rejection reason rewritten: supply-chain scope + debug story + maturity; ADR-023 trigger named |
| ADR-017-FINDING-011 | MEDIUM | §6 header bounds | max_opcodes/max_bytecode/max_retain signed + pre-deserialize edge constants |
| ADR-017-FINDING-012 | MEDIUM | §3 catch_unwind | `spawn_blocking` + `AssertUnwindSafe` + scheduler safe-state apply |
| ADR-017-FINDING-013 | MEDIUM | §5 FunctionBlockVm | New trait; legacy JSON FB trait kalır; parity test acceptance |
| ADR-017-FINDING-014 | LOW | §6 program_name 128 bytes | Validated at deserialize |
| ADR-017-FINDING-015 | LOW | §6 priority field | Signed header; conflict detector integration |
| ADR-017-FINDING-016 | LOW | §6 timestamp comment | "unix milliseconds since epoch" — RFC 3339 wording dropped |
| ADR-017-FINDING-017 | LOW | §6 tenant_id bytes | Network-byte-order UUID canonicalization spec |
| AUDIT-001 | HIGH | §4 module-boundary | CODEOWNERS line + visibility invariant + grep-compile test |
| AUDIT-006 | LOW | §5 separate trait | "Option<_> mitigate" replaced by FunctionBlockVm separate trait path |
| AUDIT-007 | LOW | §2 header | "closed under IEC 61131-3 ST subset" wording |

---

## 14. Implementation Plan (Plan §5 Faz 3)

**Hafta 10-12** (üç sprint):

1. **Sprint 10.1** — `st_compiler.rs`: Statement/Expression → opcode full mapping (§2); round-trip test (ST → bytecode → execute → reference output)
2. **Sprint 10.2** — `st_vm.rs`: dispatch loop + stack + frame + gas + watchdog; panic-hook + catch_unwind
3. **Sprint 11.1** — SQLite migration `program_kind`; persistence API extension; retain auto-binding
4. **Sprint 11.2** — `FunctionBlockVm` trait + 8 FB port; parity test vs legacy trait
5. **Sprint 12.1** — `deploy_program` format discriminator; JSON path unchanged; undeploy_program command
6. **Sprint 12.2** — Debug support (Breakpoint + DebugStep permission gate + platform step command)
7. **Sprint 12.3** — Invariant tests (4) + Kani harnesses (safe_state_reachable, gas_saturating, rbac_non_bypass) + fuzz 24h clean

**Acceptance criteria (Faz 3 close):**
- `tests/invariants/st_bytecode_gas_budget.rs` green
- `tests/invariants/st_write_tag_allowlist.rs` green
- `tests/invariants/st_safe_state_pinned_immutable.rs` green
- `tests/invariants/st_rbac_gate_mandatory.rs` green (Kani-verified if feasible)
- `tests/invariants/st_opcode_set_closed.rs` green
- `tests/invariants/process_image_inner_visibility.rs` green
- `tests/invariants/retain_var_no_orphans.rs` green
- `tests/invariants/retain_namespace_disjoint.rs` green
- `tests/invariants/st_vm_never_unwinds.rs` green
- `fuzz_st_compiler.rs` + `fuzz_st_parser.rs` 24h clean on RPi 4/5 baseline
- `fish_feeder` canonical 10-cycle execute + retain roundtrip green
- FunctionBlockVm parity test green (8 FB'nin her biri)
- ADR-021 status ≥ Proposed
- Status → Accepted

---

## References

- IEC 61131-3 "Programmable Controllers — Part 3" (2013 ed.)
- CODESYS V3 Runtime Architecture (bytecode + IL execution model baseline)
- Beckhoff TwinCAT Runtime Internals (IR + VM inspiration)
- wasmtime epoch-based interruption (gas metering pattern reference)
- `/var/aqua-saas/sens-api-gateway/src/st_validator.rs` L280-504 (AST — input contract)
- `/var/aqua-saas/sens-api-gateway/src/process_image.rs` L149-223 (tokio RwLock — scope pattern target)
- `/var/aqua-saas/sens-api-gateway/src/scripting/function_blocks/mod.rs` (legacy trait — FunctionBlockVm migration source)
- `/var/aqua-saas/sens-api-gateway/src/scripting/persistence.rs` (retain_variables schema)
- `/var/aqua-saas/sens-api-gateway/src/scripting/conflict.rs` (priority-based write-conflict detector)
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.1 D-1 (Plan B bytecode VM revision)
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-1, §5 Faz 3
- ADR-018 (Edge RBAC ABAC — `AuthorizedContext` consumer)
- ADR-019 (Firmware Signing — sealed tenant binding; DEC-002)
- ADR-021 (Platform Key Ceremony — program_signing_key HSM slot; DEC-008; BLOCKER)
- ADR-023 (SL-3 Upgrade Path — WASM re-evaluation trigger; DEC-017)
