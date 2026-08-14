#!/usr/bin/env ts-node
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  collectFiles,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveInsideWorkspace as resolveAdapterPath,
  workspacePathExists,
} from './adapter-fs';

type FindingRule =
  | 'high_risk_source_without_adjacent_test'
  | 'migration_without_test'
  | 'security_source_without_security_test';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly allowlist?: readonly string[];
  readonly includeWriteBoundaryFindings?: boolean;
  readonly repo_snapshot?: { readonly allowed_paths?: readonly string[]; readonly snapshot_hash?: string; readonly repo_state_id?: string };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly line?: number;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
}

interface AdapterFinding {
  readonly id: string;
  readonly rule: FindingRule;
  readonly severity: 'medium' | 'high';
  readonly path: string;
  readonly line?: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence?: number;
  readonly actionability?: 'actionable' | 'review_required';
  readonly review_reason?: string;
  readonly details?: Record<string, unknown>;
}

interface MemoryCandidate {
  readonly belief_id: string;
  readonly claim: string;
  readonly confidence: number;
  readonly evidence_refs: readonly string[];
  readonly source_tool_id: string;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly MemoryCandidate[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface FileUnit {
  readonly path: string;
  readonly relativePath: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
  readonly isTest: boolean;
}

interface SourceRisk {
  readonly riskClass: string;
  readonly highRisk: boolean;
  readonly securitySensitive: boolean;
  readonly migrationHazard: boolean;
  readonly writeBoundary: boolean;
}

interface AnalysisResult {
  readonly observations: AdapterObservation[];
  readonly findings: AdapterFinding[];
  readonly readPaths: string[];
}

interface PathAlias {
  readonly prefix: string;
  readonly suffix: string;
  readonly targets: readonly string[];
}

const DEFAULT_ROOTS = ['apps', 'libs', 'platform/libs', 'web'];

export function analyzeTestGaps(input: AdapterInput, workspaceRoot = process.cwd()): AriaOutput {
  const roots = input.roots ?? DEFAULT_ROOTS;
  const allowlist = new Set((input.allowlist ?? []).map(normalizePath));
  const files = roots
    .map((root) => resolveInsideWorkspace(workspaceRoot, root))
    .filter((root) => workspacePathExists(root))
    .flatMap((root) => collectSourceAndTestFiles(root));
  const snapshotFiles = filterFilesBySnapshot(files, workspaceRoot, input);
  const units = snapshotFiles.map((file) => readFileUnit(file, workspaceRoot));
  const tests = units.filter((unit) => unit.isTest);
  const sources = units.filter((unit) => !unit.isTest);
  const sourcePaths = new Set(sources.map((source) => source.relativePath));
  const pathAliases = readPathAliases(workspaceRoot);
  const result: AnalysisResult = {
    observations: [],
    findings: [],
    readPaths: units.map((unit) => unit.relativePath),
  };

  for (const test of tests) {
    result.observations.push({
      id: `test-gap-test-file:${test.relativePath}`,
      type: 'test_gap_test_file',
      path: test.relativePath,
      line: 1,
      name: basename(test.relativePath),
      details: {
        imports: importedSpecifiers(test.sourceFile).sort(),
      },
    });
  }

  let highRiskWithoutTest = 0;
  let directMatchCount = 0;
  let weakMatchCount = 0;
  for (const source of sources) {
    const risk = classifySourceRisk(source);
    if (!risk.highRisk && !risk.securitySensitive && !risk.migrationHazard) {
      continue;
    }
    const matchedTests = matchingTests(source, tests, sourcePaths, pathAliases);
    const weakMatchedTests = weakSymbolTests(source, tests).filter(
      (test) => !matchedTests.some((matched) => matched.relativePath === test.relativePath),
    );
    directMatchCount += matchedTests.length > 0 ? 1 : 0;
    weakMatchCount += weakMatchedTests.length > 0 ? 1 : 0;
    const allowlisted = allowlist.has(source.relativePath);
    result.observations.push({
      id: `test-gap-source-file:${source.relativePath}`,
      type: 'test_gap_source_file',
      path: source.relativePath,
      line: 1,
      name: basename(source.relativePath),
      details: {
        riskClass: risk.riskClass,
        highRisk: risk.highRisk,
        securitySensitive: risk.securitySensitive,
        migrationHazard: risk.migrationHazard,
        writeBoundary: risk.writeBoundary,
        matchedTests: matchedTests.map((test) => test.relativePath).sort(),
        weakMatchedTests: weakMatchedTests.map((test) => test.relativePath).sort(),
        allowlisted,
      },
    });
    if (allowlisted || matchedTests.length > 0) {
      continue;
    }
    if (risk.migrationHazard) {
      highRiskWithoutTest += 1;
      result.findings.push({
        id: `migration-without-test:${source.relativePath}`,
        rule: 'migration_without_test',
        severity: 'high',
        path: source.relativePath,
        message: 'Hazardous migration has no adjacent or importing test coverage signal.',
        evidence: [{ path: source.relativePath }],
        confidence: weakMatchedTests.length > 0 ? 0.55 : 0.88,
        actionability: weakMatchedTests.length > 0 ? 'review_required' : 'actionable',
        review_reason: weakMatchedTests.length > 0 ? 'weak_symbol_test_match' : undefined,
        details: { riskClass: risk.riskClass, weakMatchedTests: weakMatchedTests.map((test) => test.relativePath).sort() },
      });
      continue;
    }
    if (risk.securitySensitive) {
      highRiskWithoutTest += 1;
      result.findings.push({
        id: `security-source-without-test:${source.relativePath}`,
        rule: 'security_source_without_security_test',
        severity: 'high',
        path: source.relativePath,
        message: 'Security-sensitive source file has no adjacent or importing test coverage signal.',
        evidence: [{ path: source.relativePath }],
        confidence: weakMatchedTests.length > 0 ? 0.55 : 0.86,
        actionability: weakMatchedTests.length > 0 ? 'review_required' : 'actionable',
        review_reason: weakMatchedTests.length > 0 ? 'weak_symbol_test_match' : undefined,
        details: { riskClass: risk.riskClass, weakMatchedTests: weakMatchedTests.map((test) => test.relativePath).sort() },
      });
      continue;
    }
    if (input.includeWriteBoundaryFindings === true && risk.highRisk && risk.writeBoundary) {
      highRiskWithoutTest += 1;
      result.findings.push({
        id: `high-risk-source-without-adjacent-test:${source.relativePath}`,
        rule: 'high_risk_source_without_adjacent_test',
        severity: 'medium',
        path: source.relativePath,
        message: 'High-risk source file has no adjacent, sibling __tests__, or importing test coverage signal.',
        evidence: [{ path: source.relativePath }],
        confidence: weakMatchedTests.length > 0 ? 0.5 : 0.75,
        actionability: weakMatchedTests.length > 0 ? 'review_required' : 'actionable',
        review_reason: weakMatchedTests.length > 0 ? 'weak_symbol_test_match' : undefined,
        details: { riskClass: risk.riskClass, weakMatchedTests: weakMatchedTests.map((test) => test.relativePath).sort() },
      });
    }
  }

  result.observations.push({
    id: 'test-gap-coverage-summary',
    type: 'test_gap_coverage_summary',
    details: {
      sourceFiles: sources.length,
      testFiles: tests.length,
      directMatchCount,
      weakMatchCount,
      highRiskWithoutTest,
      unmatchedHighRiskCount: highRiskWithoutTest,
      scanMode: 'import_graph_v1',
    },
  });

  result.observations.sort(compareById);
  result.findings.sort(compareById);
  result.readPaths.sort();
  const evidenceSources = Array.from(
    new Set(result.findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.path))),
  ).sort();

