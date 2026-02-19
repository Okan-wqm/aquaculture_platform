---
name: config-service
description: Knowledge base for config-service - Simple CQRS-based configuration CRUD service for key-value tenant configurations
---

# Config Service Knowledge Base

## Overview
The config-service is a simple key-value configuration store for tenant-scoped configuration data. It exposes a GraphQL Federation v2 subgraph for CRUD operations on configuration entries. CQRS pattern is used throughout. This is a minimal, focused service.

## Directory Structure
```
apps/config-service/src/
  app.module.ts              # Root - TypeORM, GraphQL Fed v2, no EventBus
  main.ts
  filters/
    global-exception.filter.ts

  configuration/
    configuration.module.ts
    configuration.resolver.ts       # GraphQL resolver
    entities/
      configuration.entity.ts       # Key-value config entry
    services/
      configuration.service.ts      # Business logic
    commands/
      create-configuration.command.ts
      update-configuration.command.ts
      delete-configuration.command.ts
    handlers/
      create-configuration.handler.ts
      update-configuration.handler.ts
      delete-configuration.handler.ts
    queries/
      get-configuration.query.ts
      get-configurations.query.ts
    query-handlers/
      get-configuration.handler.ts
      get-configurations.handler.ts
    dto/
      create-configuration.input.ts

  health/
    health.module.ts
    health.controller.ts
    health.service.ts
```

## Modules & Features

### ConfigurationModule
The sole feature module. Provides CRUD operations for configuration entries:
- `ConfigurationService`: business logic (validation, defaults)
- `CreateConfigurationHandler`: creates a new config entry
- `UpdateConfigurationHandler`: updates existing config entry
- `DeleteConfigurationHandler`: soft or hard deletes config entry
- `GetConfigurationHandler`: fetches single config by key
- `GetConfigurationsHandler`: lists configs with filtering
- `ConfigurationResolver`: GraphQL interface

### HealthModule
REST endpoint `/health` for service health checks (includes database health check via `health.service.ts`).

## Key Entities

### Configuration
- `id` (uuid), `tenantId`
- `key` (string): namespaced config key (e.g., `feeding.defaultRation`, `alerts.emailEnabled`)
- `value` (string | JSONB): the configuration value
- `dataType`: string | number | boolean | json
- `description`: human-readable description of the config entry
- `isEncrypted`: whether the value is encrypted at rest (for secrets)
- `tags`: array of string tags for categorization
- `createdAt`, `updatedAt`, `createdBy`, `updatedBy`
- Unique index on `[tenantId, key]`

## API / GraphQL (config subgraph)

### Queries
- `configuration(key: String!): Configuration` - get single config by key
- `configurations(filter: ConfigFilter): [Configuration!]` - list configs, filterable by tags, key prefix

### Mutations
- `createConfiguration(input: CreateConfigurationInput!): Configuration`
- `updateConfiguration(id: ID!, input: UpdateConfigurationInput!): Configuration`
- `deleteConfiguration(id: ID!): Boolean`
- `bulkCreateConfigurations(inputs: [CreateConfigurationInput!]!): [Configuration!]`

### Input Types
```graphql
input CreateConfigurationInput {
  key: String!
  value: String!
  dataType: ConfigDataType
  description: String
  isEncrypted: Boolean
  tags: [String!]
}
```

## Patterns Used
- **CQRS** - all write operations through Commands, reads through Queries
- **Apollo Federation v2** subgraph
- **TenantSchemaMiddleware** (if present) or `tenantId` column filter per query
- Minimal service design - no event bus, no external integrations

## Inter-Service Communication
- Minimal inter-service communication
- Other services may call config-service to retrieve configuration values
- No NATS events published or consumed (this service is a simple store)

## Key Dependencies
- `@nestjs/cqrs` or `@platform/cqrs` - CQRS bus
- TypeORM with PostgreSQL
- `@nestjs/apollo` with `ApolloFederationDriver`
- `@platform/backend-common` - shared middleware

## Known Gotchas
- **No EventBus** - this service deliberately has no event bus integration; it is a simple CRUD store
- **Tenant scoping** - all config entries are scoped by `tenantId`; queries without tenantId should fail or return nothing
- **Encrypted values** - when `isEncrypted: true`, the actual encryption/decryption may be handled at the service level (not in entity)
- **Key namespacing convention** - keys use dot notation (e.g., `module.setting.subkey`); document clearly what namespace each module uses
- **No schema fixed** - check if service uses TenantSchemaMiddleware or `tenantId` column. Based on structure (no middleware visible), it likely uses tenantId column filtering approach.

## Related Services
- All other services: may fetch configuration values from this service
- admin-api-service: may seed default configurations during tenant provisioning
