import { stub, stubMember } from '@aquaculture/testing';
import type { EntityManager } from 'typeorm';

import type { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';
import { mappedCodesForUnit, measurementPlan } from '../measurement-plan';

const config = (
  code: string,
  displayOrder: number,
  isRequired: boolean,
): WaterQualityParameterConfig =>
  Object.assign({} as WaterQualityParameterConfig, { code, name: code, displayOrder, isRequired });

/** One rule for what a unit's form shows and what the validator requires. */
describe('measurementPlan', () => {
  const configs = [config('tan', 2, false), config('ph', 1, true), config('temperature', 3, true)];

  it('shows a planned unit its plan, in display order, requiring the plan’s required parameters', () => {
    const plan = measurementPlan(configs, new Set(['tan', 'ph']));
    expect(plan.planned).toBe(true);
    expect(plan.entries.map((e) => [e.config.code, e.required])).toEqual([
      ['ph', true],
      ['tan', false],
    ]);
  });

  it('shows an unplanned unit every active parameter and requires none', () => {
    const plan = measurementPlan(configs, new Set());
    expect(plan.planned).toBe(false);
    expect(plan.entries.map((e) => [e.config.code, e.required])).toEqual([
      ['ph', false],
      ['tan', false],
      ['temperature', false],
    ]);
  });

  it('requires the tenant’s required parameters on a site-level sample', () => {
    const plan = measurementPlan(configs, null);
    expect(plan.entries.filter((e) => e.required).map((e) => e.config.code)).toEqual([
      'ph',
      'temperature',
    ]);
  });
});

describe('mappedCodesForUnit', () => {
  it('reads only active mappings of the unit, inner-joined to an active config of the tenant', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const query = {
      innerJoin: (...args: unknown[]) => (calls.push(['innerJoin', ...args]), query),
      select: (...args: unknown[]) => (calls.push(['select', ...args]), query),
      where: (...args: unknown[]) => (calls.push(['where', ...args]), query),
      andWhere: (...args: unknown[]) => (calls.push(['andWhere', ...args]), query),
      getRawMany: async () => [{ code: 'ph' }, { code: 'tan' }],
    };
    const manager = stub<EntityManager>({
      createQueryBuilder: stubMember<EntityManager['createQueryBuilder']>(() => query),
    });
    const codes = await mappedCodesForUnit(manager, 'tenant-1', 'unit-1');
    expect([...codes]).toEqual(['ph', 'tan']);
    expect(calls).toEqual([
      ['innerJoin', 'mapping.parameterConfig', 'config'],
      ['select', 'config.code', 'code'],
      ['where', 'mapping.tenantId = :tenantId', { tenantId: 'tenant-1' }],
      ['andWhere', 'mapping.equipmentId = :unitId', { unitId: 'unit-1' }],
      ['andWhere', 'mapping.isActive = true'],
      // A soft-deleted config (isActive false) keeps its mappings active; it must
      // not make the unit planned with no entries.
      ['andWhere', 'config.isActive = true'],
      ['andWhere', 'config.tenantId = :tenantId', { tenantId: 'tenant-1' }],
    ]);
  });
});
