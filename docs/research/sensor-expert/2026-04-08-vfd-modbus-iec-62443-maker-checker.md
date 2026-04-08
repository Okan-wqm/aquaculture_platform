# Research: VFD Parameter Safety — Multi-Brand Modbus + IEC 62443 SL-2 Maker-Checker

**Topic:** Safe parameter change workflows for variable-frequency drives across multiple vendors (Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta, Mitsubishi, Rockwell) under IEC 62443 SL-2 compliance.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [ISA/IEC 62443 Series of Standards (ISA.org overview)](https://www.isa.org/standards-and-publications/isa-standards/isa-iec-62443-series-of-standards)
- [OPC Foundation: IEC 62443-4-2 Mapping Annex A](https://reference.opcfoundation.org/Core/Part2/v105/docs/A)
- [Variable Frequency Drive Basic Safety Guidelines](http://www.variablefrequencydrive.org/vfd-basic-safety-guidelines)
- [Modbus Communication VFD (Universal Robots / Lenze application note)](https://www.universal-robots.com/articles/ur/interface-communication/modbus-communication-variable-frequency-drive-vfd-lenze/)
- [Yaskawa GA500 VFD (SIL3/PLe safety ratings, embedded Modbus)](https://www.amazon.com/Variable-Frequency-Drive-Intuitive-Certifications/dp/B0DYK9W7V6)
- [SmartFan Stratus AC VFD (programmable control modes via Modbus)](https://controlresources.com/variable-frequency-drive-smartfan-stratus-ii/)

## Key Findings

1. **IEC 62443 is the international cybersecurity standard** for industrial automation and control systems (IACS). It defines security levels SL-1 through SL-4; SL-2 requires protection against intentional violation by unauthorized entities with low resources and generic skills — the baseline for most industrial SaaS deployments.
2. **Seven Foundational Requirements (FRs)** in IEC 62443-3-3:
   - FR1: Identification and Authentication Control
   - FR2: Use Control
   - FR3: System Integrity
   - FR4: Data Confidentiality
   - FR5: Restricted Data Flow
   - FR6: Timely Response to Events
   - FR7: Resource Availability
3. **Parameter change control** in VFD systems MUST meet IEC 62443 SL-2 use-control requirements: authenticated operator → documented change request → risk-tier evaluation → dual approval for high-risk changes → scheduled application → audit log. This is the "Maker-Checker" workflow.
4. **Risk tiering** categorizes parameter changes:
   - **LOW** (informational): names, display preferences
   - **MEDIUM** (operational): ramp times, display units, minor tuning
   - **HIGH** (behavioral): acceleration/deceleration curves, PID setpoints, output frequency limits
   - **CRITICAL** (safety): braking parameters, max frequency limit, max current limit, safety input configuration, STO (Safe Torque Off) behavior
   HIGH and CRITICAL changes MUST require a second approver (checker) and MUST NOT be applied without it.
5. **Multi-brand register mapping** — Modbus register addresses differ across vendors. A parameter named "max frequency" lives at:
   - Danfoss FC series: `3-03`
   - ABB ACS880: `30.11`
   - Siemens SINAMICS: `P1082`
   - Schneider Altivar: `HSP`
   - Yaskawa GA500: `E1-04`
   - Mitsubishi FR-A800: `Pr.1`
   - Rockwell PowerFlex 525: `P035`
   **Register mappings are brand-specific and MUST NOT be mixed.** A database column that interleaves Danfoss and ABB registers without a brand discriminator = CRITICAL (parameter writes to wrong register, potential hardware damage or safety event).
6. **Modbus TCP is plaintext by default.** Production deployments MUST use Modbus/TCP over TLS tunnels or a hardened gateway. Direct plaintext Modbus on a routed network = CRITICAL.
7. **Safety-rated VFDs** (SIL3 / PLe per IEC 61508 / ISO 13849) have independent safety paths (e.g., STO). Cybersecurity controls apply to the non-safety path; the safety path MUST NOT be compromised by a malicious or buggy control-path software.
8. **Automation rule triggering** (sensor reading → parameter change) MUST validate the change against the risk tier. An automation rule that can trigger a CRITICAL parameter change without going through Maker-Checker = CRITICAL bypass.
9. **Rollback on failure** — if a parameter write fails (Modbus timeout, invalid value, safety interlock), the system MUST revert to the previous value and log the failure. Partial writes leave the VFD in an undefined state.
10. **Audit trail** for parameter changes MUST include: who requested, who approved, when scheduled, what old value, what new value, which risk tier, actual write timestamp, acknowledgment status.

## Security Concerns
- Plaintext Modbus TCP in production = CRITICAL.
- Missing brand discriminator on VFD register table = CRITICAL (writes to wrong register across brands).
- HIGH or CRITICAL risk-tier changes applied without dual approval = CRITICAL IEC 62443 violation.
- Automation rules bypassing Maker-Checker = CRITICAL.
- Missing audit trail on parameter changes = CRITICAL compliance failure.
- Unauthenticated Modbus device = CRITICAL.
- Missing network segmentation between control network and IT network = HIGH.

## Performance Concerns
- Serial Modbus RTU throughput limits — batch parameter reads rather than per-parameter polls.
- Parameter write timeouts too short → spurious failures; too long → delayed failure detection. Tune per vendor.
- Circuit breaker on Modbus link required to prevent failed VFD from exhausting request threads.

## Architectural Implications for sensor-expert reviews
- Any parameter change flow that does NOT use Maker-Checker for HIGH/CRITICAL tier = CRITICAL IEC 62443 violation.
- Missing `RiskEvaluatorService` = CRITICAL.
- Brand-agnostic parameter table (single `registerAddress` column without `brand` discriminator) = CRITICAL.
- Automation rules that write parameters without verifying risk tier = CRITICAL.
- Missing audit trail entries for parameter writes = CRITICAL.
- Plaintext Modbus TCP without TLS tunnel in production = CRITICAL.
- Missing rollback on parameter-write failure = HIGH.
- No circuit breaker on Modbus link = MEDIUM.

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → VFD Safety (Critical)`:
- Parameter changes MUST use Maker-Checker approval workflow (IEC 62443 SL-2): `creation → risk evaluation → approval → scheduled application → audit`. Skipping any step on HIGH or CRITICAL tier = CRITICAL compliance violation.
- `RiskEvaluatorService` MUST tier every parameter change into LOW/MEDIUM/HIGH/CRITICAL based on the target register. HIGH and CRITICAL require a second approver (different user from the requester). Same-user dual approval = CRITICAL bypass.
- CRITICAL-tier parameters (max frequency, braking, STO behavior, current limits) MUST require an additional approver, explicit safety justification, and cannot be triggered by automation rules.
- Automation rules triggering parameter changes MUST validate the resulting tier against a whitelist (LOW/MEDIUM only by default). Automation writing to HIGH/CRITICAL registers without explicit override = CRITICAL.
- Multi-brand support MUST use brand-specific register tables with a `brand` discriminator. Register mappings from different brands interleaved in one table = CRITICAL (wrong-register write).
- Modbus TCP in production MUST be tunneled through TLS or equivalent encryption. Plaintext Modbus TCP = CRITICAL.
- Parameter-write failures (timeout, invalid value, safety interlock rejection) MUST trigger atomic rollback and audit log entry. Missing rollback = HIGH.
- Modbus link MUST have circuit breaker to prevent failed VFD from exhausting request threads. Missing = MEDIUM (availability under VFD fault).
- Audit trail on parameter changes MUST include requester, approver, risk tier, old value, new value, scheduled time, actual write time, acknowledgment. Missing any field = HIGH compliance gap.
- Network segmentation between control network (OT) and application network (IT) MUST be enforced at the infrastructure level per IEC 62443-3-3 FR5. Missing segmentation = HIGH.
