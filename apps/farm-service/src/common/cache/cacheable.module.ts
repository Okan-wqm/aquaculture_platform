/**
 * CacheableModule
 *
 * Global module that registers `CacheableInterceptor` as an
 * APP_INTERCEPTOR so any resolver / service method decorated with
 * @Cacheable gets read-through caching for free.
 *
 * Depends on `RedisService` from `@aquaculture/backend-common`
 * (already imported app-wide via the RedisModule wired in the root
 * AppModule). The interceptor itself marks its RedisService
 * dependency @Optional so tests that skip the redis module still
 * run — the interceptor falls through to the underlying method
 * without caching.
 *
 * Phase 7.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { CacheableInterceptor } from './cacheable.interceptor';

@Global()
@Module({
  providers: [
    CacheableInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheableInterceptor,
    },
  ],
  exports: [CacheableInterceptor],
})
export class CacheableModule {}