  return {
    observations: result.observations,
    findings: result.findings,
    read_paths: Array.from(new Set(result.readPaths)).sort(),
    evidence_sources: evidenceSources,
    belief_candidates: [
      {
        belief_id: 'test-gap:high-risk-source-coverage-surface',
        claim: 'high-risk backend, web security, and migration surfaces can be mapped to adjacent or importing test coverage signals',
        confidence: 0.75,
        evidence_refs: ['apps/**/*.ts', 'libs/**/*.ts', 'platform/libs/**/*.ts', 'web/**/*.tsx'],
        source_tool_id: 'test-gap-adapter',
      },
    ],
    cost_units: Array.from(new Set(result.readPaths)).length,
    metadata: {
      adapter: 'test-gap-adapter',
      roots: roots.map(String).sort(),
      files_scanned: snapshotFiles.length,
      findings_count: result.findings.length,
      allowlist_count: allowlist.size,
    },
  };
}

function classifySourceRisk(unit: FileUnit): SourceRisk {
  const path = unit.relativePath;
  const text = unit.text;
  const riskClass = riskClassForPath(path);
  const highRisk = /(\.controller|\.resolver|\.handler|\.guard|\.strategy|\.middleware|\.interceptor)\.ts$/.test(path);
  const securitySensitive = /dangerouslySetInnerHTML|DOMPurify|sanitizeHtml|@Public\b|AuthGuard|TenantGuard|PermissionGuard/i.test(text)
    || /(\.guard|\.strategy|\/auth\/|\/security\/|\/permission)/i.test(path);
  const writeBoundary = /@(Post|Put|Patch|Delete|Mutation)\b|\b(create|update|delete|remove|archive|approve|reject|reset|invite)\w*\s*\(/i.test(text);
  const migrationHazard = /\/migrations\/.*\.ts$/.test(path)
    && /\b(DROP|DELETE|TRUNCATE|ALTER\s+TYPE|ENABLE\s+ROW\s+LEVEL\s+SECURITY|FORCE\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(text);
  return { riskClass, highRisk, securitySensitive, migrationHazard, writeBoundary };
}

function riskClassForPath(path: string): string {
  if (path.includes('/migrations/')) {
    return 'migration';
  }
  // match[1] is narrowed explicitly so the file stays clean under
  // --noUncheckedIndexedAccess (the capture group is structurally guaranteed,
  // but the index signature cannot prove it to the compiler).
  const match = path.match(/\.([a-z-]+)\.(ts|tsx)$/);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  if (path.endsWith('.tsx')) {
    return 'ui_component';
  }
  return 'source';
}

function matchingTests(
  source: FileUnit,
  tests: readonly FileUnit[],
  sourcePaths: ReadonlySet<string>,
  pathAliases: readonly PathAlias[],
): readonly FileUnit[] {
  const sourceBase = basenameWithoutKnownSuffix(source.relativePath);
  const sourceDir = dirname(source.relativePath);
  return tests.filter((test) => {
    const testBase = basenameWithoutKnownSuffix(test.relativePath);
    if (testBase === sourceBase) {
      return true;
    }
    if (dirname(test.relativePath) === sourceDir && testBase.startsWith(sourceBase)) {
      return true;
    }
    if (dirname(test.relativePath).endsWith(`${sourceDir}/__tests__`) && testBase.includes(sourceBase)) {
      return true;
    }
    return importedSpecifiers(test.sourceFile).some((specifier) => {
      const resolved = resolveImportSpecifier(test.relativePath, specifier, sourcePaths, pathAliases);
      return resolved === source.relativePath;
    });
  });
}

function weakSymbolTests(source: FileUnit, tests: readonly FileUnit[]): readonly FileUnit[] {
  const symbolNames = exportedSymbols(source.sourceFile);
  if (symbolNames.length === 0) {
    return [];
  }
  return tests.filter((test) => symbolNames.some((symbolName) => symbolName.length > 2 && test.text.includes(symbolName)));
}

function basenameWithoutKnownSuffix(path: string): string {
  return basename(path)
    .replace(/\.(spec|test)\.(ts|tsx)$/, '')
    .replace(/\.(controller|resolver|handler|guard|strategy|middleware|interceptor|service|entity|module|component)\.(ts|tsx)$/, '')
    .replace(/\.(ts|tsx)$/, '');
}

function importedSpecifiers(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports;
}

function resolveImportSpecifier(
  importingPath: string,
  specifier: string,
  sourcePaths: ReadonlySet<string>,
  pathAliases: readonly PathAlias[],
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith('.')) {
    candidates.push(normalizePath(join(dirname(importingPath), specifier)));
  } else {
    for (const alias of pathAliases) {
      if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) {
        continue;
      }
      const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
      for (const target of alias.targets) {
        candidates.push(target.replace('*', middle));
      }
    }
  }
  for (const candidate of candidates.flatMap(candidatePathVariants)) {
    if (sourcePaths.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function candidatePathVariants(candidate: string): string[] {
  const normalized = normalizePath(candidate).replace(/^\.\//, '');
  return [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
  ];
}

function readPathAliases(workspaceRoot: string): readonly PathAlias[] {
  const path = resolve(workspaceRoot, 'tsconfig.base.json');
  if (!workspacePathExists(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readWorkspaceFile(path)) as {
      compilerOptions?: { paths?: Record<string, readonly string[]> };
    };
    return Object.entries(parsed.compilerOptions?.paths ?? {}).map(([key, targets]) => {
      const starIndex = key.indexOf('*');
      return {
        prefix: starIndex >= 0 ? key.slice(0, starIndex) : key,
        suffix: starIndex >= 0 ? key.slice(starIndex + 1) : '',
        targets: targets.map((target) => normalizePath(target)),
      };
    });
  } catch {
    return [];
  }
}

function exportedSymbols(sourceFile: ts.SourceFile): string[] {
  const symbols = new Set<string>();
  visit(sourceFile, (node) => {
    if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        symbols.add(node.name.text);
      }
    }
  });
  return Array.from(symbols).sort();
}

function readFileUnit(path: string, workspaceRoot: string): FileUnit {
  const text = readWorkspaceFile(path);
  return {
    path,
    relativePath: normalizePath(relative(workspaceRoot, path)),
    text,
    sourceFile: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    isTest: isTestFile(path),
  };
}

function collectSourceAndTestFiles(root: string): readonly string[] {
  return collectFiles(root, {
    extensions: ['.ts', '.tsx'],
    // E13 FP class (2): archived corpus (e.g. migrations/.archive/<timestamp>/)
    // is dead code — it can neither need test coverage nor PROVIDE it (an
    // archived spec must not satisfy a live source), so it is excluded from
    // the scan entirely rather than special-cased at finding time.
    includeFile: (name, path) => !name.endsWith('.d.ts') && !isArchivedWorkspacePath(path),
  });
}

function isTestFile(path: string): boolean {
  const normalized = normalizePath(path);
  return /(__tests__|\.spec\.|\.test\.)/.test(normalized);
}

function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  return resolveAdapterPath(workspaceRoot, requestedPath);
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function compareById(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id);
}

function normalizePath(path: string): string {
  return normalizeWorkspacePath(path);
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeTestGaps(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
