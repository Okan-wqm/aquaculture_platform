/**
 * Pure utility functions for hierarchical screen (scene) navigation
 * in the SCADA builder.
 *
 * All functions are pure — they take a flat `ScreenDef[]` as input
 * and return derived data. No store or React dependency.
 */

import type { ScreenDef } from './types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Tree node for hierarchical screen display. */
export interface ScreenTreeNode {
  screen: ScreenDef;
  children: ScreenTreeNode[];
  depth: number;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/** Sort comparator: sortOrder ascending (default 0), then name as tiebreaker. */
function bySortOrderThenName(a: ScreenDef, b: ScreenDef): number {
  const orderA = a.sortOrder ?? 0;
  const orderB = b.sortOrder ?? 0;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name);
}

/**
 * Recursively build child nodes for the given parentId.
 */
function buildChildren(
  screens: ScreenDef[],
  parentId: string,
  depth: number,
): ScreenTreeNode[] {
  return screens
    .filter((s) => s.parentId === parentId)
    .sort(bySortOrderThenName)
    .map((screen) => ({
      screen,
      children: buildChildren(screens, screen.id, depth + 1),
      depth,
    }));
}

/**
 * Collect all descendant IDs of a screen (depth-first).
 */
function getDescendantIds(screens: ScreenDef[], screenId: string): Set<string> {
  const descendants = new Set<string>();
  const stack = [screenId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = screens.filter((s) => s.parentId === current);
    for (const child of children) {
      if (!descendants.has(child.id)) {
        descendants.add(child.id);
        stack.push(child.id);
      }
    }
  }

  return descendants;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a tree structure from a flat screen array.
 * Root screens have `parentId` that is `null`, `undefined`, or missing.
 */
export function buildScreenTree(screens: ScreenDef[]): ScreenTreeNode[] {
  const rootScreens = screens
    .filter((s) => s.parentId == null)
    .sort(bySortOrderThenName);

  return rootScreens.map((screen) => ({
    screen,
    children: buildChildren(screens, screen.id, 1),
    depth: 0,
  }));
}

/**
 * Get all ancestor screens from a screen up to root, ordered root-first.
 * Guards against cycles with a max iteration limit of 50.
 */
export function getAncestors(
  screens: ScreenDef[],
  screenId: string,
): ScreenDef[] {
  const ancestors: ScreenDef[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = screenId;
  let iterations = 0;
  const maxIterations = 50;

  // Walk up the parentId chain starting from the given screen's parent
  const startScreen = screens.find((s) => s.id === currentId);
  if (!startScreen) return ancestors;

  currentId = startScreen.parentId;

  while (currentId != null && iterations < maxIterations) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);

    const parent = screens.find((s) => s.id === currentId);
    if (!parent) break;

    ancestors.push(parent);
    currentId = parent.parentId;
    iterations++;
  }

  // Reverse so root is first
  ancestors.reverse();
  return ancestors;
}

/**
 * Get breadcrumb path as array of `{ id, name }` from root to the given
 * screen (inclusive).
 */
export function getScreenPath(
  screens: ScreenDef[],
  screenId: string,
): Array<{ id: string; name: string }> {
  const target = screens.find((s) => s.id === screenId);
  if (!target) return [];

  const ancestors = getAncestors(screens, screenId);
  const path = ancestors.map((s) => ({ id: s.id, name: s.name }));
  path.push({ id: target.id, name: target.name });

  return path;
}

/**
 * Get direct children of a screen, sorted by `sortOrder` then `name`.
 */
export function getChildren(
  screens: ScreenDef[],
  parentId: string,
): ScreenDef[] {
  return screens
    .filter((s) => s.parentId === parentId)
    .sort(bySortOrderThenName);
}

/**
 * Get root-level screens (no parent), sorted by `sortOrder` then `name`.
 */
export function getRootScreens(screens: ScreenDef[]): ScreenDef[] {
  return screens
    .filter((s) => s.parentId == null)
    .sort(bySortOrderThenName);
}

/**
 * Flatten a tree into a depth-first ordered list.
 * Useful for rendering a tree as a flat list with indentation.
 */
export function flattenTree(nodes: ScreenTreeNode[]): ScreenTreeNode[] {
  const result: ScreenTreeNode[] = [];

  function walk(list: ScreenTreeNode[]): void {
    for (const node of list) {
      result.push(node);
      walk(node.children);
    }
  }

  walk(nodes);
  return result;
}

/**
 * Check if moving `screenId` under `newParentId` would create a cycle.
 *
 * A cycle occurs when:
 * - `newParentId` is the screen itself, or
 * - `newParentId` is a descendant of `screenId`.
 */
export function wouldCreateCycle(
  screens: ScreenDef[],
  screenId: string,
  newParentId: string,
): boolean {
  // Moving a screen under itself is always a cycle
  if (screenId === newParentId) return true;

  // Check if newParentId is among the descendants of screenId
  const descendants = getDescendantIds(screens, screenId);
  return descendants.has(newParentId);
}
