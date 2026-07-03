import { Injectable, Logger } from '@nestjs/common';

/**
 * CompositionStateService — shared readiness state for background supergraph composition.
 *
 * ARCH-GW-006: Decoupling liveness from composition.
 *
 * # The two halves of this contract
 *
 * This service is the single, in-process source of truth for "has the live
 * supergraph schema finished composing yet?". It has exactly two collaborators:
 *
 *   1. WRITER — {@link BackgroundCompositionManager}. The manager runs the real
 *      RetryableIntrospectAndCompose introspection in the BACKGROUND (off the
 *      NestFactory.create() critical path). When that background cycle finishes
 *      it WRITES the outcome here: success -> {@link markComposed}, terminal
 *      failure -> {@link markCompositionError}. The manager never throws on a
 *      background failure — the failure is recorded here and in the logs.
 *
 *   2. READER — {@link HealthService#getReadiness}. The readiness probe READS
 *      {@link isComposed} (and {@link getLastError} for diagnostics) to decide
 *      whether /health/ready should report ready. Until composition completes,
 *      /health/ready returns not_ready WITHOUT fanning out to the subgraphs —
 *      there is nothing to be ready for until the live schema exists.
 *
 * # Why a dedicated @Global() singleton instead of a field on the manager
 *
 * The manager is constructed inside the GraphQLModule.forRootAsync factory and
 * handed to Apollo Gateway; it is NOT a Nest provider, so HealthService cannot
 * inject it directly. This service IS a Nest provider (exported from a @Global()
 * module), so both the factory (which passes it INTO the manager) and
 * HealthService (which injects it) observe the exact same instance.
 *
 * # markCompositionError does NOT reset `composed`
 *
 * Once the live schema has composed at least once, a LATER poll-cycle failure
 * must not flip the gateway back to not_ready: Apollo keeps serving the
 * last-good schema (the same semantics IntrospectAndCompose polling has). We
 * record the error for observability but leave readiness intact. The gateway
 * only reports not_ready while it has never had a usable schema at all.
 */
@Injectable()
export class CompositionStateService {
  private readonly logger = new Logger(CompositionStateService.name);

  /**
   * True once the live supergraph schema has composed successfully at least
   * once. Latching: a later poll failure does not reset it (see class docblock).
   */
  private composed = false;

  /** Last terminal composition error message, for /health/ready diagnostics. */
  private lastError: string | null = null;

  /** Timestamp of the most recent successful composition. */
  private lastComposedAt: Date | null = null;

  /**
   * WRITER entrypoint: a background composition cycle produced a usable live
   * supergraph schema. Latches readiness on, clears any prior error, and
   * records when it happened.
   */
  markComposed(): void {
    this.composed = true;
    this.lastError = null;
    this.lastComposedAt = new Date();
    this.logger.log('Supergraph composition succeeded; gateway is now ready.');
  }

  /**
   * WRITER entrypoint: a background composition cycle failed terminally. Records
   * the error for diagnostics but does NOT reset {@link composed} — once a live
   * schema exists, Apollo keeps serving it (see class docblock).
   *
   * @param message - human-readable failure reason from the composer.
   */
  markCompositionError(message: string): void {
    this.lastError = message;
    this.logger.warn(`Supergraph composition error recorded: ${message}`);
  }

  /** READER: has the live supergraph schema composed at least once? */
  isComposed(): boolean {
    return this.composed;
  }

  /** READER: last terminal composition error message, or null if none. */
  getLastError(): string | null {
    return this.lastError;
  }

  /** READER: timestamp of the most recent successful composition, or null. */
  getLastComposedAt(): Date | null {
    return this.lastComposedAt;
  }
}
