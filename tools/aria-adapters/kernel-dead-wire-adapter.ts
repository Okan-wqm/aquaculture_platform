#!/usr/bin/env ts-node
// E9-b — the self-audit adapter. ARIA points every other adapter at the
// product; this one points at the kernel.
//
// WHY: one defect class cost this programme roughly nineteen closures in a
// single session, always found by a human reading code and never by a gate —
// a mechanism that is declared, validated, tested, and connected to nothing.
// It wears four masks: a writer with no reader, a reader with no writer, a
// predicate no production input can satisfy, and a tunable nothing consults.
//
// WHAT (deterministic, fs-only, no LLM):
//
//   policy_key_never_read   a key in aria-kernel/aria_kernel/data/**/*.json that
//                           no kernel module ever names. The operator can set
//                           it, the file documents it, and nothing changes.
//   cli_verb_never_routed   a subcommand registered on the CLI parser with no
//                           branch that dispatches it. Typing it does nothing.
//                           The parser is a tree: a verb is judged against the
//                           `args.<dest>` of the parser it is registered on.
//
// WHAT IS DELIBERATELY ABSENT, and the measurement that decided it. The
// writer-with-no-reader and reader-with-no-writer masks were prototyped
// against this repository first and are NOT shipped here, because the rule a
// text adapter can express is not the rule that is true. Matching declared
// ledger writers against declared ledger readers reports 49 write-only and 10
// read-only surfaces; spot-checking three of the ten (memory_beliefs,
// pressure_log, raw_findings) found all three genuinely written, through a
// path-to-surface mapping table in pressure.py rather than through a literal
// `expected_surface=` argument. A rule with that false-positive rate would be
// waived within a cycle and take the two honest rules down with it.
//
// Those two masks ARE covered, at the layer where they can be decided rather
// than guessed: `aria_kernel/surface_reachability.py` walks argument
// provenance through the AST and proves which members of a closed vocabulary
// a production path can produce. Its gate is
// `aria-kernel/tests/test_surface_reachability.py`. This adapter covers the
// two masks that layer cannot see, because policy files and argparse are not
// closed vocabularies with a single named writer.
import { relative } from 'node:path';

