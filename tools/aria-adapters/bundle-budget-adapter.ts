#!/usr/bin/env ts-node
// D2-performance dimension adapter v1 (Plan "ARIA Sinir Sistemi" FAZ 7).
//
// WHY: no adapter watched frontend performance at all — the fleet covered
// D1-security and D4-testability while every MFE could grow unbounded.
// WHAT (deterministic, no build required):
//   * `no_bundle_budget_declared` — an MFE ships without any declared bundle
//     budget (no `build.chunkSizeWarningLimit` in its vite config and no
//     `bundle-budget.json` beside it): nothing even WARNS when it bloats.
//   * `heavy_dependency_statically_imported` — a known heavyweight library
//     is imported statically in module source, which welds it into the
//     initial chunk; the fix is a dynamic `import()` at the use site.
import { dirname, join, relative } from 'node:path';

import {
  collectFiles,
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';

interface AdapterInput {
  readonly roots?: readonly string[];
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

interface AdapterFinding {
  readonly id: string;
  readonly rule: 'no_bundle_budget_declared' | 'heavy_dependency_statically_imported';
  readonly severity: 'medium' | 'high';
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

const DEFAULT_ROOTS = ['web/shell', 'web/modules', 'web/apps'];

// Libraries whose static import welds them into the initial chunk. The list
// is deliberately conservative: every entry is unambiguously heavyweight.
const HEAVY_MODULES = new Set([
  'chart.js',
  'echarts',
  'exceljs',
  'html2canvas',
  'jspdf',
  'moment',
  'pdfmake',
  'three',
  'xlsx',
]);

const STATIC_IMPORT_RE = /^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/;

export function analyzeBundleBudgets(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = input.roots ?? DEFAULT_ROOTS;
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths: string[] = [];

  const moduleRoots: string[] = [];
  for (const root of roots) {
    const absolute = resolveInsideWorkspace(workspaceRoot, root);
    if (!workspacePathExists(absolute)) {
      continue;
    }
    if (workspacePathExists(join(absolute, 'package.json'))) {
      moduleRoots.push(absolute);
      continue;
    }
    for (const config of collectFiles(absolute, { extensions: ['package.json'] })) {
      // Only direct children of a container root are modules; deeper
      // package.json files are workspaces-of-workspaces noise.
      if (dirname(dirname(config)) === absolute) {
        moduleRoots.push(dirname(config));
      }
    }
  }

  for (const moduleRoot of moduleRoots.sort()) {
    const rel = normalizeWorkspacePath(relative(workspaceRoot, moduleRoot));
    const viteConfig = ['vite.config.ts', 'vite.config.mts', 'vite.config.js']
      .map((name) => join(moduleRoot, name))
      .find((path) => workspacePathExists(path));
    const budgetManifest = join(moduleRoot, 'bundle-budget.json');
    const hasBudget =
      workspacePathExists(budgetManifest) ||
      (viteConfig !== undefined && readWorkspaceFile(viteConfig).includes('chunkSizeWarningLimit'));
    if (viteConfig !== undefined) {
      readPaths.push(normalizeWorkspacePath(relative(workspaceRoot, viteConfig)));
    }
    observations.push({
      id: `bundle-budget:module:${rel}`,
      type: 'bundle_budget_module',
      path: rel,
      details: { hasBudget, hasViteConfig: viteConfig !== undefined },
    });
    if (viteConfig !== undefined && !hasBudget) {
      const viteRel = normalizeWorkspacePath(relative(workspaceRoot, viteConfig));
      findings.push({
        id: `bundle-budget:no-budget:${rel}`,
        rule: 'no_bundle_budget_declared',
        severity: 'medium',
        path: viteRel,
        line: 1,
        message:
          `MFE \`${rel}\` declares no bundle budget: its vite config has no ` +
          '`build.chunkSizeWarningLimit` and no `bundle-budget.json` exists — ' +
          'nothing warns when the bundle grows.',
        evidence: [{ path: viteRel, line: 1 }],
        confidence: 0.9,
      });
    }

    const sources = filterFilesBySnapshot(
      collectFiles(join(moduleRoot, 'src'), { extensions: ['.ts', '.tsx'] }).filter((path) =>
        workspacePathExists(path),
      ),
      workspaceRoot,
      input,
    );
    for (const source of sources) {
      const sourceRel = normalizeWorkspacePath(relative(workspaceRoot, source));
      readPaths.push(sourceRel);
      const lines = readWorkspaceFile(source).split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const match = STATIC_IMPORT_RE.exec(lines[index]);
        if (!match) {
          continue;
        }
        const specifier = match[1];
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!HEAVY_MODULES.has(packageName)) {
          continue;
        }
        findings.push({
          id: `bundle-budget:heavy:${sourceRel}:${index + 1}`,
          rule: 'heavy_dependency_statically_imported',
          severity: 'high',
          path: sourceRel,
          line: index + 1,
          message:
            `\`${packageName}\` is imported statically, welding it into ` +
            `\`${rel}\`'s initial chunk; load it with a dynamic import() at the use site.`,
          evidence: [{ path: sourceRel, line: index + 1 }],
          confidence: 0.85,
        });
      }
    }
  }

  const sortedReadPaths = [...new Set(readPaths)].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: { scanMode: 'bundle_budget_v1', moduleCount: moduleRoots.length },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    // setEncoding('utf8') makes every chunk a string at runtime, but the
    // stream's declared chunk type stays `string | Buffer` — concatenating the
    // union is what the type checker rejects. Narrow at the boundary rather
    // than widening `input` (kernel-dead-wire-adapter is the converged shape).
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
  process.stdout.write(`${JSON.stringify(analyzeBundleBudgets(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
