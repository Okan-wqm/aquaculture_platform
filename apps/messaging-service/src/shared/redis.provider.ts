import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Creates an ioredis Redis instance for the messaging service.
 * Configurable via REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB.
 * Default DB: 3 (dedicated for messaging to avoid collisions with other services).
 *
 * Connection error handling with automatic reconnect is built into ioredis.
 * The provider logs connection events for operational observability.
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
    });

    client.on('ready', () => {
      logger.log('Redis client ready');
    });

    client.on('error', (err: Error) => {
      logger.error(`Redis connection error: ${err.message}`);
    });

    client.on('close', () => {
      logger.warn('Redis connection closed');
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
