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
 * plan's affected PATHS and the repo at HEAD. Three node classes:
 *
 *   project:<name>          — nx projects owning affected paths, plus their
 *                             reverse dependents (depth 1 by default) from
 *                             the nx dependency graph.
 *   event-consumer:<svc>:<EventType>
 *                           — when an affected path touches
 *                             libs/event-contracts/**, every service whose
 *                             services.yaml subscribe pattern overlaps the
 *                             event's NATS subject.
 *   migration:<svc>         — when an affected path is an `*.entity.ts`
 *                             under apps/<svc>/, the service's migration
 *                             surface (plan-time analog of
 *                             entity-diff-witness).
 *
 * A node is covered when the plan's paths reach it, or when an explicit
 * waiver names it (`node` exact match, or group `dependents-of:<project>`).
 * Paths owned by no nx project (docs/, .claude/, aria-tools/) are reported
 * as `unmapped_paths` — informational, never gaps.
 *
 * LLM prose (key_changes, summary) is DELIBERATELY not parsed: matching on
 * words would let a planner satisfy the gate by mentioning the right names.
 *
 * # Invocation
 *
 *   ts-node --project tools/gates/tsconfig.json tools/gates/plan-coverage-witness.ts \
 *     --input <input.json> [--graph <nx-graph.json>] [--services-yaml <services.yaml>] \
 *     [--repo-root <dir>]
 *
 * `--graph` / `--services-yaml` exist so the spec suite runs on fixtures
 * without a live nx workspace. Without `--graph`, the witness generates the
 * graph via `npx nx graph --file=<tmp>` (the scripts/ci precedent).
 *
 * Input JSON: { schema_version: 1, affected_paths: string[],
 *               waivers: [{node, reason}],
 *               options?: { transitive?: boolean, max_nodes?: number } }
 *
 * Output JSON (stdout): { schema_version: 1, verdict, closure, uncovered,
 *                         waived, unmapped_paths, inputs_hash }
 *
 * Exit codes (contract — aria_kernel/plan_coverage.py depends on these):
 *   0 — closure computed, no uncovered nodes (covered / covered_with_waivers)
 *   1 — closure computed, uncovered nodes present (gaps)
 *   2 — environment/invocation error (missing input, nx unavailable,
 *        services.yaml unreadable) — the kernel maps this to
 *        environment_unable -> HUMAN_REQUIRED, never a silent pass.
 *
 * # NATS subject matching provenance
 *
 * The services.yaml parser + NATS subject matcher below are a faithful port
 * of tools/ripple-tracer/cli.ts (which is single-file BY DOCUMENTED DESIGN —
 * "avoids ESM/CJS resolution fragility of cross-file imports"; importing it
 * would also execute its main()). Behavioral drift between the two is pinned
 * by plan-coverage-witness.spec.ts fixtures mirroring ripple-tracer cases.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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
  readonly options?: { readonly transitive?: boolean; readonly max_nodes?: number };
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
    readonly dependencies: Record<string, readonly { readonly source: string; readonly target: string }[]>;
  };
}

interface ServiceEntry {
  readonly name: string;
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
}

// ---------------------------------------------------------------------------
// services.yaml parser + NATS matcher (port of tools/ripple-tracer/cli.ts —
// see file header for why this is a port, not an import)
// ---------------------------------------------------------------------------

function parseServicesYaml(source: string): readonly ServiceEntry[] {
  const services: { name: string; publish: string[]; subscribe: string[] }[] = [];
  let current: { name: string; publish: string[]; subscribe: string[] } | null = null;
  let section: 'publish' | 'subscribe' | null = null;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    const nameMatch = /^\s*-\s+name:\s*"?([\w-]+)"?\s*$/.exec(line);
    if (nameMatch && nameMatch[1]) {
      current = { name: nameMatch[1], publish: [], subscribe: [] };
      services.push(current);
      section = null;
      continue;
    }
    if (/^\s+publish:\s*$/.test(line)) {
      section = 'publish';
      continue;
    }
    if (/^\s+subscribe:\s*$/.test(line)) {
      section = 'subscribe';
      continue;
    }
    const itemMatch = /^\s+-\s+"([^"]+)"\s*$/.exec(line);
    if (itemMatch && itemMatch[1] && current && section) {
      current[section].push(itemMatch[1]);
      continue;
    }
    if (/^\s*[\w-]+:\s*/.test(line) && !/^\s+-/.test(line)) {
      section = null;
    }
  }
  return services;
}

