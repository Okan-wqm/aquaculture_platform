export type EventPosition = string;

/**
 * Domain event interface
 */
export interface DomainEvent {
  eventType: string;
  payload: Record<string, unknown>;
  producer: string;
  producerEventId: string;
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
  streamName: string;
  globalPosition: EventPosition;
  streamPosition: EventPosition;
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
  globalPositions: EventPosition[];
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
  fromPosition: EventPosition;
  nextPosition: EventPosition;
  isEndOfAll: boolean;
}

/**
 * Stream position tracking
 */
export interface StreamPosition {
  preparePosition: EventPosition;
  commitPosition: EventPosition;
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
  fromPosition?: EventPosition;
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
 * Event handler callback type
 */
export interface ProjectionHandlerContext {
  manager: EntityManager;
  tenantId: string;
  projectionName: string;
  sourceGeneration: number;
  targetGeneration: number;
  leaseToken: string | null;
  mode: 'live' | 'rebuild';
  outboxPolicy: 'transactional' | 'disabled';
}

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
