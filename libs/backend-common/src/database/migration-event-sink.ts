/**
 * MigrationEventSink — decoupled hook for migration lifecycle events.
 * ============================================================================
 *
 * Phase 6 integration layer: per-service MigrationRunnerService (lib-
 * level) emits start/applied/failed/skipped events via this interface
 * WITHOUT depending on observability-service's CQRS surface. Keeps
 * backend-common free of cross-app coupling while letting observability
 * (or any future consumer) persist the event stream.
 *
 * # Why an interface, not a direct CQRS dispatch
 *
 * Three deployment realities forced the decoupling:
 *
 *   1. MigrationRunnerService lives in `libs/backend-common` and must
 *      NOT import from `apps/observability-service` — that's a
 *      cross-app dependency the Nx module boundary guard rejects.
 *
 *   2. Every backend service wires MigrationRunnerService via
 *      `createMigrationRunnerService(schema)`. Only services that
 *      carry `observability-audit` in their module graph (currently
 *      observability-service itself + the admin-api-service orchestrator
 *      in Phase 6 Step 2) should emit. Others get a `NoopSink` that
 *      discards.
 *
 *   3. Production emits via CQRS → DB. Local development emits via
 *      stdout logger. Tests emit into an in-memory buffer that the
 *      spec then asserts against. Three implementations of one
 *      interface.
 *
 * # Interface contract
 *
 * Emitting MUST NOT throw. A sink that propagates failure to the
 * migration runner would turn an observability hiccup into a deploy
 * rollback — the wrong blast radius. Implementations swallow + log
 * their own errors; the runner never fails because the sink did.
 */

export type MigrationSinkEventType =
  | 'start'
  | 'applied'
  | 'failed'
  | 'skipped';

export interface MigrationSinkEvent {
  readonly serviceName: string;
  readonly migrationName: string;
  readonly eventType: MigrationSinkEventType;
  readonly occurredAt: Date;
  /**
   * Present for tenant fan-out events; the runner computes the
   * cleartext tenant schema (e.g. `tenant_abc123...`) and the sink
   * HMACs before persisting per ADR-022. Undefined for source-schema
   * lifecycle events.
   */
  readonly tenantSchema?: string;
  readonly durationMs?: number;
  /**
   * Raw error object for 'failed' events. Sink is responsible for
   * sanitization via sanitizePgError + assertNoPgRowLeak before any
   * durable write.
   */
  readonly error?: unknown;
}

/**
 * Everyone except the runner consumes this interface. The runner
 * builds events and calls `emit(ev)`. Sink returns void — fire-and-
 * forget. Callers MUST NOT `await` the return value assuming it
 * guarantees durability; durability is a sink implementation detail.
 */
export interface MigrationEventSink {
  emit(event: MigrationSinkEvent): void | Promise<void>;
}

/**
 * Default — discards every event. Services that don't wire observability
 * use this so the runner's emit calls are no-ops. Production services
 * wire a CQRS-backed implementation via their DI module.
 */
export class NoopMigrationEventSink implements MigrationEventSink {
  emit(_event: MigrationSinkEvent): void {
    // no-op
  }
}

/**
 * Buffered in-memory sink — for test specs that need to assert
 * events were emitted. Never use in production (unbounded growth).
 */
export class InMemoryMigrationEventSink implements MigrationEventSink {
  readonly events: MigrationSinkEvent[] = [];

  emit(event: MigrationSinkEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Structured-logger sink — emits via a caller-supplied logger fn.
 * Useful for local dev + staging environments where durable capture
 * isn't required but a visible audit trail is.
 */
export class LoggerMigrationEventSink implements MigrationEventSink {
  constructor(
    private readonly log: (msg: string, data?: Record<string, unknown>) => void,
  ) {}

  emit(event: MigrationSinkEvent): void {
    const safeData: Record<string, unknown> = {
      serviceName: event.serviceName,
      migrationName: event.migrationName,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
    };
    if (event.tenantSchema !== undefined) {
      // Log the cleartext schema — in dev/staging only. Production
      // sinks MUST HMAC before persist; a logger sink intended for
      // production would wrap this class + hash before calling log.
      safeData['tenantSchema'] = event.tenantSchema;
    }
    if (event.durationMs !== undefined) safeData['durationMs'] = event.durationMs;
    if (event.error !== undefined) {
      safeData['hadError'] = true;
      // We don't serialize the error object to avoid PII leakage —
      // the CQRS-backed production sink sanitizes properly.
    }
    try {
      this.log(
        `migration-event: ${event.serviceName} ${event.eventType} ${event.migrationName}`,
        safeData,
      );
    } catch {
      // Logger failure MUST NOT propagate to the runner.
    }
  }
}
