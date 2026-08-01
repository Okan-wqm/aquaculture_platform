import { ConfigService } from '@nestjs/config';

/** Canonical, fail-closed parser for the refresh-token hashing posture. */
export function parseHashRefreshTokens(configService: ConfigService): boolean {
  const raw = configService.get<unknown>('HASH_REFRESH_TOKENS');
  let enabled: boolean;
  if (raw === undefined) {
    enabled = true;
  } else if (typeof raw === 'boolean') {
    enabled = raw;
  } else if (raw === 'true') {
    enabled = true;
  } else if (raw === 'false') {
    enabled = false;
  } else {
    throw new Error('HASH_REFRESH_TOKENS must be true or false');
  }

  const environment = configService.get<string>('NODE_ENV', 'development');
  if (!enabled && (environment === 'production' || environment === 'staging')) {
    throw new Error('HASH_REFRESH_TOKENS must be enabled outside development and test');
  }
  return enabled;
}
