/**
 * Facility structure tree model (/sites/setup/structure).
 *
 * WHY: the setup tabs list sites, departments, systems and equipment as flat
 * tables, but the records already carry their parent links
 * (department.siteId; system.siteId / departmentId / parentSystemId;
 * equipment.departmentId / systemIds / parentEquipmentId). The structure page
 * shows the location tree those links form — Site › Department › System ›
 * Equipment — so the tree is DERIVED here from the existing list queries,
 * never stored a second time.
 *
 * WHAT: pure builders — the structural levels from the site, department and
 * system lists; the equipment rows of one department or system from that
 * node's equipment query; and the ancestor chain of any node.
 */
import type { Department } from '../../../hooks/useDepartments';
import type { Equipment } from '../../../hooks/useEquipment';
import type { Site } from '../../../hooks/useSites';
import type { System } from '../../../hooks/useSystems';

export type FacilityNodeKind = 'site' | 'department' | 'system' | 'equipment';

interface NodeBase {
  /** Unique across the rendered tree (equipment can sit under several systems). */
  key: string;
  parentKey: string | null;
  id: string;
  code: string;
  name: string;
  siteId: string;
  /** 0 for a site; the tree's aria-level is depth + 1. */
  depth: number;
}

export interface SiteNode extends NodeBase {
  kind: 'site';
  site: Site;
  children: Array<DepartmentNode | SystemNode>;
}

export interface DepartmentNode extends NodeBase {
  kind: 'department';
  department: Department;
  children: SystemNode[];
}

export interface SystemNode extends NodeBase {
  kind: 'system';
  system: System;
  children: SystemNode[];
}

export interface EquipmentNode extends NodeBase {
  kind: 'equipment';
  equipment: Equipment;
}

/** A node that can hold others; equipment rows are loaded per container on demand. */
export type ContainerNode = SiteNode | DepartmentNode | SystemNode;
export type FacilityNode = ContainerNode | EquipmentNode;

export interface FacilityTree {
  sites: SiteNode[];
  byKey: ReadonlyMap<string, ContainerNode>;
}

export function nodeKey(kind: Exclude<FacilityNodeKind, 'equipment'>, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Builds the structural levels. A department or system whose site is not in
 * the list (an orphan left by a deleted site) has no place in a site tree and
 * is left out; a system hangs under its parent system when that is loaded,
 * else under its department, else directly under its site.
 */
export function buildFacilityTree(
  sites: readonly Site[],
  departments: readonly Department[],
  systems: readonly System[],
): FacilityTree {
  const byKey = new Map<string, ContainerNode>();
  const siteById = new Map<string, SiteNode>();
  for (const site of sites) {
    const node: SiteNode = {
      kind: 'site',
      key: nodeKey('site', site.id),
      parentKey: null,
      id: site.id,
      code: site.code,
      name: site.name,
      siteId: site.id,
      depth: 0,
      site,
      children: [],
    };
    byKey.set(node.key, node);
    siteById.set(site.id, node);
  }

  for (const department of departments) {
    const site = department.siteId ? siteById.get(department.siteId) : undefined;
    if (!site) continue;
    const node: DepartmentNode = {
      kind: 'department',
      key: nodeKey('department', department.id),
      parentKey: site.key,
      id: department.id,
      code: department.code,
      name: department.name,
      siteId: site.id,
      depth: 1,
      department,
      children: [],
    };
    byKey.set(node.key, node);
    site.children.push(node);
  }

  const placed: Array<{ node: SystemNode; site: SiteNode }> = [];
  for (const system of systems) {
    const site = siteById.get(system.siteId);
    if (!site) continue;
    const node: SystemNode = {
      kind: 'system',
      key: nodeKey('system', system.id),
      parentKey: site.key,
      id: system.id,
      code: system.code,
      name: system.name,
      siteId: site.id,
      depth: 1,
      system,
      children: [],
    };
    byKey.set(node.key, node);
    placed.push({ node, site });
  }

  for (const { node, site } of placed) {
    const parent = structuralParentOf(node.system, byKey) ?? site;
    node.parentKey = parent.key;
    parent.children.push(node);
  }

  const siteNodes = [...siteById.values()];
  setDepths(siteNodes);
  return { sites: siteNodes, byKey };
}

/** The loaded parent system, else the loaded department, on the system's own site. */
function structuralParentOf(
  system: System,
  byKey: ReadonlyMap<string, ContainerNode>,
): SystemNode | DepartmentNode | undefined {
  const parentSystem = system.parentSystemId
    ? byKey.get(nodeKey('system', system.parentSystemId))
    : undefined;
  if (parentSystem?.kind === 'system' && parentSystem.siteId === system.siteId) return parentSystem;
  const department = system.departmentId
    ? byKey.get(nodeKey('department', system.departmentId))
    : undefined;
  if (department?.kind === 'department' && department.siteId === system.siteId) return department;
  return undefined;
}

/** Depth follows the attachment, so it is set once every parent link is known. */
function setDepths(nodes: ReadonlyArray<ContainerNode>, depth = 0): void {
  for (const node of nodes) {
    node.depth = depth;
    setDepths(node.children, depth + 1);
  }
}

/**
 * The equipment rows shown under a department or system, from that node's
 * equipment query. A system shows its top-level equipment (tanks included —
 * they arrive with a systemIds entry); a department shows only the equipment
 * that belongs to no system, so nothing is listed twice on one branch.
 * Sub-equipment (parentEquipmentId) belongs to its parent item, not the tree.
 */
export function equipmentNodes(
  parent: DepartmentNode | SystemNode,
  items: readonly Equipment[],
): EquipmentNode[] {
  return items
    .filter((item) => !item.parentEquipmentId)
    .filter((item) => parent.kind === 'system' || (item.systemIds ?? []).length === 0)
    .map((equipment) => ({
      kind: 'equipment',
      key: `equipment:${parent.id}:${equipment.id}`,
      parentKey: parent.key,
      id: equipment.id,
      code: equipment.code,
      name: equipment.name,
      siteId: parent.siteId,
      depth: parent.depth + 1,
      equipment,
    }));
}

/** Root-first chain of containers above `node` (empty for a site). */
export function ancestorsOf(tree: FacilityTree, node: FacilityNode): ContainerNode[] {
  const chain: ContainerNode[] = [];
  let parentKey = node.parentKey;
  while (parentKey !== null) {
    const parent = tree.byKey.get(parentKey);
    if (!parent) break;
    chain.unshift(parent);
    parentKey = parent.parentKey;
  }
  return chain;
}
