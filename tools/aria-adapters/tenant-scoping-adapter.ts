#!/usr/bin/env ts-node
import { relative } from 'node:path';
import ts from 'typescript';
import {
  collectFiles,
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveInsideWorkspace as resolveAdapterPath,
  workspacePathExists,
} from './adapter-fs';

type FindingRule =
  | 'tenant_repository_unscoped_read'
  | 'tenant_raw_query_missing_tenant_predicate'
  | 'tenant_guard_missing';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly allowlist?: readonly string[];
  readonly includeRepositoryReadFindings?: boolean;
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

interface SourceUnit {
  readonly path: string;
  readonly relativePath: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

interface AnalysisContext {
  readonly checker: ts.TypeChecker;
  readonly tenantEntities: ReadonlyMap<string, TenantEntityRecord>;
  readonly tenantTables: ReadonlySet<string>;
  readonly includeRepositoryReadFindings: boolean;
}

interface TenantEntityRecord {
  readonly className: string;
  readonly tableName: string;
  readonly path: string;
  readonly line: number;
}

interface AnalysisResult {
  readonly observations: AdapterObservation[];
  readonly findings: AdapterFinding[];
  readonly readPaths: string[];
}

const DEFAULT_ROOTS = ['apps', 'libs', 'platform/libs'];
const REPOSITORY_METHODS = new Set(['find', 'findOne', 'findOneBy', 'findBy', 'count', 'update', 'delete', 'softDelete']);
const RAW_QUERY_METHODS = new Set(['query']);
const TENANT_GUARD_NAMES = new Set(['TenantGuard', 'GqlTenantGuard']);

export function analyzeTenantScoping(input: AdapterInput, workspaceRoot = process.cwd()): AriaOutput {
  const roots = input.roots ?? DEFAULT_ROOTS;
  const allowlist = new Set((input.allowlist ?? []).map(normalizePath));
  const files = roots
    .map((root) => resolveInsideWorkspace(workspaceRoot, root))
    .filter((root) => workspacePathExists(root))
    .flatMap((root) => collectTypeScriptFiles(root));
  const snapshotFiles = filterFilesBySnapshot(files, workspaceRoot, input);
  const program = createAnalysisProgram(snapshotFiles);
  const units = snapshotFiles.map((file) => readSourceUnit(file, workspaceRoot, program));
  const tenantEntities = collectTenantEntities(units);
  const context: AnalysisContext = {
    checker: program.getTypeChecker(),
    tenantEntities,
    tenantTables: new Set([...tenantEntities.values()].map((entity) => entity.tableName)),
    includeRepositoryReadFindings: input.includeRepositoryReadFindings === true,
  };
  const result: AnalysisResult = {
    observations: [],
    findings: [],
    readPaths: units.map((unit) => unit.relativePath),
  };

  for (const unit of units) {
    analyzeTenantUnit(unit, result, allowlist, context);
  }
  analyzeGuardCoverage(units, result);

  result.observations.sort(compareById);
  result.findings.sort(compareById);
  result.readPaths.sort();
  // Measured (2026-08-13): the full-repo scan emits 11,471 observations
  // (9,363 tenant_repository_call) — 5.84 MB of stdout that tripped the
  // runner's parse cap and marked every night budget_exceeded. Findings
  // are the actionable channel (66 rows); observations above the per-type
  // cap are dropped DETERMINISTICALLY (post-sort, stable ids) and the
  // drop is DECLARED per type — honest truncation, never silent.
  const OBSERVATION_CAP_PER_TYPE = 3000;
  const byType = new Map<string, number>();
  const truncated: Record<string, number> = {};
  result.observations = result.observations.filter((observation) => {
    const seen = (byType.get(observation.type) ?? 0) + 1;
    byType.set(observation.type, seen);
    if (seen > OBSERVATION_CAP_PER_TYPE) {
      truncated[observation.type] = (truncated[observation.type] ?? 0) + 1;
      return false;
    }
    return true;
  });
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
        belief_id: 'tenant-scoping:repository-boundary-surface',
        claim: 'backend services use tenant context and repository/query boundaries that require tenant-scoped access checks',
        confidence: 0.8,
        evidence_refs: ['apps/**/*.ts', 'libs/backend-common/src/database/**/*.ts', 'platform/libs/**/*.ts'],
        source_tool_id: 'tenant-scoping-adapter',
      },
    ],
    cost_units: Array.from(new Set(result.readPaths)).length,
    metadata: {
      adapter: 'tenant-scoping-adapter',
      roots: roots.map(String).sort(),
      files_scanned: snapshotFiles.length,
      findings_count: result.findings.length,
      allowlist_count: allowlist.size,
      tenant_owned_entity_count: tenantEntities.size,
      // Declared truncation (see the cap above): counts of observations
      // dropped per type. Empty object = nothing dropped.
      observations_truncated: truncated,
    },
  };
}

