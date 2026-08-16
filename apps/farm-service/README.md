# Farm Service

Multi-tenant aquaculture farm management microservice built with NestJS, GraphQL, and TypeORM.

## Features

- **Farm Management**: Sites, departments, systems, and equipment hierarchy
- **Batch Tracking**: Fish batch lifecycle management with mortality tracking
- **Feeding Management**: Feed schedules, inventory, and consumption tracking
- **Growth Monitoring**: Growth measurements and FCR calculations
- **Maintenance**: Work orders, spare parts, and preventive maintenance schedules
- **Harvest Management**: Harvest records and statistics
- **Water Quality**: Sensor integration and quality monitoring
- **Tenant Environmental Monitoring**: Site-scoped MET Norway weather, CMEMS
  marine models, and exact CDSE Sentinel-2 scenes
- **Regulatory Compliance**: Reporting and regulatory settings

## Architecture

```
src/
├── common/           # Shared utilities, guards, decorators
│   ├── guards/       # Authentication guards (GqlAuthGuard)
│   └── utils/        # Utilities (schema-sanitizer, etc.)
├── database/         # Database module, migrations, seeding
├── batch/            # Batch management (CQRS)
├── feeding/          # Feeding records, inventory, scheduling
├── growth/           # Growth measurements, FCR calculations
├── harvest/          # Harvest records and statistics
├── maintenance/      # Work orders, spare parts, schedules
├── farm/             # Farm entity and resolvers
├── site/             # Site management
├── department/       # Department management
├── system/           # System hierarchy
├── equipment/        # Equipment management
├── tank/             # Tank management
├── species/          # Species definitions
├── scheduler/        # Cron jobs and scheduled tasks
├── events/           # Event listeners (EventEmitter2)
├── fish-health/      # Health events and treatments
├── regulatory/       # Regulatory settings and reporting
├── sentinel-hub/     # Internal CDSE credential cutover and imagery boundary
├── weather/          # Canonical environmental ingestion, reads, and scheduling
└── water-quality/    # Water quality monitoring
```

## Security

### Authentication & Authorization

All GraphQL resolvers are protected with `@UseGuards(GqlAuthGuard)`:

```typescript
@UseGuards(GqlAuthGuard)
@Resolver(() => Entity)
export class EntityResolver {}
```

Role-based access control is enforced with `@Roles()` decorator:

```typescript
@Roles(Role.ADMIN, Role.MANAGER)
@Mutation(() => Entity)
async createEntity() { }
```

### Multi-Tenancy

- Each tenant has isolated PostgreSQL schema (`tenant_{id}`)
- Schema names are sanitized using `getTenantSchemaName()` utility
- Tenant context is validated in middleware before each request

### SQL Injection Prevention

Schema names are validated through `schema-sanitizer.ts`:

```typescript
import { getTenantSchemaName } from '../common/utils/schema-sanitizer';

const schemaName = getTenantSchemaName(tenantId);
// Validates: only [a-z0-9_], blocks reserved schemas
```

### Encryption

Sensitive data (API keys and credentials) is encrypted at rest with distinct
key domains. Provision `ENCRYPTION_KEY`, `REGULATORY_ENCRYPTION_KEY`, and,
during legacy satellite credential cutover,
`SENTINEL_HUB_ENCRYPTION_KEY` through the deployment secret store. Never place
their values in source, Compose files, documentation, or logs.

CDSE client credentials are company-owned secrets stored by `config-service`.
They are not accepted from tenant browsers or farm-service environment
variables. The Sentinel encryption key only decrypts legacy tenant rows during
the audited one-shot cutover into that configuration SSoT.

## Environment Variables

