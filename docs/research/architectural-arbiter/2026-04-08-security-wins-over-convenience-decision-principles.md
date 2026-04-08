# Research: Security Wins Over Convenience — Decision Principles & Tradeoff Framework

**Topic:** Architectural decision heuristics, when security overrides domain preference, performance vs maintainability, documented tradeoff framework, postmortem learning integration
**Date:** 2026-04-08
**Agent:** architectural-arbiter

## Sources

- [Architecture Tradeoff Analysis Method (ATAM) - SEI](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)
- [ATAM: Method for Architecture Evaluation - Kazman, Klein, Clements - SEI Technical Report](https://www.sei.cmu.edu/documents/629/2000_005_001_13706.pdf)
- [The Architecture Tradeoff Analysis Method - Kazman, Klein, Barbacci - SEI](https://www.sei.cmu.edu/library/file_redirect/1998_005_001_16646.pdf/)
- [Steps in an Architecture Tradeoff Analysis Method: Quality Attribute Models and Analysis - SEI](https://www.sei.cmu.edu/library/steps-in-an-architecture-tradeoff-analysis-method-quality-attribute-models-and-analysis/)
- [The Architecture Tradeoff Analysis Method - IEEE Conference Publication](https://ieeexplore.ieee.org/document/706657)
- [Security Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [Security Foundations - AWS Well-Architected Framework Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/security.html)
- [The 6 Pillars of the AWS Well-Architected Framework - AWS APN Blog](https://aws.amazon.com/blogs/apn/the-6-pillars-of-the-aws-well-architected-framework/)
- [OWASP Secure Product Design Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Product_Design_Cheat_Sheet.html)
- [OWASP Principles of Security - Developer Guide](https://devguide.owasp.org/en/02-foundations/03-security-principles/)
- [OWASP Secure by Design Framework](https://owasp.org/www-project-secure-by-design-framework/)
- [OWASP Fail Securely](https://owasp.org/www-community/Fail_securely)
- [OWASP Least Privilege Principle](https://owasp.org/www-community/controls/Least_Privilege_Principle)
- [A06 Insecure Design - OWASP Top 10:2025](https://owasp.org/Top10/2025/A06_2025-Insecure_Design/)
- [Gregor's Law - The Architect Elevator (Gregor Hohpe)](https://architectelevator.com/gregors-law/)
- [Is This Architecture? Look for Decisions! - Enterprise Integration Patterns - Hohpe](https://www.enterpriseintegrationpatterns.com/ramblings/86_isthisarchitecture.html)
- [Your most important architecture decisions might be the ones you didn't know you made - Hohpe](https://architectelevator.com/architecture/important-decisions/)
- [The Architect Elevator - Martin Fowler / Hohpe](https://martinfowler.com/articles/architect-elevator.html)
- [Blameless postmortems - PagerDuty postmortem-docs](https://github.com/PagerDuty/postmortem-docs/blob/master/docs/culture/blameless.md)
- [How They SRE - upgundecha/howtheysre](https://github.com/upgundecha/howtheysre)
- [Resilience Engineering papers - lorin/resilience-engineering](https://github.com/lorin/resilience-engineering)

## Key Findings

### 1. ATAM — the canonical tradeoff vocabulary

The Software Engineering Institute (SEI) at Carnegie Mellon developed the **Architecture Tradeoff Analysis Method** (ATAM) in 1998 (Kazman, Klein, Barbacci) and refined it through 2000 (Kazman, Klein, Clements). It is the most widely cited formal method for adjudicating tradeoffs between conflicting quality attributes. The arbiter must know its vocabulary because it provides the **terminology** for talking about why one concern wins over another.

**Quality attributes** (the dimensions a decision is evaluated on):
- **Modifiability** — how easily the system absorbs change.
- **Performance** — latency, throughput, resource utilization.
- **Availability** — uptime, fault tolerance, recoverability.
- **Security** — confidentiality, integrity, authentication, authorization, audit.
- **Usability** — operability, learnability.
- **Testability** — ability to verify correctness.

**Sensitivity point** — a property of one or more components that is critical for achieving a particular quality attribute response. Example: the choice of cipher suite is a sensitivity point for the security attribute. Changing it has a measurable effect on security.

**Tradeoff point** — a sensitivity point that affects **more than one** quality attribute, often in opposite directions. Example: number of replicas of a stateless service. More replicas → higher availability and higher performance under load → BUT lower security (more attack surface) and higher cost. The choice IS a tradeoff because no value is optimal for all attributes simultaneously.

**Risk** — an architectural decision that could lead to undesirable consequences in some quality attribute. Identified during the ATAM process and explicitly tracked.

**Non-risk** — a decision that, given the system's requirements, is good as-is and need not be reconsidered.

Kazman et al.'s exact framing: "These attributes interact, and improving one often comes at the price of worsening one or more of the others." This is the ATAM premise. The arbiter's job, in ATAM terms, is to **make tradeoffs explicit** and to designate which attribute wins for the specific decision under arbitration, with the loss to other attributes named as Consequences in the ADR.

### 2. The platform priority order: security > performance > maintainability > convenience

The aqua-saas CLAUDE.md and the architectural-arbiter prompt both prescribe that security takes precedence over domain correctness when the two conflict. This is consistent with multiple industry sources:

- **AWS Well-Architected Framework** lists Security as a peer pillar with Operational Excellence, Reliability, Performance Efficiency, Cost Optimization, and Sustainability — but in the security pillar's text, AWS prescribes that **security controls must be applied even at the expense of operational convenience** ("Keep people away from data" reduces human error, even though it increases the cost of routine operations).
- **OWASP Secure by Design** treats security as a **non-negotiable design property**, not a feature to be balanced. The OWASP A06 (Insecure Design) classification of the Top 10 is explicitly named because "you cannot test your way out of insecure design."
- **NIST Secure Software Development Framework** prescribes security as a precondition for release, not a tradeoff against velocity.

The implication for the arbiter: when security and another concern (performance, maintainability, velocity, domain preference) conflict on a specific decision, the resolution defaults to security UNLESS the security concern is explicitly downgraded by `security-reviewer` / `auth-security-expert` themselves. The arbiter cannot downgrade a CRITICAL security finding; it can only document the architectural context.

### 3. The OWASP secure design principles — the criteria the arbiter applies

OWASP's Secure Product Design Cheat Sheet and Principles of Security define the design heuristics that the arbiter uses when classifying a decision as a security concern. The relevant principles, with arbiter usage:

**Least Privilege.** A user, process, or program should be given only the minimum level of access necessary. Arbiter usage: any recommendation that grants broader access to resolve a domain problem is a security concern; the resolution is to find a narrower-access solution, not to widen access.

**Defense in Depth.** Multiple layers of independent security controls. Arbiter usage: a recommendation to remove a security control because "another layer also enforces it" is a defense-in-depth violation. The redundancy is the point.

**Fail Securely.** When an error condition is detected, the system defaults to a secure state rather than an unsafe state. Arbiter usage: when a domain agent recommends "let the user proceed if the auth check fails," this is a fail-open violation. The resolution is fail-closed even at the cost of denying legitimate users during an outage.

**Complete Mediation.** Every access to every object must be checked. Arbiter usage: caching of access decisions is a complete-mediation risk; the cache must have a short TTL and an invalidation mechanism. Arguments to extend the cache TTL for performance are tradeoff points where security wins by default.

**Open Design / Kerckhoffs's Principle.** Security must not depend on the obscurity of the design. Arbiter usage: recommendations that rely on "the attacker doesn't know about this endpoint" are rejected; the design must be safe even if fully disclosed.

**Separation of Duties.** No single user has authority to perform a sensitive operation alone. Arbiter usage: recommendations that consolidate permissions for convenience violate this; the consolidation must be rejected even at higher operational cost.

**Psychological Acceptability.** Security mechanisms should not unduly impede user operations. Arbiter usage: this is the **only** principle that authorizes a security/convenience tradeoff in favor of convenience, and only when the convenience improvement is large and the security cost is small. It is the exception, not the rule.

**Don't Trust Services.** Treat all external services as untrusted. Arbiter usage: a recommendation that removes input validation at a service boundary because "the upstream already validates" is rejected; every boundary validates independently.

### 4. When security does NOT win automatically

The architectural-arbiter prompt's "security trumps domain correctness" rule has important nuance. Security wins automatically only when:

- The security concern is genuinely a security concern (not a security-flavored preference).
- The conflict is between security and convenience/velocity/domain preference.
- The security recommendation comes from `security-reviewer` or `auth-security-expert`, OR another agent's recommendation aligns with documented OWASP/NIST/AWS/Microsoft security principles.

Security does NOT automatically win when:

- The conflict is between **two security recommendations** from the same or different agents. (Example: "use stricter CSP" vs "allow inline scripts for analytics that detect XSS." Both are security concerns; the arbiter must reason about the threat model.)
- The "security" concern is actually a defense-in-depth recommendation that conflicts with a documented architectural policy (e.g., "add a second auth check inside the service" when the platform's policy is "auth happens at the edge"). Defense in depth has limits; the arbiter must check the platform's documented threat model.
- The security concern is below the agent's own severity threshold. A LOW security finding does not automatically beat a HIGH performance finding; the priority order applies within comparable severities.

### 5. Performance vs maintainability — the secondary tradeoff

After security, the conventional priority order in ATAM-evaluated systems is **performance > maintainability** when the system is user-facing and has hard latency requirements, and **maintainability > performance** when the system is internal-facing or has loose latency budgets.

For aqua-saas:
- The **edge/sensor data path** (MQTT ingestion, SCADA control, VFD parameter writes) has hard real-time requirements. Performance wins over maintainability because a control loop that misses its deadline is a safety event, not just a slower experience.
- The **admin/back-office paths** (tenant management, reporting, configuration) have loose latency budgets. Maintainability wins because a 200ms admin operation that takes 400ms is acceptable, but a difficult-to-modify admin codebase is a multi-year cost.
- The **chat/messaging path** sits in the middle: latency matters for user experience, but a 200ms chat send is acceptable. Maintainability has the edge here.

When the arbiter resolves a performance/maintainability conflict, the ADR's Decision section must name **which path** the disputed code belongs to and apply the corresponding priority.

### 6. Reversible vs irreversible decisions — Hohpe's framework

Gregor Hohpe's "Architect Elevator" treats architectural decisions in **financial options** terms. The relevant heuristics for the arbiter:

- **Two-way doors** (Amazon's term, adopted by Hohpe) — decisions that are easy to undo. Examples: choice of an internal library, naming convention. For two-way doors, **prefer fast resolution over thorough analysis**. The cost of being wrong is small; the cost of stalling is large.
- **One-way doors** — decisions that are hard or impossible to undo. Examples: choice of database engine, data format for stored events, public API shape, encryption scheme. For one-way doors, **prefer thorough analysis even at the cost of stalling**. The cost of being wrong is permanent.

Hohpe's "Gregor's Law": "Excessive complexity is nature's punishment for organizations that are unable to make decisions." The arbiter must avoid the failure mode of perpetually deferring two-way-door decisions because they "deserve more analysis."

For aqua-saas, examples of the classification:
- **Two-way doors:** TypeORM query helpers, internal logging format, scope of an internal interface.
- **One-way doors:** event contract shape, encryption scheme for credentials, multi-tenant isolation mechanism, MQTT topic naming, schema migration that drops a column.

### 7. The Hohpe principle: most decisions are made invisibly

Hohpe's "Your most important architecture decisions might be the ones you didn't know you made" article makes a point central to the arbiter's role: **the most consequential decisions are the ones taken silently as a side effect of a tactical change**. The arbiter must spot these.

Examples in aqua-saas terms:
- A migration that adds a column with a default value silently makes the column part of the public schema contract.
- A new field on an event is silently a published-language change that consumers may now depend on.
- A dependency injection registration silently creates a coupling between two modules.

When an agent's tactical recommendation has a hidden architectural consequence, the arbiter's job is to **surface the consequence** in an ADR, even if the original recommendation looks routine. The ADR converts the silent decision into an explicit one.

### 8. Postmortem-driven learning — closing the loop

PagerDuty's blameless-postmortem documentation, John Allspaw's Etsy "Code as Craft" article (2012), and the resilience-engineering literature converge on a discipline that the arbiter inherits: **every architectural decision should be re-evaluated when an incident shows it was wrong**.

The mechanism:
1. An incident occurs.
2. The blameless postmortem identifies the architectural decision that contributed to the incident (often via a "five whys" or causal-chain analysis).
3. If the decision was recorded as an ADR, the postmortem references it. The ADR's status flips to `superseded by ADR-NNNN` and a new ADR is written.
4. If the decision was NOT recorded as an ADR (a Hohpe silent decision), the postmortem creates the ADR retroactively, classifying the decision as an `accepted but discovered through incident` record.

The arbiter's role in this loop is to be a **consumer of postmortem findings**. When `context-manager` or human reviewers report a postmortem that touches a prior ADR, the arbiter must update or supersede the ADR.

This is also where the OWASP "Insecure Design" Top 10 entry is operationalized: a postmortem that traces an incident to a design choice (rather than a coding bug) IS evidence that an architectural decision was wrong, and the arbiter must reverse it.

### 9. Decision principles — the arbiter's working set

Synthesizing the above, the arbiter applies the following principles in this order when adjudicating a conflict:

1. **Security wins automatically** when a security concern (from `security-reviewer`, `auth-security-expert`, or aligned with OWASP/NIST principles) conflicts with a non-security concern of any severity.
2. **For non-security conflicts, classify the dimension:** is the conflict about modifiability, performance, availability, usability? Apply the path-specific priority (edge/sensor: performance wins; admin/back-office: maintainability wins; user-facing: case-by-case).
3. **Classify the decision as one-way or two-way door.** One-way doors get thorough analysis even at the cost of stalling; two-way doors get fast resolution even at the cost of being wrong sometimes.
4. **Surface hidden architectural consequences** of tactical recommendations. The ADR must name the consequences explicitly.
5. **Check prior ADRs and postmortems for precedent.** Decisions reversed by postmortem must not be silently re-introduced.
6. **State the loss to the losing side** in the Consequences section. Every tradeoff has a loser; pretending otherwise is dishonest and breaks the ADR's value as a learning record.
7. **Escalate to human review** when the conflict is between two security concerns, when the decision is a one-way door without sufficient analysis, or when the conflict represents a SYSTEMIC architectural tension that exceeds the arbiter's authority.

### 10. Postmortem-aware ADR linking

When the arbiter writes an ADR that responds to a postmortem, the ADR's Context section MUST cite the postmortem document and the incident timeline. The Consequences section MUST include "we will detect a recurrence by [specific signal]" — the postmortem is not just a record of past failure; it is a contract for future detection.

This converts the arbiter from a reactive conflict resolver into a **closed-loop learning component** of the platform. Every postmortem either confirms an existing ADR (status updated to `accepted, validated by incident NNNN`) or generates a new ADR that supersedes the incorrect one.

## Architectural Implications for architectural-arbiter

The arbiter's tradeoff vocabulary is ATAM (sensitivity points, tradeoff points, quality attributes). The arbiter's priority order is security > path-specific (performance | maintainability) > convenience. The arbiter's classification heuristic is one-way vs two-way doors. The arbiter's learning mechanism is postmortem-driven ADR supersession.

In every arbitration ADR:
1. Identify the quality attributes in tension.
2. Name the tradeoff point(s) — where the conflict actually sits.
3. Apply the priority order, with security as the unconditional default.
4. Classify the decision as one-way or two-way and adjust the analytical thoroughness accordingly.
5. State the loss to the losing side in Consequences.
6. Cite prior ADRs and postmortems that establish precedent.
7. If the decision is a one-way door without sufficient evidence, escalate rather than fabricate.

## Domain Rule Additions for architectural-arbiter

- Every arbitration ADR MUST identify the quality attributes in tension by name (modifiability, performance, availability, security, usability, testability) and the tradeoff point. ADRs without explicit attribute identification = MEDIUM (the tradeoff is not learnable).
- When a security concern (from `security-reviewer`, `auth-security-expert`, or aligned with OWASP/NIST principles) conflicts with a non-security concern, the security concern wins by default. Arbitrations that downgrade a CRITICAL security finding for any reason = CRITICAL bypass; the arbiter MUST escalate to human review instead.
- When two security concerns conflict (both sides are security), the arbiter MUST NOT auto-resolve. The arbiter writes a `proposed` ADR framing the threat-model question and escalates to human security review. Auto-resolution of security-vs-security conflicts = HIGH (the threat model is being decided without authority).
- One-way-door decisions (event contract shape, encryption scheme, multi-tenant isolation, schema column drop, MQTT topic format, public API shape) MUST receive thorough analysis with explicit risk enumeration in the ADR. Fast/cheap arbitration of a one-way door = CRITICAL (the cost of being wrong is permanent).
- Two-way-door decisions (internal logging format, internal helper API, internal naming) get fast resolution. Stalling a two-way-door decision for "more analysis" = MEDIUM (Gregor's Law: complexity is the cost of indecision).
- The Consequences section of every arbitration ADR MUST state the loss to the losing side explicitly. ADRs whose Consequences list only benefits = HIGH (the trade-off is hidden, the losing agent's domain is unprotected against silent re-erosion).
- The arbiter MUST consume postmortem findings when they reference architectural decisions. A postmortem that contradicts a prior ADR REQUIRES the prior ADR to be updated to `superseded by ADR-NNNN` with a new ADR explaining the reversal. Postmortems that do not reach the ADR log = HIGH (the platform fails to learn).
- When an arbitration creates a hidden architectural decision as a side effect of a tactical resolution (Hohpe's silent decisions), the arbiter MUST name the side effect explicitly in the ADR and recommend that affected agents be notified. Silent side-effect decisions = HIGH (future cycles will treat them as established without ever reviewing them).
- Path-specific priority application (edge/sensor: performance wins; admin/back-office: maintainability wins; user-facing: case-by-case) MUST be stated explicitly in the ADR. Arbitrations that apply a priority without naming the path = MEDIUM (the precedent cannot be reused on a different path).
- The arbiter MUST escalate rather than fabricate a decision when (a) the conflict is between two security concerns, (b) the decision is a one-way door without sufficient evidence, or (c) the conflict represents a SYSTEMIC tension exceeding the arbiter's authority. Fabricated decisions = CRITICAL (the precedent log becomes unreliable, future arbitrations cite a guess).
