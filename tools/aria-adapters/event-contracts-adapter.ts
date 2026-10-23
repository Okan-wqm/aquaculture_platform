#!/usr/bin/env ts-node
import { relative } from 'node:path';

import ts from 'typescript';

import {
  EVENT_CONTRACTS_ROOT,
  eventContractFiles,
  eventDefinitionsIn,
  trackedTree,
} from '../gates/event-consumer-index';

import {
  filterFilesBySnapshot,
  normalizeWorkspacePath,
  readWorkspaceFile,
  resolveInsideWorkspace as resolveAdapterPath,
  workspacePathExists,
} from './adapter-fs';
import { createContainedProgram } from './adapter-ts';

type CheckName = 'base_event' | 'event_interfaces' | 'schema_catalogs' | 'validator_dispatch';
type FindingRule =
  | 'event_id_brand_missing'
  | 'base_event_field_missing'
  | 'create_base_event_missing'
  | 'schema_catalog_empty'
  | 'schema_catalog_not_wired_to_validator';

interface AdapterInput {
  readonly root?: string;
  readonly checks?: readonly CheckName[];
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

interface MemoryCandidate {
  readonly belief_id: string;
  readonly claim: string;
  readonly confidence: number;
  readonly evidence_refs: readonly string[];
  readonly source_tool_id: string;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly line?: number;
  readonly name?: string;
  readonly eventType?: string;
  readonly eventCount?: number;
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

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly MemoryCandidate[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface AnalysisResult {
  readonly observations: AdapterObservation[];
  readonly findings: AdapterFinding[];
  readonly readPaths: string[];
}

interface SourceUnit {
  readonly path: string;
  readonly relativePath: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

interface AnalysisContext {
  readonly checker: ts.TypeChecker;
}

const DEFAULT_CHECKS: readonly CheckName[] = [
  'base_event',
  'event_interfaces',
  'schema_catalogs',
  'validator_dispatch',
];
const REQUIRED_BASE_EVENT_FIELDS = ['eventId', 'eventType', 'timestamp', 'tenantId', 'version'];

/**
 * The requested scan root lies outside EVENT_CONTRACTS_ROOT. The adapter's files are the event
 * contract files (`eventContractFiles`), so such a root would select nothing and pass empty; it is
 * refused by name instead.
 */
export class ScanRootOutsideEventContracts extends Error {
  constructor(requestedRoot: string) {
    super(
      `scan root ${requestedRoot} is outside ${EVENT_CONTRACTS_ROOT}, the event contracts tree`,
    );
    this.name = 'ScanRootOutsideEventContracts';
  }
}

export function analyzeEventContracts(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const requestedRoot = input.root ?? EVENT_CONTRACTS_ROOT;
  const checks = new Set(input.checks ?? DEFAULT_CHECKS);
  const scanRoot = resolveInsideWorkspace(workspaceRoot, requestedRoot);
  const scanPath = normalizePath(relative(workspaceRoot, scanRoot));
  if (scanPath !== EVENT_CONTRACTS_ROOT && !scanPath.startsWith(`${EVENT_CONTRACTS_ROOT}/`)) {
    throw new ScanRootOutsideEventContracts(requestedRoot);
  }
  if (!workspacePathExists(workspaceRoot, scanRoot)) {
    throw new Error(`scan root does not exist: ${requestedRoot}`);
  }

  // One view and one file selection (SE-3-R2 appellate RC and R2-A): the files
  // are `eventContractFiles` of the workspace's tracked content, the selection
  // the code-fact scan's `event_definitions` and `scanEventDefinitions` read, so
  // the one definition rule (`eventDefinitionsIn`) answers over one file set for
  // all three. The scan root and the snapshot only narrow that selection. Every
  // module the files import is read through the same tracked view: an untracked
  // contract on disk is no observation, and an `eventType` whose type comes from
  // an ignored module resolves to nothing. In the adapter room the workspace
  // already shows only tracked content, so there the view changes nothing.
  const tracked = trackedTree(workspaceRoot);
  const files = filterFilesBySnapshot(
    eventContractFiles(tracked).filter((file) => {
      const path = normalizePath(relative(tracked.root, file));
      return path === scanPath || path.startsWith(`${scanPath}/`);
    }),
    workspaceRoot,
    input,
  );
  // ARIA-LOW-593 — the program is built on the one host builder, so a
  // heritage alias that resolves only through a symlinked module resolves to
  // nothing: tracked workspace content alone must establish the inheritance.
  const program = createContainedProgram({ kind: 'tracked', tree: tracked }, files);
  const units = files.map((file) => readSourceUnit(file, workspaceRoot, program));
  const context: AnalysisContext = { checker: program.getTypeChecker() };
  const result: AnalysisResult = {
    observations: [],
    findings: [],
    readPaths: units.map((unit) => unit.relativePath),
  };

  if (checks.has('base_event')) {
    analyzeBaseEvent(units, result);
  }
  if (checks.has('event_interfaces')) {
    analyzeEventInterfaces(units, result, context);
  }
  if (checks.has('schema_catalogs')) {
    analyzeSchemaCatalogs(units, result);
  }
  if (checks.has('validator_dispatch')) {
    analyzeValidatorDispatch(units, result);
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
        belief_id: 'event-contracts:runtime-schema-validation-surface',
        claim:
          'event-contracts exposes branded base events and runtime JSON Schema validator catalogs for event-boundary checks',
        confidence: 0.85,
        evidence_refs: [
          'libs/event-contracts/src/base-event.ts',
          'libs/event-contracts/src/schemas/*.schema.ts',
          'libs/event-contracts/src/schemas/validator.ts',
        ],
        source_tool_id: 'event-contracts-adapter',
      },
    ],
    cost_units: Array.from(new Set(result.readPaths)).length,
    metadata: {
      adapter: 'event-contracts-adapter',
      root: normalizePath(relative(workspaceRoot, scanRoot)),
      checks: Array.from(checks).sort(),
      files_scanned: files.length,
      findings_count: result.findings.length,
    },
  };
}

function analyzeBaseEvent(units: readonly SourceUnit[], result: AnalysisResult): void {
  const unit = units.find(
    (item) =>
      item.relativePath.endsWith('/base-event.ts') ||
      item.relativePath === 'libs/event-contracts/src/base-event.ts',
  );
  if (!unit) {
    return;
  }
  const eventId = findTypeAlias(unit, 'EventId');
  const baseEvent = findInterface(unit, 'BaseEvent');
  const createBaseEvent = findFunction(unit, 'createBaseEvent');

  result.observations.push({
    id: `event-contract-base:${unit.relativePath}`,
    type: 'event_contract_base',
    path: unit.relativePath,
    line: baseEvent ? lineOf(unit.sourceFile, baseEvent) : 1,
    details: {
      hasEventIdBrand: Boolean(eventId && unit.text.includes('unique symbol')),
      hasCreateBaseEvent: Boolean(createBaseEvent),
    },
  });

  if (!eventId || !unit.text.includes('unique symbol')) {
    result.findings.push({
      id: `event-contracts:${unit.relativePath}:event-id-brand-missing`,
      rule: 'event_id_brand_missing',
      severity: 'high',
      path: unit.relativePath,
      line: eventId ? lineOf(unit.sourceFile, eventId) : 1,
      message:
        'EventId should be a branded type so inline event construction cannot assign plain strings.',
      evidence: [{ path: unit.relativePath, line: eventId ? lineOf(unit.sourceFile, eventId) : 1 }],
    });
  }

  if (!createBaseEvent) {
    result.findings.push({
      id: `event-contracts:${unit.relativePath}:create-base-event-missing`,
      rule: 'create_base_event_missing',
      severity: 'high',
      path: unit.relativePath,
      line: 1,
      message:
        'Event contracts should expose createBaseEvent so eventId, timestamp, tenantId, and version are minted consistently.',
      evidence: [{ path: unit.relativePath, line: 1 }],
    });
  }

  if (!baseEvent) {
    return;
  }
  const properties = interfaceProperties(baseEvent);
  for (const required of REQUIRED_BASE_EVENT_FIELDS) {
    if (!properties.has(required)) {
      result.findings.push({
        id: `event-contracts:${unit.relativePath}:base-event-field:${required}`,
        rule: 'base_event_field_missing',
        severity: 'high',
        path: unit.relativePath,
        line: lineOf(unit.sourceFile, baseEvent),
        message: `BaseEvent is missing required field ${required}.`,
        evidence: [{ path: unit.relativePath, line: lineOf(unit.sourceFile, baseEvent) }],
        details: { field: required },
      });
    }
  }
}

/**
 * One `event_interface` observation per event contract interface and defined event type, by the
 * one definition rule (`eventDefinitionsIn`, tools/gates/event-consumer-index.ts), which the
 * code-fact entry's `event_definitions` reads too: an interface extending BaseEvent, directly or
 * through other interfaces, with the literal values of its own `eventType`. A base interface with
 * no literal `eventType` is observed without one; an interface defining several types (a union)
 * gives one observation per type.
 */
function analyzeEventInterfaces(
  units: readonly SourceUnit[],
  result: AnalysisResult,
  context: AnalysisContext,
): void {
  for (const unit of units) {
    for (const definition of eventDefinitionsIn(unit.sourceFile, context.checker)) {
      const id = `event-interface:${unit.relativePath}:${definition.declaration}`;
      const observed = {
        type: 'event_interface',
        path: unit.relativePath,
        line: definition.line,
        name: definition.declaration,
      };
      if (definition.eventTypes.length <= 1) {
        result.observations.push({ id, ...observed, eventType: definition.eventTypes[0] });
        continue;
      }
      for (const eventType of definition.eventTypes) {
        result.observations.push({ id: `${id}:${eventType}`, ...observed, eventType });
      }
    }
  }
}

function analyzeSchemaCatalogs(units: readonly SourceUnit[], result: AnalysisResult): void {
  for (const unit of units) {
    if (!unit.relativePath.includes('/schemas/') || !unit.relativePath.endsWith('.schema.ts')) {
      continue;
    }
    visit(unit.sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
        return;
      }
      const name = node.name.text;
      if (!name.endsWith('_EVENT_SCHEMAS')) {
        return;
      }
      const eventCount = countObjectLiteralProperties(node.initializer);
      result.observations.push({
        id: `event-schema-catalog:${unit.relativePath}:${name}`,
        type: 'event_schema_catalog',
        path: unit.relativePath,
        line: lineOf(unit.sourceFile, node),
        name,
        eventCount,
      });
      if (eventCount === 0) {
        result.findings.push({
          id: `event-contracts:${unit.relativePath}:schema-catalog-empty:${name}`,
          rule: 'schema_catalog_empty',
          severity: 'high',
          path: unit.relativePath,
          line: lineOf(unit.sourceFile, node),
          message: `Schema catalog ${name} is empty; runtime event validation would silently cover no event types.`,
          evidence: [{ path: unit.relativePath, line: lineOf(unit.sourceFile, node) }],
          details: { catalog: name },
        });
      }
    });
  }
}

