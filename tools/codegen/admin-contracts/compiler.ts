import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import * as ts from 'typescript';

export const ADMIN_HTTP_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ADMIN_HTTP_CONTRACT_SCHEMA_VERSION_V2 = 2 as const;

export type AdminHttpMethodV1 = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';

export interface AdminQueryContractV1 {
  readonly namedKeys: readonly string[];
  readonly wholeObjectDto: string | null;
}

export interface AdminHttpOperationV1 {
  readonly controller: string;
  readonly file: string;
  readonly handler: string;
  readonly method: AdminHttpMethodV1;
  readonly operationId: string;
  readonly path: string;
  readonly query: AdminQueryContractV1 | null;
}

export type AdminHttpContractDiagnosticCodeV1 =
  | 'AMBIGUOUS_ROUTE_OVERLAP'
  | 'CONTROLLER_NOT_FOUND'
  | 'CROSS_CONTROLLER_STATIC_ROUTE_CONFLICT'
  | 'DUPLICATE_NAMED_QUERY_KEY'
  | 'DUPLICATE_ROUTE'
  | 'DYNAMIC_QUERY_KEY'
  | 'MIXED_QUERY_AUTHORITY'
  | 'MULTIPLE_CONTROLLER_DECORATORS'
  | 'MULTIPLE_HTTP_DECORATORS'
  | 'MULTIPLE_QUERY_DECORATORS'
  | 'MULTIPLE_WHOLE_QUERY_AUTHORITIES'
  | 'SOURCE_PARSE_ERROR'
  | 'STATIC_ROUTE_SHADOWED'
  | 'UNSUPPORTED_CONTROLLER_DECLARATION'
  | 'UNSUPPORTED_CONTROLLER_DECORATOR'
  | 'UNSUPPORTED_CONTROLLER_ROUTE_ARGUMENT'
  | 'UNSUPPORTED_HANDLER_DECLARATION'
  | 'UNSUPPORTED_HANDLER_NAME'
  | 'UNSUPPORTED_HANDLER_ROUTE_ARGUMENT'
  | 'UNSUPPORTED_HTTP_DECORATOR'
  | 'UNSUPPORTED_QUERY_DECORATOR'
  | 'UNSUPPORTED_ROUTE_PATTERN';

export interface AdminHttpContractDiagnosticV1 {
  readonly code: AdminHttpContractDiagnosticCodeV1;
  readonly file: string;
  readonly line: number;
  readonly operationId: string;
}

export interface AdminHttpContractManifestV1 {
  readonly schemaVersion: typeof ADMIN_HTTP_CONTRACT_SCHEMA_VERSION;
  readonly operations: readonly AdminHttpOperationV1[];
}

export interface AdminHttpContractCompilationV1 {
  readonly diagnostics: readonly AdminHttpContractDiagnosticV1[];
  readonly manifest: AdminHttpContractManifestV1;
}

export interface AdminControllerSourceV1 {
  readonly contents: string;
  readonly file: string;
}

export type AdminWireShapeV2 =
  | { readonly kind: 'array'; readonly items: AdminWireShapeV2 }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'date-time' }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'number' }
  | {
      readonly additionalProperties: AdminWireShapeV2 | null;
      readonly kind: 'object';
      readonly properties: readonly AdminWirePropertyV2[];
    }
  | { readonly kind: 'string' }
  | { readonly kind: 'union'; readonly variants: readonly AdminWireShapeV2[] };

export interface AdminWirePropertyV2 {
  readonly name: string;
  readonly optional: boolean;
  readonly shape: AdminWireShapeV2;
}

export interface AdminTypeDefinitionV2 {
  readonly shape: AdminWireShapeV2;
  readonly shapeHash: string;
}

export interface AdminTypeReferenceV2 {
  readonly name: string;
  readonly shapeHash: string;
}

export interface AdminNamedValueContractV2 {
  readonly name: string;
  readonly required: boolean;
  readonly type: AdminTypeReferenceV2;
}

export type AdminQueryContractV2 =
  | {
      readonly authority: 'NAMED';
      readonly values: readonly AdminNamedValueContractV2[];
    }
  | {
      readonly authority: 'OBJECT';
      readonly type: AdminTypeReferenceV2;
    };

export interface AdminBodyContractV2 {
  readonly required: boolean;
  readonly type: AdminTypeReferenceV2;
}

export interface AdminAuthContractV2 {
  readonly guards: readonly string[];
  readonly mode: 'BEARER_JWT' | 'PUBLIC';
  readonly roles: readonly string[];
}

export type AdminResponseContractV2 =
  | { readonly kind: 'NO_CONTENT' }
  | { readonly kind: 'JSON'; readonly type: AdminTypeReferenceV2 };

export interface AdminHttpOperationV2 {
  readonly auth: AdminAuthContractV2;
  readonly body: AdminBodyContractV2 | null;
  readonly contractHash: string;
  readonly controller: string;
  readonly file: string;
  readonly handler: string;
  readonly method: AdminHttpMethodV1;
  readonly operationId: string;
  readonly parameters: readonly AdminNamedValueContractV2[];
  readonly path: string;
  readonly query: AdminQueryContractV2 | null;
  readonly response: AdminResponseContractV2;
}

export type AdminHttpContractDiagnosticCodeV2 =
  | AdminHttpContractDiagnosticCodeV1
  | 'ANONYMOUS_BODY_TYPE'
  | 'ANONYMOUS_RESPONSE_TYPE'
  | 'DUPLICATE_BODY_AUTHORITY'
  | 'DUPLICATE_PATH_PARAMETER'
  | 'DYNAMIC_AUTH_ROLE'
  | 'DYNAMIC_BODY_KEY'
  | 'DYNAMIC_PATH_PARAMETER'
  | 'ENTITY_BODY_TYPE'
  | 'ENTITY_RESPONSE_TYPE'
  | 'EXTRANEOUS_PATH_PARAMETER'
  | 'MANUAL_RESPONSE_UNSUPPORTED'
  | 'MISSING_BODY_TYPE'
  | 'MISSING_PATH_PARAMETER'
  | 'MISSING_RESPONSE_TYPE'
  | 'MULTIPLE_ROLES_DECORATORS'
  | 'OPTIONAL_PATH_PARAMETER'
  | 'UNRESOLVED_BODY_TYPE'
  | 'UNRESOLVED_AUTH_GUARD'
  | 'UNRESOLVED_OPERATION_DECLARATION'
  | 'UNRESOLVED_PARAMETER_TYPE'
  | 'UNRESOLVED_RESPONSE_TYPE'
  | 'UNSUPPORTED_BODY_DECORATOR'
  | 'UNSUPPORTED_PATH_PARAMETER_DECORATOR'
  | 'UNTRUSTED_AUTH_DECORATOR';

export interface AdminHttpContractDiagnosticV2 {
  readonly code: AdminHttpContractDiagnosticCodeV2;
  readonly file: string;
  readonly line: number;
  readonly operationId: string;
}

export interface AdminHttpContractManifestV2 {
  readonly operations: readonly AdminHttpOperationV2[];
  readonly schemaVersion: typeof ADMIN_HTTP_CONTRACT_SCHEMA_VERSION_V2;
  readonly types: readonly AdminTypeDefinitionV2[];
}

export interface AdminHttpContractCoverageV2 {
  readonly diagnosticCount: number;
  readonly discoveredOperationCount: number;
  readonly qualifiedOperationCount: number;
  readonly unqualifiedOperationCount: number;
}

export interface AdminHttpContractCompilationV2 {
  readonly controllerSourceSha256: string;
  readonly coverage: AdminHttpContractCoverageV2;
  readonly diagnostics: readonly AdminHttpContractDiagnosticV2[];
  readonly manifest: AdminHttpContractManifestV2;
}

