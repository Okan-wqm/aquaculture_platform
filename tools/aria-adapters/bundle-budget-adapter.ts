#!/usr/bin/env ts-node
// D2-performance dimension adapter v1 (Plan "ARIA Sinir Sistemi" FAZ 7).
//
// WHY: no adapter watched frontend performance at all — the fleet covered
// D1-security and D4-testability while every MFE could grow unbounded.
// WHAT (deterministic, no build required):
//   * `bundle_budget_not_enforced` — an MFE with a production Vite build has
//     no `bundle-budget.json` beside it, the per-module size budget this rule
//     reads. ARIA-MEDIUM-327: the rule used to be `no_bundle_budget_declared`,
//     counted `build.chunkSizeWarningLimit` as a budget and told the judge
//     "nothing warns when the bundle grows". Both were wrong: a warning limit
//     fails nothing, and Vite warns above 500 kB by default whether or not the
//     limit is set. What a person can act on is the ABSENCE of an enforced
//     budget, so the finding is LOW and states only that absence.
//   * `heavy_dependency_statically_imported` — a known heavyweight library
//     is imported statically in module source, which welds it into the
//     initial chunk; the fix is a dynamic `import()` at the use site.
//   * `route_page_statically_imported` — a federated remote's router lazy-loads
//     its pages and one page is imported statically, which welds that page and
//     everything it imports into the remote's initial chunk. Structural, needs
//     no library list: see `routerPageFindings`.
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';

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
  readonly rule:
    | 'bundle_budget_not_enforced'
    | 'heavy_dependency_statically_imported'
    | 'route_page_statically_imported';
  readonly severity: 'low' | 'medium' | 'high';
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

// A file is a router when it lazy-loads at least this many relative modules AND
// at least this share of the relative page modules it imports are lazy. Below
// the floor a file is a component that happens to split one chunk; below the
// share it ships most of its pages eagerly (sensor-module keeps 14 of its 31
// pages static, a 55% share, and is left alone).
const ROUTER_MIN_LAZY_MODULES = 5;
const ROUTER_MIN_LAZY_PAGE_SHARE = 0.75;

const isRelativeSpecifier = (specifier: string): boolean => specifier.startsWith('.');

// Pages of a web module live under a `pages/` directory (web/modules/*/src/pages).
const isPageSpecifier = (specifier: string): boolean => specifier.split('/').includes('pages');

const propertyNameText = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** A vite config is a federated remote's when module federation `exposes` something. */
function declaresExposes(configPath: string, text: string): boolean {
  const config = ts.createSourceFile(configPath, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): boolean =>
    ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      propertyNameText(node.name) === 'exposes') ||
    ts.forEachChild(node, visit) === true;
  return visit(config);
}

/** `import type { A } from`, `import { type A, type B } from`: erased by the build, loads nothing. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false; // `import './x'` runs the module
  }
  const bindings = clause.namedBindings;
  return (
    clause.isTypeOnly ||
    (clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly))
  );
}

/** The relative module an `import('./x')` call loads, however the lazy edge around it is written. */
function lazyModuleOf(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return undefined;
  }
  const argument = node.arguments[0];
  return argument !== undefined &&
    ts.isStringLiteralLike(argument) &&
    isRelativeSpecifier(argument.text)
    ? argument.text
    : undefined;
}

/**
 * Z37 layer 1. In a federated remote's router file (see the thresholds above),
 * every static runtime import of a relative page module is one finding, cited
 * at the import statement. A page imported both ways counts as static: the
 * static edge is what puts it in the initial chunk. Nothing is resolved on
 * disk; a page is recognised by the specifier the router wrote.
 */
