import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('distributed throttling authority', () => {
  it('uses one atomic Redis sliding-window implementation', () => {
    const strategy = source(
      'libs/backend-common/src/security/throttler/sliding-window.strategy.ts',
    );
    expect(strategy).toMatch(/RedisService/);
    expect(strategy).toMatch(/ZREMRANGEBYSCORE/);
    expect(strategy).toMatch(/ZCARD/);
    expect(strategy).toMatch(/ZADD/);
    expect(strategy).toMatch(/PEXPIRE/);
  });

  it('forbids the distributed-store kill switch and missing Redis in production', () => {
    const strategy = source(
      'libs/backend-common/src/security/throttler/sliding-window.strategy.ts',
    );
    expect(strategy).toMatch(/RATE_LIMIT_USE_REDIS=false is forbidden in production/);
    expect(strategy).toMatch(/RedisService is required for production throttling/);
  });

  it.each([
    'apps/admin-api-service/src/app.module.ts',
    'apps/ai-service/src/app.module.ts',
    'apps/farm-service/src/app.module.ts',
    'apps/hydroponics-service/src/app.module.ts',
    'apps/messaging-service/src/app.module.ts',
  ])('%s composes Redis with the shared throttler', (path) => {
    const appModule = source(path);
    expect(appModule).toMatch(/RedisModule\.forRootAsync/);
    expect(appModule).toMatch(/ThrottlerModule/);
  });

  it('accounts failed platform-admin authentication before the ordinary guard', () => {
    const guard = source('apps/admin-api-service/src/guards/platform-admin.guard.ts');
    expect(guard).toMatch(/admin-failed-auth:ip:/);
    expect(guard).toMatch(/rateLimiter\.consumeWithConfig/);
    expect(guard).toMatch(/publishTokenRejected/);
    expect(guard).toMatch(/publishRateLimitExceeded/);
  });
});