const HTTP_DECORATORS = {
  Delete: 'DELETE',
  Get: 'GET',
  Head: 'HEAD',
  Options: 'OPTIONS',
  Patch: 'PATCH',
  Post: 'POST',
  Put: 'PUT',
} as const satisfies Readonly<Record<string, AdminHttpMethodV1>>;

type HttpDecoratorName = keyof typeof HTTP_DECORATORS;

const UNSUPPORTED_NEST_ROUTE_DECORATORS: ReadonlySet<string> = new Set([
  'All',
  'Copy',
  'Lock',
  'Mkcol',
  'Move',
  'Propfind',
  'Proppatch',
  'RequestMapping',
  'Search',
  'Sse',
  'Unlock',
]);

interface NestDecoratorBindings {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
}

interface NestDecoratorUse {
  readonly call: ts.CallExpression | null;
  readonly canonicalName: string;
  readonly decorator: ts.Decorator;
}

interface LocatedAdminHttpOperation {
  readonly controllerKey: string;
  readonly declarationOrder: number;
  readonly line: number;
  readonly operation: AdminHttpOperationV1;
}

interface SourceAnalysis {
  readonly diagnostics: readonly AdminHttpContractDiagnosticV1[];
  readonly locatedOperations: readonly LocatedAdminHttpOperation[];
}

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
}

function nestDecoratorBindings(source: ts.SourceFile): NestDecoratorBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@nestjs/common' ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.add(statement.importClause.namedBindings.name.text);
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      named.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { named, namespaces };
}

function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function canonicalNestDecoratorName(
  expression: ts.LeftHandSideExpression,
  bindings: NestDecoratorBindings,
): string | null {
  if (ts.isIdentifier(expression)) {
    return bindings.named.get(expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text)
  ) {
    return expression.name.text;
  }
  return null;
}

function nestDecoratorUses(
  node: ts.Node,
  bindings: NestDecoratorBindings,
): readonly NestDecoratorUse[] {
  const uses: NestDecoratorUse[] = [];
  for (const decorator of decorators(node)) {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : null;
    const target = call?.expression ?? expression;
    const canonicalName = canonicalNestDecoratorName(target, bindings);
    if (canonicalName) uses.push({ call, canonicalName, decorator });
  }
  return uses;
}

function usesNamed(
  node: ts.Node,
  bindings: NestDecoratorBindings,
  canonicalName: string,
): readonly NestDecoratorUse[] {
  return nestDecoratorUses(node, bindings).filter((use) => use.canonicalName === canonicalName);
}

function isHttpDecoratorUse(
  use: NestDecoratorUse,
): use is NestDecoratorUse & { readonly canonicalName: HttpDecoratorName } {
  return use.canonicalName in HTTP_DECORATORS;
}

function isNestRouteDecoratorUse(use: NestDecoratorUse): boolean {
  return isHttpDecoratorUse(use) || UNSUPPORTED_NEST_ROUTE_DECORATORS.has(use.canonicalName);
}

function onlyValue<T>(values: readonly T[]): T | null {
  if (values.length !== 1) return null;
  const [value] = values;
  return value ?? null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === kind)
  );
}

function isConcreteInstanceHandler(member: ts.MethodDeclaration): boolean {
  return (
    member.body !== undefined &&
    !hasModifier(member, ts.SyntaxKind.AbstractKeyword) &&
    !hasModifier(member, ts.SyntaxKind.DeclareKeyword) &&
    !hasModifier(member, ts.SyntaxKind.StaticKeyword)
  );
}

function literalRouteArgument(call: ts.CallExpression): string | null {
  if (call.arguments.length === 0) return '';
  if (call.arguments.length !== 1) return null;
  const [argument] = call.arguments;
  if (!argument) return null;
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
    ? argument.text
    : null;
}

