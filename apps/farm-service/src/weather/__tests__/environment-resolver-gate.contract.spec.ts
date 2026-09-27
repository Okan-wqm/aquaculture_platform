import { Role } from '@aquaculture/backend-common/decorators';
import { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { ServiceUnavailableException } from '@nestjs/common';

import { EnvironmentMetric } from '../entities/environment-observation.types';
import { EnvironmentResolver } from '../environment.resolver';
import { EnvironmentMonitoringGate } from '../services/environment-monitoring-gate.service';
import { EnvironmentReadService } from '../services/environment-read.service';

/**
 * The rollout gate contract on the environment resolver (ORPHAN-MEDIUM-827).
 *
 * `environmentMonitoringStatus` is the one read that reports the gate instead
 * of enforcing it. Every other read enforces it BEFORE touching the read
 * service, so a closed gate never reaches a tenant's data. Both halves are
 * pinned here so neither can drift: a new read that forgets `assertEnabled`
 * fails the second block; a status read that starts asserting fails the first.
 */

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SITE_ID = '93638ecc-1ceb-4c4b-b0d7-e8eec529caad';
const CALLER: SiteScopeCaller = {
  sub: 'user-1',
  roles: [Role.TENANT_ADMIN],
  assignedSiteIds: [SITE_ID],
};

type EnvironmentReads = Pick<
  EnvironmentReadService,
  'current' | 'history' | 'forecast' | 'layerCatalog' | 'scenes'
>;

function makeHarness(enabled: boolean) {
  const gate = new EnvironmentMonitoringGate({ get: () => String(enabled) });
  const assertEnabled = jest.spyOn(gate, 'assertEnabled');
  const readService: EnvironmentReads = {
    current: jest.fn(),
    history: jest.fn(),
    forecast: jest.fn(),
    layerCatalog: jest.fn(),
    scenes: jest.fn(),
  };
  const resolver = new EnvironmentResolver(readService as EnvironmentReadService, gate);
  return { resolver, readService, assertEnabled };
}

describe('EnvironmentResolver rollout-gate contract', () => {
  it.each([true, false])(
    'environmentMonitoringStatus reports enabled=%s as a value, without asserting the gate',
    (enabled) => {
      const { resolver, readService, assertEnabled } = makeHarness(enabled);

      expect(resolver.environmentMonitoringStatus()).toEqual({ enabled });

      expect(assertEnabled).not.toHaveBeenCalled();
      for (const read of Object.values(readService)) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  const gatedReads: Array<[string, (resolver: EnvironmentResolver) => Promise<unknown>]> = [
    ['siteEnvironmentCurrent', (r) => r.siteEnvironmentCurrent(SITE_ID, TENANT_ID, CALLER)],
    [
      'siteEnvironmentHistory',
      (r) =>
        r.siteEnvironmentHistory(
          {
            siteId: SITE_ID,
            metrics: [EnvironmentMetric.AIR_TEMPERATURE],
            from: new Date('2026-09-01'),
            to: new Date('2026-09-18'),
          },
          TENANT_ID,
          CALLER,
        ),
    ],
    [
      'siteEnvironmentForecast',
      (r) =>
        r.siteEnvironmentForecast(
          { siteId: SITE_ID, metrics: [EnvironmentMetric.AIR_TEMPERATURE], days: 7 },
          TENANT_ID,
          CALLER,
        ),
    ],
    ['environmentLayerCatalog', (r) => r.environmentLayerCatalog(SITE_ID, TENANT_ID, CALLER)],
    [
      'environmentScenes',
      (r) =>
        r.environmentScenes(
          { siteId: SITE_ID, from: new Date('2026-09-01'), to: new Date('2026-09-18'), first: 50 },
          TENANT_ID,
          CALLER,
        ),
    ],
  ];

  it.each(gatedReads)(
    '%s refuses a closed gate before touching the read service',
    async (_name, call) => {
      const { resolver, readService } = makeHarness(false);

      await expect(call(resolver)).rejects.toBeInstanceOf(ServiceUnavailableException);

      for (const read of Object.values(readService)) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it('every read the resolver exposes is either the status read or a gated read', () => {
    const exposed = Object.getOwnPropertyNames(EnvironmentResolver.prototype).filter(
      (name) => name !== 'constructor',
    );
    const covered = new Set(['environmentMonitoringStatus', ...gatedReads.map(([name]) => name)]);
    expect(exposed.sort()).toEqual([...covered].sort());
  });
});