| Variable                              | Description                                                                              | Required                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| `DATABASE_URL`                        | PostgreSQL connection string                                                             | Yes                        |
| `ENCRYPTION_KEY`                      | AES-256 encryption key (min 32 chars)                                                    | Yes                        |
| `CORS_ORIGINS`                        | Allowed CORS origins (comma-separated)                                                   | Production                 |
| `JWT_PUBLIC_KEY`                      | RSA public key (RS256) — inline PEM. See also `JWT_PUBLIC_KEY_FILE` for path-based load. | Yes                        |
| `FARM_ENVIRONMENT_MONITORING_ENABLED` | Canonical reader/writer rollout gate; missing defaults to `false`                        | No                         |
| `MET_NORWAY_APPLICATION_NAME`         | Company application identifier sent to MET Norway                                        | When monitoring is enabled |
| `MET_NORWAY_CONTACT`                  | Company operational email or HTTPS contact sent to MET Norway                            | When monitoring is enabled |
| `MET_NORWAY_FROST_CLIENT_ID`          | Company Frost public-data client ID                                                      | For Frost observations     |
| `SENTINEL_HUB_ENCRYPTION_KEY`         | Dedicated key for decrypting legacy tenant credential rows during cutover                | During credential cutover  |

## Event-Driven Architecture

The service uses EventEmitter2 for domain events:

### Published Events

- `batch.created` - New batch created
- `mortality.recorded` - Mortality event recorded
- `harvest.completed` - Harvest completed
- `maintenance.schedule.due` - Maintenance schedule due
- `stock.low` - Spare part stock below minimum
- `feeding.completed` - Feeding record completed

### Event Listeners

Located in `src/events/listeners/`:

- `BatchCreatedListener` - Initialize batch metrics
- `MortalityRecordedListener` - Update batch counts, alert if threshold exceeded
- `HarvestCompletedListener` - Update batch status, calculate yields
- `MaintenanceScheduleDueListener` - Auto-generate work orders
- `LowStockAlertListener` - Send notifications for low stock
- `FeedingCompletedListener` - Update inventory, calculate daily totals

## Scheduled Tasks

Cron jobs managed by `@nestjs/schedule`:

| Job                       | Schedule       | Description                                                      |
| ------------------------- | -------------- | ---------------------------------------------------------------- |
| Daily Feeding Generation  | 0 4 \* \* \*   | Generate feeding schedules                                       |
| Maintenance Check         | 0 6 \* \* \*   | Check upcoming maintenance                                       |
| Stock Level Check         | 0 7 \* \* \*   | Check spare part stock levels                                    |
| FCR Calculation           | 0 0 \* \* 0    | Weekly FCR calculations                                          |
| Environment Provider Sync | `*/15 * * * *` | Claim due site/provider leases and ingest canonical observations |
| Environment Retention     | 0 3 \* \* \*   | Apply the 45-day canonical observation retention policy          |

Environmental jobs are fail-closed behind
`FARM_ENVIRONMENT_MONITORING_ENABLED`. Deployment order, credential cutover,
validation, alerts, and rollback are defined in
[`docs/runbooks/monitoring/farm-environment-monitoring.md`](../../docs/runbooks/monitoring/farm-environment-monitoring.md).

### Memory Management

Scheduler services implement automatic cleanup:

- TTL-based expiration (24 hours for inactive tenant configs)
- Periodic cleanup (every hour)
- `OnModuleDestroy` for graceful shutdown

## Database

### Migrations

```bash
# Run migrations
npm run migration:run

# Generate new migration
npm run migration:generate -- -n MigrationName

# Revert last migration
npm run migration:revert
```

### Multi-Schema Architecture

```
PostgreSQL
├── public          # Shared tables (tenants, users)
├── farm            # Farm-specific shared tables
└── tenant_{id}     # Per-tenant isolated data
```

## Development

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- pnpm

### Setup

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run start:dev farm-service

# Run tests
pnpm run test farm-service

# Build for production
pnpm run build farm-service
```

### GraphQL Playground

Available at `http://localhost:3001/graphql` in development mode.

## Testing

```bash
# Unit tests
pnpm run test farm-service

# E2E tests
pnpm run test:e2e farm-service

# Coverage report
pnpm run test:cov farm-service
```

## API Documentation

GraphQL schema is auto-generated. Key queries and mutations:

