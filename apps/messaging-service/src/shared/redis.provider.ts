import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Redis circuit breaker state.
 *
 * IMPORTANT: Without a circuit breaker, when Redis is down, every request in
 * the messaging service waits for the Redis timeout (default 5s), cascading
 * to API latency spikes across presence, caching, and pub/sub operations.
 *
 * State machine:
 * - CLOSED: Normal operation — all Redis calls pass through.
 * - OPEN: Redis failures exceeded threshold — all calls return null/fallback
 *   immediately without attempting Redis, preventing cascade failures.
 * - HALF_OPEN: After cooldown period, allow one probe request. If it succeeds,
 *   transition to CLOSED. If it fails, return to OPEN.
 *
 * @see MSG-MEDIUM-017
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/** Number of consecutive failures before the circuit opens. */
const FAILURE_THRESHOLD = 5;

/** How long the circuit stays OPEN before allowing a probe (ms). */
const OPEN_COOLDOWN_MS = 30_000;

/**
 * Redis Circuit Breaker tracker. Shared singleton across the messaging service.
 * State is tracked in-memory (not persisted) since it's per-process ephemeral state.
 */
export class RedisCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly logger = new Logger('RedisCircuitBreaker');

  /**
   * Record a successful Redis operation. Resets the circuit to CLOSED.
   */
  recordSuccess(): void {
    if (this.state !== CircuitState.CLOSED) {
      this.logger.log(`Redis circuit breaker: ${this.state} -> CLOSED (success)`);
    }
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
  }

  /**
   * Record a failed Redis operation. May transition to OPEN.
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.state === CircuitState.CLOSED) {
      this.state = CircuitState.OPEN;
      this.logger.warn(
        `Redis circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures. ` +
        `Requests will use degraded-mode fallback for ${OPEN_COOLDOWN_MS / 1000}s.`,
      );
    }
  }

  /**
   * Check if the circuit allows a Redis call.
   * Returns true if the call should proceed, false to use fallback.
   */
  allowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if cooldown has elapsed
      if (Date.now() - this.lastFailureTime >= OPEN_COOLDOWN_MS) {
        this.state = CircuitState.HALF_OPEN;
        this.logger.log('Redis circuit breaker: OPEN -> HALF_OPEN (cooldown elapsed, probing)');
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow single probe
    return true;
  }

  /** Get current circuit state for monitoring. */
  getState(): CircuitState {
    return this.state;
  }
}

/** Singleton circuit breaker instance for the messaging service. */
export const redisCircuitBreaker = new RedisCircuitBreaker();

/**
 * Creates an ioredis Redis instance for the messaging service.
 * Configurable via REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB.
 * Default DB: 3 (dedicated for messaging to avoid collisions with other services).
 *
 * Connection error handling with automatic reconnect is built into ioredis.
 * The provider logs connection events for operational observability.
 *
 * Circuit breaker integration: connection events automatically update the
 * circuit breaker state. Services should check redisCircuitBreaker.allowRequest()
 * before making Redis calls and call recordSuccess/recordFailure on the result.
 * @see MSG-MEDIUM-017
 */
export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisProvider:messaging');

    const client = new Redis({
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD'),
      db: configService.get<number>('REDIS_DB', 3),
      keyPrefix: '',
      retryStrategy(times: number): number | null {
        if (times > 20) {
          logger.error(
            `Redis reconnect failed after ${times} attempts — giving up`,
          );
          return null;
        }
        const delay = Math.min(times * 200, 5000);
        logger.warn(`Redis reconnect attempt ${times}, retrying in ${delay}ms`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    client.on('connect', () => {
      logger.log('Connected to Redis');
      redisCircuitBreaker.recordSuccess();
    });

    client.on('ready', () => {
      logger.log('Redis client ready');
      redisCircuitBreaker.recordSuccess();
    });

    client.on('error', (err: Error) => {
      logger.error(`Redis connection error: ${err.message}`);
      redisCircuitBreaker.recordFailure();
    });

    client.on('close', () => {
      logger.warn('Redis connection closed');
      redisCircuitBreaker.recordFailure();
    });

    return client;
  },
};

/**
 * Provider to gracefully disconnect Redis on application shutdown.
 */
export const redisDisconnectProvider: Provider = {
  provide: 'REDIS_DISCONNECT',
  inject: [REDIS_CLIENT],
  useFactory: (client: Redis) => ({
    onModuleDestroy: async () => {
      const logger = new Logger('RedisProvider:messaging');
      try {
        await client.quit();
        logger.log('Redis disconnected gracefully');
      } catch (err) {
        logger.error(`Redis disconnect error: ${(err as Error).message}`);
      }
    },
  }),
};
