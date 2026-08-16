import { mockCall } from '@aquaculture/testing';
import type { DataSource } from 'typeorm';

import { lookupEmergencyOverride } from '../emergency-override-check';

function makeDataSource(behavior: {
  rows?: Array<Record<string, unknown>>;
  throwOn?: Error;
}): jest.Mocked<DataSource> {
  return {
    query: jest.fn((): Promise<Array<Record<string, unknown>>> => {
      if (behavior.throwOn) return Promise.reject(behavior.throwOn);
      return Promise.resolve(behavior.rows ?? []);
    }),
  } as unknown as jest.Mocked<DataSource>;
}

describe('lookupEmergencyOverride', () => {
  it('returns active=false when no matching row', async () => {
    const ds = makeDataSource({ rows: [] });
    const result = await lookupEmergencyOverride({
      dataSource: ds,
      serviceName: 'hr',
      kind: 'drift_fatal_bypass',
      environment: 'staging',
    });
    expect(result.active).toBe(false);
    expect(result.row).toBeUndefined();
  });

  it('returns active=true with row payload on match', async () => {
    const expires = new Date('2026-04-21T15:00:00.000Z');
    const ds = makeDataSource({
      rows: [
        {
          id: 'row-1',
          service_name: 'hr',
          kind: 'drift_fatal_bypass',
          reason: 'INC-123',
          actor: 'okan',
          expires_at: expires,
          environment: 'staging',
        },
      ],
    });
    const result = await lookupEmergencyOverride({
      dataSource: ds,
      serviceName: 'hr',
      kind: 'drift_fatal_bypass',
      environment: 'staging',
    });
    expect(result.active).toBe(true);
    expect(result.row).toEqual({
      id: 'row-1',
      serviceName: 'hr',
      kind: 'drift_fatal_bypass',
      reason: 'INC-123',
      actor: 'okan',
      expiresAt: expires,
      environment: 'staging',
    });
  });

  it('FAIL-SAFE: query error → active=false + error captured', async () => {
    const ds = makeDataSource({
      throwOn: new Error('relation "observability.emergency_overrides" does not exist'),
    });
    const result = await lookupEmergencyOverride({
      dataSource: ds,
      serviceName: 'hr',
      kind: 'drift_fatal_bypass',
      environment: 'staging',
    });
    expect(result.active).toBe(false);
    expect(result.error).toContain('does not exist');
    expect(result.row).toBeUndefined();
  });

  it('passes the correct service + kind + environment to the query', async () => {
    const ds = makeDataSource({ rows: [] });
    await lookupEmergencyOverride({
      dataSource: ds,
      serviceName: 'farm',
      kind: 'migration_skip',
      environment: 'production',
    });
    const call = mockCall<[sql: string, params: string[]]>(ds.query as jest.Mock);
    expect(call[1]).toEqual(['farm', 'migration_skip', 'production']);
    // SQL contains expected filters.
    expect(call[0]).toContain('expires_at > NOW()');
    expect(call[0]).toContain('revoked_at IS NULL');
  });
});