### Batches

- `batches(filter: BatchFilterInput)` - List batches
- `batch(id: ID!)` - Get single batch
- `createBatch(input: CreateBatchInput!)` - Create batch
- `recordMortality(input: RecordMortalityInput!)` - Record mortality

### Feeding

- `feedingRecords(filter: FeedingFilterInput)` - List feeding records
- `createFeedingRecord(input: CreateFeedingRecordInput!)` - Create record
- `feedInventory(tenantId: ID!)` - Get feed inventory

### Maintenance

- `workOrders(filter: WorkOrderFilterInput)` - List work orders
- `createWorkOrder(input: CreateWorkOrderInput!)` - Create work order
- `completeWorkOrder(id: ID!)` - Complete work order
- `maintenanceSchedules` - List maintenance schedules
- `spareParts` - List spare parts

### Growth

- `growthMeasurements(batchId: ID!)` - Get measurements
- `recordGrowthSample(input: RecordGrowthSampleInput!)` - Record sample
- `calculateFCR(batchId: ID!)` - Calculate FCR

## Performance Optimizations

### N+1 Query Prevention

- Batch fetching with TypeORM `In()` operator
- `Map`-based lookups for O(1) access
- Eager loading with `relations` option

### Transaction Management

Critical operations use QueryRunner for ACID compliance:

```typescript
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();
try {
  // operations
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}
```

## Contributing

1. Follow NestJS best practices
2. Add `@UseGuards(GqlAuthGuard)` to all resolvers
3. Use `@Roles()` for mutations
4. Add validation decorators to DTOs
5. Write unit tests for services
6. Use parameterized queries for SQL

## Changelog

### Recent Audit & Improvements (January 2026)

#### ec9c2c5 - Comprehensive farm-service audit fixes

- Added JwtAuthGuard to REST controllers
- Fixed secret exposure in SentinelHub resolver
- Added transaction management to create-batch, transfer-batch, create-harvest handlers
- Fixed MaskinportenService memory leak with TTL-based cache cleanup
- Fixed N+1 queries with batch fetching in 7+ files

#### e5badfe - Security hardening and code quality improvements

- Added GqlAuthGuard to 10 unprotected resolver classes
- Created schema-sanitizer utility for SQL injection prevention
- Fixed 13 empty catch blocks with proper error logging
- Added comprehensive README documentation

#### e1690fc - Critical bug fixes and security improvements

- Removed hardcoded encryption keys (now via ConfigService)
- Fixed division by zero in growth-measurement and fcr-calculation
- Replaced wildcard CORS with environment-based configuration
- Added memory leak prevention in scheduler services

#### 446bdb4 - Comprehensive farm-service improvements

- Added 27 new DTO files with validation decorators
- Created EventListenersModule with 6 event listeners
- Added transaction management to critical operations
- Fixed SQL injection with parameterized queries

#### aa11c18 - TypeScript errors and README documentation

- Fixed TypeScript compilation errors
- Added comprehensive README documentation

### Audit Status

| Category               | Status  | Notes                      |
| ---------------------- | ------- | -------------------------- |
| TypeScript Compilation | ✅ Pass | All errors fixed           |
| Security (Guards)      | ✅ Pass | All resolvers protected    |
| Security (RBAC)        | ✅ Pass | @Roles on mutations        |
| SQL Injection          | ✅ Pass | Schema sanitization        |
| N+1 Queries            | ✅ Pass | Batch fetching implemented |
| Transaction Management | ✅ Pass | Critical handlers covered  |
| Memory Management      | ✅ Pass | TTL cleanup implemented    |
| Error Handling         | ✅ Pass | Proper type guards         |
| Module Structure       | ✅ Pass | No circular deps           |
| Test Coverage          | ⚠️ 21%  | Needs improvement          |

### Known Limitations

- FishHealthModule is scaffolded but not fully implemented
- Test coverage at 21% (priority for future sprints)
- Some TODO comments for EventBus integration pending

## License

Proprietary - All rights reserved
