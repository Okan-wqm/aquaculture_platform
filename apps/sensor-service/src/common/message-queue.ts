/**
 * Message Queue with Backpressure Handling
 *
 * Provides rate-limited, bounded message processing for high-throughput
 * scenarios like MQTT message ingestion.
 *
 * Features:
 * - Bounded queue with configurable capacity
 * - Rate limiting
 * - Concurrent processing with configurable workers
 * - Graceful overflow handling (drop oldest/newest/reject)
 * - Metrics and monitoring hooks
 *
 * SOLID Principles:
 * - Single Responsibility: Message queueing and rate limiting
 * - Open/Closed: Extensible via options and callbacks
 * - Interface Segregation: Simple processor interface
 */

import { Logger } from '@nestjs/common';

/**
 * Overflow strategy when queue is full
 */
export enum OverflowStrategy {
  /** Drop oldest messages to make room */
  DROP_OLDEST = 'drop_oldest',
  /** Drop newest (incoming) messages */
  DROP_NEWEST = 'drop_newest',
  /** Reject and throw error */
  REJECT = 'reject',
  /** Block until space is available (with timeout) */
  BLOCK = 'block',
}

/**
 * Message queue statistics
 */
export interface QueueStats {
  /** Current queue size */
  size: number;
  /** Maximum queue size reached */
  maxSizeReached: number;
  /** Total messages enqueued */
  totalEnqueued: number;
  /** Total messages processed */
  totalProcessed: number;
  /** Total messages dropped */
  totalDropped: number;
  /** Total processing errors */
  totalErrors: number;
  /** Average processing time in ms */
  avgProcessingTimeMs: number;
  /** Current processing rate (messages/second) */
  processingRate: number;
  /** Is queue paused */
  isPaused: boolean;
}

/**
 * Message queue options
 */
export interface MessageQueueOptions<T> {
  /** Maximum queue capacity */
  capacity?: number;
  /** Number of concurrent processors */
  concurrency?: number;
  /** Strategy when queue is full */
  overflowStrategy?: OverflowStrategy;
  /** Block timeout in ms (for BLOCK strategy) */
  blockTimeoutMs?: number;
  /** Rate limit (messages per second, 0 = unlimited) */
  rateLimitPerSecond?: number;
  /** Logger instance */
  logger?: Logger;
  /** Queue name for logging */
  name?: string;
  /** Callback when message is dropped */
  onDrop?: (message: T, reason: string) => void;
  /** Callback when error occurs */
  onError?: (error: Error, message: T) => void;
  /** Callback for metrics (called periodically) */
  onMetrics?: (stats: QueueStats) => void;
  /** Metrics reporting interval in ms */
  metricsIntervalMs?: number;
}

/**
 * Message processor function type
 */
export type MessageProcessor<T> = (message: T) => Promise<void>;

/**
 * Internal queue item with metadata
 */
interface QueueItem<T> {
  message: T;
  enqueuedAt: number;
}

/**
 * Async Message Queue with Backpressure
 */
export class MessageQueue<T> {
  private readonly queue: QueueItem<T>[] = [];
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly overflowStrategy: OverflowStrategy;
  private readonly blockTimeoutMs: number;
  private readonly rateLimitPerSecond: number;
  private readonly logger?: Logger;
  private readonly name: string;
  private readonly onDrop?: (message: T, reason: string) => void;
  private readonly onError?: (error: Error, message: T) => void;
  private readonly onMetrics?: (stats: QueueStats) => void;

  private processor?: MessageProcessor<T>;
  private activeWorkers = 0;
  private isPaused = false;
  private isShuttingDown = false;
  private metricsIntervalId?: NodeJS.Timeout;

  // Statistics
  private maxSizeReached = 0;
  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalDropped = 0;
  private totalErrors = 0;
  private processingTimes: number[] = [];
  private readonly processingTimesWindow = 100; // Keep last 100 for average
  private processedInLastSecond = 0;
  private lastRateCalculation = Date.now();

  // Rate limiting
  private tokenBucket: number;
  private lastTokenRefill: number;

