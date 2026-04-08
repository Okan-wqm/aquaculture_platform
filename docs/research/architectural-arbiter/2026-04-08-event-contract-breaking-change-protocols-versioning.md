# Research: Event Contract Breaking Change Protocols & Versioning

**Topic:** Additive vs breaking changes, consumer-driven contracts, semver, deprecation windows, schema registry compatibility modes, event envelope design
**Date:** 2026-04-08
**Agent:** architectural-arbiter

## Sources

- [Consumer-Driven Contracts: A Service Evolution Pattern - Martin Fowler](https://martinfowler.com/articles/consumerDrivenContracts.html)
- [bliki: Tolerant Reader - Martin Fowler](https://martinfowler.com/bliki/TolerantReader.html)
- [bliki: Contract Test - Martin Fowler](https://martinfowler.com/bliki/ContractTest.html)
- [Microservices - Martin Fowler & James Lewis](https://martinfowler.com/articles/microservices.html)
- [Evolutionary Database Design - Martin Fowler](https://martinfowler.com/articles/evodb.html)
- [Building Microservices, 2nd Edition - Sam Newman](https://samnewman.io/books/building_microservices_2nd_edition/)
- [Building Microservices Ch. 4 Integration - Sam Newman / O'Reilly](https://www.oreilly.com/library/view/building-microservices/9781491950340/ch04.html)
- [Versioning in an Event Sourced System - Greg Young, Leanpub](https://leanpub.com/esversioning/read)
- [Schema Registry in Azure Event Hubs - Microsoft Learn](https://learn.microsoft.com/en-us/azure/event-hubs/schema-registry-concepts)
- [AWS Glue Schema Registry - AWS docs](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html)
- [Validate, evolve, and control schemas in MSK and Kinesis with Glue Schema Registry - AWS Big Data Blog](https://aws.amazon.com/blogs/big-data/validate-evolve-and-control-schemas-in-amazon-msk-and-amazon-kinesis-data-streams-with-aws-glue-schema-registry/)
- [DL.ADS.5 Ensure backwards compatibility for data store and schema changes - AWS DevOps Guidance](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/dl.ads.5-ensure-backwards-compatibility-for-data-store-and-schema-changes.html)
- [Creating, evolving, and versioning microservice APIs and contracts - .NET Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/architect-microservice-container-applications/maintain-microservice-apis)
- [How to design and version APIs for microservices - IBM Cloud Blog](https://www.ibm.com/cloud/blog/rapidly-developing-applications-part-6-exposing-and-versioning-apis)
- [Level Up your Kafka Applications with Schemas - IBM](https://www.ibm.com/blog/level-up-your-kafka-applications-with-schemas/)
- [Event Sourcing Pattern - Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)

## Key Findings

### 1. Additive vs breaking changes — the canonical taxonomy

Schema and contract evolution research (Newman, Microsoft .NET architecture guidance, AWS DevOps guidance, Confluent/Kafka schema registry) converges on a precise classification. Every change to an event contract is exactly one of:

**Additive (non-breaking):**
- Adding an **optional** new field with a documented default.
- Adding a new event type.
- Widening an enum (with consumers configured to ignore unknown enum values — see Tolerant Reader).
- Adding a new optional metadata field to the envelope.

**Breaking:**
- Removing a field that any consumer reads.
- Renaming a field (semantically equivalent to remove + add).
- Changing the type of a field (`string` → `number`, `int32` → `int64` if downstream casts).
- Changing semantic meaning of a field while keeping the name (e.g., switching `temperature` from Celsius to Fahrenheit).
- Removing an event type or `eventType` value.
- Changing `eventType` casing or spelling.
- Tightening a previously optional field to required.
- Narrowing an enum (removing a possible value).
- Changing topic/subject naming or partition key derivation.

The unforgiving rule from Microsoft's microservice API guidance: **a microservice can evolve independently only if it does not break its contract**. Any change in the breaking column requires a coordinated migration, not a unilateral push.

### 2. Compatibility modes — schema registry vocabulary

Confluent, AWS Glue Schema Registry, Azure Schema Registry, and IBM Event Streams all use the same compatibility mode taxonomy. Knowing the names is essential for arbitrating contract conflicts:

- **BACKWARD** — new schema can read data written with the **old** schema. The producer can upgrade first; consumers continue to work. Allows: delete optional field, add optional field with default. This is the safest default for event-driven systems where consumers lag.
- **BACKWARD_TRANSITIVE** — like BACKWARD, but compatibility is checked against **all** prior versions, not just the immediately previous one.
- **FORWARD** — old schema can read data written with the **new** schema. Consumers can upgrade first; producers can roll out later. Allows: add a field, delete an optional field.
- **FORWARD_TRANSITIVE** — like FORWARD, against all prior versions.
- **FULL** — both BACKWARD and FORWARD. Allows only fully optional additions and removals.
- **FULL_TRANSITIVE** — FULL against all prior versions.
- **NONE** — no compatibility checking. Used only for explicit breaking changes that require coordinated rollout (and a new topic/subject).

In practice, mature event-driven platforms run with **BACKWARD_TRANSITIVE** as the registry default and treat any schema submission that fails as a CRITICAL block until either the schema is revised or the topic is replaced.

### 3. Semantic versioning applied to event contracts

The .NET microservices guidance, the IBM API design series, and the AWS App Runner semver post agree on the application of MAJOR.MINOR.PATCH to event/API contracts:

- **MAJOR** — breaking change. New consumers must be written; old consumers will break. Requires either a new topic/subject (`messaging.message.sent.v2`) or a long deprecation window with parallel publish.
- **MINOR** — additive, backward-compatible change. New optional fields, new optional event types. Existing consumers continue to work without recompilation.
- **PATCH** — clarification, documentation, no wire-format change.

The version travels in two places: (a) the topic/subject name suffix (`v2`) for true MAJOR transitions, and (b) the event envelope `version` field (typically a SemVer string or an integer schema-registry ID) for all changes including MINOR. Producers write the latest; consumers must accept any compatible version per the registry's compatibility mode.

### 4. Consumer-driven contracts (Fowler) — the arbitration anchor

Fowler's Consumer-Driven Contracts pattern is the **primary mechanism** for arbitrating breaking-change disputes between event producers and consumers:

- Each consumer publishes the subset of the contract it actually depends on (a "consumer pact").
- The producer's CI runs the union of all consumer pacts as a validation suite.
- A proposed change that breaks any consumer pact fails CI — the producer cannot ship until the consumer is also updated, or the consumer pact is explicitly retired with consumer team approval.

Pact (the tool, github.com/pact-foundation) is the de facto implementation. The pattern's value for arbitration is that it makes the conflict **automatically detectable**: the producer cannot unilaterally claim "no consumers depend on this field" — the pact files prove or disprove the claim before the change merges.

A platform without consumer-driven contract testing has no automated way to know which consumers are affected; arbitration in such a platform must be done by manual code search across consumer repositories, which is error-prone and the source of most production breakages.

### 5. Tolerant Reader (Fowler) — defensive consumer design

Tolerant Reader is the **dual** of consumer-driven contracts: while CDCT prevents producers from breaking consumers, Tolerant Reader prevents consumers from breaking themselves on benign producer changes.

The principle: a consumer should ignore fields it does not understand and use the loosest possible queries against the structure. For JSON: never validate with strict schema-by-default; pull the fields you need by name and ignore the rest. For XML: use `//order` not `/orders/order-list/order`. For event consumers: deserializers should be configured to **ignore unknown fields** (Jackson `FAIL_ON_UNKNOWN_PROPERTIES=false`, Protobuf default behavior, Avro with `union null` defaults).

A consumer that throws on unknown fields converts every additive (MINOR) producer change into a breaking-deploy event for that consumer. Fowler's exact framing: "practices such as tolerant deserialization help you delay versioning, and are useful practices even if you subsequently add semantic versioning support."

### 6. Deprecation windows

The IBM API design guidance and the AWS DevOps guidance both prescribe an explicit **deprecation window protocol** for breaking changes that cannot be avoided:

1. **Announce deprecation in version N.** Mark the old field/event as deprecated in documentation and in code (`@Deprecated` / `@deprecated`). Producer continues to write both old and new for the entire window.
2. **Parallel publish (double publish) for the duration of the window.** Producer writes both old and new field/event. This is Greg Young's "Double Publish" pattern from event-sourced versioning.
3. **Window length** is set by the slowest consumer's release cadence — typically **2-4 release cycles** for a system with weekly deploys, or **90 days minimum** for systems with quarterly consumer deploys.
4. **Consumer migration** happens during the window. Each consumer team independently switches from old to new and updates its consumer pact.
5. **Removal in version N+window.** Producer stops writing the old field/event. By this point, all consumer pacts have been updated and the producer's CI proves no consumer still depends on it.

The window is non-negotiable. Skipping the window because "the change is urgent" is the most common cause of cross-service production outages in event-driven systems.

### 7. Upcasting (event sourcing) — Greg Young

In event-sourced systems, events are immutable historical facts; old events live in the store forever. Greg Young's "Versioning in an Event Sourced System" identifies four strategies:

1. **Multiple versions of the event class.** Handlers exist for `InventoryItemDeactivated_v1` and `InventoryItemDeactivated_v2`. Each is independently maintained.
2. **Upcasting.** When an old event is read from the store, an upcaster transforms it on the fly into the new shape. The domain handler only sees the new shape. Upcasters live in a registry and are versioned themselves.
3. **In-place transformation.** Rewrite all stored events from old shape to new shape during a maintenance window. Loses the original wire form; rarely advisable.
4. **Copy and transform.** Create a new event store with the transformed shape, leave the old store untouched, switch reads. Used when the transformation is too expensive or risky for in-place.

Young's exact rule: "A new version of an event must be convertible from the old version of the event; if not, it is not a new version of the event but rather a new event." If the transformation is not deterministic, you have a NEW event type, and the old type must be retired through the deprecation window protocol — not silently replaced.

### 8. Event envelope design

The IBM, Microsoft, and Azure guidance for Kafka/Event Hubs/Service Bus all converge on a minimal envelope shape. For the aqua-saas platform's `BaseEvent` interface (`libs/event-contracts/src/base-event.ts`), the envelope should carry:

- `eventId` — UUID v4 or v7, idempotency key for consumers.
- `eventType` — PascalCase, fully-qualified (`messaging.MessageSent`, `farm.BatchHarvested`).
- `version` — SemVer string OR schema registry ID. Required.
- `timestamp` — ISO-8601 UTC, producer-side wall clock.
- `tenantId` — for multi-tenant routing and authorization.
- `traceId` / `spanId` — distributed tracing correlation.
- `producerService` — origin service name for debugging.
- `payload` — the domain-specific fields. **Flat or nested is a platform decision; the project rule "no nested payload object" must be enforced uniformly.**

Critical: the envelope itself is also a contract. Adding a required envelope field is a breaking change for **every** event in the system, not just one event type. Envelope changes go through a stricter review than payload changes.

### 9. Cross-team coordination — the policy aspect

Newman's "Building Microservices" 2nd ed. Ch. 5 and the Microsoft .NET microservices guidance are explicit that the contract policy must be enforced at the organizational level, not relied on as a courtesy:

- A producer team cannot unilaterally remove a field, even if "no one is using it." Proof of non-use must come from consumer-driven contract tests, not a code search.
- A consumer team cannot pin to an old version forever. Deprecation windows have hard end dates; consumers that miss the window get broken on purpose to force migration.
- Cross-team disputes about whether a change is breaking are resolved by **the schema registry's compatibility check**, not by negotiation. The registry is the source of truth.

This is where the architectural-arbiter has unambiguous authority: when an agent recommends a contract change, the arbiter checks the schema registry's compatibility mode, the existing consumer pacts, and the deprecation window status. If any of these block the change, the recommendation is rejected outright; if the change is genuinely additive, the arbiter approves and notifies affected agents.

## Architectural Implications for architectural-arbiter

When a domain agent recommends a change to an event contract or to `libs/event-contracts/src/`, the arbiter MUST:

1. **Classify the change** as additive or breaking using the §1 taxonomy. If breaking, automatic CRITICAL unless steps 2-5 are followed.
2. **Check the schema registry compatibility mode** (or the equivalent in-repo policy). A change that fails BACKWARD_TRANSITIVE check is rejected.
3. **Enumerate consumers** by reading the codebase or the consumer-pact directory. Cross-reference against the imported types from `@platform/event-contracts`. The list of consumers MUST be exhaustive — speculation is forbidden.
4. **Verify deprecation window compliance** for breaking changes — the change must be staged across the prescribed window with double-publish in the interim.
5. **Verify version bump** — additive changes get MINOR, breaking changes get MAJOR + new topic suffix. Missing bump is the change being shipped silently and is CRITICAL.
6. **Verify envelope discipline** — `BaseEvent` flat-object pattern, no nested `payload`/`metadata`, all required envelope fields populated, `eventType` PascalCase.

If any of these fail, the contract recommendation is rejected with a specific remediation requirement, and the originating agent must revise.

## Domain Rule Additions for architectural-arbiter

- Any recommendation that touches `libs/event-contracts/src/` or any file declaring an event-shape interface MUST be classified as additive or breaking before arbitration concludes. Unclassified contract changes = HIGH.
- Breaking event contract changes (remove field, rename field, change type, change `eventType`, narrow enum, tighten optional to required) without an explicit deprecation window plan = CRITICAL — recommendation is rejected and the originating agent must revise.
- Breaking changes without a MAJOR version bump AND a new topic/subject suffix (`.v2`) = CRITICAL.
- Additive changes without a MINOR version bump = HIGH (consumers cannot detect the new field's availability).
- Producer-side double publish during the deprecation window MUST be specified in the arbitration ADR. Missing double-publish step = CRITICAL (consumers will break the moment the producer flips).
- Consumer enumeration MUST be evidence-based: file paths and import sites of the affected event type, OR consumer-pact file references. "I checked and no one uses it" without paths = HIGH (false-negative risk is the leading cause of contract outages).
- Envelope-level contract changes (adding/removing fields on `BaseEvent` itself) MUST be reviewed against EVERY event type, not just the originating event. Envelope changes processed as single-event changes = CRITICAL.
- Tolerant Reader discipline for consumers: deserializers MUST be configured to ignore unknown fields. A consumer that throws on unknown fields MUST be flagged HIGH because it converts every additive change into a deploy break.
- Upcasters for event-sourced reads MUST be deterministic and side-effect-free. A non-deterministic upcaster (uses wall-clock, network, random) = CRITICAL (history becomes unreproducible).
- ADRs that resolve event contract conflicts MUST cite the schema registry compatibility check result, the consumer enumeration, and the deprecation window length explicitly. Missing any of these = HIGH (the decision cannot be re-grounded if challenged).
