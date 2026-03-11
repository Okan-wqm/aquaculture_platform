import { describe, it, expect } from 'vitest';
import {
  buildScreenTree,
  getAncestors,
  getScreenPath,
  getChildren,
  getRootScreens,
  flattenTree,
  wouldCreateCycle,
} from '../sceneUtils';
import type { ScreenDef } from '../types';

/* ------------------------------------------------------------------ */
/*  Helper                                                             */
/* ------------------------------------------------------------------ */

function makeScreen(
  id: string,
  name: string,
  parentId?: string | null,
  sortOrder?: number,
): ScreenDef {
  return {
    id,
    name,
    screenType: 'process',
    isDefault: false,
    icon: 'Workflow',
    layout: { type: 'grid', cols: 12, rows: 8 },
    widgets: [],
    edges: [],
    parentId: parentId ?? null,
    sortOrder: sortOrder ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Test Data                                                          */
/*                                                                     */
/*  Root1 (sortOrder: 0)                                               */
/*  +-- Child1A (sortOrder: 0)                                         */
/*  |   +-- Grandchild1A1 (sortOrder: 0)                               */
/*  +-- Child1B (sortOrder: 1)                                         */
/*  Root2 (sortOrder: 1)                                               */
/*  +-- Child2A (sortOrder: 0)                                         */
/* ------------------------------------------------------------------ */

const screens: ScreenDef[] = [
  makeScreen('root1', 'Root 1', null, 0),
  makeScreen('root2', 'Root 2', null, 1),
  makeScreen('child1a', 'Child 1A', 'root1', 0),
  makeScreen('child1b', 'Child 1B', 'root1', 1),
  makeScreen('child2a', 'Child 2A', 'root2', 0),
  makeScreen('gc1a1', 'Grandchild 1A1', 'child1a', 0),
];

/* ================================================================== */
/*  getRootScreens                                                     */
/* ================================================================== */

describe('getRootScreens', () => {
  it('returns only root screens (parentId null/undefined)', () => {
    const roots = getRootScreens(screens);
    expect(roots).toHaveLength(2);
    expect(roots.map((s) => s.id)).toEqual(['root1', 'root2']);
  });

  it('sorts by sortOrder then name', () => {
    const list = [
      makeScreen('b', 'Beta', null, 1),
      makeScreen('a', 'Alpha', null, 0),
      makeScreen('c', 'Charlie', null, 1),
    ];
    const roots = getRootScreens(list);
    expect(roots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for empty array', () => {
    expect(getRootScreens([])).toEqual([]);
  });

  it('treats undefined parentId as root', () => {
    const screen: ScreenDef = {
      id: 'x',
      name: 'X',
      screenType: 'process',
      isDefault: false,
      icon: 'Workflow',
      layout: { type: 'grid', cols: 12, rows: 8 },
      widgets: [],
      edges: [],
      // parentId intentionally omitted (undefined)
    };
    const roots = getRootScreens([screen]);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe('x');
  });
});

/* ================================================================== */
/*  getChildren                                                        */
/* ================================================================== */

describe('getChildren', () => {
  it('returns direct children sorted by sortOrder', () => {
    const children = getChildren(screens, 'root1');
    expect(children).toHaveLength(2);
    expect(children.map((s) => s.id)).toEqual(['child1a', 'child1b']);
  });

  it('returns empty for leaf nodes', () => {
    expect(getChildren(screens, 'gc1a1')).toEqual([]);
  });

  it('returns empty for non-existent parentId', () => {
    expect(getChildren(screens, 'nonexistent')).toEqual([]);
  });

  it('returns single child when parent has only one', () => {
    const children = getChildren(screens, 'child1a');
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe('gc1a1');
  });

  it('sorts by name when sortOrders are equal', () => {
    const list = [
      makeScreen('p', 'Parent', null, 0),
      makeScreen('c2', 'Zebra', 'p', 0),
      makeScreen('c1', 'Alpha', 'p', 0),
    ];
    const children = getChildren(list, 'p');
    expect(children.map((s) => s.id)).toEqual(['c1', 'c2']);
  });
});

/* ================================================================== */
/*  buildScreenTree                                                    */
/* ================================================================== */

describe('buildScreenTree', () => {
  it('builds correct tree structure with depths', () => {
    const tree = buildScreenTree(screens);
    expect(tree).toHaveLength(2);
    expect(tree[0].screen.id).toBe('root1');
    expect(tree[1].screen.id).toBe('root2');
  });

  it('root nodes have depth 0', () => {
    const tree = buildScreenTree(screens);
    for (const node of tree) {
      expect(node.depth).toBe(0);
    }
  });

  it('children have depth 1', () => {
    const tree = buildScreenTree(screens);
    const root1 = tree[0];
    expect(root1.children).toHaveLength(2);
    for (const child of root1.children) {
      expect(child.depth).toBe(1);
    }
  });

  it('grandchildren have depth 2', () => {
    const tree = buildScreenTree(screens);
    const child1a = tree[0].children[0];
    expect(child1a.children).toHaveLength(1);
    expect(child1a.children[0].depth).toBe(2);
    expect(child1a.children[0].screen.id).toBe('gc1a1');
  });

  it('sorts siblings by sortOrder then name', () => {
    const tree = buildScreenTree(screens);
    const root1Children = tree[0].children;
    expect(root1Children[0].screen.id).toBe('child1a');
    expect(root1Children[1].screen.id).toBe('child1b');
  });

  it('handles empty array', () => {
    expect(buildScreenTree([])).toEqual([]);
  });

  it('handles flat list (no parents) — all at depth 0', () => {
    const flat = [
      makeScreen('a', 'A', null, 0),
      makeScreen('b', 'B', null, 1),
      makeScreen('c', 'C', null, 2),
    ];
    const tree = buildScreenTree(flat);
    expect(tree).toHaveLength(3);
    for (const node of tree) {
      expect(node.depth).toBe(0);
      expect(node.children).toEqual([]);
    }
  });

  it('orphaned children (parentId references non-existent screen) are excluded from the tree', () => {
    const withOrphan = [
      makeScreen('root', 'Root', null, 0),
      makeScreen('orphan', 'Orphan', 'nonexistent', 0),
    ];
    const tree = buildScreenTree(withOrphan);
    // Only the root appears since orphan's parentId doesn't match any screen
    // and it's not null so it won't be a root
    expect(tree).toHaveLength(1);
    expect(tree[0].screen.id).toBe('root');
  });

  it('handles a single root screen with no children', () => {
    const single = [makeScreen('only', 'Only Screen', null, 0)];
    const tree = buildScreenTree(single);
    expect(tree).toHaveLength(1);
    expect(tree[0].screen.id).toBe('only');
    expect(tree[0].children).toEqual([]);
    expect(tree[0].depth).toBe(0);
  });
});

/* ================================================================== */
/*  getAncestors                                                       */
/* ================================================================== */

describe('getAncestors', () => {
  it('returns empty for root screen', () => {
    expect(getAncestors(screens, 'root1')).toEqual([]);
  });

  it('returns [root1] for child1a', () => {
    const ancestors = getAncestors(screens, 'child1a');
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].id).toBe('root1');
  });

  it('returns [root1, child1a] for gc1a1', () => {
    const ancestors = getAncestors(screens, 'gc1a1');
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0].id).toBe('root1');
    expect(ancestors[1].id).toBe('child1a');
  });

  it('returns empty for non-existent id', () => {
    expect(getAncestors(screens, 'nonexistent')).toEqual([]);
  });

  it('returns [root2] for child2a', () => {
    const ancestors = getAncestors(screens, 'child2a');
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].id).toBe('root2');
  });

  it('handles cycle protection (max iterations)', () => {
    // Create a circular reference: a -> b -> a
    const cyclic: ScreenDef[] = [
      makeScreen('a', 'A', 'b', 0),
      makeScreen('b', 'B', 'a', 0),
    ];
    // Should not infinite-loop; the visited set and max iteration guard protect us
    const ancestors = getAncestors(cyclic, 'a');
    // b's parent is a, which is the start screen, so the visited set stops it
    expect(ancestors.length).toBeLessThanOrEqual(50);
  });

  it('handles deeply nested chain without blowing up', () => {
    // Create a chain: screen0 -> screen1 -> screen2 -> ... -> screen10
    const chain: ScreenDef[] = [];
    for (let i = 0; i <= 10; i++) {
      chain.push(makeScreen(`s${i}`, `Screen ${i}`, i === 0 ? null : `s${i - 1}`, 0));
    }
    const ancestors = getAncestors(chain, 's10');
    expect(ancestors).toHaveLength(10);
    expect(ancestors[0].id).toBe('s0');
    expect(ancestors[9].id).toBe('s9');
  });
});

