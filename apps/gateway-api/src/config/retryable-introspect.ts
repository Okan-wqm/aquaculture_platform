import { IntrospectAndCompose, ServiceEndpointDefinition } from '@apollo/gateway';
import type { SupergraphSdlHookOptions } from '@apollo/gateway/dist/config';
import { Logger } from '@nestjs/common';

/**
 * Options for RetryableIntrospectAndCompose
 *
 * @property subgraphs - List of federated subgraph endpoints to introspect
 * @property pollIntervalInMs - Interval between schema polling cycles (default: 300000ms = 5min)
 * @property maxRetries - Maximum composition retry attempts before failing (default: 24)
 * @property retryDelayMs - Base delay between retries in milliseconds (default: 3000)
 */
interface RetryableIntrospectOptions {
  subgraphs: ServiceEndpointDefinition[];
  pollIntervalInMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Resilience wrapper for Apollo Gateway's IntrospectAndCompose.
 *
 * ARCH-GW-002: This class adds retry-with-backoff to supergraph composition.
 * It is the LAST line of defense — the primary protection is Docker Compose
 * depends_on with service_started conditions, which orders the gateway after
 * its subgraph containers have launched (NOT after they pass a healthcheck:
 * compose uses service_started, so the gateway can introspect a subgraph that
 * is up-but-not-yet-ready and the retry budget below absorbs that window).
 *
 * The retry budget here handles transient failures while subgraphs come up
 * (e.g., brief network blips during container IP reassignment, or a subgraph
 * restarting due to an unrelated crash just as the gateway introspects).
 *
 * ARCH-GW-006: initialize() NO LONGER blocks NestFactory.create(). This class is
 * now driven by BackgroundCompositionManager, which runs this retry loop OFF the
 * critical path: the gateway binds its HTTP listener and answers /health/live in
 * <1s on a placeholder supergraph, then hot-swaps the real schema in via
 * options.update() once this loop succeeds. The retry budget therefore no longer
 * needs to fit inside the Docker start_period — composition can take as long as
 * it needs without ever delaying liveness. /health/ready stays not_ready
 * (checks.composition = 'pending') until this loop completes.
 *
 * Budget calculation (defaults):
 *   24 retries x ~3.45s avg (3s base + 15% jitter) = ~83s average,
 *   ~94s with max jitter — now spent entirely in the background.
 */
export class RetryableIntrospectAndCompose extends IntrospectAndCompose {
  private readonly logger = new Logger(RetryableIntrospectAndCompose.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: RetryableIntrospectOptions) {
    super(options);
    /**
     * ARCH-GW-002 / ARCH-GW-006: 24 retries x 3s = 72-94s total retry budget,
     * now spent entirely in the BACKGROUND (BackgroundCompositionManager). The
     * budget no longer has to fit inside the Docker start_period: liveness
     * (/health/live) is answered on a placeholder supergraph the instant the
     * listener binds, so exhausting the budget leaves the gateway up-but-not-ready
     * rather than restarting the container mid-compose. The manager records the
     * terminal failure to CompositionStateService for /health/ready + the logs.
     */
    this.maxRetries = options.maxRetries ?? 24;
    this.retryDelayMs = options.retryDelayMs ?? 3000;
  }

  /**
   * Initializes the supergraph SDL by introspecting all subgraphs.
   *
   * ARCH-GW-002: Retries with jittered delay on transient composition failures.
   * Each failed attempt logs the failing subgraph(s) for operator diagnosis.
   * On final failure, throws so its caller can record the outcome.
   *
   * ARCH-GW-006: the caller is now BackgroundCompositionManager, which catches
   * this throw on the background path (it does NOT propagate to NestFactory or
   * Docker). The terminal failure is routed to CompositionStateService and the
   * gateway stays up-but-not-ready instead of crash-restarting.
   *
   * @param args - Apollo Gateway initialization arguments (supergraphSdl manager config)
   * @returns Composed supergraph SDL and cleanup function
   * @throws Error when all retry attempts are exhausted
   */
  public override async initialize(
    args: SupergraphSdlHookOptions,
  ): Promise<{ supergraphSdl: string; cleanup: () => Promise<void> }> {
    let lastError: Error | undefined;
    const totalBudgetMs = this.maxRetries * this.retryDelayMs;

    this.logger.log(
      `Starting supergraph composition (max ${this.maxRetries} attempts, ` +
      `~${Math.round(totalBudgetMs / 1000)}s budget)`,
    );

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await super.initialize(args);

        // DEFENSIVE: Verify supergraphSdl is non-null before returning.
        // IntrospectAndCompose can return { supergraphSdl: null } if subgraph
        // composition yields an empty schema (e.g., conflicting Federation types
        // or a subgraph with no resolvers). Apollo Gateway then crashes with
        // TypeError [ERR_INVALID_ARG_TYPE] when hashing null SDL.
        if (!result?.supergraphSdl) {
          throw new Error(
            'Supergraph composition returned null/empty SDL. ' +
            'This typically means one or more subgraphs have conflicting ' +
            'GraphQL type definitions or failed to generate a schema. ' +
            'Check subgraph logs for schema generation errors.',
          );
        }

        if (attempt > 1) {
          this.logger.log(
            `Supergraph composition succeeded on attempt ${attempt}/${this.maxRetries}`,
          );
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        this.logger.error(
          `Supergraph composition failed (attempt ${attempt}/${this.maxRetries}): ${lastError.message}`,
        );

        if (attempt >= this.maxRetries) {
          this.logger.error(
            `All ${this.maxRetries} composition attempts exhausted ` +
            `(total budget: ~${Math.round(totalBudgetMs / 1000)}s). ` +
            `Gateway startup will fail; Docker will restart the container.`,
          );
          throw lastError;
        }

        /**
         * Jittered delay prevents thundering herd when multiple gateway
         * replicas retry simultaneously against recovering subgraphs.
         * Jitter range: 0-30% of base delay.
         */
        const jitter = Math.random() * this.retryDelayMs * 0.3;
        const delayMs = this.retryDelayMs + jitter;
        this.logger.warn(
          `Retrying composition in ${Math.round(delayMs)}ms ` +
          `(attempt ${attempt + 1}/${this.maxRetries})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // Unreachable unless maxRetries <= 0
    throw lastError ?? new Error('No retry attempts configured');
  }
}