function analyzeTenantUnit(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlist: ReadonlySet<string>,
  context: AnalysisContext,
): void {
  const allowlisted = allowlist.has(unit.relativePath);
  const hasTenantSignal = /\btenantId\b|@Tenant\b|TenantGuard|tenantManagerRepo|TenantContext/.test(unit.text);
  const guardNames = collectIdentifiers(unit.sourceFile).filter((name) => TENANT_GUARD_NAMES.has(name));

  if (hasTenantSignal) {
    result.observations.push({
      id: `tenant-source:${unit.relativePath}`,
      type: 'tenant_source',
      path: unit.relativePath,
      line: 1,
      details: {
        hasTenantIdReference: /\btenantId\b/.test(unit.text),
        hasTenantDecorator: /@Tenant\b/.test(unit.text),
        hasTenantManagerRepo: /tenantManagerRepo/.test(unit.text),
        guardNames,
      },
    });
  }

  visit(unit.sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    const method = node.expression.name.text;
    if (!REPOSITORY_METHODS.has(method) && !RAW_QUERY_METHODS.has(method)) {
      return;
    }
    const line = lineOf(unit.sourceFile, node);
    const enclosing = enclosingFunctionLike(node);
    const scopeText = enclosing?.getText(unit.sourceFile) ?? unit.sourceFile.getText();
    const callText = node.getText(unit.sourceFile);
    const statementText = enclosingStatementText(node, unit.sourceFile);
    const receiverText = node.expression.expression.getText(unit.sourceFile);
    const boundary = classifyTenantBoundaryCall(node, unit, context);
    if (!boundary.isBoundary) {
      return;
    }
    const scopedByTenantManager = /tenantManagerRepo|tenantAware|tenantScoped|withTenant/i.test(receiverText + scopeText);
    const callHasTenantPredicate = /\btenantId\b|tenant_id|current_tenant|set_config\(['"]app\.current_tenant/.test(callText + statementText);
    const scopeHasTenant = /\btenantId\b|@Tenant\b|TenantContext|tenantManagerRepo/.test(scopeText);
    const explicitCrossTenant = hasCrossTenantComment(unit.text, node.getFullStart(), node.getStart(unit.sourceFile));

    result.observations.push({
      id: `tenant-repository-call:${unit.relativePath}:${line}:${method}`,
      type: 'tenant_repository_call',
      path: unit.relativePath,
      line,
      name: method,
      details: {
        receiver: receiverText,
        scopeHasTenant,
        callHasTenantPredicate,
        scopedByTenantManager,
        explicitCrossTenant,
        allowlisted,
        boundaryKind: boundary.kind,
        entityName: boundary.entityName ?? null,
        typeEvidence: boundary.typeEvidence,
      },
    });

    if (
      allowlisted
      || explicitCrossTenant
      || scopedByTenantManager
      || unit.relativePath.includes('/migrations/')
      || !scopeHasTenant
      || callHasTenantPredicate
      || !boundary.tenantOwned
    ) {
      return;
    }
    if (RAW_QUERY_METHODS.has(method)) {
      result.findings.push({
        id: `tenant-raw-query-missing-predicate:${unit.relativePath}:${line}`,
        rule: 'tenant_raw_query_missing_tenant_predicate',
        severity: 'high',
        path: unit.relativePath,
        line,
        message: 'Raw tenant-bound query is executed in a tenant-aware scope without an explicit tenant predicate.',
        evidence: [{ path: unit.relativePath, line }],
        confidence: isSeedOrBootstrapContext(unit.relativePath, scopeText) ? 0.55 : 0.9,
        actionability: isSeedOrBootstrapContext(unit.relativePath, scopeText) ? 'review_required' : 'actionable',
        review_reason: isSeedOrBootstrapContext(unit.relativePath, scopeText) ? 'seed_or_bootstrap_context' : undefined,
        details: { method, receiver: receiverText, entityName: boundary.entityName ?? null },
      });
      return;
    }
    if (!inputAllowsRepositoryReadFinding(context, method)) {
      return;
    }
    result.findings.push({
      id: `tenant-repository-unscoped-read:${unit.relativePath}:${line}`,
      rule: 'tenant_repository_unscoped_read',
      severity: method === 'find' || method === 'findOne' || method === 'findOneBy' || method === 'findBy' ? 'medium' : 'high',
      path: unit.relativePath,
      line,
      message: 'Repository call is made in a tenant-aware scope without an explicit tenant predicate or tenant-scoped repository helper.',
      evidence: [{ path: unit.relativePath, line }],
      confidence: 0.82,
      actionability: 'actionable',
      details: { method, receiver: receiverText, entityName: boundary.entityName ?? null },
    });
  });
}

function enclosingStatementText(node: ts.Node, sourceFile: ts.SourceFile): string {
  let current: ts.Node | undefined = node;
  while (current && !ts.isStatement(current)) {
    current = current.parent;
  }
  return current?.getText(sourceFile) ?? node.getText(sourceFile);
}

function isSeedOrBootstrapContext(path: string, text: string): boolean {
  return /seed|bootstrap|fixture/i.test(path) || /\b(seed|bootstrap|fixture)\b/i.test(text.slice(0, 4000));
}

function inputAllowsRepositoryReadFinding(context: AnalysisContext, method: string): boolean {
  return context.includeRepositoryReadFindings || !['find', 'findOne', 'findOneBy', 'findBy', 'count'].includes(method);
}

function classifyTenantBoundaryCall(
  node: ts.CallExpression,
  unit: SourceUnit,
  context: AnalysisContext,
): {
  readonly isBoundary: boolean;
  readonly tenantOwned: boolean;
  readonly kind: 'repository' | 'raw_query' | 'query_builder' | 'unknown';
  readonly entityName?: string;
  readonly typeEvidence: string;
} {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return { isBoundary: false, tenantOwned: false, kind: 'unknown', typeEvidence: '' };
  }
  const method = node.expression.name.text;
  const receiver = node.expression.expression;
  const receiverType = context.checker.typeToString(context.checker.getTypeAtLocation(receiver));
  const callText = node.getText(unit.sourceFile);
  const entityName = repositoryEntityName(receiverType);
  if (entityName) {
    return {
      isBoundary: true,
      tenantOwned: context.tenantEntities.has(entityName),
      kind: 'repository',
      entityName,
      typeEvidence: receiverType,
    };
  }
  if (method === 'query' && /\b(DataSource|EntityManager|QueryRunner)\b/.test(receiverType)) {
    return {
      isBoundary: true,
      tenantOwned: queryReferencesTenantTable(callText, context.tenantTables),
      kind: 'raw_query',
      typeEvidence: receiverType,
    };
  }
  if (method === 'getRepository' && /\b(DataSource|EntityManager|QueryRunner)\b/.test(receiverType)) {
    const firstArg = node.arguments[0]?.getText(unit.sourceFile);
    const normalized = firstArg?.split('.').pop();
    return {
      isBoundary: true,
      tenantOwned: Boolean(normalized && context.tenantEntities.has(normalized)),
      kind: 'repository',
      entityName: normalized,
      typeEvidence: receiverType,
    };
  }
  if (/SelectQueryBuilder<([^>]+)>/.test(receiverType)) {
    const match = receiverType.match(/SelectQueryBuilder<([^>]+)>/);
    const normalized = match?.[1]?.split('.').pop();
    return {
      isBoundary: true,
      tenantOwned: Boolean(normalized && context.tenantEntities.has(normalized)),
      kind: 'query_builder',
      entityName: normalized,
      typeEvidence: receiverType,
    };
  }
  return { isBoundary: false, tenantOwned: false, kind: 'unknown', typeEvidence: receiverType };
}

