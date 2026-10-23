/**
 * buildOrgTree — turns the departments a reader can see into the organization
 * chart.
 *
 * Pure and total: every visible department appears in the result exactly once,
 * and nothing about bad data is hidden. The head counts and manager names are
 * the server's (`headCount`, `managerName`); this only nests and sums them.
 *  - A department whose parent is NOT in the visible set (another module's, a
 *    company-wide one, a deleted one — they look identical from here) becomes a
 *    root and says so (`rootReason: 'parent-outside-view'`).
 *  - A parent cycle (A -> B -> A, or a department that is its own parent) is
 *    reported in `cycles` and broken at its first member, which becomes a root
 *    (`rootReason: 'cycle'`), so no department disappears behind the loop.
 *  - A person is counted once: in the department they are placed in, and in the
 *    totals of that department's ancestors.
 */
import type { OrganizationDepartment } from '../../types';

/** The department fields the chart reads. */
export type OrgDepartment = Pick<
  OrganizationDepartment,
  | 'id'
  | 'name'
  | 'code'
  | 'moduleCode'
  | 'parentDepartmentId'
  | 'managerId'
  | 'managerName'
  | 'headCount'
  | 'isActive'
  | 'sortOrder'
>;

/** Why a node stands at the top of the chart. */
export type OrgRootReason = 'top-level' | 'parent-outside-view' | 'cycle';

/** A department's manager; `name` is null when that employee is no longer on record. */
export interface OrgManager {
  id: string;
  name: string | null;
}

export interface OrgNode {
  department: OrgDepartment;
  manager: OrgManager | null;
  /** People placed directly in this department. */
  directHeadCount: number;
  /** People in this department and every department below it. */
  totalHeadCount: number;
  /** Set on roots only; null for a node that hangs under its parent. */
  rootReason: OrgRootReason | null;
  children: OrgNode[];
}

export interface OrgTree {
  roots: OrgNode[];
  /** How many departments the chart shows (every visible one, once). */
  departmentCount: number;
  /** Each parent cycle found in the data, starting at the member it was broken at. */
  cycles: OrgDepartment[][];
}

/** sortOrder, then name, then id — the id makes the order total, so it never depends on input order. */
function compareDepartments(a: OrgDepartment, b: OrgDepartment): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Finds the parent cycles. Every department that is part of one, or hangs below
 * one, never reaches a root by walking up; walking up from each department until
 * a node repeats isolates the loop itself.
 */
function findParentCycles(
  sorted: readonly OrgDepartment[],
  parentOf: ReadonlyMap<string, OrgDepartment>,
): OrgDepartment[][] {
  const cycles: OrgDepartment[][] = [];
  const settled = new Set<string>();

  for (const start of sorted) {
    const path: OrgDepartment[] = [];
    const onPath = new Set<string>();
    let current: OrgDepartment | undefined = start;
    while (current !== undefined && !settled.has(current.id) && !onPath.has(current.id)) {
      path.push(current);
      onPath.add(current.id);
      current = parentOf.get(current.id);
    }

    if (current !== undefined && onPath.has(current.id)) {
      const loop = path.slice(path.indexOf(current));
      const first = loop.reduce((best, member) =>
        compareDepartments(member, best) < 0 ? member : best,
      );
      const at = loop.indexOf(first);
      cycles.push([...loop.slice(at), ...loop.slice(0, at)]);
    }
    for (const member of path) settled.add(member.id);
  }

  return cycles;
}

export function buildOrgTree(departments: readonly OrgDepartment[]): OrgTree {
  const sorted = [...departments].sort(compareDepartments);
  const byId = new Map(sorted.map((department) => [department.id, department]));

  // The parent link that exists inside the visible set.
  const parentOf = new Map<string, OrgDepartment>();
  for (const department of sorted) {
    const parent = department.parentDepartmentId
      ? byId.get(department.parentDepartmentId)
      : undefined;
    if (parent) parentOf.set(department.id, parent);
  }

  const cycles = findParentCycles(sorted, parentOf);
  const cycleBreaks = new Set(cycles.map((cycle) => cycle[0].id));

  const childrenOf = new Map<string, OrgDepartment[]>();
  const roots: Array<{ department: OrgDepartment; reason: OrgRootReason }> = [];
  for (const department of sorted) {
    const parent = parentOf.get(department.id);
    if (parent === undefined) {
      roots.push({
        department,
        reason: department.parentDepartmentId ? 'parent-outside-view' : 'top-level',
      });
    } else if (cycleBreaks.has(department.id)) {
      roots.push({ department, reason: 'cycle' });
    } else {
      childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), department]);
    }
  }

  function managerOf(department: OrgDepartment): OrgManager | null {
    return department.managerId ? { id: department.managerId, name: department.managerName } : null;
  }

  function toNode(department: OrgDepartment, rootReason: OrgRootReason | null): OrgNode {
    const children = (childrenOf.get(department.id) ?? []).map((child) => toNode(child, null));
    const direct = department.headCount;
    return {
      department,
      manager: managerOf(department),
      directHeadCount: direct,
      totalHeadCount: children.reduce((sum, child) => sum + child.totalHeadCount, direct),
      rootReason,
      children,
    };
  }

  return {
    roots: roots.map(({ department, reason }) => toNode(department, reason)),
    departmentCount: sorted.length,
    cycles,
  };
}