function routerPageFindings(
  sourceRel: string,
  moduleRel: string,
  source: ts.SourceFile,
): AdapterFinding[] {
  const staticPages = source.statements
    .filter(ts.isImportDeclaration)
    .filter((node) => !isTypeOnlyImport(node))
    .flatMap((node) =>
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRelativeSpecifier(node.moduleSpecifier.text) &&
      isPageSpecifier(node.moduleSpecifier.text)
        ? [{ node, specifier: node.moduleSpecifier.text }]
        : [],
    );
  const lazyModules = new Set<string>();
  const visit = (node: ts.Node): void => {
    const lazyModule = lazyModuleOf(node);
    if (lazyModule !== undefined) {
      lazyModules.add(lazyModule);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const staticSpecifiers = new Set(staticPages.map((page) => page.specifier));
  const lazyPages = [...lazyModules].filter(
    (specifier) => isPageSpecifier(specifier) && !staticSpecifiers.has(specifier),
  ).length;
  const pages = lazyPages + staticSpecifiers.size;
  if (
    lazyModules.size < ROUTER_MIN_LAZY_MODULES ||
    lazyPages < ROUTER_MIN_LAZY_PAGE_SHARE * pages
  ) {
    return [];
  }
  return staticPages.map(({ node, specifier }) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return {
      id: `bundle-budget:route-page:${sourceRel}:${line}:${specifier}`,
      rule: 'route_page_statically_imported',
      severity: 'medium',
      path: sourceRel,
      line,
      message:
        `\`${sourceRel}\` lazy-loads ${lazyPages} of its ${pages} pages but imports ` +
        `\`${specifier}\` statically, welding that page and everything it imports into ` +
        `\`${moduleRel}\`'s initial chunk; load it with lazy(() => import()) like its siblings.`,
      evidence: [{ path: sourceRel, line }],
      confidence: 0.8,
    };
  });
}

export function analyzeBundleBudgets(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots('bundle-budget-adapter', input.roots);
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];
  const readPaths: string[] = [];

  const moduleRoots: string[] = [];
  for (const root of roots) {
    const absolute = resolveInsideWorkspace(workspaceRoot, root);
    if (!workspacePathExists(workspaceRoot, absolute)) {
      continue;
    }
    if (workspacePathExists(workspaceRoot, join(absolute, 'package.json'))) {
      moduleRoots.push(absolute);
      continue;
    }
    for (const config of collectFiles(workspaceRoot, absolute, { extensions: ['package.json'] })) {
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
      .find((path) => workspacePathExists(workspaceRoot, path));
    // A `chunkSizeWarningLimit` is deliberately NOT a budget here: it only
    // moves the build-time warning, and the build still succeeds past it.
    const hasBudget = workspacePathExists(workspaceRoot, join(moduleRoot, 'bundle-budget.json'));
    if (viteConfig !== undefined) {
      readPaths.push(normalizeWorkspacePath(relative(workspaceRoot, viteConfig)));
    }
    observations.push({
      id: `bundle-budget:module:${rel}`,
      type: 'bundle_budget_module',
      path: rel,
      details: { hasBudget, hasViteConfig: viteConfig !== undefined },
    });
    const federatedRemote =
      viteConfig !== undefined &&
      declaresExposes(viteConfig, readWorkspaceFile(workspaceRoot, viteConfig));
    if (viteConfig !== undefined && !hasBudget) {
      const viteRel = normalizeWorkspacePath(relative(workspaceRoot, viteConfig));
      findings.push({
        id: `bundle-budget:not-enforced:${rel}`,
        rule: 'bundle_budget_not_enforced',
        severity: 'low',
        path: viteRel,
        line: 1,
        message:
          `MFE \`${rel}\` has a production Vite build and no \`bundle-budget.json\` ` +
          'beside it, so no declared size budget is enforced for this module.',
        evidence: [{ path: viteRel, line: 1 }],
        confidence: 0.9,
      });
    }

    const sources = filterFilesBySnapshot(
      collectFiles(workspaceRoot, join(moduleRoot, 'src'), { extensions: ['.ts', '.tsx'] }).filter(
        (path) => workspacePathExists(workspaceRoot, path),
      ),
      workspaceRoot,
      input,
    );
    for (const source of sources) {
      const sourceRel = normalizeWorkspacePath(relative(workspaceRoot, source));
      readPaths.push(sourceRel);
      const text = readWorkspaceFile(workspaceRoot, source);
      const lines = text.split('\n');
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
      if (federatedRemote) {
        findings.push(
          ...routerPageFindings(
            sourceRel,
            rel,
            ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true),
          ),
        );
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
