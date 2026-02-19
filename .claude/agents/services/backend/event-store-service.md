---
name: event-store-service
description: Knowledge base for event-store-service - Event sourcing persistence, projections, snapshots, and event stream management
---

# Event Store Service Knowledge Base

## Overview
The event-store-service provides event sourcing infrastructure for the aquaculture platform. It stores domain events as an ordered, immutable log (event streams), manages projections (materialized views derived from events), and maintains aggregate snapshots for performance. It is an infrastructure service used by other services to implement event sourcing patterns.

## Directory Structure
```
apps/event-store-service/src/
  app.module.ts              # Root - TypeORM, REST controllers
  main.ts
  filters/
    global-exception.filter.ts

  event-store/
    event-store.module.ts
    event-store.controller.ts    # REST endpoints for event storage/retrieval
    entities/
      stored-event.entity.ts     # Persisted domain event
      snapshot.entity.ts         # Aggregate state snapshot
      event-stream.entity.ts     # Event stream (per aggregate)
    services/
      event-store.service.ts     # Core event persistence and retrieval
    interfaces/
      event-store.interfaces.ts  # IEvent, IEventStore interfaces
    dto/
      event-store.dto.ts         # AppendEventsDto, GetEventsDto
    __tests__/
      event-store.controller.spec.ts

  projections/
    projections.module.ts
    projections.controller.ts    # REST endpoints for projection management
    projections.service.ts       # Runs projections on event streams
    entities/
      projection-checkpoint.entity.ts  # Tracks projection progress (last processed event)

  health/
    health.module.ts
    health.controller.ts
    health.service.ts
```

## Modules & Features

### EventStoreModule
- `EventStoreService`: core service for event sourcing
  - `appendEvents(streamId, events, expectedVersion)`: appends events to a stream (optimistic concurrency)
  - `getEvents(streamId, fromVersion, toVersion)`: retrieves events from a stream
  - `getEventsByType(eventType, fromTimestamp)`: cross-stream event retrieval by type
  - `createSnapshot(aggregateId, state, version)`: creates/updates aggregate snapshot
  - `getSnapshot(aggregateId)`: retrieves latest snapshot for fast aggregate reconstruction
- `EventStoreController`: REST API for event append and retrieval
- Implements `IEventStore` interface

### ProjectionsModule
- `ProjectionsService`: runs read model projections against event streams
  - `runProjection(projectionName, handler)`: executes a projection function
  - `getCheckpoint(projectionName)`: retrieves last processed position
  - `updateCheckpoint(projectionName, position)`: updates checkpoint after processing
- `ProjectionCheckpoint` entity: tracks per-projection progress to support restart/resume
- `ProjectionsController`: REST API for projection management

### HealthModule
Checks database connectivity and reports service health.

## Key Entities

### StoredEvent
- `id` (uuid, auto-generated)
- `streamId` (string): identifies the aggregate stream (e.g., `batch-{id}`, `farm-{id}`)
- `eventType` (string): domain event type name (e.g., `BatchCreated`, `FeedingRecorded`)
- `data` (JSONB): serialized event payload
- `metadata` (JSONB): correlation ID, causation ID, user ID, timestamp
- `version` (bigint): monotonically increasing version within stream
- `globalPosition` (bigint): global ordering across all streams
- `occurredAt` (timestamptz): when the event occurred in the domain

### EventStream
- `id` (string): stream identifier
- `aggregateType` (string): e.g., `Batch`, `Farm`, `Tank`
- `currentVersion` (bigint): latest version for optimistic concurrency
- `createdAt`, `updatedAt`

### Snapshot
- `aggregateId` (string): links to event stream
- `aggregateType` (string)
- `state` (JSONB): serialized aggregate state at `version`
- `version` (bigint): the event version this snapshot represents
- `createdAt`

### ProjectionCheckpoint
- `projectionName` (string, unique): identifies the projection
- `lastProcessedGlobalPosition` (bigint): the global position of the last processed event
- `updatedAt`

## API (REST only - no GraphQL)

### Event Store Endpoints
```
POST /event-streams/:streamId/events
  Body: AppendEventsDto { events: EventDto[], expectedVersion?: number }
  Response: { newVersion: number }

GET  /event-streams/:streamId/events
  Query: from?, to?, limit?
  Response: StoredEvent[]

GET  /event-streams/:streamId/snapshot
  Response: Snapshot

GET  /events?type=BatchCreated&from=2024-01-01
  Response: StoredEvent[]
```

### Projections Endpoints
```
GET  /projections                 # List all projections and their checkpoint
GET  /projections/:name/checkpoint  # Get checkpoint for specific projection
POST /projections/:name/reset     # Reset projection (re-process from beginning)
```

### Health Endpoint
```
GET /health
```

## Patterns Used
- **Event Sourcing**: events are the source of truth; state derived from events
- **Optimistic concurrency**: `expectedVersion` parameter prevents concurrent write conflicts
- **Snapshots**: periodic state snapshots avoid replaying entire event history
- **Projections with checkpoints**: resumable projections that track their position
- **Global ordering**: `globalPosition` enables cross-stream event processing in order
- **Immutable event log**: events are append-only; never updated or deleted

## Inter-Service Communication
Other services use this service's REST API to:
- Append events after domain operations
- Read events for aggregate reconstruction
- Run projections for read models

The event-store-service itself does NOT publish NATS events (it is a storage infrastructure layer).

Relies on:
- PostgreSQL for persistent event storage

## Key Dependencies
- TypeORM with PostgreSQL (for event persistence)
- No `@platform/event-bus` (this service IS the event infrastructure, not a consumer)
- No GraphQL

## Key Configuration
```
# Database - uses SEPARATE database 'aquaculture_events'
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD
DB_NAME=aquaculture_events           # NOT the main aquaculture database!
DB_SSL, DB_POOL_SIZE (default 20)

PORT=3009 (or similar)
```

## Known Gotchas
- **Separate database** - event-store uses `aquaculture_events` (not `aquaculture`). Ensure separate PostgreSQL database exists. Config uses `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`/`DB_NAME` (different prefix from other services which use `DATABASE_*`)
- **CQRS** - event-store-service uses NestJS built-in `@nestjs/cqrs` CqrsModule (NOT `@platform/cqrs`)
- **No GraphQL** - REST only; no Apollo Federation subgraph
- **Immutable events** - events in the store are NEVER updated. If data correction is needed, append a corrective event (e.g., `BatchCorrected`)
- **Optimistic concurrency** - always pass `expectedVersion` when appending events to prevent lost updates. The store rejects appends if current version doesn't match.
- **Snapshot strategy** - snapshots are created every N events (configurable). Without snapshots, reading a stream with 10,000 events to get current state is slow.
- **Projection ordering** - projections MUST process events in `globalPosition` order for consistency
- **No GraphQL** - REST only
- **Event schema evolution** - when event payload structure changes, maintain backward compatibility in `data` JSONB or use event upcasting
- **Large event payloads** - avoid storing binary data (images, files) in events; store references to object storage instead
- **Projection idempotency** - projections must be idempotent (processing same event twice produces same result) because they may be replayed

## Related Services
- All services that implement event sourcing: append events here after commands succeed
- admin-api-service: may query events for audit/analytics
- The event-store is distinct from NATS (NATS is for real-time pub/sub; event-store is for permanent event log)
