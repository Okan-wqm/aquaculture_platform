---
name: hydroponics-service
description: Knowledge base for hydroponics-service - New minimal service for hydroponics system setup and configuration. Uses TenantSchemaMiddleware, CQRS, GraphQL Federation v2.
---

# Hydroponics Service Knowledge Base

## Overview
The hydroponics-service is a new, minimal service that manages hydroponics system configuration for aquaculture-integrated hydroponics (aquaponics). It currently has only the setup/configuration module implemented. The service follows the same patterns as other farm-service variants: TenantSchemaMiddleware for schema isolation, CQRS, GraphQL Federation v2. Port 4007 (note: different from 3000-3006 range).

## Directory Structure
```
apps/hydroponics-service/src/
  app.module.ts              # Root - TypeORM (no fixed schema), GraphQL Fed v2, CQRS, JWT
  main.ts
  middleware/
    tenant-schema.middleware.ts   # Sets search_path: "tenant_xxx", hydroponics, public

  setup/
    setup.module.ts              # HydroponicsSetupModule
    entities/
      hydroponics-config.entity.ts  # Core configuration entity
    resolvers/
      setup.resolver.ts            # GraphQL resolver for setup operations

  health/
    health.module.ts
    health.controller.ts
```

## Modules & Features

### HydroponicsSetupModule
The only feature module. Handles hydroponics system configuration:
- `SetupResolver`: GraphQL queries and mutations for hydroponics setup
- `HydroponicsConfig` entity: stores the hydroponics system configuration per tenant

### HealthModule
REST endpoint `/health` for service health checks.

## Key Entities

### HydroponicsConfig
The sole entity (very minimal). Likely includes:
- `id` (uuid), `tenantId`
- System type: NFT, DWC, Media Bed, Aquaponics
- `systemName`, `description`
- Grow bed configuration: dimensions, media type
- Fish tank integration: tankId (links to farm-service tank)
- Nutrient solution parameters: pH range, EC range, temperature range
- Plant zones: number, crop types
- Pump schedules, lighting schedules
- `isActive`, `createdAt`, `updatedAt`

(Exact fields should be confirmed from `hydroponics-config.entity.ts`)

## API / GraphQL (hydroponics subgraph)
Port 4007 (registered in gateway as `hydroponics`). Setup resolver provides:

### Queries
- `hydroponicsConfig(tenantId?)`: get current hydroponics configuration
- `hydroponicsConfigs`: list all configurations

### Mutations
- `createHydroponicsConfig(input)`: initial setup
- `updateHydroponicsConfig(id, input)`: modify configuration
- `deleteHydroponicsConfig(id)`: remove configuration

## Patterns Used
- **Apollo Federation v2** subgraph (registered in gateway as `hydroponics`)
- **CQRS** via `CqrsModule.forRoot()`
- **TenantSchemaMiddleware**: `search_path = "tenant_xxx", hydroponics, public`
- **RolesGuard** globally applied
- **JWT** for authentication (global JwtModule)
- **GraphQL security**: depth limit 10, complexity limit 1000
- Middleware chain: CorrelationId -> UserContext -> TenantContext -> TenantSchema

## Inter-Service Communication
- Links to farm-service via `tankId` in config (references tanks in farm schema)
- No NATS event bus in current implementation
- Gateway registers this service as `hydroponics` subgraph at `http://localhost:4007/graphql`

## Key Dependencies
- `@platform/backend-common` - RolesGuard, middleware
- `@nestjs/cqrs` - CQRS
- TypeORM with PostgreSQL (no fixed schema)
- `graphql-depth-limit`, `graphql-query-complexity`

## Known Gotchas
- **Port 4007** - different from the 3001-3006 range used by other services. Ensure docker-compose and gateway URL config use port 4007.
- **New service** - minimal implementation; many features likely planned but not yet built. The frontend (`web/modules/hydroponics-module/`) has much more functionality than the backend suggests.
- **No EventBus** - current implementation has no NATS event bus; not consuming or publishing events
- **No fixed schema** - like farm-service and hr-service, uses dynamic search_path; entity decorators must NOT have hardcoded schema
- **MODULE_SCHEMAS must be updated** - when new entities are added, `libs/backend-common/src/database/schema-manager.service.ts` must include `hydroponics_config` (and any new tables) in the hydroponics module tables list
- **Frontend ahead of backend** - the hydroponics frontend module (`web/modules/hydroponics-module/src/`) appears more developed than the backend service with components, hooks, context, data, and pages directories
- **Synchronize in non-production** - `app.module.ts` has `synchronize: configService.get('NODE_ENV') !== 'production'` which auto-syncs schema in dev. This is fine for the early stage but must use migrations for production.

## Status
This service is newly created and still in early development. The frontend hydroponics module is more advanced. When adding features:
1. Add entities with NO hardcoded schema decorator
2. Add to MODULE_SCHEMAS in schema-manager.service.ts
3. Follow CQRS pattern (command/query/handler)
4. Add resolver methods for new operations

## Related Services
- farm-service: hydroponics tanks may reference farm-service tanks
- admin-api-service: provisions hydroponics module tables during tenant creation
- gateway-api: registered as `hydroponics` subgraph (URL: HYDROPONICS_SERVICE_URL env var)