/* ================================================================== */
/*  getScreenPath                                                      */
/* ================================================================== */

describe('getScreenPath', () => {
  it('returns [{id, name}] for root screen', () => {
    const path = getScreenPath(screens, 'root1');
    expect(path).toEqual([{ id: 'root1', name: 'Root 1' }]);
  });

  it('returns full path for grandchild', () => {
    const path = getScreenPath(screens, 'gc1a1');
    expect(path).toEqual([
      { id: 'root1', name: 'Root 1' },
      { id: 'child1a', name: 'Child 1A' },
      { id: 'gc1a1', name: 'Grandchild 1A1' },
    ]);
  });

  it('returns empty for non-existent id', () => {
    expect(getScreenPath(screens, 'nonexistent')).toEqual([]);
  });

  it('returns two-segment path for direct child', () => {
    const path = getScreenPath(screens, 'child1b');
    expect(path).toEqual([
      { id: 'root1', name: 'Root 1' },
      { id: 'child1b', name: 'Child 1B' },
    ]);
  });

  it('returns path under root2 branch', () => {
    const path = getScreenPath(screens, 'child2a');
    expect(path).toEqual([
      { id: 'root2', name: 'Root 2' },
      { id: 'child2a', name: 'Child 2A' },
    ]);
  });
});

