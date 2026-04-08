# Research: IEC 61131-3 Structured Text — Compiler Safety & Program Lifecycle

**Topic:** Safe compilation and runtime execution of IEC 61131-3 Structured Text (ST) programs in a cloud-to-edge automation pipeline.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [IEC 61131-3 — Wikipedia technical reference](https://en.wikipedia.org/wiki/IEC_61131-3)
- [PLCopen — industry association for IEC 61131 technical standards](https://www.plcopen.org/iec-61131-3)
- [OPC Foundation specifications (Part 2 Security)](https://reference.opcfoundation.org/Core/Part2/v105/docs/)
- [KST: Executable Formal Semantics of IEC 61131-3 ST for Verification (research paper)](https://www.researchgate.net/publication/330540744_KST_Executable_Formal_Semantics_of_IEC_61131-3_Structured_Text_for_Verification)
- [Compiler Front-end for IEC 61131-3 v3 Languages (University of Porto repository)](https://repositorio-aberto.up.pt/bitstream/10216/102541/2/179524.pdf)

## Key Findings

1. **IEC 61131-3 is the international standard** for PLC programming languages, defining five languages: Structured Text (ST), Ladder Diagram (LD), Function Block Diagram (FBD), Sequential Function Chart (SFC), and Instruction List (IL). ST is the text-based high-level language most suitable for algorithmic control logic.
2. **Standard program lifecycle** in IEC 61131-3 compliant systems: `draft → review → approved → deployed`. Once deployed, programs are immutable — any change requires a new version in the draft state. This is a hard compliance requirement in safety-critical contexts.
3. **Compiler pipeline** (per academic reference implementations and commercial PLC vendors):
   - Lexer (tokenization)
   - Parser (AST construction from token stream)
   - Semantic analyzer (type checking, variable binding resolution, scope checks)
   - Code generator (target bytecode or native code for PLC runtime)
4. **Function blocks** in IEC 61131-3 include standardized components: PID (proportional-integral-derivative controllers), TON/TOF/TP (timers), CTU/CTD/CTUD (counters), R_TRIG/F_TRIG (edge detectors), SR/RS (set-reset flip-flops). These MUST follow the standard semantics exactly — a non-compliant timer or PID implementation is a safety defect.
5. **RETAIN variables** are persistent across PLC power cycles and MUST be backed by non-volatile storage (SQLite, EEPROM, FRAM). Losing RETAIN state between cycles = data integrity violation, potentially safety-relevant.
6. **Parallel program execution** (multiple ST programs on the same PLC) requires output-conflict detection: two programs writing the same physical output = undefined behavior, potentially unsafe.
7. **Formal verification** of ST programs is "highly recommended" for safety-critical applications per the standard, using tools like the KST formal semantics framework or model checkers that validate program properties against the IEC 61131-3 standard.
8. **Compilation isolation** — running a user-provided ST source through lexer + parser + semantic analyzer in the main event loop of a service = a DoS vector (malformed or adversarial input can cause parser backtracking blowup). Compilation MUST run in a worker thread or process-isolated sandbox with an execution time budget.
9. **Variable binding validation** — every ST variable MUST reference an existing entity (sensor, equipment, unified tag) at deploy time. Dangling references = runtime crash on the PLC = potential life-safety concern in aquaculture control.
10. **Rollback capability** is mandatory for deploy. A failed deployment must revert atomically to the previous known-good program version. Partial deploys = undefined state.

## Security Concerns
- ST compilation in the main thread = HIGH (DoS via adversarial input).
- Missing output conflict detection across parallel ST programs = CRITICAL (undefined hardware behavior).
- Immutable-after-deploy rule not enforced (allowing in-place edits to deployed programs) = CRITICAL compliance violation for safety-critical systems.
- Missing formal verification or at minimum property-based test coverage on PID/timer/counter implementations = HIGH (deviation from standard = safety defect).
- ST source accepted without variable binding validation = HIGH (deployment of a program that will crash at runtime).
- Missing deploy rollback = HIGH (leaves controllers in undefined state on failure).

## Performance Concerns
- Parser backtracking on malformed input = HIGH (DoS if not time-budgeted).
- Compilation on the main process event loop = HIGH (blocks other work during compilation).
- Worker thread pool not tuned to available cores = MEDIUM (either starves compilation or contends with other work).

## Architectural Implications for sensor-expert reviews
- Any ST compilation pipeline running in the main thread of a service (not in a worker thread / worker pool) = HIGH.
- Missing `STWorkerPoolService` or equivalent isolation = HIGH.
- Programs deployed via MQTT without rollback protocol = HIGH.
- Deployed program modification through any endpoint = CRITICAL (immutability violation).
- Variable binding resolution deferred to runtime (not compile time) = HIGH.
- Missing output-conflict detection = CRITICAL on safety-critical control outputs.
- RETAIN variables stored in volatile memory = HIGH (state loss).

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → Automation & IEC 61131-3`:
- Program lifecycle MUST enforce `draft → review → approved → deployed` transitions. Deployed programs are immutable — any change creates a new version and re-enters draft. In-place edit of deployed program = CRITICAL compliance violation.
- ST compilation (lexer/parser/semantic analyzer) MUST run in worker threads via `STWorkerPoolService` with an execution time budget. Main-thread compilation = HIGH (DoS vector).
- Parser MUST bound its recursive depth and backtracking to prevent adversarial input from causing resource exhaustion. Missing bounds = HIGH.
- Variable bindings MUST be resolved at compile time against existing entities; dangling binding at deploy time = HIGH.
- Output conflict detection MUST run across all parallel programs on the same PLC target before deploy. Two programs writing the same output = CRITICAL (undefined, potentially life-safety).
- Deploy protocol MUST support atomic rollback to the previous known-good program version. Partial deploy without rollback = HIGH.
- RETAIN variables MUST be persisted to non-volatile storage (SQLite with IEC 61131-3 RETAIN semantics) and MUST survive PLC restart. Volatile RETAIN = HIGH.
- PID, timer (TON/TOF/TP), counter (CTU/CTD/CTUD), edge-detector (R_TRIG/F_TRIG), and flip-flop (SR/RS) function blocks MUST follow IEC 61131-3 standard semantics exactly. Non-compliant implementation = HIGH (behavioral drift is a safety defect).
