#!/usr/bin/env ts-node
/**
 * plan-coverage-witness — deterministic impact-closure computer for ARIA plans.
 * ============================================================================
 *
 * # Purpose
 *
 * ARIA's convergence gate measures AGREEMENT between two planners, not
 * COVERAGE of the codebase: both planners can share a blind spot and converge
 * on it. This witness computes the machine-verifiable impact closure of a
 * plan's `affected_surfaces` paths and reports which closure nodes the plan
 * neither addresses nor explicitly waives. The ARIA kernel
 * (aria_kernel/plan_coverage.py) invokes it and records the verdict as a
 * `coverage_computed` event; the evaluator refuses CONVERGED while gaps or
 * an unusable environment stand.
 *
 * # What "closure" means here (plan-time, not diff-time)
 *
 * At plan time there is no diff — the only machine-trustworthy inputs are the
 * plan's affected PATHS and the repo at HEAD. The closure has ONE owner, the
 * kernel's `impact_graph.impact_closure` (service-expertise PLAN §2, SE-4): it
 * walks import, gateway_subgraph and code event edges and the kernel hands its
 * node set in as `closure_nodes`. The witness computes no project or
 * event-consumer node of its own; it adds two node classes and diffs:
 *
 *   project:<name>          — the given closure nodes, as handed in.
 *   event-consumer-unresolved:<svc|lib>:<path>:<line>
 *                           — a subscription site whose event type or
 *                             subject the scan cannot resolve statically:
 *                             an unknown consumer is a gap, never a pass.
 *   migration:<svc>         — when an affected path is an `*.entity.ts`
 *                             under apps/<svc>/, the service's migration
 *                             surface (plan-time analog of
 *                             entity-diff-witness).
 *
 * A node is covered when an explicit waiver names it (`node` exact match, or
 * group `dependents-of:<project>` over a given node's `reached_from`). The nx
 * graph names the touched projects (`closure.projects`); paths owned by no nx
 * project (docs/, .claude/, aria-tools/) are reported as `unmapped_paths` —
 * informational, never gaps.
 *
 * LLM prose (key_changes, summary) is DELIBERATELY not parsed: matching on
 * words would let a planner satisfy the gate by mentioning the right names.
 *
 * # Invocation
 *
 *   ts-node --project tools/gates/tsconfig.json tools/gates/plan-coverage-witness.ts \
 *     --input <input.json> [--graph <nx-graph.json>] [--repo-root <dir>]
 *
 * `--graph` exists so the spec suite runs on fixtures without a live nx
 * workspace. Without `--graph`, the witness generates the
 * graph via `npx nx graph --file=<tmp>` (the scripts/ci precedent).
 *
 * Input JSON: { schema_version: 1, affected_paths: string[],
 *               waivers: [{node, reason}],
 *               closure_nodes: [{node_id, kind: 'nx_project', why, reached_from?}],
 *               options?: { max_nodes?: number } }
 *
 * Output JSON (stdout): { schema_version: 1, verdict, closure, uncovered,
 *                         waived, unmapped_paths, ledger, inputs_hash }
 *
 * `ledger.event_consumer_index` records the code scan for unresolved
 * subscription sites (files scanned, subscription sites, entries, unresolved
 * and unattributed sites), and is null when no contract path is touched.
 *
 * Exit codes (contract — aria_kernel/plan_coverage.py depends on these):
 *   0 — closure computed, no uncovered nodes (covered / covered_with_waivers)
 *   1 — closure computed, uncovered nodes present (gaps)
 *   2 — environment/invocation error (missing input, no closure_nodes, nx
 *        unavailable, or the code scan for event consumers failing) — the kernel
 *        maps this to environment_unable -> HUMAN_REQUIRED, never a silent
 *        pass.
 *
 * # Event consumers come from the closure (ARIA-HIGH-313, SE-4)
 *
 * Which applications consume an event is the code-fact bridge's answer
 * (`--facts` in tools/gates/event-consumer-index.ts: code producer x code
 * subscription edges), walked by the kernel's closure. An ACL grant is a
 * permission, never an edge (SK-09), so a grant-only consumer is no node. The
 * witness still runs the consumer scan when a contract path is touched, for
 * the one thing the closure cannot carry: a subscription whose value does not
 * fold may consume any event, so it is a gap, never a pass.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { type EventConsumerIndex, scanEventConsumers } from './event-consumer-index';
import { removeFixtureTree } from './fixture-tree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WaiverEntry {
  readonly node: string;
  readonly reason: string;
}

interface WitnessInput {
  readonly schema_version: number;
  readonly affected_paths: readonly string[];
  readonly waivers: readonly WaiverEntry[];
  readonly closure_nodes: readonly ClosureNode[];
  readonly options?: { readonly max_nodes?: number };
}

interface ClosureNode {
  readonly node_id: string;
  readonly kind: 'nx_project' | 'event_consumer' | 'migration' | 'closure';
  readonly why: string;
  /** For dependents-of:<project> group waivers. */
  readonly reached_from?: string;
}

