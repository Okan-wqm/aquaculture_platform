# Indemnification — Template

> **(LEGAL REVIEW REQUIRED)** — This document templates the IP and cyber indemnification clauses applicable to commercial distribution of the Suderra Edge Agent. Scope limits, caps, and exclusions are `{TEMPLATE}` placeholders. Counsel must adapt the language to the governing law of the master agreement.

Document date: 2026-04-24

---

## 1. IP indemnification (Suderra → Licensee)

### 1.1 Obligation

Suderra shall defend, indemnify, and hold the Licensee harmless from and against any third-party claim alleging that the Licensee's authorised use of the Suderra Edge Agent, as delivered and within the permitted-use scope of `license-model.md` §4.1, directly infringes a patent, copyright, trade-mark, trade secret, or other intellectual-property right enforceable in the Licensee's primary jurisdiction.

### 1.2 Process

- The Licensee notifies Suderra in writing of any claim within `{TEMPLATE: notice window, typically 15 business days}` of receipt.
- Suderra controls the defence and settlement, provided no settlement imposes a non-indemnifiable obligation on the Licensee without the Licensee's prior written consent.
- The Licensee cooperates reasonably with Suderra (evidence, witnesses, declarations) at Suderra's expense.
- The Licensee does not admit liability, settle, or compromise the claim without Suderra's prior written consent.

### 1.3 Remedies

If use of the Edge Agent is enjoined by a court of competent jurisdiction, or in Suderra's reasonable judgement is likely to be enjoined, Suderra may at its option and at its cost:

1. Procure for the Licensee the right to continue use; or
2. Modify the Edge Agent so that it no longer infringes while retaining materially equivalent functionality; or
3. Replace the Edge Agent with a non-infringing functional equivalent; or
4. If none of the above is commercially reasonable, terminate the licence and refund the unused portion of prepaid fees on a pro-rata basis.

### 1.4 Exclusions

Suderra has no obligation under §1.1 in respect of any claim arising from:

- Modification of the Edge Agent by a party other than Suderra (combination claims defeated by the modification).
- Combination of the Edge Agent with any product, service, or data not supplied or approved by Suderra, where the claim would have been avoided but for the combination.
- Continued use of a version of the Edge Agent that Suderra has superseded with a non-infringing version and made available to the Licensee under the support tier.
- Use in violation of the permitted-use scope in `license-model.md` §4.1.
- Open-source components incorporated in the Edge Agent; claims in respect of those components are governed by their respective licences (see `oss-attribution.md`).
- Reverse engineering, decompilation, or disassembly by the Licensee except to the minimum extent permitted by mandatory law.

### 1.5 Cap

Suderra's aggregate liability under §1.1 is capped at `{TEMPLATE: IP indemnification cap, candidate formulations: (a) the fees paid by the Licensee under the master agreement in the 12 months preceding the claim; (b) a fixed monetary cap; (c) 2× clause (a)}`. The cap does not apply to claims arising from Suderra's wilful infringement or fraudulent concealment of an infringement it knew about at signature.

**(LEGAL REVIEW REQUIRED)**

### 1.6 Sole remedy

The process, remedies, and cap in §1.2–1.5 are the Licensee's sole and exclusive remedy in respect of IP-infringement claims.

---

## 2. Cyber indemnification (Suderra → Licensee)

### 2.1 Obligation

Suderra shall defend, indemnify, and hold the Licensee harmless from and against third-party claims and regulatory enforcement actions arising from a Security Incident (§2.2) that is directly and proximately caused by a vulnerability in the Suderra Edge Agent, where the vulnerability was present in the as-delivered code and was not caused by the Licensee's misconfiguration or by a hardware fault of the underlying edge device.

### 2.2 Security Incident

"Security Incident" means unauthorised access, exfiltration, alteration, or destruction of Licensee data persisted in or passing through the Edge Agent, attributable to a vulnerability in the Edge Agent code-base or a design defect in the Edge Agent PKI / key-management subsystems as documented in `../security/`.

### 2.3 Scope extensions covered

