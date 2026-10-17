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
 *                             libs/event-contracts/**, every application
 *                             that consumes the event: a subscription in
 *                             its code (tools/gates/event-consumer-index.ts,
 *                             durable JetStream consumers included), or a
 *                             services.yaml subscribe grant that names the
 *                             event. <svc> is the nx project (a grant's
 *                             `application:`, not its `name:`). A catch-all
 *                             grant (`events.>`) is a permission, not
 *                             consumption: it is recorded in the ledger and
 *                             makes no node.
 *   event-consumer-unresolved:<svc|lib>:<path>:<line>
 *                           — a subscription site whose event type or
 *                             subject the scan cannot resolve statically:
 *                             an unknown consumer is a gap, never a pass.
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
 *                         waived, unmapped_paths, ledger, inputs_hash }
 *
 * `ledger.services_yaml` records what was parsed from the live NATS SSoT
 * (services, publish / subscribe patterns, event types) whenever the
 * event-consumer closure reads it, and is null otherwise.
 * `ledger.event_consumer_index` records the code scan of the same run (files
 * scanned, subscription sites, entries, unresolved and unattributed sites,
 * the catch-all grants that made no node), and is null when no contract
 * path is touched.
 *
 * Exit codes (contract — aria_kernel/plan_coverage.py depends on these):
 *   0 — closure computed, no uncovered nodes (covered / covered_with_waivers)
 *   1 — closure computed, uncovered nodes present (gaps)
 *   2 — environment/invocation error (missing input, nx unavailable,
 *        services.yaml unreadable, not in the SSoT's shape, or parsed to
 *        zero services or zero publish / subscribe patterns, or the code
 *        scan for event consumers failing) — the kernel
 *        maps this to environment_unable -> HUMAN_REQUIRED, never a silent
 *        pass.
 *
 * # services.yaml and NATS subjects (ARIA-HIGH-306, ARIA-MEDIUM-314)
 *
 * infrastructure/nats/services.yaml is read through tools/gates/nats-services.ts, the one reader
 * every tool shares: a YAML parse held to the SSoT's own schema
 * (infrastructure/nats/services.schema.json), NATS subject matching, and the subjects an event
 * travels on (the publish grants that name it, else the event bus's default `events.*.<T>`). A
 * document the schema refuses, including one that lost its grants, is exit 2. The line-regex parser
 * this witness had before ARIA-HIGH-306 accepted only quoted items and parsed nothing once the SSoT
 * dropped its quotes (2026-08-01); a private copy of the reader in tools/ripple-tracer drifted the
 * same way (ARIA-MEDIUM-314).
 *
 * # Event consumers come from the code (ARIA-HIGH-313)
 *
 * A service consumes an event through a durable JetStream consumer, which
 * receives through `$JS.API.CONSUMER.>` and its inbox: no subscribe grant of
 * its identity names the event. Consumers taken from ACL grants alone missed
 * most real consumers (notification-service's UserInvited handler) and named
 * every catch-all holder instead. The consumer set is
 * `eventConsumersFor` (tools/gates/event-consumer-index.ts): the code's
 * subscription sites, recognised by the type checker, united with the grants
 * that name the event. The scan runs only when a contract path is touched.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  eventConsumersFor,
  type EventConsumerIndex,
  scanEventConsumers,
} from './event-consumer-index';
import { loadNatsServices, NATS_SERVICES_YAML, type NatsServiceEntry } from './nats-services';

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
    readonly dependencies: Record<
      string,
      readonly { readonly source: string; readonly target: string }[]
    >;
  };
}

/** What the witness parsed from services.yaml — written to the report. */
interface ServicesYamlLedger {
  readonly services: number;
  readonly publish_patterns: number;
  readonly subscribe_patterns: number;
  readonly event_types: number;
}

