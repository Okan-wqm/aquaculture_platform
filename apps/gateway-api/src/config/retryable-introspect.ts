import { IntrospectAndCompose, ServiceEndpointDefinition } from '@apollo/gateway';
import { Logger } from '@nestjs/common';

/**
 * Options for RetryableIntrospectAndCompose
 *
 * @property subgraphs - List of federated subgraph endpoints to introspect
 * @property pollIntervalInMs - Interval between schema polling cycles (default: 300000ms = 5min)
 * @property maxRetries - Maximum composition retry attempts before failing (default: 12)
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
 * depends_on with service_healthy conditions, which ensures all subgraphs
 * are up before the gateway container even starts.
 *
 * The retry budget here handles only transient failures that occur AFTER
 * subgraphs have passed their Docker healthchecks (e.g., brief network
 * blips during container IP reassignment, or a subgraph restarting due
 * to an unrelated crash just as the gateway introspects).
 *
 * IMPORTANT: initialize() BLOCKS NestFactory.create(). Until composition
 * succeeds, no HTTP listener is bound and /health/live will not respond.
 * Therefore the total retry budget (maxRetries x retryDelayMs) must be
 * shorter than the Docker healthcheck start_period for the gateway, or
 * Docker will mark the gateway as unhealthy and restart it mid-retry.
 *
 * Budget calculation (defaults):
 *   12 retries x ~3.45s avg (3s base + 15% jitter) = ~41s worst case
 *   Gateway Docker start_period = 120s (ample headroom)
 *   Deploy script health loop = 30 x 10s = 300s
 */
export class RetryableIntrospectAndCompose extends IntrospectAndCompose {
  private readonly logger = new Logger(RetryableIntrospectAndCompose.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: RetryableIntrospectOptions) {
    super(options);
    /**
     * ARCH-GW-002: 12 retries x 3s = 36-42s total retry budget.
     * This is intentionally shorter than the gateway's Docker start_period (120s)
     * so that if all retries are exhausted, Docker can restart the container
     * and attempt a fresh composition cycle.
     *
     * Previous values (30 x 5s = 150s) exceeded the start_period and raced
     * with the deploy script's 300s health check window.
     */
    this.maxRetries = options.maxRetries ?? 12;
    this.retryDelayMs = options.retryDelayMs ?? 3000;
  }

  /**
   * Initializes the supergraph SDL by introspecting all subgraphs.
   *
   * ARCH-GW-002: Retries with jittered delay on transient composition failures.
   * Each failed attempt logs the failing subgraph(s) for operator diagnosis.
   * On final failure, throws to let NestJS/Docker handle the restart cycle.
   *
   * @param args - Apollo Gateway initialization arguments (supergraphSdl manager config)
   * @returns Composed supergraph SDL and cleanup function
   * @throws Error when all retry attempts are exhausted
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override async initialize(args: any): Promise<{ supergraphSdl: string; cleanup: () => Promise<void> }> {
    let lastError: Error | undefined;
    const totalBudgetMs = this.maxRetries * this.retryDelayMs;

    this.logger.log(
      `Starting supergraph composition (max ${this.maxRetries} attempts, ` +
      `~${Math.round(totalBudgetMs / 1000)}s budget)`,
    );

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await super.initialize(args);
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