  constructor(options: MessageQueueOptions<T> = {}) {
    this.capacity = options.capacity ?? 10000;
    this.concurrency = options.concurrency ?? 4;
    this.overflowStrategy = options.overflowStrategy ?? OverflowStrategy.DROP_OLDEST;
    this.blockTimeoutMs = options.blockTimeoutMs ?? 5000;
    this.rateLimitPerSecond = options.rateLimitPerSecond ?? 0;
    this.logger = options.logger;
    this.name = options.name ?? 'MessageQueue';
    this.onDrop = options.onDrop;
    this.onError = options.onError;
    this.onMetrics = options.onMetrics;

    // Initialize rate limiting
    this.tokenBucket = this.rateLimitPerSecond || Infinity;
    this.lastTokenRefill = Date.now();

    // Start metrics reporting if callback provided
    if (this.onMetrics && options.metricsIntervalMs) {
      this.metricsIntervalId = setInterval(() => {
        this.reportMetrics();
      }, options.metricsIntervalMs);
      this.metricsIntervalId.unref();
    }
  }

  /**
   * Set the message processor function
   */
  setProcessor(processor: MessageProcessor<T>): void {
    this.processor = processor;
  }

  /**
   * Enqueue a message for processing
   * Returns true if message was accepted, false if dropped
   */
  async enqueue(message: T): Promise<boolean> {
    if (this.isShuttingDown) {
      this.logger?.debug?.(`[${this.name}] Rejecting message - shutting down`);
      return false;
    }

    // Check capacity
    if (this.queue.length >= this.capacity) {
      return this.handleOverflow(message);
    }

    // Add to queue
    this.queue.push({
      message,
      enqueuedAt: Date.now(),
    });

    this.totalEnqueued++;
    if (this.queue.length > this.maxSizeReached) {
      this.maxSizeReached = this.queue.length;
    }

    // Trigger processing
    this.processNext();

    return true;
  }

  /**
   * Enqueue multiple messages
   * Returns count of accepted messages
   */
  async enqueueMany(messages: T[]): Promise<number> {
    let accepted = 0;
    for (const message of messages) {
      if (await this.enqueue(message)) {
        accepted++;
      }
    }
    return accepted;
  }

  /**
   * Pause message processing
   */
  pause(): void {
    this.isPaused = true;
    this.logger?.log?.(`[${this.name}] Processing paused`);
  }

  /**
   * Resume message processing
   */
  resume(): void {
    this.isPaused = false;
    this.logger?.log?.(`[${this.name}] Processing resumed`);

    // Restart workers
    for (let i = 0; i < this.concurrency; i++) {
      this.processNext();
    }
  }

  /**
   * Gracefully shutdown the queue
   * Waits for in-flight messages to complete
   */
  async shutdown(timeoutMs = 30000): Promise<void> {
    this.isShuttingDown = true;
    this.logger?.log?.(`[${this.name}] Shutting down...`);

    // Stop metrics reporting
    if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = undefined;
    }

    // Wait for active workers to complete
    const startTime = Date.now();
    while (this.activeWorkers > 0 && Date.now() - startTime < timeoutMs) {
      await this.sleep(100);
    }

    if (this.activeWorkers > 0) {
      this.logger?.warn?.(`[${this.name}] Shutdown timeout - ${this.activeWorkers} workers still active`);
    }

    // Log dropped messages
    if (this.queue.length > 0) {
      this.logger?.warn?.(`[${this.name}] ${this.queue.length} messages dropped on shutdown`);
      this.totalDropped += this.queue.length;
    }

