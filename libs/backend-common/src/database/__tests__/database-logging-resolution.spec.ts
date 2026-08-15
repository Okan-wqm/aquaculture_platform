import { ConfigService } from '@nestjs/config';

import { resolveDatabaseLogging } from '../typeorm-config.factory';

/**
 * Regression suite for the production incident of 2026-08-15.
 *
 * `DATABASE_LOGGING=true` was set on a production service. TypeORM then logged
 * one line per statement, and because every service polls its outbox
 * continuously, auth-service alone wrote ~1.9 lines/second — its container log
 * reached 960 MB and the host disk hit 99%. No data was being written; the
 * volume was statement echo.
 *
 * The knob stays useful for debugging. What changes is that a bare `true`
 * cannot leave per-statement logging on in production forever.
 */

function config(env: Record<string, string>): ConfigService {
  return new ConfigService(env);
}

describe('resolveDatabaseLogging', () => {
  it('logs nothing extra when logging was not requested', () => {
    expect(resolveDatabaseLogging(config({ NODE_ENV: 'production' }))).toBe(false);
  });

  it('honours the request outside production', () => {
    expect(
      resolveDatabaseLogging(config({ NODE_ENV: 'development', DATABASE_LOGGING: 'true' })),
    ).toBe(true);
  });

  it('withholds per-statement logging in production, keeping the diagnostics that matter', () => {
    const resolved = resolveDatabaseLogging(
      config({ NODE_ENV: 'production', DATABASE_LOGGING: 'true' }),
    );

    // Not `true`: that is the setting that filled the disk.
    expect(resolved).not.toBe(true);
    expect(resolved).toEqual(['error', 'warn', 'migration', 'schema']);
  });

  it('lets an operator opt in deliberately, by name', () => {
    expect(
      resolveDatabaseLogging(
        config({
          NODE_ENV: 'production',
          DATABASE_LOGGING: 'true',
          DATABASE_QUERY_LOGGING_ALLOW_IN_PRODUCTION: 'true',
        }),
      ),
    ).toBe(true);
  });

  it('does not treat the opt-in as a way to enable logging that was never asked for', () => {
    // The acknowledgement removes a guard; it must not be a second switch.
    expect(
      resolveDatabaseLogging(
        config({
          NODE_ENV: 'production',
          DATABASE_QUERY_LOGGING_ALLOW_IN_PRODUCTION: 'true',
        }),
      ),
    ).toBe(false);
  });
});
