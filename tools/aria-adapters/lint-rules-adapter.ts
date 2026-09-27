#!/usr/bin/env ts-node
// lint-rules-adapter (ARIA-MEDIUM-178) — the curated rule packs inside ARIA.
//
// WHY: ARIA's seven adapters are bespoke checkers (doc staleness, test gaps,
// tenant scoping, security boundaries, dead wires, bundle budgets, DTO
// parity). The industry baseline a code-quality product ships — hundreds
// of curated language rules — was absent from ARIA's ledger, so its judges,
// consensus and label queue never saw the class of finding every other tool
// starts from. The rules are not written here: the open-source packs that
// implement SonarSource's JS/TS rules and the security pack run under
// ARIA's own configuration (`lint-rules.eslint.config.mjs`), in shadow, and
// the repository's labels decide rule by rule what stays.
// WHAT (deterministic, no build required):
//   one finding per rule message, `rule` = the ESLint rule id
//   (`sonarjs/no-identical-expressions`, `security/detect-eval-with-expression`),
//   evidence = the file and line the message names; a file the parser could
//   not read is an observation (`lint_rules_parse_error`), never a finding.
import { relative, resolve } from 'node:path';

import {
  collectFiles,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  requireScanRoots,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly includeTests?: boolean;
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

type Severity = 'low' | 'medium' | 'high';

interface AdapterFinding {
  readonly id: string;
  readonly rule: string;
  readonly severity: Severity;
  readonly path: string;
  readonly line?: number;
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

// The subset of ESLint's result shape this adapter reads, named here so the
// adapter does not depend on ESLint's own type declarations resolving under
// the gates tsconfig.
interface LintMessage {
  readonly ruleId: string | null;
  readonly severity: number;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly fatal?: boolean;
}

interface LintResult {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
}

interface RuleMeta {
  readonly type?: string;
  readonly docs?: { readonly url?: string };
}

interface LintEngine {
  lintFiles(patterns: readonly string[]): Promise<LintResult[]>;
  getRulesMetaForResults(results: readonly LintResult[]): Record<string, RuleMeta>;
}

export const LINT_RULES_CONFIG_PATH = resolve(__dirname, 'lint-rules.eslint.config.mjs');
export const RULE_PACKS = ['sonarjs', 'security'] as const;
const TEST_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;
// The scan surface is the manifest's declared scope, TypeScript sources: a
// generated `.js` beside them (a wasm binding, a build artefact) is outside
// the allowed read globs and would fail the evidence validator by name.
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

// Severity is the pack's own classification, not a guess about impact: a
// security-pack rule names a hazard class (high), a `problem` rule names
// code that is wrong or surprising (medium), a `suggestion` names style or
// simplification (low). The label queue re-weighs all three by what this
// repository's labels say.
// Rules the packs themselves document as heuristic: `detect-object-injection`
// fires on every computed member access (2169 of the first real-repository
// run's 5575 findings) and its own documentation says most are not
// injections. It stays in the scan — the label queue is where its precision
// on this repository is measured — but it enters at the lowest severity so
// it cannot crowd the judges' sample with a hazard class it does not carry.
const HEURISTIC_RULES: ReadonlySet<string> = new Set(['security/detect-object-injection']);

export function severityFor(ruleId: string, meta: RuleMeta | undefined): Severity {
  if (HEURISTIC_RULES.has(ruleId)) return 'low';
  if (ruleId.startsWith('security/')) return 'high';
  if (meta?.type === 'problem') return 'medium';
  return 'low';
}

export function selectFiles(input: AdapterInput, workspaceRoot: string): readonly string[] {
  const roots = requireScanRoots('lint-rules-adapter', input.roots);
  const files: string[] = [];
  for (const root of roots) {
    const absolute = resolveInsideWorkspace(workspaceRoot, root);
    if (!workspacePathExists(absolute)) continue;
    for (const file of collectFiles(absolute, {
      extensions: SOURCE_EXTENSIONS,
      includeFile: (name, path) =>
        !name.endsWith('.d.ts') &&
        (input.includeTests === true || !TEST_FILE_RE.test(name)) &&
        !isArchivedWorkspacePath(relative(workspaceRoot, path)),
    })) {
      files.push(file);
    }
  }
  return filterFilesBySnapshot([...new Set(files)].sort(), workspaceRoot, input);
}

async function createEngine(workspaceRoot: string): Promise<LintEngine> {
  // Resolved at call time so the adapter's tests can substitute an engine
  // and the import cost is paid only by a real run.
  const eslintModule = (await import('eslint')) as {
    ESLint: new (options: Record<string, unknown>) => LintEngine;
  };
  return new eslintModule.ESLint({
    cwd: workspaceRoot,
    overrideConfigFile: LINT_RULES_CONFIG_PATH,
    errorOnUnmatchedPattern: false,
    cache: false,
  });
}

export async function analyzeLintRules(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
  engineFactory: (root: string) => Promise<LintEngine> = createEngine,
): Promise<AriaOutput> {
  const files = selectFiles(input, workspaceRoot);
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths = files.map((file) => normalizeWorkspacePath(relative(workspaceRoot, file)));
  const ruleHistogram: Record<string, number> = {};
  let parseErrors = 0;
  let notices = 0;

  if (files.length > 0) {
    const engine = await engineFactory(workspaceRoot);
    const results = await engine.lintFiles(files);
    const rulesMeta = engine.getRulesMetaForResults(results);
    for (const result of results) {
      const rel = normalizeWorkspacePath(relative(workspaceRoot, result.filePath));
      for (const message of result.messages) {
        const line = message.line ?? 1;
        if (message.fatal === true) {
          parseErrors += 1;
          observations.push({
            id: `lint-rules:parse-error:${rel}:${line}`,
            type: 'lint_rules_parse_error',
            path: rel,
            details: { line, message: message.message },
          });
          continue;
        }
        if (message.ruleId === null) {
          // A notice that names no rule (a directive comment, an engine
          // remark) is not a finding of any pack.
          notices += 1;
          continue;
        }
        const ruleId = message.ruleId;
        const meta = rulesMeta[ruleId];
        ruleHistogram[ruleId] = (ruleHistogram[ruleId] ?? 0) + 1;
        const docs = meta?.docs?.url ? ` (${meta.docs.url})` : '';
        findings.push({
          id: `lint-rules:${ruleId}:${rel}:${line}:${message.column ?? 0}`,
          rule: ruleId,
          severity: severityFor(ruleId, meta),
          path: rel,
          line,
          message: `${ruleId}: ${message.message}${docs}`,
          evidence: [{ path: rel, line }],
          // A pack rule's precision on THIS repository is what the label
          // queue measures; until it has, the finding carries the pack's
          // own confidence, below every closing threshold.
          confidence: 0.6,
        });
      }
    }
  }

  observations.push({
    id: 'lint-rules:summary',
    type: 'lint_rules_summary',
    details: {
      files: files.length,
      findings: findings.length,
      parseErrors,
      notices,
      rulePacks: [...RULE_PACKS],
      ruleHistogram: Object.fromEntries(
        Object.entries(ruleHistogram).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  });

  const sortedReadPaths = [...new Set(readPaths)].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: {
      scanMode: 'lint_rules_v1',
      rulePacks: [...RULE_PACKS],
      configPath: normalizeWorkspacePath(relative(workspaceRoot, LINT_RULES_CONFIG_PATH)),
      fileCount: files.length,
      findingCount: findings.length,
      parseErrorCount: parseErrors,
      noticeCount: notices,
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
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
  process.stdout.write(`${JSON.stringify(await analyzeLintRules(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
