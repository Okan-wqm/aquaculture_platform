/**
 * Topological sort-based circular dependency detector for computed expressions.
 *
 * When expressions reference other computed tags, cycles must be detected
 * to prevent infinite evaluation loops. For example:
 *   A = ${B} + 1
 *   B = ${A} * 2
 * This creates A -> B -> A, an infinite loop.
 *
 * Algorithm: Kahn's algorithm for topological sort.
 * - Build adjacency list and in-degree map from expression dependencies
 * - Process nodes with zero in-degree first (no dependencies on other computed tags)
 * - If all nodes are processed, the graph is acyclic — return evaluation order
 * - If some nodes remain, they form one or more cycles — return the cycle
 *
 * Time complexity: O(V + E) where V = number of expressions, E = total dependencies.
 * This is optimal for DAG cycle detection and adequate for SCADA screens with
 * up to thousands of computed tags.
 */

export interface ExpressionDefinition {
  /** The computed tag name (the output) */
  name: string;
  /** The raw expression string (for error reporting) */
  expression: string;
  /** Tag names this expression depends on (from parser.parse().dependencies) */
  dependencies: string[];
}

export interface CycleDetectionResult {
  /** Topologically sorted evaluation order (null if cycle detected) */
  order: string[] | null;
  /** List of node names forming a cycle (null if no cycle) */
  cycle: string[] | null;
}

/**
 * Detect cycles among computed expressions and return safe evaluation order.
 *
 * @param expressions - All computed expression definitions in the SCADA screen
 * @returns Either a valid evaluation order or the detected cycle
 */
export function detectCycles(expressions: ExpressionDefinition[]): CycleDetectionResult {
  if (expressions.length === 0) {
    return { order: [], cycle: null };
  }

  // Build the set of computed tag names for quick lookup
  const computedNames = new Set<string>(expressions.map((e) => e.name));

  // Adjacency list: for each computed tag, which other computed tags depend on it?
  // If A depends on B, then B has an edge to A (B must be evaluated before A).
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize all nodes
  for (const expr of expressions) {
    adjacency.set(expr.name, []);
    inDegree.set(expr.name, 0);
  }

  // Build edges: if expression A depends on computed tag B, add edge B -> A
  for (const expr of expressions) {
    for (const dep of expr.dependencies) {
      // Only track dependencies on OTHER computed tags — raw sensor tags
      // are leaf nodes that don't participate in the dependency graph
      if (computedNames.has(dep) && dep !== expr.name) {
        adjacency.get(dep)!.push(expr.name);
        inDegree.set(expr.name, (inDegree.get(expr.name) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm: BFS from nodes with zero in-degree
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // If we processed all nodes, the graph is acyclic
  if (order.length === computedNames.size) {
    return { order, cycle: null };
  }

  // Some nodes were not processed — they are part of cycle(s).
  // Extract one cycle for error reporting using DFS from an unprocessed node.
  const processed = new Set(order);
  const cycle = extractCycle(adjacency, inDegree, processed, computedNames);

  return { order: null, cycle };
}

/**
 * Extract a single cycle from the remaining unprocessed nodes using DFS.
 * We only need one cycle for error reporting — finding all cycles is
 * not useful for the user experience.
 */
function extractCycle(
  adjacency: Map<string, string[]>,
  inDegree: Map<string, number>,
  processed: Set<string>,
  computedNames: Set<string>,
): string[] {
  // Find an unprocessed node to start DFS from
  let startNode: string | null = null;
  for (const name of computedNames) {
    if (!processed.has(name)) {
      startNode = name;
      break;
    }
  }

  if (!startNode) return [];

  // DFS to find a cycle: follow edges from unprocessed nodes
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (visited.has(node)) {
      // Found a cycle — extract it from the path
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        return [...path.slice(cycleStart), node];
      }
      return [node];
    }

    visited.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!processed.has(neighbor)) {
        const result = dfs(neighbor);
        if (result) return result;
      }
    }

    path.pop();
    return null;
  }

  return dfs(startNode) ?? [startNode];
}