/** Two wildcard patterns overlap if some concrete subject matches both. */
function patternsOverlap(a: string, b: string): boolean {
  const aTokens = a.split('.');
  const bTokens = b.split('.');
  const max = Math.max(aTokens.length, bTokens.length);
  for (let i = 0; i < max; i += 1) {
    const at = aTokens[i];
    const bt = bTokens[i];
    if (at === '>' || bt === '>') return true;
    if (at === undefined || bt === undefined) return false;
    if (at === '*' || bt === '*') continue;
    if (at.endsWith('*') && at.length > 1) {
      if (!bt.startsWith(at.slice(0, -1)) && !bt.endsWith('*')) return false;
      continue;
    }
    if (bt.endsWith('*') && bt.length > 1) {
      if (!at.startsWith(bt.slice(0, -1))) return false;
      continue;
    }
    if (at !== bt) return false;
  }
  return true;
}

function defaultSubjectFor(eventType: string): string {
  return `AQUACULTURE_EVENTS.${eventType}.>`;
}

// ---------------------------------------------------------------------------
// Closure computation
// ---------------------------------------------------------------------------

const EVENT_CONTRACTS_PREFIX = 'libs/event-contracts/';
// Matches the literal eventType field of event-contract interfaces, e.g.
//   readonly eventType: 'BatchHarvested';
const EVENT_TYPE_LITERAL_RE = /eventType\??\s*:\s*['"]([A-Z][A-Za-z0-9]*)['"]/g;
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
  const rawOptions =
    typeof candidate.options === 'object' && candidate.options !== null
      ? (candidate.options as Record<string, unknown>)
      : {};
  return {
    schema_version: typeof candidate.schema_version === 'number' ? candidate.schema_version : 1,
    affected_paths: rawPaths,
    waivers,
    options: {
      transitive: rawOptions.transitive === true,
      max_nodes: typeof rawOptions.max_nodes === 'number' ? rawOptions.max_nodes : undefined,
    },
  };
}

function loadGraph(graphArg: string | undefined, repoRoot: string): NxGraphFile {
  if (graphArg) {
    return JSON.parse(readFileSync(graphArg, 'utf8')) as NxGraphFile;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'plan-coverage-'));
  const graphPath = join(tmp, 'nx-graph.json');
  execFileSync('npx', ['nx', 'graph', `--file=${graphPath}`], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120_000,
  });
  return JSON.parse(readFileSync(graphPath, 'utf8')) as NxGraphFile;
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

function reverseDependents(graph: NxGraphFile, roots: ReadonlySet<string>, transitive: boolean): Map<string, string> {
  const reverse = new Map<string, Set<string>>();
  for (const deps of Object.values(graph.graph.dependencies)) {
    for (const dep of deps) {
      const entry = reverse.get(dep.target) ?? new Set<string>();
      entry.add(dep.source);
      reverse.set(dep.target, entry);
    }
  }
  // dependent project -> the touched project it was reached from (for
  // dependents-of:<project> group waivers).
  const reached = new Map<string, string>();
  for (const root of roots) {
    const queue: string[] = [root];
    const seen = new Set<string>([root]);
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const dependent of reverse.get(current) ?? []) {
        if (seen.has(dependent) || roots.has(dependent)) continue;
        seen.add(dependent);
        if (!reached.has(dependent)) reached.set(dependent, root);
        if (transitive) queue.push(dependent);
      }
    }
  }
  return reached;
}

