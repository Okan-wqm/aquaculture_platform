import { IntrospectAndCompose, IntrospectAndComposeOptions } from '@apollo/gateway';
import { Logger } from '@nestjs/common';

/**
 * Resilience wrapper for IntrospectAndCompose
 * Retries composition on failure instead of crashing
 */
export class RetryableIntrospectAndCompose extends IntrospectAndCompose {
  private readonly logger = new Logger(RetryableIntrospectAndCompose.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: IntrospectAndComposeOptions & { maxRetries?: number; retryDelayMs?: number }) {
    super(options);
    this.maxRetries = options.maxRetries || 10;
    this.retryDelayMs = options.retryDelayMs || 5000;
  }

  // Override the initialize method (or supergraphSdl provider hook if accessible)
  // Unfortunately, IntrospectAndCompose structure is rigid.
  // Instead of inheritance override which relies on internal API, 
  // we will rely on the fact that Apollo Gateway polls.
  // BUT, to prevent initial crash, we might need to mask errors.
  
  // Actually, Apollo Gateway's IntrospectAndCompose throws if initial composition fails?
  // Yes. To solve this, we can catch the error during the load.
  
  public async initialize(args: any): Promise<{ supergraphSdl: string; cleanup?: () => Promise<void> }> {
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