Within the envelope of §2.1, the indemnification extends to reasonable documented costs of:

- External forensic investigation conducted by a mutually agreed responder.
- Regulatory notifications mandated by applicable data-protection law (GDPR Art. 33–34, KVKK Art. 12, equivalents) where Suderra's vulnerability triggered the notification obligation.
- Affected-data-subject notifications where mandated by applicable law.
- Reasonable credit-monitoring offers to affected natural persons where customary in the Licensee's primary jurisdiction.

### 2.4 Exclusions

Suderra has no obligation under §2.1 in respect of any Security Incident arising from:

- Licensee misconfiguration in breach of the hardening guide (`../deployment/hardening-guide.md`) or the secure-defaults posture (ADR-018 §7).
- Disabling, bypassing, or mis-operating the signed-deploy feature, the anti-rollback counter, the TPM-sealed key hierarchy, or any other security feature documented in `../security/`.
- Compromise of the Licensee's operator-side credentials, private networks, or cloud accounts not attributable to a vulnerability in the Edge Agent.
- Vulnerabilities in third-party systems integrated with the Edge Agent via the documented northbound protocols, where the vulnerability is in the third-party system itself.
- Continued operation of a version of the Edge Agent for which Suderra has published a security patch and made it available under the support tier, after the applicable patch window has elapsed, where the patch would have prevented the Incident.
- Vulnerabilities in open-source components incorporated in the Edge Agent where Suderra has promptly backported an upstream patch and made it available under the support tier.

### 2.5 Notification and cooperation

- The Licensee notifies Suderra in writing within `{TEMPLATE: cyber-notice window, typically 72 hours}` of discovering a suspected Security Incident attributable to the Edge Agent.
- The Licensee preserves forensic evidence (audit-chain entries, attestation outputs per ADR-020 §2) and shares evidence reasonably required for root-cause determination.
- Suderra controls the technical incident-response activities downstream of the Edge Agent; the Licensee controls communications with its own regulators and affected data subjects, subject to the cooperation obligation above.

### 2.6 Cap

Suderra's aggregate liability under §2.1 is capped at `{TEMPLATE: cyber indemnification cap}`. The cap does not apply in respect of Suderra's gross negligence or wilful misconduct, where the governing law excludes such caps as a matter of mandatory statute.

**(LEGAL REVIEW REQUIRED)**

---

## 3. Third-party-claim indemnification (Licensee → Suderra)

The Licensee shall defend, indemnify, and hold Suderra harmless from and against third-party claims arising from:

- The Licensee's use of the Edge Agent outside the permitted-use scope of `license-model.md` §4.1.
- The Licensee's breach of the export-control obligations in `export-control.md`.
- The Licensee's breach of applicable data-protection law in relation to data the Licensee controls and processes through the Edge Agent.
- The Licensee's failure to obtain data-subject consent or to discharge a lawful-basis obligation for sensor or operator data collected via the Edge Agent.

Process, caps, and exclusions mirror §1.2, §1.4, and §1.5 *mutatis mutandis*, with `{TEMPLATE: Licensee-side cap}` as the aggregate limit.

**(LEGAL REVIEW REQUIRED)**

---

## 4. Interaction with other liability terms

- The caps in this document apply per the direct-indemnification clauses and do not aggregate with the general liability cap in the master agreement; counsel to confirm the interaction at contract execution.
- Indemnification obligations survive termination of the master agreement in respect of claims arising during the term.

**(LEGAL REVIEW REQUIRED)**

---

## 5. Insurance

Suderra maintains (or will maintain at Effective Date):

- Technology errors-and-omissions insurance with a per-claim limit of `{TEMPLATE: E&O limit}`.
- Cyber-liability insurance with a per-claim limit of `{TEMPLATE: cyber limit}`.
- General commercial liability insurance to local customary limits.

Certificates of insurance are provided on written request. The existence of insurance does not enlarge the indemnification obligations above.

**(LEGAL REVIEW REQUIRED)**

---

Export-control reference date: 2026-04-24
