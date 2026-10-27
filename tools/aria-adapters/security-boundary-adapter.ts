#!/usr/bin/env ts-node
import { relative } from 'node:path';

import ts from 'typescript';

import {
  collectFiles,
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  requireScanRoots,
  resolveInsideWorkspace as resolveAdapterPath,
  workspacePathExists,
} from './adapter-fs';

type FindingRule =
  | 'public_write_endpoint_without_allowlist'
  | 'mutation_missing_role_boundary'
  | 'controller_missing_guard_boundary'
  | 'authz_boundary_missing_among_peers'
  | 'capability_differs_from_class_majority'
  | 'dangerous_html_without_sanitizer'
  | 'raw_security_sensitive_import';

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly allowlist?: readonly string[];
  readonly repo_snapshot?: {
    readonly allowed_paths?: readonly string[];
    readonly snapshot_hash?: string;
    readonly repo_state_id?: string;
  };
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

interface AnalysisResult {
  readonly observations: AdapterObservation[];
  readonly findings: AdapterFinding[];
  readonly readPaths: string[];
}

interface SecurityContext {
  readonly serviceGuards: ReadonlyMap<string, readonly string[]>;
}

interface DecoratorUse {
  readonly name: string;
  readonly args: readonly ts.Expression[];
}

// One route of a class as its peers see it. `carriesBoundary` is the method's
// own Roles, Permissions, RequiresCapability or UseGuards; `capability` is the
// value the method's RequiresCapability names, undefined when it names none.
interface PeerRoute {
  readonly name: string;
  readonly line: number;
  readonly writes: boolean;
  readonly isPublic: boolean;
  readonly carriesBoundary: boolean;
  readonly capability: string | undefined;
}

interface PeerClass {
  readonly name: string;
  readonly hasClassAuthz: boolean;
  readonly routes: readonly PeerRoute[];
}

const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Query', 'Mutation']);
const WRITE_DECORATORS = new Set(['Post', 'Put', 'Patch', 'Delete', 'Mutation']);
// What a class-level decorator must be to cover every route of the class: an
// authorisation, not a guard (a class-level UseGuards is authentication or tenant
// routing, which every route of a service already has).
const AUTHZ_DECORATORS = new Set(['Roles', 'Permissions', 'RequiresCapability']);
const SECURITY_DECORATORS = new Set([
  'UseGuards',
  ...AUTHZ_DECORATORS,
  'Public',
  'SkipTenantGuard',
]);
// Peer rules (Z-C1): a boundary is judged against the boundaries of its class
// peers. Both need a class large enough to have peers, and a share of 75% or
// more; the share is compared in integers so the threshold has no rounding.
const PEER_MIN_WRITE_ROUTES = 3;
const PEER_MIN_CAPABILITY_ROUTES = 4;
const SAFE_RAW_IMPORT_ALLOWLIST = [
  'apps/ai-service/src/agent/agent-runner.service.ts',
  'tools/eslint-rules/no-claude-sdk-raw-call.ts',
];

export function analyzeSecurityBoundaries(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots('security-boundary-adapter', input.roots);
  const allowlist = new Set((input.allowlist ?? []).map(normalizePath));
  const files = roots
    .map((root) => resolveInsideWorkspace(workspaceRoot, root))
    .filter((root) => workspacePathExists(workspaceRoot, root))
    .flatMap((root) => collectSourceFiles(workspaceRoot, root));
  const snapshotFiles = filterFilesBySnapshot(files, workspaceRoot, input);
  const units = snapshotFiles.map((file) => readSourceUnit(file, workspaceRoot));
  const result: AnalysisResult = {
    observations: [],
    findings: [],
    readPaths: units.map((unit) => unit.relativePath),
  };
  const context: SecurityContext = {
    serviceGuards: collectServiceGuards(units),
  };

  for (const unit of units) {
    analyzeSecurityUnit(unit, result, allowlist, context);
  }

  result.observations.sort(compareById);
  result.findings.sort(compareById);
  result.readPaths.sort();
  const evidenceSources = Array.from(
    new Set(
      result.findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.path)),
    ),
  ).sort();

  return {
    observations: result.observations,
    findings: result.findings,
    read_paths: Array.from(new Set(result.readPaths)).sort(),
    evidence_sources: evidenceSources,
    belief_candidates: [
      {
        belief_id: 'security-boundary:route-and-sensitive-sink-surface',
        claim:
          'backend and web route boundaries expose guard/decorator and sensitive sink surfaces that need deterministic security checks',
        confidence: 0.8,
        evidence_refs: ['apps/**/*.ts', 'web/**/*.tsx', 'libs/backend-common/src/**/*.ts'],
        source_tool_id: 'security-boundary-adapter',
      },
    ],
    cost_units: Array.from(new Set(result.readPaths)).length,
    metadata: {
      adapter: 'security-boundary-adapter',
      roots: roots.map(String).sort(),
      files_scanned: snapshotFiles.length,
      findings_count: result.findings.length,
      allowlist_count: allowlist.size,
    },
  };
}

