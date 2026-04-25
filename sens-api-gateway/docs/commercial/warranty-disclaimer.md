# Warranty and Disclaimer — Template

> **(LEGAL REVIEW REQUIRED)** — This document templates the warranty scope, disclaimers, and consequential-damage caps. Counsel must adapt the language to the governing law of the master agreement, particularly where consumer-protection statutes or EU mandatory-consumer provisions apply. All monetary caps are `{TEMPLATE}` placeholders.

Document date: 2026-04-24

---

## 1. Express warranty

Suderra warrants that, for a period of `{TEMPLATE: warranty period, typically 12 months}` from the activation date (the "Warranty Period"), the Suderra Edge Agent, when installed, configured, and operated in accordance with the documentation set under `sens-api-gateway/docs/`, will materially conform to the functional specifications described in `../product/feature-matrix.md` and the protocol-reference chapters under `../protocols/`.

The sole and exclusive remedy for breach of this express warranty is, at Suderra's option:

1. Use of commercially reasonable efforts to correct the non-conformity within a reasonable time; or
2. Replacement of the non-conforming Edge Agent build with a conforming build; or
3. If neither correction nor replacement is commercially reasonable, termination of the affected licence and refund of the unused portion of prepaid fees on a pro-rata basis over the Warranty Period.

**(LEGAL REVIEW REQUIRED)**

---

## 2. Warranty exclusions

The express warranty in §1 does not extend to defects or non-conformities caused by:

- Modification of the Edge Agent by a party other than Suderra.
- Use outside the documented specifications (`../product/`, `../api/`, `../protocols/`) or in breach of the permitted-use clauses in `license-model.md` §4.1.
- Hardware faults in the underlying edge device (Raspberry Pi, Revolution Pi, TPM module, sensors, actuators) or in the associated network infrastructure.
- Combination with third-party software or data not supplied or approved by Suderra, where the defect would have been avoided but for the combination.
- Disabling, bypassing, or mis-operating a security feature documented in `../security/` (signed-deploy, TPM-sealed key hierarchy, anti-rollback counter, audit chain).
- Operator error, negligence, or failure to apply a security patch that Suderra has made available under the support tier.
- Force majeure events.
- The open-source components incorporated in the Edge Agent; the Licensee's rights in those components are governed by their respective licences (see `oss-attribution.md`).

---

## 3. Disclaimer of implied warranties

EXCEPT FOR THE EXPRESS WARRANTY IN §1, AND TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SUDERRA EDGE AGENT IS PROVIDED "AS IS" AND SUDERRA DISCLAIMS ALL OTHER WARRANTIES, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING WITHOUT LIMITATION ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, COMPLETENESS, ABSENCE OF VIRUSES OR ERRORS, UNINTERRUPTED OR ERROR-FREE OPERATION, OR THAT ALL DEFECTS WILL BE CORRECTED.

Some jurisdictions (notably EU consumer-protection regimes, UK Consumer Rights Act 2015, Turkish Tüketicinin Korunması Hakkında Kanun) do not permit the exclusion of certain implied warranties. In those jurisdictions, the disclaimer above applies to the maximum extent permitted by law, and statutory consumer warranties are unaffected.

**(LEGAL REVIEW REQUIRED)**

---

## 4. Consequential-damage cap

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, SUDERRA SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION LOSS OF REVENUE, LOSS OF PROFITS, LOSS OF USE, LOSS OF DATA, LOSS OF GOODWILL, BUSINESS INTERRUPTION, COST OF SUBSTITUTE SERVICES, OR PROCUREMENT OF SUBSTITUTE GOODS, ARISING OUT OF OR IN CONNECTION WITH THE SUDERRA EDGE AGENT OR THE MASTER AGREEMENT, EVEN IF SUDERRA HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

SUDERRA'S AGGREGATE LIABILITY UNDER THE MASTER AGREEMENT, EXCEPT AS EXPRESSLY PROVIDED IN THE INDEMNIFICATION CLAUSES IN `indemnification.md`, SHALL NOT EXCEED `{TEMPLATE: aggregate liability cap, candidate formulations: (a) the fees paid by the Licensee under the master agreement in the 12 months preceding the claim; (b) a fixed monetary cap; (c) 2× clause (a)}`.

The cap above does not apply to:

- Suderra's indemnification obligations per `indemnification.md` (separate caps there).
- Suderra's breach of its confidentiality obligations.
- Suderra's gross negligence or wilful misconduct.
- Liabilities that cannot be limited under the governing law of the master agreement (e.g. personal injury, death, fraud, fraudulent misrepresentation under English law; equivalents in other jurisdictions).

**(LEGAL REVIEW REQUIRED)**

---

## 5. Use-case restrictions — safety-critical and life-critical

### 5.1 Position statement

The Suderra Edge Agent is designed for industrial IoT and aquaculture water-quality monitoring. It is **NOT designed, manufactured, or intended** for use in the following high-risk applications, and the Licensee must not deploy it in such applications under the default commercial licence:

- Aircraft navigation, aircraft flight-control, or any other aviation function where failure would reasonably be expected to cause loss of life, personal injury, or catastrophic property damage.
- Nuclear-facility instrumentation, nuclear-reactor control, or nuclear-material handling.
- Medical devices within the meaning of EU Regulation 2017/745 (MDR) or US FDA 21 CFR Parts 800–898, including any life-sustaining or life-supporting function.
- Weapons systems, weapons-guidance, or weapons-delivery systems.
- Mass-transit vehicle safety systems (railway signalling, autonomous-vehicle primary safety, etc.).
- Any other deployment where the failure of the Edge Agent could reasonably be expected to cause a SIL-3 or SIL-4 hazard event within the meaning of IEC 61508, or a Class C medical-device event within the meaning of IEC 62304.

### 5.2 Aquaculture water-quality boundary

Water-quality monitoring for aquaculture is the Edge Agent's primary intended use. The monitoring function is advisory: it reports sensor readings and triggers alarms, and it supports operator-enforced safe-state triggers through the signed-command path (ADR-018 §7). The monitoring function is **not** a safety-instrumented system within the meaning of IEC 61511 and is not substitute for operator oversight of the fish-farming operation. The Licensee maintains independent operator presence and independent fallback procedures for loss-of-monitoring scenarios.

### 5.3 Separately qualified deployments

Safety-critical or life-critical deployment, where the applicable functional-safety standard (IEC 61508, IEC 61511, ISO 26262, IEC 62304, DO-178C, etc.) applies, requires a **separately negotiated qualification agreement** with Suderra under which:

- A functional-safety gap assessment is performed against the applicable standard.
- The Edge Agent is deployed as one element in a multi-diverse-channel safety architecture (hardware-in-the-loop redundancy, not as a single-point safety function).
- The qualification agreement allocates the residual-risk responsibility explicitly and is priced to reflect the additional engineering and evidence burden.

Absent such an agreement, safety-critical deployment is prohibited under `license-model.md` §4.2.

**(LEGAL REVIEW REQUIRED)**

---

## 6. Environmental and regulatory conformance

The Edge Agent binary is distributed under conformance with the CE, FCC, UL, and RED conformance programmes described in `../compliance/ce-fcc-ul-red.md`, as applicable to the target hardware. The conformance programme assumes installation on reference-qualified hardware; deviation from reference hardware requires re-qualification.

---

## 7. Survival

The disclaimers and caps in §3, §4, and §5 survive termination of the master agreement.

---

Export-control reference date: 2026-04-24