import {
  collectFiles,
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  requireScanRoots,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly policyDir?: string;
  readonly cliPath?: string;
  readonly repo_snapshot?: { readonly allowed_paths?: readonly string[] };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

type DeadWireRule = 'policy_key_never_read' | 'cli_verb_never_routed';

interface AdapterFinding {
  readonly id: string;
  readonly rule: DeadWireRule;
  readonly severity: 'medium';
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence?: number;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

const DEFAULT_POLICY_DIR = 'aria-kernel/aria_kernel/data';
const DEFAULT_CLI_PATH = 'aria-kernel/aria_kernel/cli.py';

// The CLI parser is a tree. Its root parser is the variable `sub` and routes
// through `args.command`; every group beneath it owns an
// `<group>_sub = <parser>.add_subparsers(dest="<group>_command")` of its own.
// A verb registered on a parser is dispatched by `args.<that parser's dest>`.
const ROOT_PARENT = 'sub';
const ROOT_DEST = 'command';
// `\s*` spans lines: `x_sub = x_parser.add_subparsers(\n    dest="x_command", ...)`.
const SUBPARSERS_DEST_RE = /(\w+)\s*=\s*[\w.]+\.add_subparsers\(\s*dest\s*=\s*["'](\w+)["']/g;
const REGISTER_RE = /add_subparser\(\s*(\w+)\s*,\s*["']([a-z0-9_-]+)["']/g;
const ROUTE_EQ_RE = /args\.(\w+)\s*==\s*["']([a-z0-9_-]+)["']/g;
// A membership test against a tuple OR a set literal: `in ("a", "b")`, `in {"a", "b"}`.
const ROUTE_IN_RE = /args\.(\w+)\s+in\s+(?:\(([^)]*)\)|\{([^}]*)\})/g;

// Keys that are prose, not configuration. The policy files carry inline
// documentation under `_doc`/`comment` keys; treating a comment as an unread
// tunable is the first false positive anyone would hit.
const DOC_KEY_RE = /^(_|comment$)/;

/**
 * Is this key a tunable, or a data row that happens to be a key?
 *
 * `auto_action_policy.json` maps path GLOBS to lane exclusions — those keys
 * are the data the policy is made of, not switches the kernel reads by name.
 * Without this the rule reports eighteen path patterns as dead configuration
 * and buries the four real ones.
 */
function isTunableKey(key: string): boolean {
  if (DOC_KEY_RE.test(key)) {
    return false;
  }
  if (key.includes('*') || key.includes('/') || key.includes('.')) {
    return false;
  }
  // Single-character and very short keys collide with too much source text to
  // decide either way; silence beats a coin flip.
  return key.length >= 4 && /^[a-z][a-z0-9_]*$/.test(key);
}

function collectKeys(value: unknown, into: Map<string, number>, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!into.has(key)) {
      into.set(key, depth);
    }
    collectKeys(child, into, depth + 1);
  }
}

/** Line of the first `"key"` occurrence in the policy file, 1-based. */
function keyLine(lines: readonly string[], key: string): number {
  const needle = `"${key}"`;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) {
      return index + 1;
    }
  }
  return 1;
}

export function analyzeKernelDeadWire(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots('kernel-dead-wire-adapter', input.roots);
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths: string[] = [];

  const sources = filterFilesBySnapshot(
    roots
      .map((root) => resolveInsideWorkspace(workspaceRoot, root))
      .filter((root) => workspacePathExists(workspaceRoot, root))
      .flatMap((root) => collectFiles(workspaceRoot, root, { extensions: ['.py'] })),
    workspaceRoot,
    input,
  );

  // The kernel's own source, minus its tests: a test naming a policy key is
  // exactly the evidence that cannot count, because it is how an unread
  // tunable stays green.
  const productionSources = sources.filter(
    (path) =>
      !/(^|\/)tests?\//.test(normalizeWorkspacePath(relative(workspaceRoot, path))) &&
      !/(^|\/)test_[^/]*\.py$/.test(normalizeWorkspacePath(relative(workspaceRoot, path))),
  );
  const corpus: string[] = [];
  for (const path of productionSources) {
    readPaths.push(normalizeWorkspacePath(relative(workspaceRoot, path)));
    corpus.push(readWorkspaceFile(workspaceRoot, path));
  }
  const haystack = corpus.join('\n');

  // ---------------------------------------------------------- policy tunables
  const policyDirRel = input.policyDir ?? DEFAULT_POLICY_DIR;
  const policyDir = resolveInsideWorkspace(workspaceRoot, policyDirRel);
  let policyKeysChecked = 0;
  if (workspacePathExists(workspaceRoot, policyDir)) {
    for (const policyPath of collectFiles(workspaceRoot, policyDir, { extensions: ['.json'] })) {
      const policyRel = normalizeWorkspacePath(relative(workspaceRoot, policyPath));
      readPaths.push(policyRel);
      const raw = readWorkspaceFile(workspaceRoot, policyPath);
      const lines = raw.split('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A malformed policy file is a different defect with a different
        // owner; this adapter does not also become a JSON linter.
        continue;
      }
      const keys = new Map<string, number>();
      collectKeys(parsed, keys);
      let unreadInFile = 0;
      for (const [key] of keys) {
        if (!isTunableKey(key)) {
          continue;
        }
        policyKeysChecked += 1;
        // A read is the key NAMED as a string anywhere in kernel source:
        // `policy.get("x")`, `block["x"]`, or a DEFAULTS dict declaring it.
        // Deliberately generous — the finding must survive indirection to be
        // worth acting on.
        if (haystack.includes(`"${key}"`) || haystack.includes(`'${key}'`)) {
          continue;
        }
        unreadInFile += 1;
        const line = keyLine(lines, key);
        findings.push({
          id: `kernel-dead-wire:policy:${policyRel}:${key}`,
          rule: 'policy_key_never_read',
          severity: 'medium',
          path: policyRel,
          line,
          message:
            `\`${policyRel}\` declares tunable \`${key}\`, which no kernel ` +
            'module ever names — an operator can set it and nothing changes.',
          evidence: [{ path: policyRel, line }],
          confidence: 0.8,
        });
      }
      observations.push({
        id: `kernel-dead-wire:policy:${policyRel}`,
        type: 'kernel_policy_file',
        path: policyRel,
        details: { keys: keys.size, unread: unreadInFile },
      });
    }
  }

  // ------------------------------------------------------------- CLI dispatch
  const cliRel = input.cliPath ?? DEFAULT_CLI_PATH;
  const cliPath = resolveInsideWorkspace(workspaceRoot, cliRel);
  let verbsChecked = 0;
  if (workspacePathExists(workspaceRoot, cliPath)) {
    readPaths.push(cliRel);
    const cliText = readWorkspaceFile(workspaceRoot, cliPath);
    const cliLines = cliText.split('\n');
    const destOf = new Map<string, string>([[ROOT_PARENT, ROOT_DEST]]);
    for (const match of cliText.matchAll(SUBPARSERS_DEST_RE)) {
      destOf.set(match[1], match[2]);
    }
    // Both maps are keyed `<dest>:<verb>`: `status` on two groups is two verbs.
    const registered = new Map<string, { dest: string; verb: string; line: number }>();
    const routed = new Set<string>();
    for (let index = 0; index < cliLines.length; index += 1) {
      const line = cliLines[index];
      for (const match of line.matchAll(REGISTER_RE)) {
        const dest = destOf.get(match[1]);
        // A parent whose `add_subparsers(dest=...)` this file never declares
        // has no `args.<dest>` to judge its verbs against.
        if (dest !== undefined && !registered.has(`${dest}:${match[2]}`)) {
          registered.set(`${dest}:${match[2]}`, { dest, verb: match[2], line: index + 1 });
        }
      }
      for (const match of line.matchAll(ROUTE_EQ_RE)) {
        routed.add(`${match[1]}:${match[2]}`);
      }
      for (const match of line.matchAll(ROUTE_IN_RE)) {
        for (const inner of (match[2] ?? match[3]).matchAll(/["']([a-z0-9_-]+)["']/g)) {
          routed.add(`${match[1]}:${inner[1]}`);
        }
      }
    }
    verbsChecked = registered.size;
    const unrouted = [...registered.entries()]
      .filter(([key]) => !routed.has(key))
      .map(([, entry]) => entry);
    for (const { dest, verb, line } of unrouted) {
      const nested = dest !== ROOT_DEST;
      // A nested group's handler is an `if args.<dest> == "a"` chain whose last
      // verb is reached by falling off the end: the real cli.py has one such verb
      // per group. One unrouted verb cannot be told from that fall-through by
      // reading lines, and silence beats a coin flip; two or more cannot all be
      // the fall-through, so at least one is dead. The root parser has no
      // fall-through: its lone unrouted verb is flagged.
      if (nested && unrouted.filter((other) => other.dest === dest).length < 2) {
        continue;
      }
      findings.push({
        id: `kernel-dead-wire:cli:${nested ? `${dest}:${verb}` : verb}`,
        rule: 'cli_verb_never_routed',
        severity: 'medium',
        path: cliRel,
        line,
        message:
          `CLI registers subcommand \`${verb}\`${nested ? ` of \`args.${dest}\`` : ''} and no ` +
          'branch dispatches it — the verb parses, prints help, and does nothing.',
        evidence: [{ path: cliRel, line }],
        confidence: 0.85,
      });
    }
    observations.push({
      id: `kernel-dead-wire:cli:${cliRel}`,
      type: 'kernel_cli_surface',
      path: cliRel,
      details: { registered: registered.size, routed: routed.size },
    });
  }

  const sortedReadPaths = [...new Set(readPaths)].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: {
      scanMode: 'kernel_dead_wire_v1',
      moduleCount: productionSources.length,
      policyKeysChecked,
      verbsChecked,
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    // setEncoding('utf8') makes every chunk a string at runtime, but the
    // stream's declared chunk type stays `string | Buffer` — concatenating the
    // union is what the type checker rejects. Narrow at the boundary rather
    // than widening `input`.
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeKernelDeadWire(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
