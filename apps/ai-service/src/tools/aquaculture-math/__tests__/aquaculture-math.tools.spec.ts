import 'reflect-metadata';
import {
  carryingCapacity,
  feedingImpact,
  growthProjection,
  oxygenBudget,
  specificGrowthRate,
} from '@platform/aquaculture-engines';
import type { ToolExecutionContext } from '../../core/tool.interface';
import { CalculateCarryingCapacityTool } from '../calculate-carrying-capacity.tool';
import { CalculateGrowthMetricsTool } from '../calculate-growth-metrics.tool';
import { CalculateOxygenBudgetTool } from '../calculate-oxygen-budget.tool';
import { PredictFeedingImpactTool } from '../predict-feeding-impact.tool';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'expert-farm-production-v1',
  personaTier: 'expert',
  actuationPolicy: 'confirm_required',
};

/**
 * FARM-LOW-329 — the ai-service math tools are thin @Tool wrappers over
 * @platform/aquaculture-engines: core (no module gate), read-only, every tier,
 * and they return the engine's result unchanged. Input hygiene is the tool's
 * own job (model-authored numbers).
 */
describe('aquaculture-math tools', () => {
  const tools = [
    new CalculateOxygenBudgetTool(),
    new CalculateCarryingCapacityTool(),
    new CalculateGrowthMetricsTool(),
    new PredictFeedingImpactTool(),
  ];

  it('are core, read-only, every-tier tools', () => {
    for (const tool of tools) {
      const meta = tool.getMetadata();
      expect(meta.requiresModule).toBeNull();
      expect(meta.requiresConfirmation).toBe(false);
      expect(meta.runtime).toBe('both');
      expect(meta.requiredPermissions).toEqual(['operator', 'manager', 'expert', 'supervisor']);
    }
    expect(tools.map((t) => t.getMetadata().name)).toEqual([
      'calculate_oxygen_budget',
      'calculate_carrying_capacity',
      'calculate_growth_metrics',
      'predict_feeding_impact',
    ]);
  });

  it('calculate_oxygen_budget returns the engine result verbatim', async () => {
    const input = {
      temperatureC: 20,
      dailyFeedKg: 10,
      tankVolumeM3: 100,
      currentDoMgL: 8,
      waterFlowM3h: 50,
    };
    const result = await new CalculateOxygenBudgetTool().execute(input, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(oxygenBudget(input));
  });

  it('calculate_carrying_capacity returns the engine result verbatim', async () => {
    const input = {
      tankVolumeM3: 100,
      temperatureC: 20,
      maxDensityKgM3: 20,
      avgFishWeightG: 500,
      dailyFeedingRatePercent: 2,
    };
    const result = await new CalculateCarryingCapacityTool().execute(input, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(carryingCapacity(input));
  });

  it('predict_feeding_impact returns the engine result verbatim', async () => {
    const input = {
      feedKg: 10,
      biomassKg: 500,
      tankVolumeM3: 100,
      temperatureC: 20,
      currentPH: 7.5,
      speciesCode: 'trout',
    };
    const result = await new PredictFeedingImpactTool().execute(input, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(feedingImpact(input));
  });

  it('calculate_growth_metrics dispatches on mode and tags the result', async () => {
    const tool = new CalculateGrowthMetricsTool();
    const sgr = await tool.execute(
      { mode: 'sgr', initialWeightG: 100, finalWeightG: 150, days: 30 },
      CTX,
    );
    expect(sgr.data).toEqual({ mode: 'sgr', ...specificGrowthRate(100, 150, 30) });

    const projection = await tool.execute(
      {
        mode: 'projection',
        currentWeightG: 100,
        currentQuantity: 1000,
        sgrPercentPerDay: 1,
        targetWeightG: 200,
      },
      CTX,
    );
    expect(projection.data).toEqual({
      mode: 'projection',
      ...growthProjection({
        currentWeightG: 100,
        currentQuantity: 1000,
        sgrPercentPerDay: 1,
        targetWeightG: 200,
      }),
    });

    const transfer = await tool.execute(
      {
        mode: 'transfer_density',
        sourceTank: { volumeM3: 100, currentBiomassKg: 1500, maxDensityKgM3: 20 },
        destTank: { volumeM3: 50, currentBiomassKg: 200, maxDensityKgM3: 20 },
        transferBiomassKg: 500,
      },
      CTX,
    );
    expect(transfer.success).toBe(true);
    expect(transfer.data).toMatchObject({
      mode: 'transfer_density',
      feasible: true,
      maxSafeTransferKg: 800,
    });
  });

  it('rejects out-of-range and mode-incomplete input before computing', async () => {
    const oxygen = await new CalculateOxygenBudgetTool().execute(
      { temperatureC: 60, dailyFeedKg: 10, tankVolumeM3: 100, currentDoMgL: 8 },
      CTX,
    );
    expect(oxygen.success).toBe(false);
    expect(oxygen.error).toContain('temperatureC must be ≤ 45');

    const zeroVolume = await new PredictFeedingImpactTool().execute(
      { feedKg: 10, biomassKg: 500, tankVolumeM3: 0, temperatureC: 20, currentPH: 7.5 },
      CTX,
    );
    expect(zeroVolume.success).toBe(false);
    expect(zeroVolume.error).toContain('tankVolumeM3');

    const growth = new CalculateGrowthMetricsTool();
    const missing = await growth.execute({ mode: 'fcr', feedConsumedKg: 10 }, CTX);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('biomassGainKg is required for mode fcr');
    const noHorizon = await growth.execute(
      { mode: 'projection', currentWeightG: 100, currentQuantity: 10, sgrPercentPerDay: 1 },
      CTX,
    );
    expect(noHorizon.success).toBe(false);
    expect(noHorizon.error).toContain('targetWeightG or projectionDays');
    const badMode = await growth.execute({ mode: 'fcr2' as never }, CTX);
    expect(badMode.success).toBe(false);
  });
});
