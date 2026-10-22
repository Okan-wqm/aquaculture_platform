/**
 * buildOrgTree — the organization chart's one derivation, pure and exhaustive.
 *
 * The chart must show EVERY visible department exactly once, say why a node is
 * a root, sum the server's head counts up the tree without double counting, and
 * never hide bad data (a parent cycle) — each rule is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { buildOrgTree, type OrgDepartment, type OrgNode, type OrgTree } from '../buildOrgTree';

function department(id: string, overrides: Partial<OrgDepartment> = {}): OrgDepartment {
  return {
    id,
    name: id,
    code: id.toUpperCase(),
    moduleCode: 'FARM',
    isActive: true,
    sortOrder: 0,
    headCount: 0,
    managerName: null,
    ...overrides,
  };
}

/** Department ids of a tree in reading order (parent before children). */
function readingOrder(nodes: readonly OrgNode[]): string[] {
  return nodes.flatMap((node) => [node.department.id, ...readingOrder(node.children)]);
}

function onlyRoot(tree: OrgTree): OrgNode {
  expect(tree.roots).toHaveLength(1);
  return tree.roots[0]!;
}

describe('buildOrgTree', () => {
  it('returns an empty chart for no departments', () => {
    const tree = buildOrgTree([]);

    expect(tree.roots).toEqual([]);
    expect(tree.cycles).toEqual([]);
    expect(tree.departmentCount).toBe(0);
  });

  it('nests departments through parentDepartmentId', () => {
    const tree = buildOrgTree([
      department('ops'),
      department('feeding', { parentDepartmentId: 'ops' }),
      department('night', { parentDepartmentId: 'feeding' }),
    ]);

    const ops = onlyRoot(tree);
    expect(ops.department.id).toBe('ops');
    expect(ops.rootReason).toBe('top-level');
    expect(ops.children.map((child) => child.department.id)).toEqual(['feeding']);
    expect(ops.children[0]!.rootReason).toBeNull();
    expect(ops.children[0]!.children.map((child) => child.department.id)).toEqual(['night']);
  });

  it('orders siblings by sortOrder, then name, then id — whatever order the server answered in', () => {
    const departments = [
      department('z-last', { name: 'Zeta', sortOrder: 2 }),
      department('b-two', { name: 'Beta', sortOrder: 1 }),
      department('a-one', { name: 'Alpha', sortOrder: 1 }),
      department('twin-2', { name: 'Twin', sortOrder: 3 }),
      department('twin-1', { name: 'Twin', sortOrder: 3 }),
    ];

    const forward = readingOrder(buildOrgTree(departments).roots);
    const reversed = readingOrder(buildOrgTree([...departments].reverse()).roots);

    expect(forward).toEqual(['a-one', 'b-two', 'z-last', 'twin-1', 'twin-2']);
    expect(reversed).toEqual(forward);
  });

  it('makes a department whose parent is outside the visible set a root and says so', () => {
    // WHY: a module workspace lists only its own departments; a company-wide
    // parent (or a soft-deleted one) is simply absent from the set.
    const tree = buildOrgTree([
      department('feeding', { parentDepartmentId: 'management-not-visible' }),
      department('night', { parentDepartmentId: 'feeding' }),
      department('top'),
    ]);

    const byId = new Map(tree.roots.map((root) => [root.department.id, root]));
    expect(byId.get('feeding')?.rootReason).toBe('parent-outside-view');
    expect(byId.get('top')?.rootReason).toBe('top-level');
    expect(byId.get('feeding')?.children.map((child) => child.department.id)).toEqual(['night']);
    expect(tree.cycles).toEqual([]);
  });

  it("shows each department's own head count and sums it up the tree", () => {
    const tree = buildOrgTree([
      department('ops', { headCount: 1 }),
      department('feeding', { parentDepartmentId: 'ops', headCount: 2 }),
      department('night', { parentDepartmentId: 'feeding', headCount: 4 }),
    ]);

    const ops = onlyRoot(tree);
    expect(ops.directHeadCount).toBe(1);
    expect(ops.totalHeadCount).toBe(7);
    expect(ops.children[0]!.directHeadCount).toBe(2);
    expect(ops.children[0]!.totalHeadCount).toBe(6);
    expect(ops.children[0]!.children[0]!.totalHeadCount).toBe(4);
  });

  it('keeps a department that has nobody in it at zero', () => {
    expect(onlyRoot(buildOrgTree([department('empty')])).totalHeadCount).toBe(0);
  });

  describe('manager', () => {
    it('is null when the department has none', () => {
      expect(onlyRoot(buildOrgTree([department('ops')])).manager).toBeNull();
    });

    it("is named with the server's managerName, even when the manager works in another module", () => {
      const tree = buildOrgTree([
        department('ops', { managerId: 'boss', managerName: 'Ada Lovelace' }),
      ]);

      expect(onlyRoot(tree).manager).toEqual({ id: 'boss', name: 'Ada Lovelace' });
    });

    it('has no name when the manager is no longer on record', () => {
      const tree = buildOrgTree([department('ops', { managerId: 'gone', managerName: null })]);

      expect(onlyRoot(tree).manager).toEqual({ id: 'gone', name: null });
    });
  });

  describe('bad data: parent cycles are reported, never hidden', () => {
    it('breaks a two-department cycle at its first member and lists the cycle', () => {
      const tree = buildOrgTree([
        department('a', { name: 'A', parentDepartmentId: 'b', headCount: 1 }),
        department('b', { name: 'B', parentDepartmentId: 'a' }),
        department('tail', { name: 'Tail', parentDepartmentId: 'b', headCount: 1 }),
      ]);

      expect(tree.cycles.map((cycle) => cycle.map((d) => d.id))).toEqual([['a', 'b']]);
      const root = onlyRoot(tree);
      expect(root.department.id).toBe('a');
      expect(root.rootReason).toBe('cycle');
      // Every department is still on the chart exactly once.
      expect(readingOrder(tree.roots).sort()).toEqual(['a', 'b', 'tail']);
      // And the people are still counted once.
      expect(root.totalHeadCount).toBe(2);
    });

    it('reports a department that is its own parent as a one-member cycle', () => {
      const tree = buildOrgTree([department('loop', { parentDepartmentId: 'loop' })]);

      expect(tree.cycles.map((cycle) => cycle.map((d) => d.id))).toEqual([['loop']]);
      expect(onlyRoot(tree).rootReason).toBe('cycle');
    });

    it('keeps healthy trees beside a cycle untouched', () => {
      const tree = buildOrgTree([
        department('healthy'),
        department('child', { parentDepartmentId: 'healthy' }),
        department('x', { parentDepartmentId: 'y' }),
        department('y', { parentDepartmentId: 'x' }),
      ]);

      expect(readingOrder(tree.roots).sort()).toEqual(['child', 'healthy', 'x', 'y']);
      expect(tree.cycles).toHaveLength(1);
      const healthy = tree.roots.find((root) => root.department.id === 'healthy');
      expect(healthy?.rootReason).toBe('top-level');
      expect(healthy?.children.map((c) => c.department.id)).toEqual(['child']);
    });
  });

  it('shows every visible department exactly once, whatever the shape of the data', () => {
    const departments = [
      department('r1'),
      department('r2', { parentDepartmentId: 'outside' }),
      department('c1', { parentDepartmentId: 'r1' }),
      department('c2', { parentDepartmentId: 'c1' }),
      department('c3', { parentDepartmentId: 'r2' }),
      department('k1', { parentDepartmentId: 'k2' }),
      department('k2', { parentDepartmentId: 'k1' }),
    ];

    const tree = buildOrgTree(departments);
    const shown = readingOrder(tree.roots);

    expect(tree.departmentCount).toBe(departments.length);
    expect([...shown].sort()).toEqual(departments.map((d) => d.id).sort());
    expect(new Set(shown).size).toBe(departments.length);
  });
});