function repositoryEntityName(typeText: string): string | undefined {
  const match = typeText.match(/\bRepository<([^>]+)>/);
  return match?.[1]?.split('.').pop();
}

function queryReferencesTenantTable(callText: string, tenantTables: ReadonlySet<string>): boolean {
  const lower = callText.toLowerCase();
  return [...tenantTables].some((table) => table && lower.includes(table.toLowerCase()));
}

function collectTenantEntities(units: readonly SourceUnit[]): ReadonlyMap<string, TenantEntityRecord> {
  const entities = new Map<string, TenantEntityRecord>();
  for (const unit of units) {
    visit(unit.sourceFile, (node) => {
      if (!ts.isClassDeclaration(node) || !node.name) {
        return;
      }
      const hasTenantField = node.members.some((member) => {
        const name = ts.isPropertyDeclaration(member) && member.name ? member.name.getText(unit.sourceFile) : '';
        return name === 'tenantId' || name === 'tenant_id';
      });
      if (!hasTenantField && !/implements\s+TenantEntity/.test(node.getText(unit.sourceFile))) {
        return;
      }
      const tableName = readEntityTableName(node, unit) ?? camelToSnake(node.name.text);
      entities.set(node.name.text, {
        className: node.name.text,
        tableName,
        path: unit.relativePath,
        line: lineOf(unit.sourceFile, node),
      });
    });
  }
  return entities;
}