function analyzeValidatorDispatch(units: readonly SourceUnit[], result: AnalysisResult): void {
  const validator = units.find((unit) => unit.relativePath.endsWith('/schemas/validator.ts'));
  if (!validator) {
    return;
  }
  const schemaCatalogs = result.observations
    .filter((observation) => observation.type === 'event_schema_catalog' && observation.name)
    .map((observation) => String(observation.name));

  const validateFunctions: string[] = [];
  visit(validator.sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith('validate')) {
      validateFunctions.push(node.name.text);
    }
  });
  result.observations.push({
    id: `event-validator-dispatch:${validator.relativePath}`,
    type: 'event_validator_dispatch',
    path: validator.relativePath,
    line: 1,
    details: {
      validateFunctions: validateFunctions.sort(),
      schemaCatalogs: schemaCatalogs.sort(),
      importedCatalogs: schemaCatalogs
        .filter((catalog) => validatorCatalogLocalName(validator.sourceFile, catalog) !== null)
        .sort(),
      runtimeReferencedCatalogs: schemaCatalogs
        .filter((catalog) => {
          const localName = validatorCatalogLocalName(validator.sourceFile, catalog) ?? catalog;
          return hasRuntimeIdentifierReference(validator.sourceFile, localName);
        })
        .sort(),
    },
  });

  for (const catalog of schemaCatalogs) {
    const localName = validatorCatalogLocalName(validator.sourceFile, catalog);
    const referenceName = localName ?? catalog;
    const runtimeReferenced = hasRuntimeIdentifierReference(validator.sourceFile, referenceName);
    const catalogObservation = result.observations.find(
      (observation) => observation.type === 'event_schema_catalog' && observation.name === catalog,
    );
    if (catalogObservation) {
      (catalogObservation as { details?: Record<string, unknown> }).details = {
        ...catalogObservation.details,
        importedByValidator: localName !== null,
        runtimeReferencedByValidator: runtimeReferenced,
        validatorReferenceName: referenceName,
      };
    }
    if (!runtimeReferenced) {
      result.findings.push({
        id: `event-contracts:${validator.relativePath}:catalog-not-wired:${catalog}`,
        rule: 'schema_catalog_not_wired_to_validator',
        severity: 'medium',
        path: validator.relativePath,
        line: 1,
        message: `Schema catalog ${catalog} is not referenced by the runtime validator dispatcher.`,
        evidence: [{ path: validator.relativePath, line: 1 }],
        details: {
          catalog,
          importedByValidator: localName !== null,
          runtimeReferencedByValidator: false,
          validatorReferenceName: referenceName,
        },
      });
    }
  }
}

