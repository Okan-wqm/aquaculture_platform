import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('runtime lifecycle timer SSoT', () => {
  it('centralizes process-lifecycle timers in backend-common', () => {
    const source = read('libs/backend-common/src/utils/lifecycle-timer.ts');
    const index = read('libs/backend-common/src/utils/index.ts');
    const tsconfig = read('tsconfig.base.json');

    expect(source).toContain('createManagedTimeout');
    expect(source).toContain('createManagedInterval');
    expect(source).toContain('createAbortSignalTimeout');
    expect(source).toContain('timer.unref?.()');
    expect(index).toContain("export * from './lifecycle-timer'");
    expect(tsconfig).toContain('"@aquaculture/backend-common/utils"');
    expect(tsconfig).not.toContain('"@aquaculture/backend-common/timers"');
  });

  it('uses managed intervals for service background cleanup loops', () => {
    for (const path of [
      'libs/backend-common/src/guards/jwks.service.ts',
      'libs/backend-common/src/rate-limit/in-memory-rate-limit.store.ts',
      'apps/farm-service/src/scheduler/feeding-scheduler.service.ts',
      'apps/farm-service/src/scheduler/cron-jobs.service.ts',
      'apps/farm-service/src/regulatory/maskinporten.service.ts',
    ]) {
      const source = read(path);

      expect(source).toContain('createManagedInterval');
      expect(source).toContain('clearManagedTimer');
      expect(source).not.toMatch(/=\s*setInterval\(/);
      expect(source).not.toMatch(/clearInterval\(/);
    }
  });

  it('uses managed abort timeouts for external HTTP calls', () => {
    for (const path of [
      'apps/notification-service/src/notification/services/notification-dispatcher.service.ts',
      'apps/notification-service/src/notification/services/sms.service.ts',
      'apps/farm-service/src/weather/services/open-meteo.service.ts',
    ]) {
      const source = read(path);

      expect(source).toContain('createAbortSignalTimeout');
      expect(source).toContain('timeout.clear()');
      expect(source).not.toContain('new AbortController()');
      expect(source).not.toMatch(/setTimeout\(\(\)\s*=>\s*controller\.abort\(\)/);
      expect(source).not.toMatch(/clearTimeout\(/);
    }
  });

  it('keeps notification unit tests on a deterministic Nest logger setup', () => {
    const config = read('apps/notification-service/jest.config.ts');
    const setup = read('apps/notification-service/jest.setup.ts');
    const eslintTsconfig = read('apps/notification-service/tsconfig.eslint.json');
    const specTsconfig = read('apps/notification-service/tsconfig.spec.json');

    expect(config).toContain("setupFilesAfterEnv: ['<rootDir>/jest.setup.ts']");
    expect(setup).toContain('Logger.overrideLogger(false)');
    expect(eslintTsconfig).toContain('"jest.setup.ts"');
    expect(specTsconfig).toContain('"jest.setup.ts"');
  });
});