interface NxGraphFile {
  readonly graph: {
    readonly nodes: Record<string, { readonly data?: { readonly root?: string } }>;
    readonly dependencies: Record<
      string,
      readonly { readonly source: string; readonly target: string }[]
    >;
  };
}

/** What the code scan for event consumers found — written to the report. */
interface EventConsumerIndexLedger {
  readonly files_scanned: number;
  readonly sites: number;
  readonly entries: number;
  readonly unresolved: readonly string[];
  readonly unattributed: readonly string[];
}

// ---------------------------------------------------------------------------
// Closure computation
// ---------------------------------------------------------------------------

const EVENT_CONTRACTS_PREFIX = 'libs/event-contracts/';
const ENTITY_PATH_RE = /^apps\/([\w-]+)\/.*\.entity\.ts$/;
const MIGRATION_PATH_RE = /^apps\/([\w-]+)\/src\/(?:database\/)?migrations\//;
const DEFAULT_MAX_NODES = 200;

function fail(message: string): never {
  process.stderr.write(`plan-coverage-witness: ${message}\n`);
  process.exit(2);
}

/** Runtime-validated input parse — the type is EARNED, not asserted. */
function parseWitnessInput(raw: string): WitnessInput {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) fail('input must be a JSON object');
  const candidate = parsed as Record<string, unknown>;
  const rawPaths = candidate.affected_paths;
  if (!Array.isArray(rawPaths) || !rawPaths.every((p): p is string => typeof p === 'string')) {
    fail('input.affected_paths must be a string array');
  }
  const rawWaivers = Array.isArray(candidate.waivers) ? candidate.waivers : [];
  const waivers: WaiverEntry[] = [];
  for (const entry of rawWaivers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const waiver = entry as Record<string, unknown>;
    if (typeof waiver.node === 'string' && typeof waiver.reason === 'string') {
      waivers.push({ node: waiver.node, reason: waiver.reason });
    }
  }
  // The kernel's closure (SE-4): required, because a witness without it would report a plan
  // that reaches nothing as covered.
  const rawNodes = candidate.closure_nodes;
  if (!Array.isArray(rawNodes)) fail('input.closure_nodes must be an array');
  const closureNodes: ClosureNode[] = rawNodes.map((entry: unknown): ClosureNode => {
    const node =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const { node_id: nodeId, kind, why, reached_from: reachedFrom } = node;
    if (
      typeof nodeId !== 'string' ||
      !nodeId.startsWith('project:') ||
      kind !== 'nx_project' ||
      typeof why !== 'string' ||
      (reachedFrom !== undefined && typeof reachedFrom !== 'string')
    ) {
      fail(
        `input.closure_nodes entry is not a {node_id: project:<name>, kind: nx_project, why} node: ${JSON.stringify(entry)}`,
      );
    }
    return reachedFrom === undefined
      ? { node_id: nodeId, kind, why }
      : { node_id: nodeId, kind, why, reached_from: reachedFrom };
  });
  const rawOptions =
    typeof candidate.options === 'object' && candidate.options !== null
      ? (candidate.options as Record<string, unknown>)
      : {};
  return {
    schema_version: typeof candidate.schema_version === 'number' ? candidate.schema_version : 1,
    affected_paths: rawPaths,
    waivers,
    closure_nodes: closureNodes,
    options: {
      max_nodes: typeof rawOptions.max_nodes === 'number' ? rawOptions.max_nodes : undefined,
    },
  };
}

