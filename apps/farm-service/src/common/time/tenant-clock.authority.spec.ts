import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { TenantClockAuthority } from './tenant-clock.authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('TenantClockAuthority', () => {
  it('uses the site catalog timezone for the local calendar date', async () => {
    const requested = new Date('2026-01-01T05:30:00.000Z');
    const query = jest.fn().mockResolvedValue([{ timezone: 'Pacific/Honolulu' }]);
    const authority = new TenantClockAuthority();

    const result = await authority.resolve(mock<EntityManager>({ query }), TENANT, SITE, requested);

    expect(result).toEqual({
      instant: requested,
      timezone: 'Pacific/Honolulu',
      localDate: '2025-12-31',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM sites'), [SITE, TENANT]);
  });

  it('uses one PostgreSQL transaction timestamp when no event instant is supplied', async () => {
    const instant = '2026-07-20T12:00:00.000Z';
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ instant }])
      .mockResolvedValueOnce([{ timezone: 'Europe/Oslo' }]);

    const result = await new TenantClockAuthority().resolve(
      mock<EntityManager>({ query }),
      TENANT,
      SITE,
    );

    expect(result.instant.toISOString()).toBe(instant);
    expect(result.localDate).toBe('2026-07-20');
    expect(query.mock.calls[0][0]).toContain('transaction_timestamp()');
  });

  it('fails closed when a site-less operation spans multiple timezones', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ timezone: 'Europe/Oslo' }, { timezone: 'Pacific/Honolulu' }]);

    await expect(
      new TenantClockAuthority().resolve(
        mock<EntityManager>({ query }),
        TENANT,
        undefined,
        new Date('2026-07-20T12:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed on missing or invalid catalog timezone authority', async () => {
    const missing = mock<EntityManager>({ query: jest.fn().mockResolvedValue([]) });
    await expect(
      new TenantClockAuthority().resolve(
        missing,
        TENANT,
        SITE,
        new Date('2026-07-20T12:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const invalid = mock<EntityManager>({
      query: jest.fn().mockResolvedValue([{ timezone: 'Mars/Olympus_Mons' }]),
    });
    await expect(
      new TenantClockAuthority().resolve(
        invalid,
        TENANT,
        SITE,
        new Date('2026-07-20T12:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('bulk-resolves per-site calendar dates and rejects catalog set drift', async () => {
    const siteB = '33333333-3333-4333-8333-333333333333';
    const instant = new Date('2026-01-01T05:30:00.000Z');
    const query = jest.fn().mockResolvedValue([
      { id: SITE, timezone: 'Pacific/Honolulu' },
      { id: siteB, timezone: 'Pacific/Kiritimati' },
    ]);
    const authority = new TenantClockAuthority();

    const clocks = await authority.resolveSites(
      mock<EntityManager>({ query }),
      TENANT,
      [siteB, SITE, siteB],
      instant,
    );

    expect(clocks.get(SITE)?.localDate).toBe('2025-12-31');
    expect(clocks.get(siteB)?.localDate).toBe('2026-01-01');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('id = ANY'), [
      TENANT,
      [SITE, siteB],
    ]);

    const missing = mock<EntityManager>({
      query: jest.fn().mockResolvedValue([{ id: SITE, timezone: 'UTC' }]),
    });
    await expect(
      authority.resolveSites(missing, TENANT, [SITE, siteB], instant),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