function analyzeSecurityUnit(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlist: ReadonlySet<string>,
  context: SecurityContext,
): void {
  const allowlisted = allowlist.has(unit.relativePath);
  analyzeEndpoints(unit, result, allowlisted, context);
  analyzePeerBoundaries(unit, result, allowlisted);
  analyzeDangerousHtml(unit, result, allowlisted);
  analyzeRawSecurityImports(unit, result, allowlisted);
  analyzeExistingGates(unit, result);
}

function analyzeEndpoints(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlisted: boolean,
  context: SecurityContext,
): void {
  const inheritedGuards = serviceGuardsForUnit(unit, context);
  visit(unit.sourceFile, (node) => {
    if (!ts.isMethodDeclaration(node) && !ts.isClassDeclaration(node)) {
      return;
    }
    const decorators = decoratorNames(node);
    const routeDecorators = decorators.filter((name) => ROUTE_DECORATORS.has(name));
    if (routeDecorators.length === 0) {
      return;
    }
    const line = lineOf(unit.sourceFile, node);
    const name = ts.isMethodDeclaration(node)
      ? node.name.getText(unit.sourceFile)
      : (node.name?.text ?? '<anonymous>');
    const classNode = ts.isMethodDeclaration(node) ? nearestClass(node) : node;
    const classDecorators = classNode ? decoratorNames(classNode) : [];
    const allDecorators = new Set([...decorators, ...classDecorators]);
    const hasLocalGuardBoundary =
      allDecorators.has('UseGuards') ||
      allDecorators.has('Roles') ||
      allDecorators.has('Permissions');
    const hasInheritedGuardBoundary = inheritedGuards.length > 0;
    const hasGuardBoundary = hasLocalGuardBoundary || hasInheritedGuardBoundary;
    const isPublic = allDecorators.has('Public');
    const isSkippedTenant = allDecorators.has('SkipTenantGuard');
    const writes = routeDecorators.some((decorator) => WRITE_DECORATORS.has(decorator));

    result.observations.push({
      id: `security-boundary-endpoint:${unit.relativePath}:${line}:${name}`,
      type: 'security_boundary_endpoint',
      path: unit.relativePath,
      line,
      name,
      details: {
        routeDecorators: routeDecorators.sort(),
        securityDecorators: [...allDecorators]
          .filter((decorator) => SECURITY_DECORATORS.has(decorator))
          .sort(),
        inheritedGuards,
        hasLocalGuardBoundary,
        hasInheritedGuardBoundary,
        hasGuardBoundary,
        isPublic,
        isSkippedTenant,
        writes,
        allowlisted,
      },
    });

    if (allowlisted) {
      return;
    }
    if (isPublic && writes && !isSkippedTenant) {
      result.findings.push({
        id: `public-write-endpoint-without-allowlist:${unit.relativePath}:${line}`,
        rule: 'public_write_endpoint_without_allowlist',
        severity: 'high',
        path: unit.relativePath,
        line,
        message: 'Public write endpoint requires an explicit allowlist or tenant-skip rationale.',
        evidence: [{ path: unit.relativePath, line }],
        details: { routeDecorators: routeDecorators.sort(), name },
      });
    }
    if (routeDecorators.includes('Mutation') && !hasGuardBoundary && !isPublic) {
      result.findings.push({
        id: `mutation-missing-role-boundary:${unit.relativePath}:${line}`,
        rule: 'mutation_missing_role_boundary',
        severity: 'medium',
        path: unit.relativePath,
        line,
        message: 'GraphQL mutation has no method/class role, permission, or guard boundary.',
        evidence: [{ path: unit.relativePath, line }],
        details: { name },
      });
    }
    if (
      !isPublic &&
      !hasGuardBoundary &&
      routeDecorators.some((decorator) => decorator !== 'Query')
    ) {
      result.findings.push({
        id: `controller-missing-guard-boundary:${unit.relativePath}:${line}`,
        rule: 'controller_missing_guard_boundary',
        severity: 'medium',
        path: unit.relativePath,
        line,
        message: 'Route boundary has no explicit public marker or method/class guard boundary.',
        evidence: [{ path: unit.relativePath, line }],
        details: { routeDecorators: routeDecorators.sort(), name },
      });
    }
  });
}

