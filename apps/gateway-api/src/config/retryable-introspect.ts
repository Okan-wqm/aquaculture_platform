import { IntrospectAndCompose, ServiceEndpointDefinition } from '@apollo/gateway';
import { Logger } from '@nestjs/common';

/**
 * Options for RetryableIntrospectAndCompose
 */
interface RetryableIntrospectOptions {
  subgraphs: ServiceEndpointDefinition[];
  pollIntervalInMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Resilience wrapper for IntrospectAndCompose
 * Retries composition on failure instead of crashing
 */
export class RetryableIntrospectAndCompose extends IntrospectAndCompose {
  private readonly logger = new Logger(RetryableIntrospectAndCompose.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: RetryableIntrospectOptions) {
    super(options);
    this.maxRetries = options.maxRetries || 30;  // 30 × 5s = 150s safety net
    this.retryDelayMs = options.retryDelayMs || 5000;
  }

  // Override the initialize method to add retry logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override async initialize(args: any): Promise<{ supergraphSdl: string; cleanup: () => Promise<void> }> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await super.initialize(args);
      } catch (error) {
        lastError = error as Error;
        this.logger.error(
          `Supergraph composition failed (attempt ${attempt}/${this.maxRetries}): ${lastError.message}`,
        );

        if (attempt >= this.maxRetries) {
          this.logger.error('Max retries reached. Gateway startup failed.');
          throw lastError;
        }

        // Add jitter to prevent thundering herd on retry
        const jitter = Math.random() * this.retryDelayMs * 0.3;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs + jitter));
      }
    }
    // This line is only reached if maxRetries <= 0
    throw lastError ?? new Error('No retry attempts configured');
  }
}