function readSourceUnit(path: string, workspaceRoot: string, program: ts.Program): SourceUnit {
  const text = readWorkspaceFile(workspaceRoot, path);
  return {
    path,
    relativePath: normalizePath(relative(workspaceRoot, path)),
    text,
    sourceFile:
      program.getSourceFile(path) ?? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
  };
}

function findTypeAlias(unit: SourceUnit, name: string): ts.TypeAliasDeclaration | undefined {
  let found: ts.TypeAliasDeclaration | undefined;
  visit(unit.sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
    }
  });
  return found;
}

function findInterface(unit: SourceUnit, name: string): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined;
  visit(unit.sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = node;
    }
  });
  return found;
}

function findFunction(unit: SourceUnit, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  visit(unit.sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
    }
  });
  return found;
}

function interfaceProperties(node: ts.InterfaceDeclaration): ReadonlySet<string> {
  const properties = new Set<string>();
  for (const member of node.members) {
    if (ts.isPropertySignature(member)) {
      properties.add(member.name.getText().replaceAll("'", '').replaceAll('"', ''));
    }
  }
  return properties;
}

function countObjectLiteralProperties(node: ts.Expression | undefined): number {
  const target = unwrapExpression(node);
  if (!target || !ts.isObjectLiteralExpression(target)) {
    return 0;
  }
  return target.properties.filter(
    (property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
  ).length;
}

function unwrapExpression(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  while (current) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return undefined;
}

function validatorCatalogLocalName(sourceFile: ts.SourceFile, catalog: string): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === catalog) {
        return element.name.text;
      }
    }
  }
  return null;
}

function hasRuntimeIdentifierReference(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  visit(sourceFile, (node) => {
    if (found || !ts.isIdentifier(node) || node.text !== name) {
      return;
    }
    if (isRuntimeIdentifier(node)) {
      found = true;
    }
  });
  return found;
}

function isRuntimeIdentifier(node: ts.Identifier): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isImportDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamedImports(parent) ||
      ts.isImportSpecifier(parent)
    ) {
      return false;
    }
    if (
      ts.isTypeNode(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isImportTypeNode(parent)
    ) {
      return false;
    }
    if (ts.isVariableDeclaration(parent) && parent.name === current) {
      return false;
    }
    current = parent;
  }
  return true;
}

function compareById(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function resolveInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  return resolveAdapterPath(workspaceRoot, requestedPath);
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
  process.stdout.write(`${JSON.stringify(analyzeEventContracts(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