    this.queue.length = 0;
    this.logger?.log?.(`[${this.name}] Shutdown complete`);
  }

  /**
   * Get current queue statistics
   */
  getStats(): QueueStats {
    return {
      size: this.queue.length,
      maxSizeReached: this.maxSizeReached,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      totalErrors: this.totalErrors,
      avgProcessingTimeMs: this.calculateAvgProcessingTime(),
      processingRate: this.calculateProcessingRate(),
      isPaused: this.isPaused,
    };
  }

  /**
   * Clear all pending messages
   */
  clear(): number {
    const count = this.queue.length;
    this.totalDropped += count;
    this.queue.length = 0;
    this.logger?.log?.(`[${this.name}] Cleared ${count} messages`);
    return count;
  }

  /**
   * Handle queue overflow based on strategy
   */
  private async handleOverflow(message: T): Promise<boolean> {
    switch (this.overflowStrategy) {
      case OverflowStrategy.DROP_OLDEST: {
        const dropped = this.queue.shift();
        if (dropped) {
          this.totalDropped++;
          this.onDrop?.(dropped.message, 'overflow_drop_oldest');
        }
        // Now enqueue the new message
        this.queue.push({
          message,
          enqueuedAt: Date.now(),
        });
        this.totalEnqueued++;
        this.processNext();
        return true;
      }

      case OverflowStrategy.DROP_NEWEST: {
        this.totalDropped++;
        this.onDrop?.(message, 'overflow_drop_newest');
        return false;
      }

      case OverflowStrategy.REJECT: {
        throw new Error(`[${this.name}] Queue is full (capacity: ${this.capacity})`);
      }

      case OverflowStrategy.BLOCK: {
        const startTime = Date.now();
        while (this.queue.length >= this.capacity) {
          if (Date.now() - startTime > this.blockTimeoutMs) {
            this.totalDropped++;
            this.onDrop?.(message, 'block_timeout');
            return false;
          }
          await this.sleep(10);
        }
        // Space available now
        this.queue.push({
          message,
          enqueuedAt: Date.now(),
        });
        this.totalEnqueued++;
        this.processNext();
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Process next message from queue
   */
  private processNext(): void {
    if (this.isPaused || this.isShuttingDown) return;
    if (this.activeWorkers >= this.concurrency) return;
    if (this.queue.length === 0) return;
    if (!this.processor) return;

    // Check rate limit
    if (!this.tryConsumeToken()) {
      // Schedule retry after token refill
      setTimeout(() => this.processNext(), 10);
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeWorkers++;

    const startTime = Date.now();

    this.processor(item.message)
      .then(() => {
        this.totalProcessed++;
        this.processedInLastSecond++;
        this.recordProcessingTime(Date.now() - startTime);
      })
      .catch((error: Error) => {
        this.totalErrors++;
        this.onError?.(error, item.message);
        this.logger?.error?.(`[${this.name}] Processing error: ${error.message}`);
      })
      .finally(() => {
        this.activeWorkers--;
        this.processNext();
      });

    // Start another worker if queue has more items
    if (this.queue.length > 0 && this.activeWorkers < this.concurrency) {
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Try to consume a rate limit token
   */
  private tryConsumeToken(): boolean {
    if (this.rateLimitPerSecond === 0) return true;

    this.refillTokens();

    if (this.tokenBucket >= 1) {
      this.tokenBucket--;
      return true;
    }

    return false;
  }

  /**
   * Refill rate limit tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastTokenRefill) / 1000;
    const tokensToAdd = elapsed * this.rateLimitPerSecond;

    this.tokenBucket = Math.min(this.rateLimitPerSecond, this.tokenBucket + tokensToAdd);
    this.lastTokenRefill = now;
  }

  /**
   * Record processing time for metrics
   */
  private recordProcessingTime(timeMs: number): void {
    this.processingTimes.push(timeMs);
    if (this.processingTimes.length > this.processingTimesWindow) {
      this.processingTimes.shift();
    }
  }

  /**
   * Calculate average processing time
   */
  private calculateAvgProcessingTime(): number {
    if (this.processingTimes.length === 0) return 0;
    const sum = this.processingTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.processingTimes.length);
  }

  /**
   * Calculate current processing rate
   */
  private calculateProcessingRate(): number {
    const now = Date.now();
    const elapsed = (now - this.lastRateCalculation) / 1000;

    if (elapsed >= 1) {
      const rate = this.processedInLastSecond / elapsed;
      this.processedInLastSecond = 0;
      this.lastRateCalculation = now;
      return Math.round(rate * 10) / 10; // 1 decimal place
    }

    return 0;
  }

  /**
   * Report metrics via callback
   */
  private reportMetrics(): void {
    if (this.onMetrics) {
      this.onMetrics(this.getStats());
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a simple rate limiter
 */
export function createRateLimiter(
  maxRequestsPerSecond: number,
): (fn: () => Promise<void>) => Promise<void> {
  let tokenBucket = maxRequestsPerSecond;
  let lastRefill = Date.now();

  const refillTokens = () => {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokenBucket = Math.min(maxRequestsPerSecond, tokenBucket + elapsed * maxRequestsPerSecond);
    lastRefill = now;
  };

  return async (fn: () => Promise<void>): Promise<void> => {
    refillTokens();

    while (tokenBucket < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      refillTokens();
    }

    tokenBucket--;
    await fn();
  };
}
