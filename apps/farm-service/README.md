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
├── sentinel-hub/     # Satellite imagery integration
└── water-quality/    # Water quality monitoring
```

## Security

### Authentication & Authorization

All GraphQL resolvers are protected with `@UseGuards(GqlAuthGuard)`:

```typescript
@UseGuards(GqlAuthGuard)
@Resolver(() => Entity)
export class EntityResolver { }
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

Sensitive data (API keys, credentials) is encrypted at rest:

```typescript
// Required environment variables
ENCRYPTION_KEY=your-32-char-minimum-key
SENTINEL_HUB_ENCRYPTION_KEY=optional-override
REGULATORY_ENCRYPTION_KEY=optional-override
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `ENCRYPTION_KEY` | AES-256 encryption key (min 32 chars) | Yes |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | Production |
| `JWT_SECRET` | JWT signing secret | Yes |
| `SENTINEL_HUB_CLIENT_ID` | Sentinel Hub API client ID | No |
| `SENTINEL_HUB_INSTANCE_ID` | Sentinel Hub instance ID | No |

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

| Job | Schedule | Description |
|-----|----------|-------------|
| Daily Feeding Generation | 0 4 * * * | Generate feeding schedules |
| Maintenance Check | 0 6 * * * | Check upcoming maintenance |
| Stock Level Check | 0 7 * * * | Check spare part stock levels |
| FCR Calculation | 0 0 * * 0 | Weekly FCR calculations |

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

## License

Proprietary - All rights reserved
