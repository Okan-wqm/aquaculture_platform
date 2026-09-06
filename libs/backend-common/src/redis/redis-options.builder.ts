import { ConfigService } from '@nestjs/config';

import { RedisModuleOptions } from './redis.service';

export type RedisConfigMode = 'required' | 'optional';

function readConfigString(config: ConfigService, key: string): string | undefined {
  const value = config.get<string | number | undefined>(key);
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

function parseIntegerConfig(config: ConfigService, key: string, fallback: number): number {
  const raw = readConfigString(config, key);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

export function buildRedisOptions(
  config: ConfigService,
  serviceName: string,
  mode: RedisConfigMode = 'optional',
): RedisModuleOptions {
  const url = readConfigString(config, 'REDIS_URL');
  const host = readConfigString(config, 'REDIS_HOST');
  const password = readConfigString(config, 'REDIS_PASSWORD');
  const hasPort = readConfigString(config, 'REDIS_PORT') !== undefined;
  const hasDb = readConfigString(config, 'REDIS_DB') !== undefined;
  const hasHostStyleConfig = host !== undefined || password !== undefined || hasPort || hasDb;

  if (url && hasHostStyleConfig) {
    throw new Error(
      'REDIS_URL cannot be combined with REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB',
    );
  }

  const isProduction = config.get<string>('NODE_ENV') === 'production';
  if (isProduction && mode === 'required' && !url && !host) {
    throw new Error(`Redis is required for ${serviceName} in production`);
  }

  const keyPrefix = `${serviceName}:`;
  // SEC-HIGH-108 (2026-08-23 scan №53): dedicated noeviction instance for the
  // authorization namespace — optional; unset keeps the shared-client shape.
  const authorizationUrl = readConfigString(config, 'REDIS_AUTH_URL');
  if (url) {
    return { url, keyPrefix, ...(authorizationUrl ? { authorizationUrl } : {}) };
  }

  return {
    host: host ?? 'localhost',
    port: parseIntegerConfig(config, 'REDIS_PORT', 6379),
    password,
    db: parseIntegerConfig(config, 'REDIS_DB', 0),
    keyPrefix,
  };
}
