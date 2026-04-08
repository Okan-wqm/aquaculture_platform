# Research: Cross-Cutting Concern Arbitration & Bounded Context Conflicts

**Topic:** DDD bounded contexts, context maps, integration patterns (Partnership/Customer-Supplier/Conformist/ACL/Open-Host/Shared Kernel/Separate Ways), strategic design conflict resolution
**Date:** 2026-04-08
**Agent:** architectural-arbiter

## Sources

- [bliki: Bounded Context - Martin Fowler](https://martinfowler.com/bliki/BoundedContext.html)
- [bliki: Domain Driven Design - Martin Fowler](https://martinfowler.com/bliki/DomainDrivenDesign.html)
- [Linking Modular Architecture to Development Teams - Martin Fowler](https://martinfowler.com/articles/linking-modular-arch.html)
- [bliki: CQRS - Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
- [Domain-Driven Design Reference (Eric Evans, dddcommunity.org Chapter 14 — Maintaining Model Integrity)](https://www.dddcommunity.org/uncategorized/ch14/)
- [DDD Community Table of Contents](https://www.dddcommunity.org/uncategorized/toc/)
- [Use Domain Analysis to Model Microservices - Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis)
- [Use Tactical DDD to Design Microservices - Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/tactical-ddd)
- [Identify microservice boundaries - Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries)
- [Anti-corruption Layer pattern - Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
- [Designing a DDD-oriented microservice - .NET Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/ddd-oriented-microservice)
- [Identifying domain-model boundaries for each microservice - .NET Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/architect-microservice-container-applications/identify-microservice-domain-model-boundaries)
- [A Pattern for Sharing Data Across DDD Bounded Contexts - MSDN Magazine](https://learn.microsoft.com/en-us/archive/msdn-magazine/2014/october/data-points-a-pattern-for-sharing-data-across-domain-driven-design-bounded-contexts)
- [Best Practice: An Introduction to Domain-Driven Design - MSDN Magazine](https://learn.microsoft.com/en-us/archive/msdn-magazine/2009/february/best-practice-an-introduction-to-domain-driven-design)

## Key Findings

### 1. Bounded context — what it is, what it is not

A bounded context (Eric Evans, *Domain-Driven Design*, 2003) is a **linguistic and modeling boundary** within which a single ubiquitous language has consistent meaning. Inside the boundary, "Customer" means exactly one thing; outside, the same word may mean something else, and both meanings can be valid.

Fowler's exact framing: "as you try to model a larger domain, it gets progressively harder to build a single unified model. DDD recognizes that 'total unification of the domain model for a large system will not be feasible or cost-effective' and instead divides up a large system into Bounded Contexts, each of which can have a unified model."

A bounded context is **not** the same as:
- A microservice (a context can span several services or live inside a modular monolith).
- A team (one team can own several contexts; one large context can be co-owned by several teams via a shared kernel).
- A database schema (though they often align in practice).

For the aqua-saas platform, the agent roster maps roughly to bounded contexts: `farm-expert` owns the farming/aquaculture context, `messaging-expert` owns the chat context, `sensor-expert` owns the SCADA/IoT context, etc. Cross-context conflicts are exactly the cases the architectural-arbiter is invoked to resolve.

### 2. Context map — the canonical relationship vocabulary

Evans identified seven (some sources count nine) integration patterns between bounded contexts. The architectural-arbiter must know these by name because they are the **vocabulary of the resolution**: every cross-context conflict resolves to one of these patterns being in force, and the arbitration ADR must name the pattern explicitly.

**1. Partnership** — two contexts succeed or fail together; they coordinate their releases and jointly plan integration changes. Communication is bidirectional and continuous. Used when neither context can deliver value without the other (e.g., a payment context and an order context in a checkout system).

**2. Shared Kernel** — two contexts share a small, explicitly defined subset of the model (code, schema, types). The shared kernel is jointly owned and changes require consent from both teams. Powerful but expensive: every change is a coordination cost.

**3. Customer/Supplier** — upstream (supplier) provides; downstream (customer) consumes. The downstream is a paying "customer" in the sense that the upstream prioritizes its needs in the planning process. The supplier publishes the contract; the customer's needs are negotiated into the supplier's roadmap.

**4. Conformist** — downstream consumes upstream's model verbatim, with no translation. The downstream gives up modeling autonomy to avoid the cost of an anti-corruption layer. Used when the upstream model is "good enough" or when the downstream lacks negotiating power.

**5. Anti-Corruption Layer (ACL)** — downstream builds a translation layer between the upstream model and its own. The ACL is the downstream's defense: changes upstream are absorbed by the ACL and do not propagate into the downstream's domain model. The most defensive integration pattern; costly but maximally protective.

**6. Open Host Service (OHS)** — upstream publishes a deliberate, well-documented integration API meant for many consumers. The OHS is **stable** by design — the upstream commits to not breaking it without a long deprecation window. Often paired with a Published Language.

**7. Published Language** — a shared, public, well-documented data format (JSON Schema, Protobuf, AsyncAPI) that contexts use to exchange information without sharing internal models. The published language is itself an artifact under version control with its own evolution rules.

**8. Separate Ways** — two contexts have no integration. Each evolves independently. Used when the cost of integration exceeds its benefit. The arbiter occasionally resolves a conflict by **declaring Separate Ways**: stop trying to integrate, accept the duplication.

**9. Big Ball of Mud** — Evans's term for an unbounded, unstructured legacy mess. Not a target pattern; named so teams can recognize when they have one and **prevent it from spreading** by wrapping it in an ACL.

### 3. Pattern selection — which to use when

Microsoft's Azure Architecture Center synthesizes the selection rules:

- **Both teams have authority and stable requirements** → Partnership.
- **One team is clearly upstream and the other downstream, downstream needs influence** → Customer/Supplier.
- **Downstream has no political leverage and upstream is reasonable** → Conformist.
- **Upstream is unreasonable, legacy, or about to be replaced, but cannot be discarded** → Anti-Corruption Layer.
- **Upstream has many consumers** → Open Host Service + Published Language.
- **Two teams need a small shared concept that cannot be cleanly split** → Shared Kernel (use sparingly; high coordination cost).
- **Integration is more trouble than it's worth** → Separate Ways.

The arbiter's role is to **name the pattern that should be in force** for a disputed integration, then verify that the recommendation under arbitration is consistent with that pattern. If two agents are arguing as if Conformist is in force but the codebase shows an ACL (or vice versa), the conflict is a pattern-misalignment, not a code defect, and the arbitration ADR resolves it by declaring the canonical pattern.

### 4. Anti-Corruption Layer — the arbiter's most useful tool

The ACL is special because it is the pattern that **resolves conflict by adding a translation layer rather than changing either side's model**. When agent A and agent B both claim authority over the shape of an event/type/schema, and neither side will yield, the arbiter can often resolve by:

1. Declaring one side the **producer of the canonical shape** (the upstream).
2. Declaring the other side the **consumer of a translated shape** through an ACL.
3. Specifying the location and ownership of the ACL in the arbitration ADR.

The Azure ACL guidance explicitly notes that the ACL "can translate incoming integration events, including mapping to a different event type when the publishing bounded context has changed the type of an event to one that the receiving bounded context does not recognize, or converting to a different version of the event when the publishing bounded context uses a different version." This is exactly the contract-version conflict the arbiter sees most often.

ACL trade-off (must be in the Consequences section of any ADR that prescribes one):
- **Cost:** the ACL is real code that must be maintained and tested.
- **Benefit:** the downstream's model is decoupled from upstream changes; the downstream can evolve independently.
- **Failure mode:** the ACL becomes a dumping ground for translation hacks and itself turns into a Big Ball of Mud. Mitigation: own the ACL by the downstream team, version it, and write tests for the translations.

### 5. Polysemic terms — when the same word means different things

Fowler's framing: "different contexts sometimes have completely different models of common concepts with mechanisms to map between these polysemic concepts for integration."

In aqua-saas this is observable: `User` in the auth context (`auth-security-expert`) has fields for credentials, MFA, sessions; `User` in the messaging context (`messaging-expert`) has handle, avatar, channel memberships; `User` in the farm context (`farm-expert`) has worker assignments and shift schedules. These are three different models of one concept.

Conflicts arise when an agent's recommendation assumes "User" means the same thing across contexts. The arbiter must:
1. Identify which context's `User` definition is canonical for the disputed code path.
2. Verify whether translation between contexts is happening (ACL or shared kernel) or whether the contexts are leaking into each other.
3. If contexts are leaking, the resolution is either to introduce an ACL or to push the leaking concept into the other context's bounded language.

The mistake to avoid: collapsing the polysemic terms into a single definition to "resolve the conflict." That destroys both contexts' models and creates a shared kernel that no one agreed to maintain.

### 6. Strategic design vs tactical design

Evans separates DDD into:

- **Strategic design** — bounded contexts, context maps, ubiquitous language, distillation of the core domain. Operates at the system-of-systems level. Decisions here are slow, expensive to reverse, and govern team boundaries.
- **Tactical design** — entities, value objects, aggregates, domain events, repositories. Operates within a single bounded context. Decisions here are local and reversible.

The architectural-arbiter operates **at the strategic level**. Domain agents (`farm-expert`, `messaging-expert`, etc.) operate at the tactical level. When an agent's tactical recommendation has strategic consequences — e.g., "move this aggregate from the messaging context to the farm context" — the arbiter must recognize the strategic implication and either approve it via an ADR that updates the context map, or reject it as out of scope for a single agent.

### 7. Service boundaries should match context boundaries (Microsoft, .NET microservices guidance)

Microsoft's `.NET microservices` guidance is unambiguous: "Identifying domain-model boundaries for each microservice" is the same exercise as identifying bounded contexts. Where microservices and contexts diverge, you get one of two failure modes:

- **Two contexts in one service** — the service becomes a small monolith. Different ubiquitous languages collide inside one codebase. Symptom: types named `MessagingUser` and `FarmUser` living next to each other in the same module.
- **One context split across two services** — every transaction needs distributed coordination. Symptom: every domain operation requires a saga or two-phase commit between the two services.

The arbiter must check which failure mode is in play when an agent reports a "split confusion" finding, and the arbitration ADR must explicitly name the bounded context that is being violated.

### 8. Integration events and bounded context boundaries

Microsoft's microservice DDD guidance treats domain events as the **primary integration mechanism** between bounded contexts. The discipline:

- Domain events live **inside** the source context.
- An "integration event" is the published shape that crosses the context boundary — typically a translated, stable, well-versioned event with a `Published Language` schema.
- The integration event is **not** the same as the internal domain event. The internal domain event can be rich and tied to the source's aggregate; the integration event is flat, stable, and consumer-friendly.

For the aqua-saas platform, this translates to: events in `libs/event-contracts/src/` are integration events. They are the published language between contexts. Internal events used inside a single bounded context (e.g., for CQRS read-model updates within `messaging-service`) are NOT in `libs/event-contracts/` — they live inside the service.

A common arbitration pattern: an agent recommends adding a field to a `libs/event-contracts/` type because their internal aggregate has it. The arbiter rejects: the integration event is the published language, it does not get fields added because one context's internal model evolved. If the new field is genuinely needed for cross-context integration, it goes through the deprecation window; if not, the change belongs inside the source service.

### 9. Conflict resolution decision tree for the arbiter

When two agents conflict on a cross-context concern, the arbiter follows this decision tree:

1. **Are both agents talking about the same bounded context?** If no, the conflict is polysemic — name the contexts, declare the canonical pattern (likely an ACL), and resolve.
2. **Is one agent the upstream and the other the downstream?** If yes, the resolution defers to the Customer/Supplier or Open Host Service pattern: upstream owns the contract, downstream's needs are negotiated into the upstream's roadmap.
3. **Are both agents inside the same context with conflicting tactical advice?** If yes, the conflict is local to that context and the arbiter defers to the **primary owner** of the context (see research file `primary-owner-rule-scope-overlap-resolution`).
4. **Does the conflict require changing the published language (event contract)?** If yes, the §2 contract-versioning research applies: classify as additive/breaking, enforce deprecation window.
5. **Is one side a security concern?** Security wins (see research file `security-wins-over-convenience-decision-principles`).
6. **None of the above apply?** Escalate to human review. The arbiter does not invent strategic decisions outside its evidence base.

## Architectural Implications for architectural-arbiter

The arbiter's first analytical move on every cross-agent conflict is to **place the conflict on the context map**. Specifically:

1. **Identify the bounded contexts** of both agents involved. Use the agent roster as the first-order mapping (one agent ≈ one context) and refine if the conflict is intra-context.
2. **Name the integration pattern** currently in force between the two contexts (Customer/Supplier, ACL, OHS, etc.). If the pattern is unclear or absent, that absence is itself the root cause of the conflict.
3. **State the integration pattern that should be in force** in the arbitration ADR. If it differs from the current pattern, the ADR's Decision section is "We will adopt pattern X."
4. **For published-language disputes**, defer to the event-contract research file's deprecation window protocol.
5. **For polysemic-term disputes**, never collapse the polysemy. Either introduce an ACL or push the term into one context's exclusive ownership.

## Domain Rule Additions for architectural-arbiter

- Every cross-agent conflict arbitration MUST identify the bounded context(s) involved by name in the Context section of the ADR. ADRs that name agents but not contexts = HIGH (the conflict cannot be located on the context map for future precedent).
- Every cross-context arbitration MUST name the DDD integration pattern (Partnership, Shared Kernel, Customer/Supplier, Conformist, ACL, Open Host Service, Published Language, Separate Ways) that resolves the conflict. ADRs that resolve a cross-context conflict without naming a pattern = HIGH (the resolution is ad-hoc and cannot be reapplied).
- Recommendations that would collapse a polysemic term into a single shared definition (e.g., merge `auth.User` and `messaging.User` into a single shared `User`) without explicit Shared Kernel agreement from BOTH affected agents = CRITICAL (creates an unsanctioned shared kernel and destroys one context's model).
- Recommendations that propose adding fields to `libs/event-contracts/src/` types because of internal aggregate changes in one context, without explicit cross-context integration justification = HIGH (the published language is being polluted with internal state).
- Recommendations to introduce an Anti-Corruption Layer MUST specify: (a) the location of the ACL in the codebase, (b) the owning agent/team, (c) the translation rules between the upstream and downstream models, (d) the test strategy for the translations. Missing any = MEDIUM (the ACL will rot into a Big Ball of Mud).
- Recommendations that resolve a strategic-level conflict (boundary change, ownership change, integration pattern change) MUST be ratified via an ADR. Strategic decisions made inside a tactical recommendation = HIGH (the strategic change is invisible to other agents).
- When two agents conflict on tactical advice **inside the same bounded context**, the arbiter MUST defer to the primary owner of that context. Cross-context arbitration of intra-context disputes = MEDIUM (overreach; the wrong agent is being granted authority).
- When the arbiter declares "Separate Ways" (no integration), the ADR MUST identify what duplication is being accepted and the operational cost of that duplication. Silent Separate Ways declarations = HIGH (the duplication is invisible until it causes an inconsistency incident).