function analyzePeerBoundaries(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlisted: boolean,
): void {
  if (allowlisted) {
    return;
  }
  visit(unit.sourceFile, (node) => {
    if (!ts.isClassDeclaration(node)) {
      return;
    }
    const peerClass = collectPeerClass(node, unit.sourceFile);
    result.findings.push(
      ...boundaryMissingAmongPeers(unit.relativePath, peerClass),
      ...capabilityDiffersFromMajority(unit.relativePath, peerClass),
    );
  });
}

function collectPeerClass(classNode: ts.ClassDeclaration, sourceFile: ts.SourceFile): PeerClass {
  const classDecorators = decoratorsOf(classNode);
  const routes = classNode.members.filter(ts.isMethodDeclaration).flatMap((method): PeerRoute[] => {
    const decorators = decoratorsOf(method);
    const routeNames = decorators
      .map((decorator) => decorator.name)
      .filter((name) => ROUTE_DECORATORS.has(name));
    if (routeNames.length === 0) {
      return [];
    }
    const capabilities = decorators
      .filter((decorator) => decorator.name === 'RequiresCapability')
      .map((decorator) => capabilityValue(decorator, sourceFile));
    return [
      {
        name: method.name.getText(sourceFile),
        line: lineOf(sourceFile, method),
        writes: routeNames.some((name) => WRITE_DECORATORS.has(name)),
        isPublic: [...classDecorators, ...decorators].some(
          (decorator) => decorator.name === 'Public',
        ),
        carriesBoundary: decorators.some(
          (decorator) => decorator.name === 'UseGuards' || AUTHZ_DECORATORS.has(decorator.name),
        ),
        capability: capabilities.length === 0 ? undefined : capabilities.sort().join('|'),
      },
    ];
  });
  return {
    name: classNode.name?.text ?? '<anonymous>',
    hasClassAuthz: classDecorators.some((decorator) => AUTHZ_DECORATORS.has(decorator.name)),
    routes,
  };
}

// The capability a decorator names, by value: quote style and argument order
// do not make two routes differ (a route admits any one of the listed values).
function capabilityValue(decorator: DecoratorUse, sourceFile: ts.SourceFile): string {
  return decorator.args
    .map((arg) => (ts.isStringLiteralLike(arg) ? arg.text : arg.getText(sourceFile)))
    .sort()
    .join(',');
}

function isPeerMajority(count: number, total: number): boolean {
  return count * 4 >= total * 3;
}

function boundaryMissingAmongPeers(path: string, peerClass: PeerClass): AdapterFinding[] {
  const peers = peerClass.routes.filter((route) => route.writes && !route.isPublic);
  const guarded = peers.filter((route) => route.carriesBoundary);
  if (
    peerClass.hasClassAuthz ||
    peers.length < PEER_MIN_WRITE_ROUTES ||
    !isPeerMajority(guarded.length, peers.length)
  ) {
    return [];
  }
  return peers
    .filter((route) => !route.carriesBoundary)
    .map((route) => ({
      id: `authz-boundary-missing-among-peers:${path}:${route.line}`,
      rule: 'authz_boundary_missing_among_peers',
      severity: 'medium',
      path,
      line: route.line,
      message: `Write route ${peerClass.name}.${route.name} has no role, permission, capability or guard decorator, but ${guarded.length} of the ${peers.length} write routes of its class carry one and the class has no class-level role, permission or capability.`,
      evidence: [{ path, line: route.line }],
      details: {
        name: route.name,
        peerWriteRoutes: peers.length,
        peersWithBoundary: guarded.length,
      },
    }));
}

