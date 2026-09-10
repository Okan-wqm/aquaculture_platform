/**
 * The retention window a SUPER_ADMIN can actually set (ADMIN-CRITICAL-151).
 *
 * `RetentionPolicy.retentionDays` documents `-1` as indefinite, and
 * `executeRetentionCleanup` skips those policies
 * (`retention-policy.service.ts:221`) — so indefinite retention is a real,
 * supported, nightly-honoured state. `UpdateRetentionPolicyDto` declared
 * `@Min(1)`, which made it unreachable through the API: the one window an
 * operator picks for a legal-preservation channel was the one window the
 * endpoint refused. The admin panel offered it in a dropdown, which is how the
 * contradiction stayed invisible.
 *
 * Zero stays refused. Zero days would ask the cleanup to delete every message
 * the moment it runs, which is not a retention decision anyone means to make
 * through a dropdown.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { UpdateRetentionPolicyDto } from '../dto/messaging-admin.dto';

const CHANNEL_ID = '44444444-4444-4444-8444-444444444444';

async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateRetentionPolicyDto, payload);
  const failures = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return failures.flatMap((failure) => Object.keys(failure.constraints ?? {}));
}

describe('UpdateRetentionPolicyDto (ADMIN-CRITICAL-151)', () => {
  it('accepts -1, the value that means indefinite', async () => {
    await expect(errorsFor({ retentionDays: -1 })).resolves.toEqual([]);
  });

  it('accepts -1 for one channel as well as for the tenant default', async () => {
    await expect(errorsFor({ channelId: CHANNEL_ID, retentionDays: -1 })).resolves.toEqual([]);
  });

  it('accepts the ordinary windows the panel offers', async () => {
    for (const days of [1, 30, 90, 365, 1095, 2555, 3650]) {
      await expect(errorsFor({ retentionDays: days })).resolves.toEqual([]);
    }
  });

  it('refuses zero, which would delete everything at the next cleanup', async () => {
    await expect(errorsFor({ retentionDays: 0 })).resolves.toContain('notEquals');
  });

  it('refuses windows below -1 and above ten years', async () => {
    await expect(errorsFor({ retentionDays: -2 })).resolves.toContain('min');
    await expect(errorsFor({ retentionDays: 3651 })).resolves.toContain('max');
  });

  it('refuses a non-integer window', async () => {
    await expect(errorsFor({ retentionDays: 90.5 })).resolves.toContain('isInt');
  });

  it('requires a window: a body without one is what the panel used to send', async () => {
    // The pre-fix client sent `{defaultRetention, applyToAll}` — no
    // `retentionDays` at all, and two properties the DTO does not have.
    await expect(errorsFor({ defaultRetention: '1y', applyToAll: true })).resolves.toEqual(
      expect.arrayContaining(['isInt']),
    );
  });

  it('refuses a channel id that is not a uuid', async () => {
    await expect(errorsFor({ channelId: 'general', retentionDays: 90 })).resolves.toContain(
      'isUuid',
    );
  });

  it('accepts an explicit null channel id, which means the tenant default', async () => {
    await expect(errorsFor({ channelId: null, retentionDays: 90 })).resolves.toEqual([]);
  });
});