function extractEventTypes(contractPaths: readonly string[], repoRoot: string): Set<string> {
  const eventTypes = new Set<string>();
  for (const path of contractPaths) {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute)) continue; // plan proposes a NEW file — nothing extractable at HEAD
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(EVENT_TYPE_LITERAL_RE)) {
      if (match[1]) eventTypes.add(match[1]);
    }
  }
  return eventTypes;
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
  let servicesYamlArg: string | undefined;
  let repoRootArg: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input') { inputArg = value; i += 1; }
    else if (flag === '--graph') { graphArg = value; i += 1; }
    else if (flag === '--services-yaml') { servicesYamlArg = value; i += 1; }
    else if (flag === '--repo-root') { repoRootArg = value; i += 1; }
    else fail(`unknown flag: ${flag}`);
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
  const transitive = input.options?.transitive === true;
  const maxNodes = input.options?.max_nodes ?? DEFAULT_MAX_NODES;
  const inputsHash = createHash('sha256')
    .update(JSON.stringify({ affected_paths: [...input.affected_paths].sort(), waivers, transitive, maxNodes }))
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

  // --- project closure -----------------------------------------------------
  const touchedProjects = new Set<string>();
  const unmappedPaths: string[] = [];
  for (const path of input.affected_paths) {
    const owner = projectFor(path, rootsByProject);
    if (owner) touchedProjects.add(owner);
    else unmappedPaths.push(path);
  }
  const dependents = reverseDependents(graph, touchedProjects, transitive);

  const closureProjects: { name: string; root: string; reason: 'direct' | 'reverse_dependent' }[] = [];
  const nodes: ClosureNode[] = [];
  for (const project of [...touchedProjects].sort()) {
    closureProjects.push({ name: project, root: rootsByProject.get(project) ?? '', reason: 'direct' });
  }
  for (const [dependent, reachedFrom] of [...dependents.entries()].sort()) {
    closureProjects.push({ name: dependent, root: rootsByProject.get(dependent) ?? '', reason: 'reverse_dependent' });
    nodes.push({
      node_id: `project:${dependent}`,
      kind: 'nx_project',
      why: `reverse dependent of touched project ${reachedFrom} in the nx graph`,
      reached_from: reachedFrom,
    });
  }

  // --- event-consumer closure ----------------------------------------------
  const contractPaths = input.affected_paths.filter((p) => p.startsWith(EVENT_CONTRACTS_PREFIX));
  const eventConsumers: { event_type: string; consumer: string; matching_pattern: string }[] = [];
  if (contractPaths.length > 0) {
    const servicesYamlPath = servicesYamlArg ?? join(repoRoot, 'infrastructure', 'nats', 'services.yaml');
    let services: readonly ServiceEntry[];
    try {
      services = parseServicesYaml(readFileSync(servicesYamlPath, 'utf8'));
    } catch (error) {
      fail(`services.yaml unreadable: ${String(error)}`);
    }
    const eventTypes = extractEventTypes(contractPaths, repoRoot);
    for (const eventType of [...eventTypes].sort()) {
      const subject = defaultSubjectFor(eventType);
      for (const svc of services) {
        const matching = svc.subscribe.find((pattern) => patternsOverlap(pattern, subject));
        if (!matching) continue;
        eventConsumers.push({ event_type: eventType, consumer: svc.name, matching_pattern: matching });
        const consumerProject = rootsByProject.has(svc.name) ? svc.name : null;
        const consumerTouched = consumerProject !== null && touchedProjects.has(consumerProject);
        if (!consumerTouched) {
          nodes.push({
            node_id: `event-consumer:${svc.name}:${eventType}`,
            kind: 'event_consumer',
            why: `services.yaml pattern "${matching}" subscribes to ${eventType} published from a touched contract file`,
          });
        }
      }
    }
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
      .map((p) => basename(p).replace(/\.entity\.ts$/, '').replace(/\.ts$/, ''))
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
  // Project nodes: a reverse dependent is covered when the plan also touches
  // it directly (then it never became a node) — so every project node here
  // needs a waiver. Event-consumer nodes were filtered to untouched consumers
  // above. Migration nodes were filtered to missing-migration services above.
  let effectiveNodes = nodes;
  if (nodes.length > maxNodes) {
    effectiveNodes = [{
      node_id: 'closure:oversized',
      kind: 'closure',
      why: `impact closure has ${nodes.length} nodes (max ${maxNodes}) — reduce plan scope or add a group waiver`,
    }];
  }
  const uncovered: ClosureNode[] = [];
  const waived: { node_id: string; reason: string }[] = [];
  for (const node of effectiveNodes) {
    const waiver = isWaived(node, waivers);
    if (waiver) waived.push({ node_id: node.node_id, reason: waiver.reason });
    else uncovered.push(node);
  }

  const verdict = uncovered.length > 0 ? 'gaps' : waived.length > 0 ? 'covered_with_waivers' : 'covered';
  const report = {
    schema_version: 1,
    verdict,
    closure: {
      projects: closureProjects,
      event_consumers: eventConsumers,
      migration_couplings: migrationCouplings,
    },
    uncovered: uncovered.map(({ reached_from: _reachedFrom, ...rest }) => rest),
    waived,
    unmapped_paths: unmappedPaths,
    inputs_hash: inputsHash,
  };
  // Single-line JSON on purpose (repo-wide no-restricted-syntax bans
  // indented stringify): the kernel wrapper parses stdout, humans read
  // the pretty manifest artifact the kernel writes instead.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(uncovered.length > 0 ? 1 : 0);
}

main();
