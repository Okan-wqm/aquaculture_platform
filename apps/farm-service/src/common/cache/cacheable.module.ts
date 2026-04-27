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
import { CacheEvictInterceptor } from './cache-evict.interceptor';

@Global()
@Module({
  providers: [
    CacheableInterceptor,
    CacheEvictInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheableInterceptor,
    },
    // Phase 7.3.2 — the evict interceptor runs alongside the
    // read-through interceptor. Both are declarative via metadata
    // so a method that carries neither decorator passes through
    // both interceptors untouched.
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheEvictInterceptor,
    },
  ],
  exports: [CacheableInterceptor, CacheEvictInterceptor],
})
export class CacheableModule {}