function operationPath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((value) => value.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}`;
}

function routeSegments(path: string): readonly string[] {
  return path.split('/').filter(Boolean);
}

function isParameterSegment(segment: string): boolean {
  return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment);
}

function isSupportedRoutePattern(path: string): boolean {
  return routeSegments(path).every(
    (segment) =>
      (!segment.startsWith(':') && !/[?*+()[\]{}]/.test(segment)) || isParameterSegment(segment),
  );
}

function hasDynamicSegment(path: string): boolean {
  return routeSegments(path).some(isParameterSegment);
}

function routePatternKey(path: string): string {
  return routeSegments(path)
    .map((segment) => (isParameterSegment(segment) ? ':' : segment))
    .join('/');
}

function routePatternsOverlap(leftPath: string, rightPath: string): boolean {
  const leftSegments = routeSegments(leftPath);
  const rightSegments = routeSegments(rightPath);
  return (
    leftSegments.length === rightSegments.length &&
    leftSegments.every(
      (segment, index) =>
        isParameterSegment(segment) ||
        isParameterSegment(rightSegments[index] ?? '') ||
        segment === rightSegments[index],
    )
  );
}

function preferredRouteAtFirstDifference(
  leftPath: string,
  rightPath: string,
): 'left' | 'right' | null {
  const leftSegments = routeSegments(leftPath);
  const rightSegments = routeSegments(rightPath);
  for (const [index, leftSegment] of leftSegments.entries()) {
    const rightSegment = rightSegments[index];
    if (rightSegment === undefined || leftSegment === rightSegment) continue;
    const leftIsParameter = isParameterSegment(leftSegment);
    const rightIsParameter = isParameterSegment(rightSegment);
    if (leftIsParameter === rightIsParameter) continue;
    return leftIsParameter ? 'right' : 'left';
  }
  return null;
}

function displayPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function lineOfPosition(source: ts.SourceFile, position: number | undefined): number {
  return source.getLineAndCharacterOfPosition(position ?? 0).line + 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: AdminHttpContractDiagnosticV1,
  right: AdminHttpContractDiagnosticV1,
): number {
  return (
    compareText(left.file, right.file) ||
    left.line - right.line ||
    compareText(left.code, right.code) ||
    compareText(left.operationId, right.operationId)
  );
}

function compareOperations(left: AdminHttpOperationV1, right: AdminHttpOperationV1): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.method, right.method) ||
    compareText(left.operationId, right.operationId) ||
    compareText(left.file, right.file)
  );
}

function compareLocatedOperations(
  left: LocatedAdminHttpOperation,
  right: LocatedAdminHttpOperation,
): number {
  return (
    compareText(left.operation.file, right.operation.file) ||
    left.line - right.line ||
    compareText(left.operation.operationId, right.operation.operationId)
  );
}

function uniqueDiagnostics(
  diagnostics: readonly AdminHttpContractDiagnosticV1[],
): AdminHttpContractDiagnosticV1[] {
  const unique = new Map<string, AdminHttpContractDiagnosticV1>();
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.code, diagnostic.file, diagnostic.line, diagnostic.operationId].join(
      '\u0000',
    );
    unique.set(key, diagnostic);
  }
  return [...unique.values()].sort(compareDiagnostics);
}

function hasParseDiagnostics(source: ts.SourceFile): source is SourceFileWithParseDiagnostics {
  return 'parseDiagnostics' in source && Array.isArray(source.parseDiagnostics);
}

function sourceParseDiagnostics(source: ts.SourceFile): readonly ts.Diagnostic[] {
  return hasParseDiagnostics(source) ? source.parseDiagnostics : [];
}

function classLikeDeclarations(
  source: ts.SourceFile,
): readonly (ts.ClassDeclaration | ts.ClassExpression)[] {
  const declarations: (ts.ClassDeclaration | ts.ClassExpression)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

function routeRelationshipDiagnostics(
  locatedOperations: readonly LocatedAdminHttpOperation[],
): readonly AdminHttpContractDiagnosticV1[] {
  const diagnostics: AdminHttpContractDiagnosticV1[] = [];
  const ordered = [...locatedOperations].sort(compareLocatedOperations);

  for (const [leftIndex, left] of ordered.entries()) {
    for (const right of ordered.slice(leftIndex + 1)) {
      if (left.operation.method !== right.operation.method) continue;

      const sameController = left.controllerKey === right.controllerKey;
      if (routePatternKey(left.operation.path) === routePatternKey(right.operation.path)) {
        diagnostics.push({
          code: 'DUPLICATE_ROUTE',
          file: right.operation.file,
          line: right.line,
          operationId: right.operation.operationId,
        });
        continue;
      }

      const leftIsDynamic = hasDynamicSegment(left.operation.path);
      const rightIsDynamic = hasDynamicSegment(right.operation.path);
      if (!routePatternsOverlap(left.operation.path, right.operation.path)) continue;
      if (!sameController) {
        diagnostics.push({
          code:
            leftIsDynamic && rightIsDynamic
              ? 'AMBIGUOUS_ROUTE_OVERLAP'
              : 'CROSS_CONTROLLER_STATIC_ROUTE_CONFLICT',
          file: right.operation.file,
          line: right.line,
          operationId: right.operation.operationId,
        });
        continue;
      }

      const preferred = preferredRouteAtFirstDifference(left.operation.path, right.operation.path);
      const preferredOperation = preferred === 'left' ? left : preferred === 'right' ? right : null;
      const otherOperation = preferred === 'left' ? right : left;
      if (
        preferredOperation &&
        otherOperation.declarationOrder < preferredOperation.declarationOrder
      ) {
        diagnostics.push({
          code: 'STATIC_ROUTE_SHADOWED',
          file: preferredOperation.operation.file,
          line: preferredOperation.line,
          operationId: preferredOperation.operation.operationId,
        });
      }
    }
  }

  return uniqueDiagnostics(diagnostics);
}

function analyzeAdminControllerSourceInternal(file: string, contents: string): SourceAnalysis {
  const source = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = nestDecoratorBindings(source);
  const diagnostics: AdminHttpContractDiagnosticV1[] = sourceParseDiagnostics(source).map(
    (diagnostic) => ({
      code: 'SOURCE_PARSE_ERROR',
      file,
      line: lineOfPosition(source, diagnostic.start),
      operationId: '<source>',
    }),
  );
  const locatedOperations: LocatedAdminHttpOperation[] = [];
  let controllerCount = 0;

  for (const declaration of classLikeDeclarations(source)) {
    const controllerUses = usesNamed(declaration, bindings, 'Controller');
    if (controllerUses.length === 0) continue;
    controllerCount += 1;
    const declarationLine = lineOf(source, declaration);
    if (
      !ts.isClassDeclaration(declaration) ||
      declaration.parent !== source ||
      !declaration.name ||
      hasModifier(declaration, ts.SyntaxKind.AbstractKeyword) ||
      hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)
    ) {
      diagnostics.push({
        code: 'UNSUPPORTED_CONTROLLER_DECLARATION',
        file,
        line: declarationLine,
        operationId: `<controller@${declarationLine}>`,
      });
      continue;
    }

    const controller = declaration.name.text;
    const controllerOperationId = `${controller}.<controller>`;
    if (controllerUses.length > 1) {
      diagnostics.push({
        code: 'MULTIPLE_CONTROLLER_DECORATORS',
        file,
        line: declarationLine,
        operationId: controllerOperationId,
      });
      continue;
    }
    const controllerUse = onlyValue(controllerUses);
    if (!controllerUse?.call) {
      diagnostics.push({
        code: 'UNSUPPORTED_CONTROLLER_DECORATOR',
        file,
        line: declarationLine,
        operationId: controllerOperationId,
      });
      continue;
    }
    const controllerPath = literalRouteArgument(controllerUse.call);
    if (controllerPath === null) {
      diagnostics.push({
        code: 'UNSUPPORTED_CONTROLLER_ROUTE_ARGUMENT',
        file,
        line: declarationLine,
        operationId: controllerOperationId,
      });
      continue;
    }
    if (!isSupportedRoutePattern(controllerPath)) {
      diagnostics.push({
        code: 'UNSUPPORTED_ROUTE_PATTERN',
        file,
        line: declarationLine,
        operationId: controllerOperationId,
      });
      continue;
    }

    const controllerKey = `${file}:${declaration.pos}`;
    for (const [declarationOrder, member] of declaration.members.entries()) {
      const routeUses = nestDecoratorUses(member, bindings).filter(isNestRouteDecoratorUse);
      if (routeUses.length === 0) continue;
      const memberLine = lineOf(source, member);
      const fallbackOperationId = `${controller}.<handler@${memberLine}>`;
      if (!ts.isMethodDeclaration(member) || !isConcreteInstanceHandler(member)) {
        diagnostics.push({
          code: 'UNSUPPORTED_HANDLER_DECLARATION',
          file,
          line: memberLine,
          operationId: fallbackOperationId,
        });
        continue;
      }
      if (!ts.isIdentifier(member.name)) {
        diagnostics.push({
          code: 'UNSUPPORTED_HANDLER_NAME',
          file,
          line: memberLine,
          operationId: fallbackOperationId,
        });
        continue;
      }

      const handler = member.name.text;
      const operationId = `${controller}.${handler}`;
      if (routeUses.length > 1) {
        diagnostics.push({
          code: 'MULTIPLE_HTTP_DECORATORS',
          file,
          line: memberLine,
          operationId,
        });
        continue;
      }
      const routeUse = onlyValue(routeUses);
      if (!routeUse?.call || !isHttpDecoratorUse(routeUse)) {
        diagnostics.push({
          code: 'UNSUPPORTED_HTTP_DECORATOR',
          file,
          line: memberLine,
          operationId,
        });
        continue;
      }
      const handlerPath = literalRouteArgument(routeUse.call);
      if (handlerPath === null) {
        diagnostics.push({
          code: 'UNSUPPORTED_HANDLER_ROUTE_ARGUMENT',
          file,
          line: memberLine,
          operationId,
        });
        continue;
      }
      const path = operationPath(controllerPath, handlerPath);
      if (!isSupportedRoutePattern(path)) {
        diagnostics.push({
          code: 'UNSUPPORTED_ROUTE_PATTERN',
          file,
          line: memberLine,
          operationId,
        });
        continue;
      }

      const namedKeys: string[] = [];
      const wholeObjectDtos: string[] = [];
      for (const parameter of member.parameters) {
        const queryUses = usesNamed(parameter, bindings, 'Query');
        if (queryUses.length === 0) continue;
        if (queryUses.length > 1) {
          diagnostics.push({
            code: 'MULTIPLE_QUERY_DECORATORS',
            file,
            line: lineOf(source, parameter),
            operationId,
          });
          continue;
        }
        const queryUse = onlyValue(queryUses);
        if (!queryUse?.call) {
          diagnostics.push({
            code: 'UNSUPPORTED_QUERY_DECORATOR',
            file,
            line: lineOf(source, parameter),
            operationId,
          });
          continue;
        }
        const key = queryUse.call.arguments[0];
        if (!key) {
          wholeObjectDtos.push(parameter.type?.getText(source) ?? 'unknown');
        } else if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
          namedKeys.push(key.text);
        } else {
          diagnostics.push({
            code: 'DYNAMIC_QUERY_KEY',
            file,
            line: lineOf(source, parameter),
            operationId,
          });
        }
      }

      const uniqueNamedKeys = [...new Set(namedKeys)].sort();
      if (uniqueNamedKeys.length !== namedKeys.length) {
        diagnostics.push({
          code: 'DUPLICATE_NAMED_QUERY_KEY',
          file,
          line: memberLine,
          operationId,
        });
      }
      if (namedKeys.length > 0 && wholeObjectDtos.length > 0) {
        diagnostics.push({
          code: 'MIXED_QUERY_AUTHORITY',
          file,
          line: memberLine,
          operationId,
        });
      }
      if (wholeObjectDtos.length > 1) {
        diagnostics.push({
          code: 'MULTIPLE_WHOLE_QUERY_AUTHORITIES',
          file,
          line: memberLine,
          operationId,
        });
      }

      const query =
        namedKeys.length === 0 && wholeObjectDtos.length === 0
          ? null
          : {
              namedKeys: uniqueNamedKeys,
              wholeObjectDto: wholeObjectDtos[0] ?? null,
            };
      locatedOperations.push({
        controllerKey,
        declarationOrder,
        line: memberLine,
        operation: {
          controller,
          file,
          handler,
          method: HTTP_DECORATORS[routeUse.canonicalName],
          operationId,
          path,
          query,
        },
      });
    }
  }

  if (controllerCount === 0) {
    diagnostics.push({
      code: 'CONTROLLER_NOT_FOUND',
      file,
      line: 1,
      operationId: '<source>',
    });
  }

  return { diagnostics: uniqueDiagnostics(diagnostics), locatedOperations };
}

export function compileAdminHttpContractSourcesV1(
  sources: readonly AdminControllerSourceV1[],
): AdminHttpContractCompilationV1 {
  const analyses = sources.map(({ file, contents }) =>
    analyzeAdminControllerSourceInternal(file, contents),
  );
  const diagnostics = analyses.flatMap(({ diagnostics: sourceDiagnostics }) => sourceDiagnostics);
  const locatedOperations = analyses.flatMap(
    ({ locatedOperations: sourceOperations }) => sourceOperations,
  );
  const operations = locatedOperations.map(({ operation }) => operation);
  return {
    diagnostics: uniqueDiagnostics([
      ...diagnostics,
      ...routeRelationshipDiagnostics(locatedOperations),
    ]),
    manifest: {
      schemaVersion: ADMIN_HTTP_CONTRACT_SCHEMA_VERSION,
      operations: operations.sort(compareOperations),
    },
  };
}

export function analyzeAdminControllerSourceV1(
  file: string,
  contents: string,
): AdminHttpContractCompilationV1 {
  return compileAdminHttpContractSourcesV1([{ contents, file }]);
}

function controllerFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.controller.ts')) files.push(path);
    }
  };
  visit(join(root, 'apps/admin-api-service/src'));
  return files.sort();
}

export function compileAdminHttpContractsV1(repoRoot: string): AdminHttpContractCompilationV1 {
  return compileAdminHttpContractSourcesV1(
    controllerFiles(repoRoot).map((absolutePath) => ({
      contents: readFileSync(absolutePath, 'utf8'),
      file: displayPath(relative(repoRoot, absolutePath)),
    })),
  );
}

export function canonicalAdminHttpContractJsonV1(
  compilation: AdminHttpContractCompilationV1,
): string {
  if (compilation.diagnostics.length > 0) {
    throw new Error('Cannot serialize an admin HTTP contract with diagnostics');
  }
  return `${JSON.stringify(compilation.manifest)}\n`;
}

interface TypedAdminOperationDeclarationV2 {
  readonly bindings: NestDecoratorBindings;
  readonly controller: ts.ClassDeclaration;
  readonly member: ts.MethodDeclaration;
  readonly source: ts.SourceFile;
}

interface AdminAuthDecoratorUseV2 {
  readonly call: ts.CallExpression | null;
  readonly decorator: ts.Decorator;
}

interface WireShapeSuccessV2 {
  readonly shape: AdminWireShapeV2;
}

interface WireShapeFailureV2 {
  readonly failure: 'ENTITY' | 'UNRESOLVED';
}

type WireShapeResultV2 = WireShapeFailureV2 | WireShapeSuccessV2;

interface TypeReferenceSuccessV2 {
  readonly reference: AdminTypeReferenceV2;
}

interface TypeReferenceFailureV2 {
  readonly diagnostic: AdminHttpContractDiagnosticV2;
}

type TypeReferenceResultV2 = TypeReferenceFailureV2 | TypeReferenceSuccessV2;

interface OperationContractsV2 {
  readonly auth: AdminAuthContractV2 | null;
  readonly body: AdminBodyContractV2 | null;
  readonly parameters: readonly AdminNamedValueContractV2[] | null;
  readonly query: AdminQueryContractV2 | null;
  readonly response: AdminResponseContractV2 | null;
}

const ADMIN_HTTP_DEFAULT_GUARDS_V2 = ['PlatformAdminGuard'] as const;
const ADMIN_HTTP_DEFAULT_ROLES_V2 = ['SUPER_ADMIN'] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function controllerSourceSha256V2(sources: readonly AdminControllerSourceV1[]): string {
  const canonicalSources = [...sources]
    .sort((left, right) => compareText(left.file, right.file))
    .map(({ contents, file }) => ({ contents, file }));
  return sha256(JSON.stringify(canonicalSources));
}

function canonicalShapeJsonV2(shape: AdminWireShapeV2): string {
  return JSON.stringify(shape);
}

function compareDiagnosticsV2(
  left: AdminHttpContractDiagnosticV2,
  right: AdminHttpContractDiagnosticV2,
): number {
  return (
    compareText(left.file, right.file) ||
    left.line - right.line ||
    compareText(left.code, right.code) ||
    compareText(left.operationId, right.operationId)
  );
}

function uniqueDiagnosticsV2(
  diagnostics: readonly AdminHttpContractDiagnosticV2[],
): AdminHttpContractDiagnosticV2[] {
  const unique = new Map<string, AdminHttpContractDiagnosticV2>();
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.code, diagnostic.file, diagnostic.line, diagnostic.operationId].join(
      '\u0000',
    );
    unique.set(key, diagnostic);
  }
  return [...unique.values()].sort(compareDiagnosticsV2);
}

function compareOperationsV2(left: AdminHttpOperationV2, right: AdminHttpOperationV2): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.method, right.method) ||
    compareText(left.operationId, right.operationId) ||
    compareText(left.file, right.file)
  );
}

function moduleDecoratorBindings(
  source: ts.SourceFile,
  acceptsModule: (moduleName: string) => boolean,
): NestDecoratorBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !acceptsModule(statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.add(statement.importClause.namedBindings.name.text);
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      named.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return { named, namespaces };
}

function decoratorTargetName(expression: ts.Expression): string | null {
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

function canonicalAuthDecoratorNameV2(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): 'Public' | 'Roles' | null {
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  const symbolNode = ts.isPropertyAccessExpression(target) ? target.name : target;
  const unresolvedSymbol = checker.getSymbolAtLocation(symbolNode);
  if (!unresolvedSymbol) return null;
  const symbol =
    (unresolvedSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(unresolvedSymbol)
      : unresolvedSymbol;
  const name = symbol.getName();
  if (name !== 'Public' && name !== 'Roles') return null;
  const expectedFile =
    name === 'Public'
      ? '/apps/admin-api-service/src/decorators/public.decorator.ts'
      : '/apps/admin-api-service/src/decorators/roles.decorator.ts';
  return (symbol.declarations ?? []).some((declaration) =>
    displayPath(resolve(declaration.getSourceFile().fileName)).endsWith(expectedFile),
  )
    ? name
    : null;
}

function authDecoratorUsesV2(
  node: ts.Node,
  checker: ts.TypeChecker,
  canonicalName: 'Public' | 'Roles',
): readonly AdminAuthDecoratorUseV2[] {
  const uses: AdminAuthDecoratorUseV2[] = [];
  for (const decorator of decorators(node)) {
    if (canonicalAuthDecoratorNameV2(decorator.expression, checker) !== canonicalName) continue;
    uses.push({
      call: ts.isCallExpression(decorator.expression) ? decorator.expression : null,
      decorator,
    });
  }
  return uses;
}

function isTypeOrmEntitySymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return false;
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isClassDeclaration(declaration)) continue;
    const bindings = moduleDecoratorBindings(
      declaration.getSourceFile(),
      (moduleName) => moduleName === 'typeorm',
    );
    for (const decorator of decorators(declaration)) {
      const expression = decorator.expression;
      const call = ts.isCallExpression(expression) ? expression : null;
      const target = call?.expression ?? expression;
      if (canonicalNestDecoratorName(target, bindings) === 'Entity') return true;
    }
  }
  return false;
}

function typeIsUnresolvedV2(type: ts.Type): boolean {
  const unresolvedFlags =
    ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter | ts.TypeFlags.Unknown;
  return (type.flags & unresolvedFlags) !== 0;
}

function literalShapeV2(type: ts.Type, checker: ts.TypeChecker, anchor: ts.Node): AdminWireShapeV2 {
  return {
    kind: 'literal',
    value: checker.typeToString(type, anchor, ts.TypeFormatFlags.NoTruncation),
  };
}

function compileWireShapeV2(
  type: ts.Type,
  checker: ts.TypeChecker,
  anchor: ts.Node,
  activeTypes: Set<ts.Type>,
): WireShapeResultV2 {
  if (typeIsUnresolvedV2(type) || (type.flags & ts.TypeFlags.Undefined) !== 0) {
    return { failure: 'UNRESOLVED' };
  }
  if (isTypeOrmEntitySymbol(type.aliasSymbol) || isTypeOrmEntitySymbol(type.getSymbol())) {
    return { failure: 'ENTITY' };
  }
  for (const argument of type.aliasTypeArguments ?? []) {
    const argumentShape = compileWireShapeV2(argument, checker, anchor, activeTypes);
    if ('failure' in argumentShape) return argumentShape;
  }
  if (type.isLiteral() || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return { shape: literalShapeV2(type, checker, anchor) };
  }
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { shape: { kind: 'string' } };
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { shape: { kind: 'number' } };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { shape: { kind: 'boolean' } };
  if ((type.flags & ts.TypeFlags.Null) !== 0) return { shape: { kind: 'null' } };

  if (type.isUnion()) {
    const variants: AdminWireShapeV2[] = [];
    for (const member of type.types) {
      if ((member.flags & ts.TypeFlags.Undefined) !== 0) continue;
      const compiled = compileWireShapeV2(member, checker, anchor, activeTypes);
      if ('failure' in compiled) return compiled;
      variants.push(compiled.shape);
    }
    const uniqueVariants = new Map<string, AdminWireShapeV2>();
    for (const variant of variants) uniqueVariants.set(canonicalShapeJsonV2(variant), variant);
    const sortedVariants = [...uniqueVariants.values()].sort((left, right) =>
      compareText(canonicalShapeJsonV2(left), canonicalShapeJsonV2(right)),
    );
    if (sortedVariants.length === 0) return { failure: 'UNRESOLVED' };
    const onlyVariant = onlyValue(sortedVariants);
    return onlyVariant
      ? { shape: onlyVariant }
      : { shape: { kind: 'union', variants: sortedVariants } };
  }

  const symbolName = type.getSymbol()?.getName();
  if (symbolName === 'Date') return { shape: { kind: 'date-time' } };
  if (activeTypes.has(type)) return { failure: 'UNRESOLVED' };
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const itemType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!itemType) return { failure: 'UNRESOLVED' };
    activeTypes.add(type);
    const item = compileWireShapeV2(itemType, checker, anchor, activeTypes);
    activeTypes.delete(type);
    return 'failure' in item ? item : { shape: { kind: 'array', items: item.shape } };
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return { failure: 'UNRESOLVED' };
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return { failure: 'UNRESOLVED' };
  }

  activeTypes.add(type);
  const properties: AdminWirePropertyV2[] = [];
  for (const property of [...type.getProperties()].sort((left, right) =>
    compareText(left.getName(), right.getName()),
  )) {
    const propertyName = property.getName();
    if (propertyName.startsWith('__@')) {
      activeTypes.delete(type);
      return { failure: 'UNRESOLVED' };
    }
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      property.valueDeclaration ?? anchor,
    );
    const propertyShape = compileWireShapeV2(
      propertyType,
      checker,
      property.valueDeclaration ?? anchor,
      activeTypes,
    );
    if ('failure' in propertyShape) {
      activeTypes.delete(type);
      return propertyShape;
    }
    properties.push({
      name: propertyName,
      optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
      shape: propertyShape.shape,
    });
  }
  const indexedType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const indexedShape = indexedType
    ? compileWireShapeV2(indexedType, checker, anchor, activeTypes)
    : null;
  activeTypes.delete(type);
  if (indexedShape && 'failure' in indexedShape) return indexedShape;
  return {
    shape: {
      additionalProperties: indexedShape?.shape ?? null,
      kind: 'object',
      properties,
    },
  };
}

function unwrapPromiseTypeNodeV2(typeNode: ts.TypeNode): ts.TypeNode {
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === 'Promise' &&
    typeNode.typeArguments?.length === 1
  ) {
    const nested = typeNode.typeArguments[0];
    return nested ? unwrapPromiseTypeNodeV2(nested) : typeNode;
  }
  return typeNode;
}

function containsAnonymousTypeSyntaxV2(typeNode: ts.TypeNode): boolean {
  const node = unwrapPromiseTypeNodeV2(typeNode);
  if (
    ts.isTypeLiteralNode(node) ||
    ts.isMappedTypeNode(node) ||
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node)
  ) {
    return true;
  }
  if (ts.isArrayTypeNode(node)) return containsAnonymousTypeSyntaxV2(node.elementType);
  if (ts.isTupleTypeNode(node)) return node.elements.some(containsAnonymousTypeSyntaxV2);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.some(containsAnonymousTypeSyntaxV2);
  }
  if (ts.isParenthesizedTypeNode(node)) return containsAnonymousTypeSyntaxV2(node.type);
  return ts.isTypeReferenceNode(node)
    ? (node.typeArguments?.some(containsAnonymousTypeSyntaxV2) ?? false)
    : false;
}

function typeReferenceNameV2(type: ts.Type, checker: ts.TypeChecker, anchor: ts.Node): string {
  return checker.typeToString(
    type,
    anchor,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
}

function boundaryTypeReferenceV2(
  role: 'BODY' | 'PARAMETER' | 'RESPONSE',
  file: string,
  typeNode: ts.TypeNode | undefined,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  diagnosticNode: ts.Node,
  operationId: string,
  definitions: Map<string, AdminTypeDefinitionV2>,
): TypeReferenceResultV2 {
  const diagnostic = (code: AdminHttpContractDiagnosticCodeV2): AdminHttpContractDiagnosticV2 => ({
    code,
    file,
    line: lineOf(source, diagnosticNode),
    operationId,
  });
  if (!typeNode) {
    return {
      diagnostic: diagnostic(
        role === 'BODY'
          ? 'MISSING_BODY_TYPE'
          : role === 'RESPONSE'
            ? 'MISSING_RESPONSE_TYPE'
            : 'UNRESOLVED_PARAMETER_TYPE',
      ),
    };
  }
  if (containsAnonymousTypeSyntaxV2(typeNode)) {
    return {
      diagnostic: diagnostic(
        role === 'BODY'
          ? 'ANONYMOUS_BODY_TYPE'
          : role === 'RESPONSE'
            ? 'ANONYMOUS_RESPONSE_TYPE'
            : 'UNRESOLVED_PARAMETER_TYPE',
      ),
    };
  }
  if (!type || typeIsUnresolvedV2(type)) {
    return {
      diagnostic: diagnostic(
        role === 'BODY'
          ? 'UNRESOLVED_BODY_TYPE'
          : role === 'RESPONSE'
            ? 'UNRESOLVED_RESPONSE_TYPE'
            : 'UNRESOLVED_PARAMETER_TYPE',
      ),
    };
  }
  const compiledShape = compileWireShapeV2(type, checker, diagnosticNode, new Set());
  if ('failure' in compiledShape) {
    return {
      diagnostic: diagnostic(
        compiledShape.failure === 'ENTITY' && role === 'BODY'
          ? 'ENTITY_BODY_TYPE'
          : compiledShape.failure === 'ENTITY' && role === 'RESPONSE'
            ? 'ENTITY_RESPONSE_TYPE'
            : role === 'BODY'
              ? 'UNRESOLVED_BODY_TYPE'
              : role === 'RESPONSE'
                ? 'UNRESOLVED_RESPONSE_TYPE'
                : 'UNRESOLVED_PARAMETER_TYPE',
      ),
    };
  }
  const shapeHash = sha256(canonicalShapeJsonV2(compiledShape.shape));
  definitions.set(shapeHash, { shape: compiledShape.shape, shapeHash });
  return {
    reference: {
      name: typeReferenceNameV2(type, checker, diagnosticNode),
      shapeHash,
    },
  };
}

function operationDeclarationMapV2(
  sources: readonly AdminControllerSourceV1[],
  program: ts.Program,
  sourceRoot: string,
): ReadonlyMap<string, TypedAdminOperationDeclarationV2> {
  const declarations = new Map<string, TypedAdminOperationDeclarationV2>();
  for (const input of sources) {
    const absoluteFile = displayPath(resolve(sourceRoot, input.file));
    const source = program.getSourceFile(absoluteFile);
    if (!source) continue;
    const bindings = nestDecoratorBindings(source);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      if (usesNamed(statement, bindings, 'Controller').length === 0) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        if (!nestDecoratorUses(member, bindings).some(isHttpDecoratorUse)) continue;
        const operationId = `${statement.name.text}.${member.name.text}`;
        declarations.set(`${input.file}\u0000${operationId}`, {
          bindings,
          controller: statement,
          member,
          source,
        });
      }
    }
  }
  return declarations;
}

function diagnosticAtV2(
  code: AdminHttpContractDiagnosticCodeV2,
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  operationId: string,
): AdminHttpContractDiagnosticV2 {
  return { code, file, line: lineOf(source, node), operationId };
}

function decoratorArgumentNameV2(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText();
  return null;
}

function compileAuthContractV2(
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  file: string,
  operationId: string,
  diagnostics: AdminHttpContractDiagnosticV2[],
): AdminAuthContractV2 | null {
  const scopes: readonly ts.Node[] = [declaration.controller, declaration.member];
  let isPublic = false;
  let selectedRoles: readonly string[] = ADMIN_HTTP_DEFAULT_ROLES_V2;
  const guards = new Set<string>(ADMIN_HTTP_DEFAULT_GUARDS_V2);

  for (const scope of scopes) {
    const rolesUses = authDecoratorUsesV2(scope, checker, 'Roles');
    if (rolesUses.length > 1) {
      diagnostics.push(
        diagnosticAtV2('MULTIPLE_ROLES_DECORATORS', file, declaration.source, scope, operationId),
      );
    }
    const rolesUse = onlyValue(rolesUses);
    if (rolesUse?.call) {
      const roles: string[] = [];
      for (const argument of rolesUse.call.arguments) {
        if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
          diagnostics.push(
            diagnosticAtV2('DYNAMIC_AUTH_ROLE', file, declaration.source, argument, operationId),
          );
          continue;
        }
        roles.push(argument.text);
      }
      selectedRoles = roles.length > 0 ? [...new Set(roles)].sort() : ADMIN_HTTP_DEFAULT_ROLES_V2;
    }
    if (authDecoratorUsesV2(scope, checker, 'Public').length > 0) {
      isPublic = true;
    }

    for (const decorator of decorators(scope)) {
      const rawName = decoratorTargetName(decorator.expression);
      if (rawName !== 'Public' && rawName !== 'Roles') continue;
      if (canonicalAuthDecoratorNameV2(decorator.expression, checker) !== rawName) {
        diagnostics.push(
          diagnosticAtV2(
            'UNTRUSTED_AUTH_DECORATOR',
            file,
            declaration.source,
            decorator,
            operationId,
          ),
        );
      }
    }

    for (const guardUse of usesNamed(scope, declaration.bindings, 'UseGuards')) {
      if (!guardUse.call) {
        diagnostics.push(
          diagnosticAtV2(
            'UNRESOLVED_AUTH_GUARD',
            file,
            declaration.source,
            guardUse.decorator,
            operationId,
          ),
        );
        continue;
      }
      for (const argument of guardUse.call.arguments) {
        const guardName = decoratorArgumentNameV2(argument);
        if (guardName) guards.add(guardName);
        else {
          diagnostics.push(
            diagnosticAtV2(
              'UNRESOLVED_AUTH_GUARD',
              file,
              declaration.source,
              argument,
              operationId,
            ),
          );
        }
      }
    }
  }

  if (
    diagnostics.some(
      (diagnostic) => diagnostic.file === file && diagnostic.operationId === operationId,
    )
  ) {
    return null;
  }
  return isPublic
    ? { guards: [], mode: 'PUBLIC', roles: [] }
    : { guards: [...guards].sort(), mode: 'BEARER_JWT', roles: selectedRoles };
}

function compilePathParametersV2(
  operation: AdminHttpOperationV1,
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  definitions: Map<string, AdminTypeDefinitionV2>,
  diagnostics: AdminHttpContractDiagnosticV2[],
): readonly AdminNamedValueContractV2[] | null {
  const declaredNames = new Set(
    routeSegments(operation.path)
      .filter(isParameterSegment)
      .map((segment) => segment.slice(1)),
  );
  const parameters: AdminNamedValueContractV2[] = [];
  const seenNames = new Set<string>();
  for (const parameter of declaration.member.parameters) {
    const paramUses = usesNamed(parameter, declaration.bindings, 'Param');
    if (paramUses.length === 0) continue;
    const paramUse = onlyValue(paramUses);
    if (!paramUse?.call || paramUses.length !== 1) {
      diagnostics.push(
        diagnosticAtV2(
          'UNSUPPORTED_PATH_PARAMETER_DECORATOR',
          operation.file,
          declaration.source,
          parameter,
          operation.operationId,
        ),
      );
      continue;
    }
    const argument = paramUse.call.arguments[0];
    if (!argument) {
      diagnostics.push(
        diagnosticAtV2(
          'UNSUPPORTED_PATH_PARAMETER_DECORATOR',
          operation.file,
          declaration.source,
          parameter,
          operation.operationId,
        ),
      );
      continue;
    }
    if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
      diagnostics.push(
        diagnosticAtV2(
          'DYNAMIC_PATH_PARAMETER',
          operation.file,
          declaration.source,
          argument,
          operation.operationId,
        ),
      );
      continue;
    }
    if (seenNames.has(argument.text)) {
      diagnostics.push(
        diagnosticAtV2(
          'DUPLICATE_PATH_PARAMETER',
          operation.file,
          declaration.source,
          parameter,
          operation.operationId,
        ),
      );
      continue;
    }
    seenNames.add(argument.text);
    if (!declaredNames.has(argument.text)) {
      diagnostics.push(
        diagnosticAtV2(
          'EXTRANEOUS_PATH_PARAMETER',
          operation.file,
          declaration.source,
          parameter,
          operation.operationId,
        ),
      );
    }
    if (parameter.questionToken || parameter.initializer) {
      diagnostics.push(
        diagnosticAtV2(
          'OPTIONAL_PATH_PARAMETER',
          operation.file,
          declaration.source,
          parameter,
          operation.operationId,
        ),
      );
    }
    const parameterType = checker.getTypeAtLocation(parameter);
    const reference = boundaryTypeReferenceV2(
      'PARAMETER',
      operation.file,
      parameter.type,
      parameterType,
      checker,
      declaration.source,
      parameter,
      operation.operationId,
      definitions,
    );
    if ('diagnostic' in reference) diagnostics.push(reference.diagnostic);
    else {
      parameters.push({ name: argument.text, required: true, type: reference.reference });
    }
  }
  for (const missingName of [...declaredNames].filter((name) => !seenNames.has(name)).sort()) {
    diagnostics.push(
      diagnosticAtV2(
        'MISSING_PATH_PARAMETER',
        operation.file,
        declaration.source,
        declaration.member,
        operation.operationId,
      ),
    );
    void missingName;
  }
  return diagnostics.some((diagnostic) => diagnostic.operationId === operation.operationId)
    ? null
    : parameters.sort((left, right) => compareText(left.name, right.name));
}

function compileBodyContractV2(
  operation: AdminHttpOperationV1,
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  definitions: Map<string, AdminTypeDefinitionV2>,
  diagnostics: AdminHttpContractDiagnosticV2[],
): AdminBodyContractV2 | null {
  const bodyParameters = declaration.member.parameters.filter(
    (parameter) => usesNamed(parameter, declaration.bindings, 'Body').length > 0,
  );
  if (bodyParameters.length === 0) return null;
  if (bodyParameters.length > 1) {
    diagnostics.push(
      diagnosticAtV2(
        'DUPLICATE_BODY_AUTHORITY',
        operation.file,
        declaration.source,
        declaration.member,
        operation.operationId,
      ),
    );
    return null;
  }
  const parameter = onlyValue(bodyParameters);
  if (!parameter) return null;
  const bodyUses = usesNamed(parameter, declaration.bindings, 'Body');
  const bodyUse = onlyValue(bodyUses);
  if (!bodyUse?.call || bodyUses.length !== 1) {
    diagnostics.push(
      diagnosticAtV2(
        'UNSUPPORTED_BODY_DECORATOR',
        operation.file,
        declaration.source,
        parameter,
        operation.operationId,
      ),
    );
    return null;
  }
  if (bodyUse.call.arguments.length > 0) {
    diagnostics.push(
      diagnosticAtV2(
        bodyUse.call.arguments.every(
          (argument) =>
            ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument),
        )
          ? 'UNSUPPORTED_BODY_DECORATOR'
          : 'DYNAMIC_BODY_KEY',
        operation.file,
        declaration.source,
        parameter,
        operation.operationId,
      ),
    );
    return null;
  }
  const reference = boundaryTypeReferenceV2(
    'BODY',
    operation.file,
    parameter.type,
    checker.getTypeAtLocation(parameter),
    checker,
    declaration.source,
    parameter,
    operation.operationId,
    definitions,
  );
  if ('diagnostic' in reference) {
    diagnostics.push(reference.diagnostic);
    return null;
  }
  return {
    required: !parameter.questionToken && !parameter.initializer,
    type: reference.reference,
  };
}

function compileQueryContractV2(
  operation: AdminHttpOperationV1,
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  definitions: Map<string, AdminTypeDefinitionV2>,
  diagnostics: AdminHttpContractDiagnosticV2[],
): AdminQueryContractV2 | null {
  const namedValues: AdminNamedValueContractV2[] = [];
  const objectParameters: ts.ParameterDeclaration[] = [];
  for (const parameter of declaration.member.parameters) {
    const queryUses = usesNamed(parameter, declaration.bindings, 'Query');
    const queryUse = onlyValue(queryUses);
    if (!queryUse?.call || queryUses.length !== 1) continue;
    const argument = queryUse.call.arguments[0];
    if (!argument) {
      objectParameters.push(parameter);
      continue;
    }
    if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) continue;
    const reference = boundaryTypeReferenceV2(
      'PARAMETER',
      operation.file,
      parameter.type,
      checker.getTypeAtLocation(parameter),
      checker,
      declaration.source,
      parameter,
      operation.operationId,
      definitions,
    );
    if ('diagnostic' in reference) diagnostics.push(reference.diagnostic);
    else {
      namedValues.push({
        name: argument.text,
        required: !parameter.questionToken && !parameter.initializer,
        type: reference.reference,
      });
    }
  }
  if (objectParameters.length === 0 && namedValues.length === 0) return null;
  const objectParameter = onlyValue(objectParameters);
  if (objectParameter) {
    const reference = boundaryTypeReferenceV2(
      'PARAMETER',
      operation.file,
      objectParameter.type,
      checker.getTypeAtLocation(objectParameter),
      checker,
      declaration.source,
      objectParameter,
      operation.operationId,
      definitions,
    );
    if ('diagnostic' in reference) {
      diagnostics.push(reference.diagnostic);
      return null;
    }
    return { authority: 'OBJECT', type: reference.reference };
  }
  return {
    authority: 'NAMED',
    values: namedValues.sort((left, right) => compareText(left.name, right.name)),
  };
}

function compileResponseContractV2(
  operation: AdminHttpOperationV1,
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  definitions: Map<string, AdminTypeDefinitionV2>,
  diagnostics: AdminHttpContractDiagnosticV2[],
): AdminResponseContractV2 | null {
  const hasManualResponse = declaration.member.parameters.some(
    (parameter) => usesNamed(parameter, declaration.bindings, 'Res').length > 0,
  );
  if (hasManualResponse) {
    diagnostics.push(
      diagnosticAtV2(
        'MANUAL_RESPONSE_UNSUPPORTED',
        operation.file,
        declaration.source,
        declaration.member,
        operation.operationId,
      ),
    );
    return null;
  }
  const signature = checker.getSignatureFromDeclaration(declaration.member);
  const declaredType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  const responseType = declaredType
    ? (checker.getAwaitedType(declaredType) ?? declaredType)
    : undefined;
  if (responseType && (responseType.flags & ts.TypeFlags.Void) !== 0) {
    if (!declaration.member.type) {
      diagnostics.push(
        diagnosticAtV2(
          'MISSING_RESPONSE_TYPE',
          operation.file,
          declaration.source,
          declaration.member,
          operation.operationId,
        ),
      );
      return null;
    }
    return { kind: 'NO_CONTENT' };
  }
  const reference = boundaryTypeReferenceV2(
    'RESPONSE',
    operation.file,
    declaration.member.type,
    responseType,
    checker,
    declaration.source,
    declaration.member,
    operation.operationId,
    definitions,
  );
  if ('diagnostic' in reference) {
    diagnostics.push(reference.diagnostic);
    return null;
  }
  return { kind: 'JSON', type: reference.reference };
}

function compileOperationContractsV2(
  operation: AdminHttpOperationV1,
  declaration: TypedAdminOperationDeclarationV2,
  checker: ts.TypeChecker,
  definitions: Map<string, AdminTypeDefinitionV2>,
  diagnostics: AdminHttpContractDiagnosticV2[],
): OperationContractsV2 {
  const auth = compileAuthContractV2(
    declaration,
    checker,
    operation.file,
    operation.operationId,
    diagnostics,
  );
  const parameters = compilePathParametersV2(
    operation,
    declaration,
    checker,
    definitions,
    diagnostics,
  );
  const body = compileBodyContractV2(operation, declaration, checker, definitions, diagnostics);
  const query = compileQueryContractV2(operation, declaration, checker, definitions, diagnostics);
  const response = compileResponseContractV2(
    operation,
    declaration,
    checker,
    definitions,
    diagnostics,
  );
  return { auth, body, parameters, query, response };
}

function operationContractHashV2(
  operation: AdminHttpOperationV1,
  contracts: {
    readonly auth: AdminAuthContractV2;
    readonly body: AdminBodyContractV2 | null;
    readonly parameters: readonly AdminNamedValueContractV2[];
    readonly query: AdminQueryContractV2 | null;
    readonly response: AdminResponseContractV2;
  },
): string {
  return sha256(
    JSON.stringify({
      auth: contracts.auth,
      body: contracts.body,
      controller: operation.controller,
      file: operation.file,
      handler: operation.handler,
      method: operation.method,
      operationId: operation.operationId,
      parameters: contracts.parameters,
      path: operation.path,
      query: contracts.query,
      response: contracts.response,
    }),
  );
}

function referencedTypeShapeHashesV2(
  operations: readonly AdminHttpOperationV2[],
): ReadonlySet<string> {
  const hashes = new Set<string>();
  for (const operation of operations) {
    if (operation.body) hashes.add(operation.body.type.shapeHash);
    for (const parameter of operation.parameters) hashes.add(parameter.type.shapeHash);
    if (operation.query?.authority === 'NAMED') {
      for (const value of operation.query.values) hashes.add(value.type.shapeHash);
    } else if (operation.query) {
      hashes.add(operation.query.type.shapeHash);
    }
    if (operation.response.kind === 'JSON') hashes.add(operation.response.type.shapeHash);
  }
  return hashes;
}

function compileAdminHttpContractSourcesWithProgramV2(
  sources: readonly AdminControllerSourceV1[],
  program: ts.Program,
  sourceRoot: string,
): AdminHttpContractCompilationV2 {
  const controllerSources = sources.filter((source) => source.file.endsWith('.controller.ts'));
  const syntaxCompilation = compileAdminHttpContractSourcesV1(controllerSources);
  const diagnostics: AdminHttpContractDiagnosticV2[] = [...syntaxCompilation.diagnostics];
  const definitions = new Map<string, AdminTypeDefinitionV2>();
  const declarations = operationDeclarationMapV2(controllerSources, program, sourceRoot);
  const checker = program.getTypeChecker();
  const operations: AdminHttpOperationV2[] = [];

  for (const operation of syntaxCompilation.manifest.operations) {
    const declaration = declarations.get(`${operation.file}\u0000${operation.operationId}`);
    if (!declaration) {
      diagnostics.push({
        code: 'UNRESOLVED_OPERATION_DECLARATION',
        file: operation.file,
        line: 1,
        operationId: operation.operationId,
      });
      continue;
    }
    const operationDiagnosticCount = diagnostics.filter(
      (diagnostic) =>
        diagnostic.file === operation.file && diagnostic.operationId === operation.operationId,
    ).length;
    const contracts = compileOperationContractsV2(
      operation,
      declaration,
      checker,
      definitions,
      diagnostics,
    );
    const hasNewDiagnostic =
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.file === operation.file && diagnostic.operationId === operation.operationId,
      ).length > operationDiagnosticCount;
    if (hasNewDiagnostic || !contracts.auth || !contracts.parameters || !contracts.response) {
      continue;
    }
    const contractHash = operationContractHashV2(operation, {
      auth: contracts.auth,
      body: contracts.body,
      parameters: contracts.parameters,
      query: contracts.query,
      response: contracts.response,
    });
    operations.push({
      auth: contracts.auth,
      body: contracts.body,
      contractHash,
      controller: operation.controller,
      file: operation.file,
      handler: operation.handler,
      method: operation.method,
      operationId: operation.operationId,
      parameters: contracts.parameters,
      path: operation.path,
      query: contracts.query,
      response: contracts.response,
    });
  }

  const orderedOperations = operations.sort(compareOperationsV2);
  const referencedTypeShapeHashes = referencedTypeShapeHashesV2(orderedOperations);
  const orderedDiagnostics = uniqueDiagnosticsV2(diagnostics);
  const discoveredOperationCount = syntaxCompilation.manifest.operations.length;
  const qualifiedOperationCount = orderedOperations.length;
  return {
    controllerSourceSha256: controllerSourceSha256V2(controllerSources),
    coverage: {
      diagnosticCount: orderedDiagnostics.length,
      discoveredOperationCount,
      qualifiedOperationCount,
      unqualifiedOperationCount: discoveredOperationCount - qualifiedOperationCount,
    },
    diagnostics: orderedDiagnostics,
    manifest: {
      operations: orderedOperations,
      schemaVersion: ADMIN_HTTP_CONTRACT_SCHEMA_VERSION_V2,
      types: [...definitions.values()]
        .filter((definition) => referencedTypeShapeHashes.has(definition.shapeHash))
        .sort((left, right) => compareText(left.shapeHash, right.shapeHash)),
    },
  };
}

function virtualProgramV2(sources: readonly AdminControllerSourceV1[]): ts.Program {
  const options: ts.CompilerOptions = {
    experimentalDecorators: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2021,
    types: [],
  };
  const virtualSources = new Map(
    sources.map((source) => [displayPath(resolve(process.cwd(), source.file)), source.contents]),
  );
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.fileExists = (fileName): boolean =>
    virtualSources.has(displayPath(resolve(fileName))) || defaultFileExists(fileName);
  host.readFile = (fileName): string | undefined =>
    virtualSources.get(displayPath(resolve(fileName))) ?? defaultReadFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ): ts.SourceFile | undefined => {
    const contents = virtualSources.get(displayPath(resolve(fileName)));
    return contents === undefined
      ? defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, contents, languageVersion, true, ts.ScriptKind.TS);
  };
  host.resolveModuleNames = (moduleNames, containingFile): (ts.ResolvedModule | undefined)[] =>
    moduleNames.map((moduleName) => {
      if (!moduleName.startsWith('.')) return undefined;
      const base = displayPath(resolve(dirname(containingFile), moduleName));
      const candidates = [`${base}.ts`, join(base, 'index.ts')].map(displayPath);
      const resolvedFileName = candidates.find((candidate) => virtualSources.has(candidate));
      return resolvedFileName ? { resolvedFileName } : undefined;
    });
  return ts.createProgram({ rootNames: [...virtualSources.keys()], options, host });
}

export function compileAdminHttpContractSourcesV2(
  sources: readonly AdminControllerSourceV1[],
): AdminHttpContractCompilationV2 {
  return compileAdminHttpContractSourcesWithProgramV2(
    sources,
    virtualProgramV2(sources),
    process.cwd(),
  );
}

export function analyzeAdminControllerSourceV2(
  file: string,
  contents: string,
): AdminHttpContractCompilationV2 {
  return compileAdminHttpContractSourcesV2([{ contents, file }]);
}

export function compileAdminHttpContractsV2(repoRoot: string): AdminHttpContractCompilationV2 {
  const configPath = join(repoRoot, 'apps/admin-api-service/tsconfig.app.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const sources = controllerFiles(repoRoot).map((absolutePath) => ({
    contents: readFileSync(absolutePath, 'utf8'),
    file: displayPath(relative(repoRoot, absolutePath)),
  }));
  return compileAdminHttpContractSourcesWithProgramV2(sources, program, repoRoot);
}

export function canonicalAdminHttpContractJsonV2(
  compilation: AdminHttpContractCompilationV2,
): string {
  if (compilation.diagnostics.length > 0) {
    throw new Error('Cannot serialize an admin HTTP contract V2 with diagnostics');
  }
  return `${JSON.stringify(compilation.manifest)}\n`;
}

export function canonicalAdminHttpContractTypeScriptV2(
  compilation: AdminHttpContractCompilationV2,
): string {
  const manifest = canonicalAdminHttpContractJsonV2(compilation).trimEnd();
  return `export const adminHttpContractManifestV2 = ${manifest} as const;\n`;
}