function readEntityTableName(node: ts.ClassDeclaration, unit: SourceUnit): string | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || expression.expression.getText(unit.sourceFile).split('.').pop() !== 'Entity') {
      continue;
    }
    const firstArg = expression.arguments[0];
    if (firstArg && ts.isStringLiteralLike(firstArg)) {
      return firstArg.text;
    }
  }
  return undefined;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function analyzeGuardCoverage(units: readonly SourceUnit[], result: AnalysisResult): void {
  const modules = units.filter((unit) => unit.relativePath.endsWith('app.module.ts'));
  for (const unit of modules) {
    const registersTenantGuard = /APP_GUARD[\s\S]{0,240}TenantGuard|TenantGuard[\s\S]{0,240}APP_GUARD/.test(unit.text);
    const importsTenantGuard = /\bTenantGuard\b/.test(unit.text);
    result.observations.push({
      id: `tenant-guard-registration:${unit.relativePath}`,
      type: 'tenant_guard_registration',
      path: unit.relativePath,
      line: importsTenantGuard ? firstLineMatching(unit, /\bTenantGuard\b/) : 1,
      details: { importsTenantGuard, registersTenantGuard },
    });
    if (importsTenantGuard && !registersTenantGuard) {
      result.findings.push({
        id: `tenant-guard-missing:${unit.relativePath}`,
        rule: 'tenant_guard_missing',
        severity: 'medium',
        path: unit.relativePath,
        line: firstLineMatching(unit, /\bTenantGuard\b/),
        message: 'App module imports TenantGuard but does not register it as an APP_GUARD.',
        evidence: [{ path: unit.relativePath, line: firstLineMatching(unit, /\bTenantGuard\b/) }],
      });
    }
  }
}

function hasCrossTenantComment(text: string, fullStart: number, start: number): boolean {
  const leading = text.slice(fullStart, start);
  return /cross-tenant|tenant-fanout|SkipTenantGuard|allowlist/i.test(leading);
}

function collectIdentifiers(sourceFile: ts.SourceFile): string[] {
  const names = new Set<string>();
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
  });
  return Array.from(names).sort();
}

function enclosingFunctionLike(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isMethodDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function firstLineMatching(unit: SourceUnit, pattern: RegExp): number {
  const lines = unit.text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : 1;
}

function createAnalysisProgram(files: readonly string[]): ts.Program {
  return ts.createProgram([...files], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    experimentalDecorators: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
  });
}

function readSourceUnit(path: string, workspaceRoot: string, program: ts.Program): SourceUnit {
  const text = readWorkspaceFile(path);
  return {
    path,
    relativePath: normalizePath(relative(workspaceRoot, path)),
    text,
    sourceFile: program.getSourceFile(path) ?? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
  };
}

function collectTypeScriptFiles(root: string): readonly string[] {
  return collectFiles(root, {
    extensions: ['.ts'],
    includeExcludedDir: (name) => name === '__tests__',
    includeFile: (name) => !isTestFile(name),
  });
}

function isTestFile(name: string): boolean {
  return name.endsWith('.spec.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts');
}

function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  return resolveAdapterPath(workspaceRoot, requestedPath);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
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
  process.stdout.write(`${JSON.stringify(analyzeTenantScoping(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