/** What the code scan for event consumers found — written to the report. */
interface EventConsumerIndexLedger {
  readonly files_scanned: number;
  readonly sites: number;
  readonly entries: number;
  readonly unresolved: readonly string[];
  readonly unattributed: readonly string[];
  readonly acl_catch_all: readonly {
    readonly event_type: string;
    readonly application: string;
    readonly grant: string;
  }[];
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

function reverseDependents(
  graph: NxGraphFile,
  roots: ReadonlySet<string>,
  transitive: boolean,
): Map<string, string> {
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
    if (flag === '--input') {
      inputArg = value;
      i += 1;
    } else if (flag === '--graph') {
      graphArg = value;
      i += 1;
    } else if (flag === '--services-yaml') {
      servicesYamlArg = value;
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
  const transitive = input.options?.transitive === true;
  const maxNodes = input.options?.max_nodes ?? DEFAULT_MAX_NODES;
  const inputsHash = createHash('sha256')
    .update(
      JSON.stringify({
        affected_paths: [...input.affected_paths].sort(),
        waivers,
        transitive,
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

  // --- project closure -----------------------------------------------------
  const touchedProjects = new Set<string>();
  const unmappedPaths: string[] = [];
  for (const path of input.affected_paths) {
    const owner = projectFor(path, rootsByProject);
    if (owner) touchedProjects.add(owner);
    else unmappedPaths.push(path);
  }
  const dependents = reverseDependents(graph, touchedProjects, transitive);

  const closureProjects: { name: string; root: string; reason: 'direct' | 'reverse_dependent' }[] =
    [];
  const nodes: ClosureNode[] = [];
  for (const project of [...touchedProjects].sort()) {
    closureProjects.push({
      name: project,
      root: rootsByProject.get(project) ?? '',
      reason: 'direct',
    });
  }
  for (const [dependent, reachedFrom] of [...dependents.entries()].sort()) {
    closureProjects.push({
      name: dependent,
      root: rootsByProject.get(dependent) ?? '',
      reason: 'reverse_dependent',
    });
    nodes.push({
      node_id: `project:${dependent}`,
      kind: 'nx_project',
      why: `reverse dependent of touched project ${reachedFrom} in the nx graph`,
      reached_from: reachedFrom,
    });
  }

  // --- event-consumer closure ----------------------------------------------
  const contractPaths = input.affected_paths.filter((p) => p.startsWith(EVENT_CONTRACTS_PREFIX));
  const eventConsumers: {
    event_type: string;
    consumer: string;
    matching_pattern: string;
    subject: string;
    sources: readonly string[];
    code_sites: readonly string[];
  }[] = [];
  let servicesYamlLedger: ServicesYamlLedger | null = null;
  let consumerIndexLedger: EventConsumerIndexLedger | null = null;
  if (contractPaths.length > 0) {
    // --repo-root decides which SSoT is read; the shared reader's own default is its checkout's.
    let services: readonly NatsServiceEntry[];
    try {
      services = loadNatsServices(servicesYamlArg ?? join(repoRoot, NATS_SERVICES_YAML));
    } catch (error) {
      fail(`services.yaml unreadable: ${String(error)}`);
    }
    // The consumers are read from the code of the same repository (ARIA-HIGH-313).
    let index: EventConsumerIndex;
    try {
      index = scanEventConsumers(repoRoot);
    } catch (error) {
      fail(`event-consumer scan failed: ${String(error)}`);
    }
    const eventTypes = extractEventTypes(contractPaths, repoRoot);
    // The schema the reader enforces requires every service to hold publish and subscribe grants,
    // so a file that lost its grants (ARIA-HIGH-306's vacuous closure) is refused above, exit 2.
    servicesYamlLedger = {
      services: services.length,
      publish_patterns: services.reduce((sum, svc) => sum + svc.publish.length, 0),
      subscribe_patterns: services.reduce((sum, svc) => sum + svc.subscribe.length, 0),
      event_types: eventTypes.size,
    };
    const catchAll: { event_type: string; application: string; grant: string }[] = [];
    for (const eventType of [...eventTypes].sort()) {
      const found = eventConsumersFor(eventType, index, services);
      for (const grant of found.aclCatchAll) {
        catchAll.push({
          event_type: eventType,
          application: grant.service.application,
          grant: grant.grant,
        });
      }
      for (const consumer of found.consumers) {
        eventConsumers.push({
          event_type: eventType,
          consumer: consumer.application,
          matching_pattern: consumer.matchingPattern,
          subject: consumer.subject,
          sources: consumer.sources,
          code_sites: consumer.codeSites,
        });
        if (touchedProjects.has(consumer.application)) continue;
        const reasons: string[] = [];
        if (consumer.codeSites.length > 0) {
          reasons.push(`subscribes to it in code at ${consumer.codeSites.join(', ')}`);
        }
        if (consumer.acl !== null) {
          reasons.push(
            `services.yaml grants ${consumer.acl.service.name} "${consumer.acl.grant}" on ${consumer.acl.subject}`,
          );
        }
        nodes.push({
          node_id: `event-consumer:${consumer.application}:${eventType}`,
          kind: 'event_consumer',
          why: `${consumer.application} consumes ${eventType}, published from a touched contract file: ${reasons.join('; ')}`,
        });
      }
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
      acl_catch_all: catchAll,
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
  // Project nodes: a reverse dependent is covered when the plan also touches
  // it directly (then it never became a node) — so every project node here
  // needs a waiver. Event-consumer nodes were filtered to untouched consumers
  // above. Migration nodes were filtered to missing-migration services above.
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
      event_consumers: eventConsumers,
      migration_couplings: migrationCouplings,
    },
    uncovered: uncovered.map(({ reached_from: _reachedFrom, ...rest }) => rest),
    waived,
    unmapped_paths: unmappedPaths,
    ledger: { services_yaml: servicesYamlLedger, event_consumer_index: consumerIndexLedger },
    inputs_hash: inputsHash,
  };
  // Single-line JSON on purpose (repo-wide no-restricted-syntax bans
  // indented stringify): the kernel wrapper parses stdout, humans read
  // the pretty manifest artifact the kernel writes instead.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(uncovered.length > 0 ? 1 : 0);
}

if (require.main === module) main();
