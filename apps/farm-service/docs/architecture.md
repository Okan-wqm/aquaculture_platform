# Farm Service Architecture

## Request Flow

`gateway-api -> farm-service -> GraphQL context -> CQRS handler -> domain policy -> tenant transaction -> audit and outbox`.

## Main Modules

- `batch`: batch lifecycle, tank allocation, mortality, cull, cleaner fish.
- `tank`: tank registry, capacity policy, operational status.
- `feeding`: feed inventory and feeding records.
- `growth`: growth samples, SGR and FCR calculations.
- `water-quality`: measurements, parameter config, evaluation.
- `fish-health`: health events and harvest eligibility.
- `harvest`: plans and harvest records.
- `sentinel-hub`: server-side satellite proxy and credentials.
- `farm-stock`: read model for inventory and biomass views.

## Boundaries

Business writes go through CQRS handlers. Domain policies own business rules. Persistence infrastructure owns migrations, source schema bootstrap, tenant schema sync, and outbox relay.

## Contracts

- Security: `docs/architecture/farm-service-security-boundaries.md`.
- Tenant isolation: `docs/architecture/farm-service-tenant-isolation.md`.
- API posture: `docs/architecture/ADR-farm-api-contract-posture.md`.
- Persistence: `docs/architecture/ADR-farm-persistence-boundary.md`.
- Eventing: `docs/architecture/ADR-farm-eventing-outbox-inbox.md`.
