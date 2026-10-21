/**
 * Scenario CRUD handler specs — fail-closed tenant scoping + the ≥2-points
 * / unique-date / range validation the interpolation contract needs.
 */
import { createMockDataSource } from '@aquaculture/testing';
import { BadRequestException } from '@nestjs/common';

import { GetTemperatureScenariosHandler } from '../query-handlers/get-temperature-scenarios.handler';
import { CreateTemperatureScenarioHandler } from '../query-handlers/create-temperature-scenario.handler';
import { GetTemperatureScenariosQuery } from '../queries/get-temperature-scenarios.query';
import { CreateTemperatureScenarioQuery } from '../queries/create-temperature-scenario.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('temperature scenario handlers', () => {
  it('lists scenarios scoped to tenant + site, points joined by scenario', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockImplementation(async (entity: unknown) => {
      if (String(entity).includes('TemperatureScenarioPoint')) {
        return [
          { tenantId, scenarioId: 's2', date: '2026-11-01', celsius: 15 },
          { tenantId, scenarioId: 's1', date: '2026-10-01', celsius: 13 },
        ];
      }
      return [
        {
          id: 's1',
          tenantId,
          siteId,
          name: 'Kış 26',
          source: 'manual',
          isDeleted: false,
          createdAt: new Date(),
        },
        {
          id: 's2',
          tenantId,
          siteId,
          name: 'Sonbahar',
          source: 'manual',
          isDeleted: false,
          createdAt: new Date(),
        },
      ];
    });

    const result = await new GetTemperatureScenariosHandler(mockDataSource).execute(
      new GetTemperatureScenariosQuery(tenantId, siteId),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.points).toEqual([{ date: '2026-10-01', celsius: 13 }]);
    expect(result[1]?.points).toEqual([{ date: '2026-11-01', celsius: 15 }]);
    const [, scenarioOpts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(scenarioOpts.where).toMatchObject({ tenantId, siteId, isDeleted: false });
  });

  it('refuses fewer than two points (interpolation needs a span)', async () => {
    const { mockDataSource } = createMockDataSource();
    await expect(
      new CreateTemperatureScenarioHandler(mockDataSource).execute(
        new CreateTemperatureScenarioQuery(
          tenantId,
          siteId,
          'X',
          [{ date: '2026-10-01', celsius: 13 }],
          'u1',
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses duplicate dates and out-of-range temperatures', async () => {
    const { mockDataSource } = createMockDataSource();
    await expect(
      new CreateTemperatureScenarioHandler(mockDataSource).execute(
        new CreateTemperatureScenarioQuery(
          tenantId,
          siteId,
          'X',
          [
            { date: '2026-10-01', celsius: 13 },
            { date: '2026-10-01', celsius: 14 },
          ],
          'u1',
        ),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      new CreateTemperatureScenarioHandler(mockDataSource).execute(
        new CreateTemperatureScenarioQuery(
          tenantId,
          siteId,
          'X',
          [
            { date: '2026-10-01', celsius: 13 },
            { date: '2026-11-01', celsius: 99 },
          ],
          'u1',
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('saves the scenario and its points in one tenant transaction', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.save as jest.Mock).mockResolvedValue({
      id: 's1',
      tenantId,
      siteId,
      name: 'Kış 26',
      source: 'manual',
      isDeleted: false,
      createdAt: new Date('2026-10-19T00:00:00Z'),
    });

    const result = await new CreateTemperatureScenarioHandler(mockDataSource).execute(
      new CreateTemperatureScenarioQuery(
        tenantId,
        siteId,
        'Kış 26',
        [
          { date: '2026-11-01', celsius: 15 },
          { date: '2026-10-01', celsius: 13 },
        ],
        'u1',
      ),
    );

    expect(result.points.map((p) => p.date)).toEqual(['2026-10-01', '2026-11-01']);
    const [entity, saved] = (mockManager.save as jest.Mock).mock.calls[1];
    expect(String(entity)).toContain('TemperatureScenarioPoint');
    expect(saved).toHaveLength(2);
  });
});
