import {
  THROTTLE_KEY,
  SlidingWindowStrategy,
  ThrottlerGuard,
} from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { AppModule } from '../../app.module';
import { EnvironmentResolver } from '../environment.resolver';

interface FactoryProviderContract {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

function isFactoryProvider(value: unknown): value is FactoryProviderContract {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provide' in value &&
    'useFactory' in value &&
    typeof value.useFactory === 'function'
  );
}

describe('environment direct-subgraph rate-limit contract', () => {
  it('registers the shared throttler as a global farm-service guard', () => {
    const metadata: unknown = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule);
    const providers = Array.isArray(metadata) ? metadata : [];
    const throttlerProvider = providers.find(
      (provider) =>
        isFactoryProvider(provider) &&
        provider.provide === APP_GUARD &&
        provider.inject?.includes(SlidingWindowStrategy),
    );

    expect(isFactoryProvider(throttlerProvider)).toBe(true);
    if (!isFactoryProvider(throttlerProvider)) {
      throw new Error('Farm AppModule is missing its global ThrottlerGuard provider');
    }
    expect(throttlerProvider.useFactory(new Reflector(), new ConfigService(), {})).toBeInstanceOf(
      ThrottlerGuard,
    );
  });

  it('pins a bounded shared bucket on every environment read resolver', () => {
    expect(Reflect.getMetadata(THROTTLE_KEY, EnvironmentResolver)).toEqual({
      limit: 30,
      ttl: 60,
      keyPrefix: 'environment-read',
    });
  });
});
