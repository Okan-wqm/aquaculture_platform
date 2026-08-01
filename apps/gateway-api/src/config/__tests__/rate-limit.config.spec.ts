import { ConfigService } from '@nestjs/config';

import { buildGatewayEdgeConfig } from '../rate-limit.config';

// Real ConfigService over an in-memory config map — no cast-through-unknown
// shortcut (the banned-construct gate forbids it). ConfigService.get reads
// this internal config.
function config(env: Record<string, string> = {}): ConfigService {
  return new ConfigService(env);
}

describe('buildGatewayEdgeConfig', () => {
  it('reproduces the gateway default tiers when no env is set', () => {
    const edge = buildGatewayEdgeConfig(config());
    expect(edge.tiers).toMatchObject({
      default: { name: 'default', limit: 100, windowMs: 60_000 },
      anonymous: { name: 'anonymous', limit: 20, windowMs: 60_000 },
      tenant: { name: 'tenant', limit: 1000, windowMs: 60_000 },
      login: { name: 'login', limit: 5, windowMs: 900_000 },
      upload: { name: 'upload', limit: 10, windowMs: 60_000 },
      marineRender: { name: 'marine-render', limit: 6, windowMs: 60_000 },
      mutations: { name: 'mutations', limit: 30, windowMs: 60_000 },
    });
  });

  it('maps literal login/upload paths and the segment-exact marine render route', () => {
    const edge = buildGatewayEdgeConfig(config());
    expect(edge.endpointBuckets).toEqual([
      { tier: 'login', paths: ['/api/auth/login', '/auth/login'] },
      { tier: 'upload', paths: ['/api/files/upload', '/api/v1/files/upload'] },
      {
        tier: 'marineRender',
        paths: [],
        pathTemplates: ['/api/marine/sites/:siteId/render'],
      },
    ]);
    expect(edge.mutationTier).toBe('mutations');
  });

  it('honors env overrides (parsed to numbers)', () => {
    const edge = buildGatewayEdgeConfig(
      config({
        RATE_LIMIT_DEFAULT: '50',
        RATE_LIMIT_WINDOW_MS: '30000',
        RATE_LIMIT_LOGIN_MAX: '3',
        RATE_LIMIT_MUTATION_MAX: '15',
        RATE_LIMIT_MARINE_RENDER_MAX: '4',
        RATE_LIMIT_MARINE_RENDER_WINDOW_MS: '120000',
      }),
    );
    expect(edge.tiers.default).toEqual({ name: 'default', limit: 50, windowMs: 30_000 });
    expect(edge.tiers.anonymous.windowMs).toBe(30_000); // shares RATE_LIMIT_WINDOW_MS
    // login/upload/mutations are Record-indexed (| undefined under
    // noUncheckedIndexedAccess) — assert via the whole object, not a member.
    expect(edge.tiers.login).toMatchObject({ limit: 3 });
    expect(edge.tiers.mutations).toMatchObject({ limit: 15 });
    expect(edge.tiers.marineRender).toEqual({
      name: 'marine-render',
      limit: 4,
      windowMs: 120_000,
    });
  });

  it('falls back to the default for a non-numeric env value', () => {
    const edge = buildGatewayEdgeConfig(config({ RATE_LIMIT_DEFAULT: 'not-a-number' }));
    expect(edge.tiers.default.limit).toBe(100);
  });

  it.each(['0', '-1', '1.5', '60oops', String(Number.MAX_SAFE_INTEGER + 1)])(
    'rejects unsafe marine render window override %s',
    (value) => {
      const edge = buildGatewayEdgeConfig(config({ RATE_LIMIT_MARINE_RENDER_WINDOW_MS: value }));

      expect(edge.tiers.marineRender?.windowMs).toBe(60_000);
    },
  );

  it.each(['0', '-6', '6requests'])(
    'rejects non-positive or partial marine render limit override %s',
    (value) => {
      const edge = buildGatewayEdgeConfig(config({ RATE_LIMIT_MARINE_RENDER_MAX: value }));

      expect(edge.tiers.marineRender?.limit).toBe(6);
    },
  );

  it('does NOT declare a passwordReset tier (gateway never enforced it)', () => {
    const edge = buildGatewayEdgeConfig(config());
    expect(edge.tiers).not.toHaveProperty('passwordReset');
    expect(edge.endpointBuckets.some((b) => b.tier === 'passwordReset')).toBe(false);
  });
});
