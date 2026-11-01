import type { ResolveDevicePlacementRequest } from '@platform/event-contracts';

import { type DevicePlacementFacts, judgeDevicePlacement } from './device-placement-judgement';

/**
 * Where a device may stand: a path down farm's topology in which every named
 * level is live and belongs to the named levels above it. The first failing
 * level is the answer; a placeable answer carries the unit's kind.
 */
describe('judgeDevicePlacement', () => {
  const request = (
    place: Partial<ResolveDevicePlacementRequest>,
  ): ResolveDevicePlacementRequest => ({
    tenantId: 'tenant-1',
    siteId: 'site-1',
    departmentId: null,
    systemId: null,
    unitId: null,
    ...place,
  });
  const tank = {
    kind: 'TANK' as const,
    departmentId: 'dept-1',
    systemIds: new Set(['loop-a']),
  };
  const facts = (known: Partial<DevicePlacementFacts>): DevicePlacementFacts => ({
    siteLive: true,
    department: { siteId: 'site-1' },
    system: { siteId: 'site-1', departmentId: 'dept-1' },
    unit: tank,
    ...known,
  });
  const fullPath = request({
    departmentId: 'dept-1',
    systemId: 'loop-a',
    unitId: 'tank-1',
  });

  it('places a device on a full, coherent path and says the unit is a tank', () => {
    expect(judgeDevicePlacement(fullPath, facts({}))).toEqual({
      placeable: true,
      unitKind: 'TANK',
    });
  });

  it('places a device at a site alone, with no unit kind', () => {
    expect(
      judgeDevicePlacement(request({}), facts({ department: null, system: null, unit: null })),
    ).toEqual({ placeable: true, unitKind: null });
  });

  it('refuses a site that is missing, deleted or inactive before looking further', () => {
    expect(judgeDevicePlacement(fullPath, facts({ siteLive: false }))).toEqual({
      placeable: false,
      refusedAt: 'SITE',
    });
  });

  it('refuses a department that is not live or is at another site', () => {
    expect(judgeDevicePlacement(fullPath, facts({ department: null }))).toEqual({
      placeable: false,
      refusedAt: 'DEPARTMENT',
    });
    expect(judgeDevicePlacement(fullPath, facts({ department: { siteId: 'site-2' } }))).toEqual({
      placeable: false,
      refusedAt: 'DEPARTMENT',
    });
    expect(judgeDevicePlacement(fullPath, facts({ department: { siteId: null } }))).toEqual({
      placeable: false,
      refusedAt: 'DEPARTMENT',
    });
  });

  it('refuses a system that is not live, at another site, or in another department', () => {
    expect(judgeDevicePlacement(fullPath, facts({ system: null }))).toEqual({
      placeable: false,
      refusedAt: 'SYSTEM',
    });
    expect(
      judgeDevicePlacement(
        fullPath,
        facts({ system: { siteId: 'site-2', departmentId: 'dept-1' } }),
      ),
    ).toEqual({ placeable: false, refusedAt: 'SYSTEM' });
    expect(
      judgeDevicePlacement(
        fullPath,
        facts({ system: { siteId: 'site-1', departmentId: 'dept-2' } }),
      ),
    ).toEqual({ placeable: false, refusedAt: 'SYSTEM' });
  });

  it('accepts a site-wide system (no department) under any department of that site', () => {
    expect(
      judgeDevicePlacement(fullPath, facts({ system: { siteId: 'site-1', departmentId: null } })),
    ).toEqual({ placeable: true, unitKind: 'TANK' });
  });

  it('refuses a unit that is not live, or not in the named department or system', () => {
    expect(judgeDevicePlacement(fullPath, facts({ unit: null }))).toEqual({
      placeable: false,
      refusedAt: 'UNIT',
    });
    for (const unit of [
      { ...tank, departmentId: 'dept-2' },
      { ...tank, departmentId: null },
      { ...tank, systemIds: new Set(['loop-b']) },
    ]) {
      expect(judgeDevicePlacement(fullPath, facts({ unit }))).toEqual({
        placeable: false,
        refusedAt: 'UNIT',
      });
    }
  });

  it('checks a unit against only the levels the request names, and says it is equipment', () => {
    const inDepartment = request({ departmentId: 'dept-1', unitId: 'filter-1' });
    const filter = { ...tank, kind: 'EQUIPMENT' as const, systemIds: new Set<string>() };
    expect(judgeDevicePlacement(inDepartment, facts({ system: null, unit: filter }))).toEqual({
      placeable: true,
      unitKind: 'EQUIPMENT',
    });
  });

  it('refuses a system or a unit named without its department', () => {
    for (const place of [{ systemId: 'loop-a' }, { unitId: 'tank-1' }]) {
      expect(judgeDevicePlacement(request(place), facts({ department: null }))).toEqual({
        placeable: false,
        refusedAt: 'DEPARTMENT',
      });
    }
  });
});
