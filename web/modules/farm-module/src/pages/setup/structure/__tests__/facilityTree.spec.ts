/**
 * facilityTree — the location tree is derived from the records' own parent
 * links (department.siteId, system.departmentId / parentSystemId / siteId,
 * equipment.systemIds / parentEquipmentId), never stored twice.
 */
import { describe, expect, it } from 'vitest';

import type { Department } from '../../../../hooks/useDepartments';
import type { Equipment } from '../../../../hooks/useEquipment';
import type { Site } from '../../../../hooks/useSites';
import type { System } from '../../../../hooks/useSystems';
import { equipmentIdsOfNodes } from '../../../../hooks/useProcessFlows';
import { ancestorsOf, buildFacilityTree, equipmentNodes, nodeKey } from '../facilityTree';

const STAMP = '2026-01-01T00:00:00.000Z';

function site(id: string, code: string): Site {
  return {
    id,
    code,
    name: `Site ${code}`,
    type: 'LAND_BASED',
    status: 'ACTIVE',
    monitoringRadiusM: 500,
    monitoringLocationRevision: 1,
    isActive: true,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function department(id: string, code: string, siteId: string | undefined): Department {
  return {
    id,
    code,
    name: `Department ${code}`,
    type: 'GROW_OUT',
    status: 'ACTIVE',
    siteId,
    isActive: true,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function system(
  id: string,
  code: string,
  siteId: string,
  links: { departmentId?: string; parentSystemId?: string } = {},
): System {
  return {
    id,
    code,
    name: `System ${code}`,
    type: 'RAS',
    status: 'ACTIVE',
    siteId,
    ...links,
    isActive: true,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function equipment(
  id: string,
  code: string,
  links: { systemIds?: string[]; parentEquipmentId?: string } = {},
): Equipment {
  return {
    id,
    code,
    name: `Equipment ${code}`,
    status: 'OPERATIONAL',
    equipmentTypeId: 'type-1',
    departmentId: 'dep-a',
    ...links,
    isActive: true,
  };
}

const SITES = [site('site-a', 'SITE-A'), site('site-b', 'SITE-B')];
const DEPARTMENTS = [
  department('dep-a', 'A-BUY', 'site-a'),
  department('dep-orphan', 'ORPHAN', undefined),
];
const SYSTEMS = [
  system('sys-1', 'RAS-1', 'site-a', { departmentId: 'dep-a' }),
  system('sys-1a', 'RAS-1A', 'site-a', { departmentId: 'dep-a', parentSystemId: 'sys-1' }),
  system('sys-site', 'PWR-A', 'site-a'),
  system('sys-gone', 'GONE', 'site-deleted'),
];

describe('buildFacilityTree', () => {
  const tree = buildFacilityTree(SITES, DEPARTMENTS, SYSTEMS);

  it('hangs departments under their site and drops orphans', () => {
    expect(tree.sites.map((s) => s.code)).toEqual(['SITE-A', 'SITE-B']);
    const siteA = tree.sites[0];
    expect(siteA.children.map((c) => c.code)).toEqual(['A-BUY', 'PWR-A']);
    expect(tree.byKey.has(nodeKey('department', 'dep-orphan'))).toBe(false);
    expect(tree.byKey.has(nodeKey('system', 'sys-gone'))).toBe(false);
  });

  it('places a system under its parent system, else its department, else its site', () => {
    const department = tree.byKey.get(nodeKey('department', 'dep-a'));
    expect(department?.children.map((c) => c.code)).toEqual(['RAS-1']);
    const ras1 = tree.byKey.get(nodeKey('system', 'sys-1'));
    expect(ras1?.children.map((c) => c.code)).toEqual(['RAS-1A']);
    expect(ras1?.depth).toBe(2);
    expect(tree.byKey.get(nodeKey('system', 'sys-1a'))?.depth).toBe(3);
    expect(tree.byKey.get(nodeKey('system', 'sys-site'))?.depth).toBe(1);
  });

  it('returns the root-first ancestor chain of a node', () => {
    const child = tree.byKey.get(nodeKey('system', 'sys-1a'));
    if (!child) throw new Error('fixture missing');
    expect(ancestorsOf(tree, child).map((n) => n.code)).toEqual(['SITE-A', 'A-BUY', 'RAS-1']);
  });
});

describe('equipmentNodes', () => {
  const tree = buildFacilityTree(SITES, DEPARTMENTS, SYSTEMS);
  const items = [
    equipment('eq-pump', 'P-101', { systemIds: ['sys-1'] }),
    equipment('eq-loose', 'FD-04', { systemIds: [] }),
    equipment('eq-sub', 'P-101-M', { systemIds: ['sys-1'], parentEquipmentId: 'eq-pump' }),
  ];

  it('lists a system’s top-level equipment, one level below it', () => {
    const ras1 = tree.byKey.get(nodeKey('system', 'sys-1'));
    if (ras1?.kind !== 'system') throw new Error('fixture missing');
    const rows = equipmentNodes(ras1, items);
    expect(rows.map((r) => r.code)).toEqual(['P-101', 'FD-04']);
    expect(rows[0].depth).toBe(3);
    expect(rows[0].parentKey).toBe(ras1.key);
  });

  it('lists only system-less equipment directly under a department', () => {
    const dep = tree.byKey.get(nodeKey('department', 'dep-a'));
    if (dep?.kind !== 'department') throw new Error('fixture missing');
    expect(equipmentNodes(dep, items).map((r) => r.code)).toEqual(['FD-04']);
  });
});

describe('equipmentIdsOfNodes', () => {
  it('reads node.data.equipmentId from a process diagram node list', () => {
    const nodes = [
      { id: 'n1', data: { equipmentId: 'eq-pump', equipmentName: 'Pump' } },
      { id: 'n2', data: { equipmentName: 'Label' } },
      { id: 'n3', data: { equipmentId: 'eq-pump' } },
      'not-a-node',
    ];
    expect(equipmentIdsOfNodes(nodes)).toEqual(['eq-pump']);
    expect(equipmentIdsOfNodes({ not: 'a list' })).toEqual([]);
  });
});