/* ================================================================== */
/*  flattenTree                                                        */
/* ================================================================== */

describe('flattenTree', () => {
  it('flattens tree in depth-first order', () => {
    const tree = buildScreenTree(screens);
    const flat = flattenTree(tree);
    const ids = flat.map((n) => n.screen.id);
    // DFS: root1 -> child1a -> gc1a1 -> child1b -> root2 -> child2a
    expect(ids).toEqual(['root1', 'child1a', 'gc1a1', 'child1b', 'root2', 'child2a']);
  });

  it('preserves depth information', () => {
    const tree = buildScreenTree(screens);
    const flat = flattenTree(tree);
    const depths = flat.map((n) => n.depth);
    expect(depths).toEqual([0, 1, 2, 1, 0, 1]);
  });

  it('returns empty for empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('handles single-node tree', () => {
    const tree = buildScreenTree([makeScreen('only', 'Only', null, 0)]);
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(1);
    expect(flat[0].screen.id).toBe('only');
    expect(flat[0].depth).toBe(0);
  });

  it('handles flat list (all roots, no children)', () => {
    const tree = buildScreenTree([
      makeScreen('a', 'A', null, 0),
      makeScreen('b', 'B', null, 1),
    ]);
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(2);
    expect(flat.every((n) => n.depth === 0)).toBe(true);
  });
});

/* ================================================================== */
/*  wouldCreateCycle                                                   */
/* ================================================================== */

describe('wouldCreateCycle', () => {
  it('returns true when moving screen to itself', () => {
    expect(wouldCreateCycle(screens, 'root1', 'root1')).toBe(true);
  });

  it('returns true when moving root1 under gc1a1 (descendant)', () => {
    // root1 -> child1a -> gc1a1; moving root1 under gc1a1 creates a cycle
    expect(wouldCreateCycle(screens, 'root1', 'gc1a1')).toBe(true);
  });

  it('returns true when moving root1 under child1a (direct child)', () => {
    expect(wouldCreateCycle(screens, 'root1', 'child1a')).toBe(true);
  });

  it('returns true when moving root1 under child1b', () => {
    expect(wouldCreateCycle(screens, 'root1', 'child1b')).toBe(true);
  });

  it('returns false for valid reparenting (child1b under child1a)', () => {
    // child1b is a sibling of child1a, not a descendant — no cycle
    expect(wouldCreateCycle(screens, 'child1b', 'child1a')).toBe(false);
  });

  it('returns false for moving between unrelated branches', () => {
    // child2a is under root2, moving child1a under child2a is valid
    expect(wouldCreateCycle(screens, 'child1a', 'child2a')).toBe(false);
  });

  it('returns false for moving leaf to another branch', () => {
    expect(wouldCreateCycle(screens, 'gc1a1', 'root2')).toBe(false);
  });

  it('returns false when moving a screen under its current sibling', () => {
    expect(wouldCreateCycle(screens, 'child1a', 'child1b')).toBe(false);
  });

  it('handles screen with no descendants', () => {
    // gc1a1 has no children, so moving anything under gc1a1 is safe
    // except gc1a1 itself
    expect(wouldCreateCycle(screens, 'gc1a1', 'gc1a1')).toBe(true);
    expect(wouldCreateCycle(screens, 'gc1a1', 'root2')).toBe(false);
  });

  it('detects cycle in a deeper chain', () => {
    // s0 -> s1 -> s2 -> s3 -> s4
    const chain: ScreenDef[] = [];
    for (let i = 0; i <= 4; i++) {
      chain.push(makeScreen(`s${i}`, `S${i}`, i === 0 ? null : `s${i - 1}`, 0));
    }
    // Moving s0 under s4 would create: s4 -> s0 -> s1 -> s2 -> s3 -> s4 (cycle)
    expect(wouldCreateCycle(chain, 's0', 's4')).toBe(true);
    // Moving s4 under s0 is valid (s0 is already the ultimate ancestor)
    // Actually s4 has no descendants, so s0 is not a descendant of s4
    expect(wouldCreateCycle(chain, 's4', 's0')).toBe(false);
  });
});
