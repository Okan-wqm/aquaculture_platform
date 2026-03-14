# ADR-007: CQRS Usage Strategy

**Date:** 2026-03-14
**Status:** Accepted
**Deciders:** Platform Team

---

## Context

The platform uses CQRS (Command/Query Responsibility Segregation) pattern inconsistently across services:

- **admin-api-service**: CQRS only in tenant module (6 command handlers, 8 query handlers). Other modules (billing, settings, security, support, etc.) use classic Controller -> Service pattern.
- **farm-service**: CQRS imported in app.module and all 19 submodules (farm, batch, feeding, harvest, etc.) but actual handler usage limited to equipment module.
- **hr-service**: CQRS active in hr, attendance, leave, training, scheduling, aquaculture modules with dedicated command/query handlers.
- **billing-service, config-service, hydroponics-service**: CqrsModule imported but minimal handler usage.
- **sensor-service, alert-engine**: No CQRS usage.

This is organic growth, not a deliberate architectural decision.

## Decision

CQRS is **not mandated platform-wide**. Each service chooses its own pattern based on domain complexity:

1. **admin-api-service**: CQRS remains tenant-module-only. Other modules continue with Controller -> Service.
2. **hr-service**: Full CQRS is appropriate -- complex workflows (leave approval chains, attendance state machines) benefit from explicit command/query separation.
3. **farm-service**: CqrsModule is imported but most modules use classic services. No obligation to add handlers where services suffice.
4. **New modules**: Default to Controller -> Service. Adopt CQRS only when domain complexity justifies it (state machines, event sourcing, multi-step workflows).

## Consequences

**Positive:**
- No forced migration of working classic services to CQRS
- Teams choose the right tool for domain complexity
- Tenant and HR modules retain their well-structured CQRS implementations

**Negative:**
- Developers must understand both patterns when working across services
- No single "look here for business logic" convention -- some modules use handlers, others use services