function capabilityDiffersFromMajority(path: string, peerClass: PeerClass): AdapterFinding[] {
  const gated = peerClass.routes.flatMap((route) =>
    route.capability === undefined ? [] : [{ route, capability: route.capability }],
  );
  if (gated.length < PEER_MIN_CAPABILITY_ROUTES) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const { capability } of gated) {
    counts.set(capability, (counts.get(capability) ?? 0) + 1);
  }
  const majority = [...counts].find(([, count]) => isPeerMajority(count, gated.length));
  if (majority === undefined) {
    return [];
  }
  const [majorityCapability, majorityRoutes] = majority;
  return gated
    .filter(({ capability }) => capability !== majorityCapability)
    .map(({ route, capability }) => ({
      id: `capability-differs-from-class-majority:${path}:${route.line}`,
      rule: 'capability_differs_from_class_majority',
      severity: 'medium',
      path,
      line: route.line,
      message: `Route ${peerClass.name}.${route.name} names capability '${capability}', but ${majorityRoutes} of the ${gated.length} capability-gated routes of its class name '${majorityCapability}'.`,
      evidence: [{ path, line: route.line }],
      details: {
        name: route.name,
        capability,
        majorityCapability,
        majorityRoutes,
        capabilityRoutes: gated.length,
      },
    }));
}

function collectServiceGuards(
  units: readonly SourceUnit[],
): ReadonlyMap<string, readonly string[]> {
  const contexts = new Map<string, readonly string[]>();
  for (const unit of units) {
    if (!unit.relativePath.endsWith('/app.module.ts')) {
      continue;
    }
    const guards = new Set<string>();
    visit(unit.sourceFile, (node) => {
      if (
        !ts.isObjectLiteralExpression(node) ||
        !objectHasPropertyText(node, 'provide', 'APP_GUARD')
      ) {
        return;
      }
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const name = property.name.getText(unit.sourceFile);
        if (name !== 'useClass' && name !== 'useFactory' && name !== 'useExisting') {
          continue;
        }
        for (const guard of guardNamesInText(property.initializer.getText(unit.sourceFile))) {
          guards.add(guard);
        }
      }
    });
    const serviceRoot = unit.relativePath.replace(/\/app\.module\.ts$/, '');
    contexts.set(serviceRoot, Array.from(guards).sort());
  }
  return contexts;
}

function objectHasPropertyText(
  node: ts.ObjectLiteralExpression,
  propertyName: string,
  expectedText: string,
): boolean {
  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== propertyName) {
      return false;
    }
    return property.initializer.getText().includes(expectedText);
  });
}

function guardNamesInText(text: string): string[] {
  const matches = text.match(/\b[A-Za-z0-9_]*(?:Guard|AuthGuard)\b/g) ?? [];
  return [...new Set(matches)].filter(
    (name) =>
      /Guard$/.test(name) ||
      [
        'AuthGuard',
        'GqlAuthGuard',
        'JwtAuthGuard',
        'PlatformAdminGuard',
        'ServiceIdentityGuard',
      ].includes(name),
  );
}

function serviceGuardsForUnit(unit: SourceUnit, context: SecurityContext): readonly string[] {
  const candidates = [...context.serviceGuards.entries()]
    .filter(([root]) => unit.relativePath.startsWith(`${root}/`))
    .sort((a, b) => b[0].length - a[0].length);
  return candidates[0]?.[1] ?? [];
}

function analyzeDangerousHtml(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlisted: boolean,
): void {
  if (!unit.relativePath.endsWith('.tsx')) {
    return;
  }

  const fileHasSanitizerCall = hasRuntimeSanitizerCall(unit.sourceFile);
  for (const sink of dangerousHtmlSinks(unit)) {
    const hasSanitizer = sink.hasLocalSanitizer || fileHasSanitizerCall;
    result.observations.push({
      id: `security-sensitive-sink:${unit.relativePath}:${sink.line}:dangerouslySetInnerHTML`,
      type: 'security_sensitive_sink',
      path: unit.relativePath,
      line: sink.line,
      name: 'dangerouslySetInnerHTML',
      details: {
        hasSanitizer,
        hasLocalSanitizer: sink.hasLocalSanitizer,
        fileHasSanitizerCall,
        allowlisted,
      },
    });
    if (!allowlisted && !hasSanitizer) {
      result.findings.push({
        id: `dangerous-html-without-sanitizer:${unit.relativePath}:${sink.line}`,
        rule: 'dangerous_html_without_sanitizer',
        severity: 'high',
        path: unit.relativePath,
        line: sink.line,
        message:
          'dangerouslySetInnerHTML is used without an obvious sanitizer in the sink expression or same file.',
        evidence: [{ path: unit.relativePath, line: sink.line }],
      });
    }
  }
}

