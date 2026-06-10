/**
 * Domain event interface
 */
export interface DomainEvent {
  producerEventId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  schemaVersion?: number;
}

/**
 * Stored event with persistence metadata
 */
export interface PersistedEvent extends DomainEvent {
  id: string;
  producer?: string;
  streamName: string;
  globalPosition: number;
  streamPosition: number;
  aggregateType: string;
  aggregateId: string;
  version: number;
  tenantId: string;
  storedAt: Date;
}

/**
 * Result of appending events to a stream
 */
export interface AppendResult {
  success: boolean;
  streamName: string;
  newVersion: number;
  eventIds: string[];
  globalPositions: number[];
}

/**
 * Event stream slice from a read operation
 */
export interface EventStreamSlice {
  streamName: string;
  events: PersistedEvent[];
  fromVersion: number;
  nextVersion: number;
  isEndOfStream: boolean;
  streamPosition: StreamPosition;
}

/**
 * All events slice from a read all operation
 */
export interface AllEventsSlice {
  events: PersistedEvent[];
  fromPosition: number;
  nextPosition: number;
  isEndOfAll: boolean;
}

/**
 * Stream position tracking
 */
export interface StreamPosition {
  preparePosition: number;
  commitPosition: number;
}

/**
 * Snapshot data
 */
export interface SnapshotData {
  aggregateType: string;
  aggregateId: string;
  version: number;
  state: Record<string, unknown>;
  tenantId: string;
  createdAt: Date;
  schemaVersion: number;
}

/**
 * Options for reading events
 */
export interface ReadOptions {
  fromVersion?: number;
  maxCount?: number;
  direction?: 'forward' | 'backward';
  includeMetadata?: boolean;
}

/**
 * Options for reading all events
 */
export interface ReadAllOptions {
  fromPosition?: number;
  maxCount?: number;
  direction?: 'forward' | 'backward';
  eventTypes?: string[];
  aggregateTypes?: string[];
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Concurrency check result
 */
export interface ConcurrencyCheckResult {
  valid: boolean;
  currentVersion: number;
  expectedVersion: number;
  conflictingEvents?: PersistedEvent[];
}

/**
 * Transaction context passed to projection handlers.
 *
 * Handlers that write read-model state must use this manager for their
 * projection writes. The projections service records the inbox row and
 * checkpoint in the same transaction, so handler side effects, dedupe state,
 * and checkpoint movement commit or roll back together.
 */
export interface ProjectionHandlerContext {
  manager: EntityManager;
}

/**
 * Event handler callback type.
 *
 * Existing handlers that only accept `event` remain valid; transactional
 * handlers accept the second context argument and write through
 * `context.manager`.
 */
export type EventHandler = (
  event: PersistedEvent,
  context: ProjectionHandlerContext,
) => Promise<void>;

/**
 * Retry policy for failed event processing
 */
export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}
import type { EntityManager } from 'typeorm';
