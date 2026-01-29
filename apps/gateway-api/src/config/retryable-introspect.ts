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
    this.maxRetries = options.maxRetries || 10;
    this.retryDelayMs = options.retryDelayMs || 5000;
  }

  // Override the initialize method to add retry logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override async initialize(args: any): Promise<{ supergraphSdl: string; cleanup: () => Promise<void> }> {
    let attempts = 0;
    while (attempts < this.maxRetries) {
      try {
        return await super.initialize(args);
      } catch (error) {
        attempts++;
        this.logger.error(
          `Supergraph composition failed (attempt ${attempts}/${this.maxRetries}): ${(error as Error).message}`,
        );

        if (attempts >= this.maxRetries) {
          this.logger.error('Max retries reached. Gateway startup failed.');
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw new Error('Unreachable');
  }
}