function loadGraph(graphArg: string | undefined, repoRoot: string): NxGraphFile {
  if (graphArg) {
    return JSON.parse(readFileSync(graphArg, 'utf8')) as NxGraphFile;
  }
  // ARIA-LOW-558: the graph file lives only as long as this read. Every call
  // without --graph used to leave its directory in the temp dir; the finally
  // removes it on success and on a failed or timed-out nx run alike.
  const tmp = mkdtempSync(join(tmpdir(), 'plan-coverage-'));
  try {
    const graphPath = join(tmp, 'nx-graph.json');
    execFileSync('npx', ['nx', 'graph', `--file=${graphPath}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
    return JSON.parse(readFileSync(graphPath, 'utf8')) as NxGraphFile;
  } finally {
    removeFixtureTree(tmp);
  }
}

/** Longest-prefix owner project for a repo-relative path. */
function projectFor(path: string, rootsByProject: ReadonlyMap<string, string>): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [project, root] of rootsByProject) {
    if (root === '' || root === '.') continue;
    if ((path === root || path.startsWith(`${root}/`)) && root.length > bestLen) {
      best = project;
      bestLen = root.length;
    }
  }
  return best;
}

function isWaived(node: ClosureNode, waivers: readonly WaiverEntry[]): WaiverEntry | null {
  for (const waiver of waivers) {
    if (waiver.node === node.node_id) return waiver;
    if (node.reached_from && waiver.node === `dependents-of:${node.reached_from}`) return waiver;
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  let inputArg: string | undefined;
  let graphArg: string | undefined;
  let repoRootArg: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input') {
      inputArg = value;
      i += 1;
    } else if (flag === '--graph') {
      graphArg = value;
      i += 1;
    } else if (flag === '--repo-root') {
      repoRootArg = value;
      i += 1;
    } else fail(`unknown flag: ${flag}`);
  }
  if (!inputArg) fail('--input <input.json> is required');
  const repoRoot = resolve(repoRootArg ?? process.cwd());

  let rawInput: string;
  try {
    rawInput = readFileSync(inputArg, 'utf8');
  } catch (error) {
    fail(`input unreadable: ${String(error)}`);
  }
  let input: WitnessInput;
  try {
    input = parseWitnessInput(rawInput);
  } catch (error) {
    fail(`input unparseable: ${String(error)}`);
  }
  const waivers: readonly WaiverEntry[] = input.waivers;
  const maxNodes = input.options?.max_nodes ?? DEFAULT_MAX_NODES;
  const inputsHash = createHash('sha256')
    .update(
      JSON.stringify({
        affected_paths: [...input.affected_paths].sort(),
        waivers,
        closure_nodes: input.closure_nodes,
        maxNodes,
      }),
    )
    .digest('hex');

  let graph: NxGraphFile;
  try {
    graph = loadGraph(graphArg, repoRoot);
  } catch (error) {
    fail(`nx graph unavailable: ${String(error)}`);
  }
  const rootsByProject = new Map<string, string>();
  for (const [name, node] of Object.entries(graph.graph.nodes ?? {})) {
    if (node?.data?.root) rootsByProject.set(name, node.data.root.replace(/\/+$/, ''));
  }

  // --- touched projects (the closure itself is the kernel's) ------------------
  const touchedProjects = new Set<string>();
  const unmappedPaths: string[] = [];
  for (const path of input.affected_paths) {
    const owner = projectFor(path, rootsByProject);
    if (owner) touchedProjects.add(owner);
    else unmappedPaths.push(path);
  }
  const closureProjects = [...touchedProjects].sort().map((project) => ({
    name: project,
    root: rootsByProject.get(project) ?? '',
    reason: 'direct',
  }));
  const nodes: ClosureNode[] = [...input.closure_nodes];

  // --- unresolved event subscriptions ----------------------------------------
  const contractPaths = input.affected_paths.filter((p) => p.startsWith(EVENT_CONTRACTS_PREFIX));
  let consumerIndexLedger: EventConsumerIndexLedger | null = null;
  if (contractPaths.length > 0) {
    let index: EventConsumerIndex;
    try {
      index = scanEventConsumers(repoRoot);
    } catch (error) {
      fail(`event-consumer scan failed: ${String(error)}`);
    }
    // A subscription whose value does not fold may consume any of these events: fail closed.
    for (const site of index.unresolved) {
      nodes.push({
        node_id: `event-consumer-unresolved:${site.application ?? 'lib'}:${site.site}`,
        kind: 'event_consumer',
        why: `${site.api} at ${site.site} subscribes to \`${site.form}\`, which the code scan cannot resolve to an event type or subject; make the value static (tools/gates/event-consumer-index.ts)`,
      });
    }
    consumerIndexLedger = {
      files_scanned: index.filesScanned,
      sites: index.sites.length,
      entries: index.entries.length,
      unresolved: index.unresolved.map((site) => site.site),
      unattributed: index.unattributed,
    };
  }

  // --- entity -> migration closure ------------------------------------------
  const migrationCouplings: { service: string; entity_paths: string[] }[] = [];
  const entitiesByService = new Map<string, string[]>();
  for (const path of input.affected_paths) {
    const match = ENTITY_PATH_RE.exec(path);
    if (match && match[1]) {
      const list = entitiesByService.get(match[1]) ?? [];
      list.push(path);
      entitiesByService.set(match[1], list);
    }
  }
  for (const [service, entityPaths] of [...entitiesByService.entries()].sort()) {
    migrationCouplings.push({ service, entity_paths: entityPaths });
    // ARIA-AUDIT-056: a migration PATH alone is not coverage — any file
    // named like a migration satisfied the node, whether or not it carries
    // this entity's schema. The migration file must now CONTENT-BIND: its
    // text names at least one touched entity's stem (e.g. `farm` from
    // farm.entity.ts), the coupling a real schema change would exhibit.
    const entityStems = entityPaths
      .map((p) =>
        basename(p)
          .replace(/\.entity\.ts$/, '')
          .replace(/\.ts$/, ''),
      )
      .filter((stem) => stem.length >= 3);
    const hasMigration = input.affected_paths.some((p) => {
      const m = MIGRATION_PATH_RE.exec(p);
      if (m === null || m[1] !== service) return false;
      try {
        const text = readFileSync(resolve(repoRoot, p), 'utf8');
        return entityStems.some((stem) => text.includes(stem));
      } catch {
        return false;
      }
    });
    if (!hasMigration) {
      nodes.push({
        node_id: `migration:${service}`,
        kind: 'migration',
        why: `plan touches ${entityPaths.length} entity file(s) in apps/${service} without touching its migration surface`,
      });
    }
  }

  // --- coverage predicate ----------------------------------------------------
  // Project nodes: the kernel's closure excludes the touched projects, so
  // every given node needs a waiver. Migration nodes were filtered to
  // missing-migration services above.
  let effectiveNodes = nodes;
  if (nodes.length > maxNodes) {
    effectiveNodes = [
      {
        node_id: 'closure:oversized',
        kind: 'closure',
        why: `impact closure has ${nodes.length} nodes (max ${maxNodes}) — reduce plan scope or add a group waiver`,
      },
    ];
  }
  const uncovered: ClosureNode[] = [];
  const waived: { node_id: string; reason: string }[] = [];
  for (const node of effectiveNodes) {
    const waiver = isWaived(node, waivers);
    if (waiver) waived.push({ node_id: node.node_id, reason: waiver.reason });
    else uncovered.push(node);
  }

  const verdict =
    uncovered.length > 0 ? 'gaps' : waived.length > 0 ? 'covered_with_waivers' : 'covered';
  const report = {
    schema_version: 1,
    verdict,
    closure: {
      projects: closureProjects,
      closure_nodes: input.closure_nodes,
      migration_couplings: migrationCouplings,
    },
    uncovered: uncovered.map(({ reached_from: _reachedFrom, ...rest }) => rest),
    waived,
    unmapped_paths: unmappedPaths,
    ledger: { event_consumer_index: consumerIndexLedger },
    inputs_hash: inputsHash,
  };
  // Single-line JSON on purpose (repo-wide no-restricted-syntax bans
  // indented stringify): the kernel wrapper parses stdout, humans read
  // the pretty manifest artifact the kernel writes instead.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(uncovered.length > 0 ? 1 : 0);
}

if (require.main === module) main();