function dangerousHtmlSinks(
  unit: SourceUnit,
): Array<{ readonly line: number; readonly hasLocalSanitizer: boolean }> {
  const sinks: Array<{ readonly line: number; readonly hasLocalSanitizer: boolean }> = [];
  visit(unit.sourceFile, (node) => {
    // `JsxAttributeName` is Identifier | JsxNamespacedName since TS 5.1;
    // only the identifier form can be this sink, and `.text` exists only
    // on it — the narrowing is the type fix, not a behavioural change.
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'dangerouslySetInnerHTML'
    ) {
      sinks.push({
        line: lineOf(unit.sourceFile, node),
        hasLocalSanitizer: node.initializer ? hasRuntimeSanitizerCall(node.initializer) : false,
      });
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name, unit.sourceFile) === 'dangerouslySetInnerHTML'
    ) {
      sinks.push({
        line: lineOf(unit.sourceFile, node),
        hasLocalSanitizer: hasRuntimeSanitizerCall(node.initializer),
      });
    }
  });
  return sinks;
}

function hasRuntimeSanitizerCall(node: ts.Node): boolean {
  let found = false;
  visit(node, (child) => {
    if (found || !ts.isCallExpression(child)) {
      return;
    }
    const expression = child.expression;
    if (ts.isIdentifier(expression) && ['sanitizeHtml', 'sanitize'].includes(expression.text)) {
      found = true;
      return;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'sanitize' &&
      expression.expression.getText().endsWith('DOMPurify')
    ) {
      found = true;
    }
  });
  return found;
}

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function analyzeRawSecurityImports(
  unit: SourceUnit,
  result: AnalysisResult,
  allowlisted: boolean,
): void {
  visit(unit.sourceFile, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }
    const moduleName = node.moduleSpecifier.text;
    if (moduleName !== '@anthropic-ai/sdk') {
      return;
    }
    const line = lineOf(unit.sourceFile, node);
    const builtInAllowlisted = SAFE_RAW_IMPORT_ALLOWLIST.includes(unit.relativePath);
    result.observations.push({
      id: `security-sensitive-import:${unit.relativePath}:${line}:${moduleName}`,
      type: 'security_sensitive_sink',
      path: unit.relativePath,
      line,
      name: moduleName,
      details: { allowlisted: allowlisted || builtInAllowlisted },
    });
    if (!allowlisted && !builtInAllowlisted) {
      result.findings.push({
        id: `raw-security-sensitive-import:${unit.relativePath}:${line}`,
        rule: 'raw_security_sensitive_import',
        severity: 'high',
        path: unit.relativePath,
        line,
        message:
          'Raw security-sensitive SDK import should go through the approved wrapper or lint-enforced allowlist.',
        evidence: [{ path: unit.relativePath, line }],
        details: { moduleName },
      });
    }
  });
}

function analyzeExistingGates(unit: SourceUnit, result: AnalysisResult): void {
  if (!unit.relativePath.includes('tools/eslint-rules/')) {
    return;
  }
  if (
    /no-(direct-event-publish|claude-sdk-raw-call|bare-graphql-query-string)/.test(
      unit.relativePath,
    )
  ) {
    result.observations.push({
      id: `security-existing-gate:${unit.relativePath}`,
      type: 'security_existing_gate',
      path: unit.relativePath,
      line: 1,
      name: unit.relativePath.split('/').pop(),
    });
  }
}

function decoratorsOf(node: ts.Node): DecoratorUse[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((decorator) => {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    const text = (call ? call.expression : expression).getText();
    return { name: text.split('.').pop() ?? text, args: call ? [...call.arguments] : [] };
  });
}

function decoratorNames(node: ts.Node): string[] {
  return decoratorsOf(node)
    .map((decorator) => decorator.name)
    .sort();
}

function nearestClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function readSourceUnit(path: string, workspaceRoot: string): SourceUnit {
  const text = readWorkspaceFile(workspaceRoot, path);
  return {
    path,
    relativePath: normalizePath(relative(workspaceRoot, path)),
    text,
    sourceFile: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
  };
}

function collectSourceFiles(workspaceRoot: string, root: string): readonly string[] {
  return collectFiles(workspaceRoot, root, {
    extensions: ['.ts', '.tsx'],
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
  process.stdout.write(`${JSON.stringify(analyzeSecurityBoundaries(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
