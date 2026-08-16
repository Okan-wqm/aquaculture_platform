/**
 * One-shot, compiler-backed migration from inferred/admin-local response
 * shapes to executable route projections.
 *
 * This is intentionally a source transformer, not a readiness exemption. It
 * writes a named contract beside each domain controller, annotates the route
 * with that named DTO, and binds the same executable projection to Nest
 * metadata. The normal admin-contract generator remains the permanent gate.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const PROJECTION_DIRECTORIES = ['/dto/', '/contracts/'];
const write = process.argv.includes('--write');
const repairGenerated = process.argv.includes('--repair-generated');

class MigrationError extends Error {}

const SCHEMALESS_REASON_BY_PATH: ReadonlyArray<readonly [pattern: RegExp, reason: string]> = [
  [/\.metadata(?:\[key\])?$/, 'extension-metadata'],
  [/^(?:DatabaseExplorer|Monitoring|Schema)\./, 'database-record'],
  [/^DebugTools\./, 'debug-observation'],
  [/^JobQueue\./, 'job-payload'],
  [/^Reports\./, 'report-dataset'],
  [/^(?:Settings|TenantConfiguration|GlobalSettings)\./, 'operator-configuration'],
  [
    /^(?:ActivityLog|AuditLog|AuditTrail|Compliance|Impersonation|ErrorTracking|SecurityMonitoring|SystemMetrics|TenantAdmin)\./,
    'security-audit-context',
  ],
  [/^Modules\./, 'external-system-record'],
];

function schemalessReason(path: string): string {
  const match = SCHEMALESS_REASON_BY_PATH.find(([pattern]) => pattern.test(path));
  if (match === undefined) {
    throw new MigrationError(`${path}: unknown/any has no reviewed schemaless JSON classification`);
  }
  return match[1];
}

interface RouteMigration {
  readonly source: ts.SourceFile;
  readonly controller: ts.ClassDeclaration;
  readonly member: ts.MethodDeclaration;
  readonly method: string;
  readonly routePath: string;
  readonly typeName: string;
  readonly contractName: string;
  readonly responseContractName: string;
  readonly contractFile: string;
  readonly collection: 'value' | 'array' | 'page';
  readonly schema: string;
  readonly asynchronous: boolean;
  readonly terminal?: 'never' | 'void';
}

interface FrontendProjectionDemand {
  readonly collection: 'value' | 'array' | 'page';
  readonly projection: ts.Type;
  readonly source: string;
}

function sourceFilesUnder(directory: string, suffix: string): string[] {
  const root = resolve(REPO_ROOT, directory);
  const discovered: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        discovered.push(relative(REPO_ROOT, absolute).replaceAll('\\', '/'));
      }
    }
  };
  visit(root);
  return discovered.sort();
}

function readPaths(): Record<string, string[]> {
  const parsed = ts.parseConfigFileTextToJson(
    resolve(REPO_ROOT, 'tsconfig.base.json'),
    readFileSync(resolve(REPO_ROOT, 'tsconfig.base.json'), 'utf8'),
  );
  return parsed.config.compilerOptions?.paths ?? {};
}

function createProgram(files: readonly string[]): ts.Program {
  return ts.createProgram({
    rootNames: files.map((file) => resolve(REPO_ROOT, file)),
    options: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: REPO_ROOT,
      paths: readPaths(),
    },
  });
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorCall(node: ts.Node, names: ReadonlySet<string>): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    if (ts.isIdentifier(expression) && names.has(expression.text)) {
      return decorator.expression;
    }
  }
  return undefined;
}

function literalDecoratorPath(call: ts.CallExpression | undefined): string {
  const argument = call?.arguments[0];
  if (argument === undefined) return '';
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  throw new MigrationError(
    `${argument.getSourceFile().fileName}:${argument.getStart()} has a non-literal route path`,
  );
}

function joinedRoutePath(controllerPath: string, methodPath: string): string {
  const joined = [controllerPath, methodPath]
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/');
  return joined.length === 0 ? '/' : `/${joined}`;
}

function frontendEndpoint(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'buildQueryString'
  ) {
    return '';
  }
  if (ts.isTemplateExpression(node)) {
    let endpoint = node.head.text;
    for (const span of node.templateSpans) {
      const expression = frontendEndpoint(span.expression);
      endpoint += expression === '' ? span.literal.text : `:*${span.literal.text}`;
    }
    return endpoint;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = frontendEndpoint(node.left);
    const right = frontendEndpoint(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function normalizedPath(path: string): string {
  const [withoutQuery = path] = path.split('?');
  const normalized = withoutQuery
    .replace(/:\*/g, ':*')
    .replace(/:[^/]+/g, ':*')
    .replace(/\/+$/g, '');
  return normalized.length === 0 ? '/' : normalized;
}

function requestMethod(options: ts.Expression | undefined): string {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return 'GET';
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'method' &&
      (ts.isStringLiteral(property.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return 'GET';
}

function resolvedSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function hasTypedResponseBypass(member: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
  for (const decorator of decoratorsOf(member)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const callee = decorator.expression.expression;
    const symbol = resolvedSymbol(
      checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee),
      checker,
    );
    const declarationFile = symbol?.declarations?.[0]?.getSourceFile().fileName;
    if (
      symbol?.getName() === 'AdminResponseBypass' &&
      declarationFile?.endsWith('/shared/admin-response-contract.decorator.ts') === true
    ) {
      return true;
    }
  }
  return false;
}

function repositoryFile(symbol: ts.Symbol): string | undefined {
  const file = symbol.declarations?.[0]?.getSourceFile().fileName;
  if (file === undefined || !file.startsWith(REPO_ROOT)) return undefined;
  return relative(REPO_ROOT, file).replaceAll('\\', '/');
}

function isEntitySymbol(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isClassDeclaration(declaration) &&
      decoratorCall(declaration, new Set(['Entity'])) !== undefined,
  );
}

function isReadyProjection(member: ts.MethodDeclaration, checker: ts.TypeChecker): boolean {
  if (member.type === undefined) return false;
  const root = unwrapTypeNode(member.type);
  if (root.kind === ts.SyntaxKind.VoidKeyword || root.kind === ts.SyntaxKind.NeverKeyword) {
    return true;
  }
  if (ts.isTypeLiteralNode(root) || ts.isUnionTypeNode(root)) return false;
  const symbol = ts.isTypeReferenceNode(root)
    ? resolvedSymbol(checker.getSymbolAtLocation(root.typeName), checker)
    : resolvedSymbol(
        checker.getTypeFromTypeNode(root).aliasSymbol ??
          checker.getTypeFromTypeNode(root).getSymbol(),
        checker,
      );
  if (symbol === undefined || isEntitySymbol(symbol)) return false;
  const file = repositoryFile(symbol);
  return (
    file !== undefined && PROJECTION_DIRECTORIES.some((directory) => `/${file}`.includes(directory))
  );
}

function unwrapTypeNode(node: ts.TypeNode): ts.TypeNode {
  if (ts.isParenthesizedTypeNode(node)) return unwrapTypeNode(node.type);
  if (ts.isArrayTypeNode(node)) return unwrapTypeNode(node.elementType);
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    const first = node.typeArguments?.[0];
    if (
      first !== undefined &&
      (name === 'Promise' ||
        name === 'Array' ||
        name === 'ReadonlyArray' ||
        name === 'IStandardPaginatedResult' ||
        name === 'StandardPaginatedResult')
    ) {
      return unwrapTypeNode(first);
    }
  }
  return node;
}

function pascal(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+(.)/g, (_match, character: string) => character.toUpperCase())
    .replace(/^[a-z]/, (character) => character.toUpperCase());
}

function camel(value: string): string {
  const converted = pascal(value);
  return converted.charAt(0).toLowerCase() + converted.slice(1);
}

function controllerStem(controller: ts.ClassDeclaration): string {
  const name = controller.name?.text;
  if (name === undefined) throw new MigrationError('anonymous controller class');
  return name.replace(/Controller$/, '');
}

function contractFileFor(controllerFile: string): string {
  const sourceDirectory = posix.dirname(controllerFile);
  const domainDirectory = sourceDirectory.endsWith('/controllers')
    ? posix.dirname(sourceDirectory)
    : sourceDirectory;
  return `${domainDirectory}/contracts/admin-http-response.contract.ts`;
}

function isAsync(member: ts.MethodDeclaration): boolean {
  return (member.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function awaited(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  return checker.getAwaitedType(type) ?? type;
}

function returnExpressionTypes(member: ts.MethodDeclaration, checker: ts.TypeChecker): ts.Type[] {
  const types: ts.Type[] = [];
  if (member.body === undefined) return types;
  const visit = (node: ts.Node): void => {
    if (node !== member.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression !== undefined) {
        types.push(awaited(checker.getTypeAtLocation(node.expression), checker));
      }
      return;
    }
    node.forEachChild(visit);
  };
  member.body.forEachChild(visit);
  return types;
}

function inferredReturnTypes(member: ts.MethodDeclaration, checker: ts.TypeChecker): ts.Type[] {
  const expressions = returnExpressionTypes(member, checker);
  if (expressions.length > 0) return expressions;
  const signature = checker.getSignatureFromDeclaration(member);
  if (signature === undefined) return [];
  const inferred = awaited(checker.getReturnTypeOfSignature(signature), checker);
  return (inferred.flags & ts.TypeFlags.Void) !== 0 ? [] : [inferred];
}

interface CollectionType {
  readonly collection: 'value' | 'array' | 'page';
  readonly projection: ts.Type;
}

function typeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
    ? checker.getTypeArguments(type as ts.TypeReference)
    : [];
}

function propertyType(
  type: ts.Type,
  propertyName: string,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const property = checker.getPropertyOfType(type, propertyName);
  if (property === undefined) return undefined;
  const declaration = property.declarations?.[0];
  return declaration === undefined
    ? checker.getTypeOfSymbol(property)
    : checker.getTypeOfSymbolAtLocation(property, declaration);
}

function arrayElement(type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return typeArguments(type, checker)[0];
  }
  return undefined;
}

function collectionType(type: ts.Type, checker: ts.TypeChecker): CollectionType {
  const directArray = arrayElement(type, checker);
  if (directArray !== undefined) {
    return { collection: 'array', projection: directArray };
  }

  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  const argumentsOfType = typeArguments(type, checker);
  if (
    (name === 'IStandardPaginatedResult' || name === 'StandardPaginatedResult') &&
    argumentsOfType[0] !== undefined
  ) {
    return { collection: 'page', projection: argumentsOfType[0] };
  }

  const requiredPageKeys = [
    'items',
    'total',
    'page',
    'limit',
    'totalPages',
    'hasNextPage',
    'hasPreviousPage',
  ];
  if (requiredPageKeys.every((key) => checker.getPropertyOfType(type, key) !== undefined)) {
    const items = propertyType(type, 'items', checker);
    const item = items === undefined ? undefined : arrayElement(items, checker);
    if (item !== undefined) return { collection: 'page', projection: item };
  }

  return { collection: 'value', projection: type };
}

function discoverFrontendProjectionDemands(
  program: ts.Program,
  apiFiles: readonly string[],
): ReadonlyMap<string, readonly FrontendProjectionDemand[]> {
  const checker = program.getTypeChecker();
  const demands = new Map<string, FrontendProjectionDemand[]>();
  for (const file of apiFiles) {
    const source = program.getSourceFile(resolve(REPO_ROOT, file));
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'apiFetch' &&
        node.arguments[0] !== undefined &&
        node.typeArguments?.[0] !== undefined
      ) {
        const endpoint = frontendEndpoint(node.arguments[0]);
        if (endpoint !== undefined) {
          const method = requestMethod(node.arguments[1]);
          const response = collectionType(
            checker.getTypeFromTypeNode(node.typeArguments[0]),
            checker,
          );
          if (!isUnknownLike(response.projection) && !isVoidLike(response.projection)) {
            const id = `${method} ${normalizedPath(endpoint)}`;
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const bucket = demands.get(id) ?? [];
            bucket.push({
              ...response,
              source: `${file}:${line}`,
            });
            demands.set(id, bucket);
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  return demands;
}

function isVoidLike(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Undefined)) !== 0;
}

function isUnknownLike(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function semanticProjectionName(
  types: readonly ts.Type[],
  checker: ts.TypeChecker,
): string | undefined {
  const names = types.map((type) => {
    const symbol = resolvedSymbol(type.aliasSymbol ?? type.getSymbol(), checker);
    const name = symbol?.getName();
    return name === undefined || name.startsWith('__') || name === 'Record' ? undefined : name;
  });
  const first = names[0];
  return first !== undefined && names.every((name) => name === first) ? first : undefined;
}

class SchemaRenderer {
  constructor(private readonly checker: ts.TypeChecker) {}

  render(type: ts.Type, path: string): string {
    return this.renderType(type, path, [], 0);
  }

  canProject(source: ts.Type, mask: ts.Type): boolean {
    return this.canProjectType(source, mask, [], 0);
  }

  renderProjected(source: ts.Type, mask: ts.Type, path: string): string {
    if (!this.canProject(source, mask)) {
      throw new MigrationError(
        `${path}: frontend facade is not a field-safe projection of the backend result`,
      );
    }
    return this.renderProjectedType(source, mask, path, [], 0);
  }

  private materialTypes(type: ts.Type): readonly ts.Type[] {
    return type.isUnion()
      ? type.types.filter(
          (member) =>
            (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) ===
            0,
        )
      : [type];
  }

  private isLeafType(type: ts.Type): boolean {
    return (
      isUnknownLike(type) ||
      type.getSymbol()?.getName() === 'Date' ||
      (type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.Null)) !==
        0
    );
  }

  private leafTypesAreWireCompatible(source: ts.Type, mask: ts.Type): boolean {
    if (isUnknownLike(mask)) return true;
    if ((mask.flags & ts.TypeFlags.StringLike) !== 0) {
      return (
        (source.flags & ts.TypeFlags.StringLike) !== 0 || source.getSymbol()?.getName() === 'Date'
      );
    }
    if ((mask.flags & ts.TypeFlags.NumberLike) !== 0) {
      return (source.flags & ts.TypeFlags.NumberLike) !== 0;
    }
    if ((mask.flags & ts.TypeFlags.BooleanLike) !== 0) {
      return (source.flags & ts.TypeFlags.BooleanLike) !== 0;
    }
    return (source.flags & ts.TypeFlags.Null) !== 0;
  }

  private canProjectType(
    source: ts.Type,
    mask: ts.Type,
    ancestors: readonly string[],
    depth: number,
  ): boolean {
    if (depth > 18) return false;
    const sourceTypes = this.materialTypes(source);
    const maskTypes = this.materialTypes(mask);
    const sourceType = sourceTypes[0];
    const maskType = maskTypes[0];
    if (sourceType === undefined || maskType === undefined) return false;
    if (this.isLeafType(maskType)) {
      return sourceTypes.every((candidate) => this.leafTypesAreWireCompatible(candidate, maskType));
    }

    const sourceArray = arrayElement(sourceType, this.checker);
    const maskArray = arrayElement(maskType, this.checker);
    if (sourceArray !== undefined || maskArray !== undefined) {
      return (
        sourceArray !== undefined &&
        maskArray !== undefined &&
        this.canProjectType(sourceArray, maskArray, ancestors, depth + 1)
      );
    }

    const maskProperties = this.checker.getPropertiesOfType(maskType).filter((property) => {
      const declaration = property.declarations?.[0];
      return !(
        declaration !== undefined &&
        (ts.isMethodDeclaration(declaration) ||
          ts.isMethodSignature(declaration) ||
          ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration))
      );
    });
    if (maskProperties.length === 0) return true;

    const pair = `${this.checker.typeToString(sourceType)}=>${this.checker.typeToString(maskType)}`;
    if (ancestors.includes(pair)) return false;
    const next = [...ancestors, pair];
    return maskProperties.every((maskProperty) => {
      const sourceProperty = this.checker.getPropertyOfType(sourceType, maskProperty.getName());
      if (sourceProperty === undefined) return false;
      const maskDeclaration = maskProperty.declarations?.[0];
      const sourceDeclaration = sourceProperty.declarations?.[0];
      const maskChild =
        maskDeclaration === undefined
          ? this.checker.getTypeOfSymbol(maskProperty)
          : this.checker.getTypeOfSymbolAtLocation(maskProperty, maskDeclaration);
      const sourceChild =
        sourceDeclaration === undefined
          ? this.checker.getTypeOfSymbol(sourceProperty)
          : this.checker.getTypeOfSymbolAtLocation(sourceProperty, sourceDeclaration);
      return this.canProjectType(sourceChild, maskChild, next, depth + 1);
    });
  }

  private renderProjectedType(
    source: ts.Type,
    mask: ts.Type,
    path: string,
    ancestors: readonly string[],
    depth: number,
  ): string {
    const optional =
      mask.isUnion() && mask.types.some((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
    const nullable =
      mask.isUnion() && mask.types.some((member) => (member.flags & ts.TypeFlags.Null) !== 0);
    const sourceTypes = this.materialTypes(source);
    const maskTypes = this.materialTypes(mask);
    const maskType = maskTypes[0];
    if (maskType === undefined || sourceTypes.length === 0) {
      throw new MigrationError(`${path}: projection has no material wire type`);
    }

    const renderedVariants = sourceTypes.map((sourceType) => {
      const sourceArray = arrayElement(sourceType, this.checker);
      const maskArray = arrayElement(maskType, this.checker);
      if (sourceArray !== undefined && maskArray !== undefined) {
        return `adminResponse.array(${this.renderProjectedType(
          sourceArray,
          maskArray,
          `${path}[]`,
          ancestors,
          depth + 1,
        )})`;
      }

      if (this.isLeafType(maskType)) {
        return this.renderType(sourceType, path, [], depth);
      }

      const maskProperties = this.checker.getPropertiesOfType(maskType).filter((property) => {
        const declaration = property.declarations?.[0];
        return !(
          declaration !== undefined &&
          (ts.isMethodDeclaration(declaration) ||
            ts.isMethodSignature(declaration) ||
            ts.isGetAccessorDeclaration(declaration) ||
            ts.isSetAccessorDeclaration(declaration))
        );
      });
      if (maskProperties.length === 0) {
        return this.renderType(sourceType, path, [], depth);
      }

      const pair = `${this.checker.typeToString(sourceType)}=>${this.checker.typeToString(maskType)}`;
      if (ancestors.includes(pair)) {
        throw new MigrationError(`${path}: recursive facade projection`);
      }
      const next = [...ancestors, pair];
      const fields = maskProperties.map((maskProperty) => {
        const sourceProperty = this.checker.getPropertyOfType(sourceType, maskProperty.getName());
        if (sourceProperty === undefined) {
          throw new MigrationError(
            `${path}.${maskProperty.getName()}: facade field has no backend source`,
          );
        }
        const maskDeclaration = maskProperty.declarations?.[0];
        const sourceDeclaration = sourceProperty.declarations?.[0];
        const maskChild =
          maskDeclaration === undefined
            ? this.checker.getTypeOfSymbol(maskProperty)
            : this.checker.getTypeOfSymbolAtLocation(maskProperty, maskDeclaration);
        const sourceChild =
          sourceDeclaration === undefined
            ? this.checker.getTypeOfSymbol(sourceProperty)
            : this.checker.getTypeOfSymbolAtLocation(sourceProperty, sourceDeclaration);
        let child = this.renderProjectedType(
          sourceChild,
          maskChild,
          `${path}.${maskProperty.getName()}`,
          next,
          depth + 1,
        );
        if (
          (maskProperty.flags & ts.SymbolFlags.Optional) !== 0 &&
          !child.startsWith('adminResponse.optional(')
        ) {
          child = `adminResponse.optional(${child})`;
        }
        return `    ${JSON.stringify(maskProperty.getName())}: ${child},`;
      });
      return `adminResponse.object({\n${fields.join('\n')}\n  })`;
    });

    const unique = [...new Set(renderedVariants)];
    let rendered =
      unique.length === 1 ? unique[0] : `adminResponse.union([${unique.join(', ')}] as const)`;
    if (rendered === undefined) {
      throw new MigrationError(`${path}: projection produced no schema`);
    }
    if (nullable) rendered = `adminResponse.nullable(${rendered})`;
    if (optional) rendered = `adminResponse.optional(${rendered})`;
    return rendered;
  }

  private renderType(
    type: ts.Type,
    path: string,
    ancestors: readonly ts.Type[],
    depth: number,
  ): string {
    if (depth > 18) {
      throw new MigrationError(`${path}: response shape exceeds 18 nested levels`);
    }
    if (isUnknownLike(type)) {
      return `adminResponse.json(${JSON.stringify(schemalessReason(path))})`;
    }
    if ((type.flags & ts.TypeFlags.String) !== 0) return 'adminResponse.string()';
    if ((type.flags & ts.TypeFlags.Number) !== 0) return 'adminResponse.number()';
    if ((type.flags & ts.TypeFlags.Boolean) !== 0) return 'adminResponse.boolean()';
    if ((type.flags & ts.TypeFlags.Null) !== 0) return 'adminResponse.literal(null)';
    if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
      return `adminResponse.literal(${JSON.stringify((type as ts.StringLiteralType).value)})`;
    }
    if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
      return `adminResponse.literal(${(type as ts.NumberLiteralType).value})`;
    }
    if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return `adminResponse.literal(${this.checker.typeToString(type)})`;
    }

    if (type.getSymbol()?.getName() === 'Date') return 'adminResponse.dateString()';

    if (type.isUnion()) {
      const optional = type.types.some((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
      const nullable = type.types.some((member) => (member.flags & ts.TypeFlags.Null) !== 0);
      const material = type.types.filter(
        (member) =>
          (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) === 0,
      );
      if (material.length === 0) {
        return optional
          ? 'adminResponse.optional(adminResponse.literal(null))'
          : 'adminResponse.literal(null)';
      }
      const variants = [
        ...new Set(material.map((member) => this.renderType(member, path, ancestors, depth + 1))),
      ];
      let rendered =
        variants.length === 1
          ? variants[0]
          : `adminResponse.union([${variants.join(', ')}] as const)`;
      if (rendered === undefined) {
        throw new MigrationError(`${path}: empty union`);
      }
      if (nullable) rendered = `adminResponse.nullable(${rendered})`;
      if (optional) rendered = `adminResponse.optional(${rendered})`;
      return rendered;
    }

    if (this.checker.isTupleType(type)) {
      const items = typeArguments(type, this.checker).map((item, index) =>
        this.renderType(item, `${path}[${index}]`, ancestors, depth + 1),
      );
      return `adminResponse.tuple([${items.join(', ')}] as const)`;
    }
    if (this.checker.isArrayType(type)) {
      const item = typeArguments(type, this.checker)[0];
      if (item === undefined) throw new MigrationError(`${path}: array item is unresolved`);
      return `adminResponse.array(${this.renderType(item, `${path}[]`, ancestors, depth + 1)})`;
    }

    const stringIndex = this.checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const properties = this.checker.getPropertiesOfType(type);
    if (stringIndex !== undefined && properties.length === 0) {
      return `adminResponse.record(${this.renderType(
        stringIndex,
        `${path}[key]`,
        ancestors,
        depth + 1,
      )})`;
    }

    if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0) {
      if (ancestors.includes(type)) {
        throw new MigrationError(
          `${path}: recursive response objects require an explicit projection`,
        );
      }
      const nextAncestors = [...ancestors, type];
      const fields: string[] = [];
      for (const property of properties) {
        const declaration = property.declarations?.[0];
        if (
          declaration !== undefined &&
          (ts.isMethodDeclaration(declaration) ||
            ts.isMethodSignature(declaration) ||
            ts.isGetAccessorDeclaration(declaration) ||
            ts.isSetAccessorDeclaration(declaration))
        ) {
          continue;
        }
        const child =
          declaration === undefined
            ? this.checker.getTypeOfSymbol(property)
            : this.checker.getTypeOfSymbolAtLocation(property, declaration);
        if (
          (child.flags & ts.TypeFlags.Never) !== 0 &&
          (property.flags & ts.SymbolFlags.Optional) !== 0
        ) {
          continue;
        }
        const childPath = `${path}.${property.getName()}`;
        let rendered = this.renderType(child, childPath, nextAncestors, depth + 1);
        if (
          (property.flags & ts.SymbolFlags.Optional) !== 0 &&
          !rendered.startsWith('adminResponse.optional(')
        ) {
          rendered = `adminResponse.optional(${rendered})`;
        }
        fields.push(`    ${JSON.stringify(property.getName())}: ${rendered},`);
      }
      if (fields.length === 0) {
        throw new MigrationError(`${path}: object has no serializable fields`);
      }
      return `adminResponse.object({\n${fields.join('\n')}\n  })`;
    }

    throw new MigrationError(`${path}: cannot project ${this.checker.typeToString(type)}`);
  }
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function applyEdits(source: string, edits: readonly TextEdit[]): string {
  let output = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

function relativeImport(fromFile: string, toFile: string): string {
  let path = posix.relative(posix.dirname(fromFile), toFile).replace(/\.ts$/, '');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
}

function contractFileContent(migrations: readonly RouteMigration[]): string {
  const projections = migrations
    .filter(
      (migration, index) =>
        migrations.findIndex((candidate) => candidate.contractName === migration.contractName) ===
        index,
    )
    .map(
      (migration) =>
        `export const ${migration.contractName} = ${migration.schema};\n\n` +
        `export type ${migration.typeName} = AdminResponseProjection<\n` +
        `  typeof ${migration.contractName}\n` +
        `>;`,
    )
    .join('\n\n');
  const wrappers = migrations
    .filter((migration) => migration.responseContractName !== migration.contractName)
    .filter(
      (migration, index, wrapperMigrations) =>
        wrapperMigrations.findIndex(
          (candidate) => candidate.responseContractName === migration.responseContractName,
        ) === index,
    )
    .map((migration) => {
      const builder = migration.collection === 'page' ? 'page' : 'array';
      return (
        `export const ${migration.responseContractName} = ` +
        `adminResponse.${builder}(${migration.contractName});`
      );
    })
    .join('\n\n');
  return (
    `import {\n` +
    `  adminResponse,\n` +
    `  type AdminResponseProjection,\n` +
    `} from '@platform/admin-http-contracts';\n\n` +
    `${projections}${wrappers.length > 0 ? `\n\n${wrappers}` : ''}\n`
  );
}

function repairGeneratedWrappers(controllerFiles: readonly string[]): void {
  const contractFiles = sourceFilesUnder(
    'apps/admin-api-service/src',
    'admin-http-response.contract.ts',
  );
  const contracts = new Map(
    contractFiles.map((file) => [file, readFileSync(resolve(REPO_ROOT, file), 'utf8')]),
  );
  const definitions = new Map<string, string>();
  for (const [file, source] of contracts) {
    for (const match of source.matchAll(/export const ([a-z][A-Za-z0-9]+Contract)\s*=/g)) {
      const name = match[1];
      if (name !== undefined) definitions.set(name, file);
    }
  }

  const required = new Set<string>();
  for (const file of controllerFiles) {
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    for (const match of source.matchAll(/\b([a-z][A-Za-z0-9]+(?:Array|Page)Contract)\b/g)) {
      const name = match[1];
      if (name !== undefined) required.add(name);
    }
  }

  const additions = new Map<string, string[]>();
  for (const wrapper of [...required].sort()) {
    if (definitions.has(wrapper)) continue;
    const collection = wrapper.endsWith('PageContract') ? 'page' : 'array';
    const base = wrapper.replace(/(?:Array|Page)Contract$/, 'Contract');
    const file = definitions.get(base);
    if (file === undefined) {
      throw new MigrationError(`${wrapper}: base executable contract ${base} is missing`);
    }
    const group = additions.get(file) ?? [];
    group.push(`export const ${wrapper} = adminResponse.${collection}(${base});`);
    additions.set(file, group);
  }

  for (const [file, lines] of additions) {
    const source = contracts.get(file);
    if (source === undefined) throw new MigrationError(`${file}: contract source is missing`);
    writeFileSync(resolve(REPO_ROOT, file), `${source.trimEnd()}\n\n${lines.join('\n\n')}\n`, 'utf8');
  }
}

function repairGeneratedPromiseAnnotations(
  program: ts.Program,
  checker: ts.TypeChecker,
  controllerFiles: readonly string[],
): void {
  for (const file of controllerFiles) {
    const source = program.getSourceFile(resolve(REPO_ROOT, file));
    if (source === undefined) continue;
    const edits: TextEdit[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.type !== undefined && node.body !== undefined) {
        if (
          !ts.isTypeReferenceNode(node.type) ||
          node.type.typeName.getText(source) !== 'Promise'
        ) {
          let returnsPromise = false;
          const inspectReturn = (child: ts.Node): void => {
            if (child !== node.body && ts.isFunctionLike(child)) return;
            if (ts.isReturnStatement(child) && child.expression !== undefined) {
              const expressionType = checker.getTypeAtLocation(child.expression);
              if (checker.getPromisedTypeOfPromise(expressionType) !== undefined) {
                returnsPromise = true;
              }
              return;
            }
            child.forEachChild(inspectReturn);
          };
          node.body.forEachChild(inspectReturn);
          if (returnsPromise) {
            edits.push({
              start: node.type.getStart(source),
              end: node.type.getEnd(),
              text: `Promise<${node.type.getText(source)}>`,
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    if (edits.length > 0) {
      writeFileSync(
        resolve(REPO_ROOT, file),
        applyEdits(readFileSync(resolve(REPO_ROOT, file), 'utf8'), edits),
        'utf8',
      );
    }
  }
}

function annotation(migration: RouteMigration): string {
  if (migration.terminal !== undefined) {
    return migration.asynchronous ? `Promise<${migration.terminal}>` : migration.terminal;
  }
  const root =
    migration.collection === 'page'
      ? `IStandardPaginatedResult<${migration.typeName}>`
      : migration.collection === 'array'
        ? `${migration.typeName}[]`
        : migration.typeName;
  return migration.asynchronous ? `Promise<${root}>` : root;
}

function migrationForRoute(
  source: ts.SourceFile,
  controller: ts.ClassDeclaration,
  member: ts.MethodDeclaration,
  method: string,
  routePath: string,
  checker: ts.TypeChecker,
  renderer: SchemaRenderer,
  frontendDemands: ReadonlyMap<string, readonly FrontendProjectionDemand[]>,
  frontendProjectionCatalog: ReadonlyMap<string, readonly ts.Type[]>,
): RouteMigration | undefined {
  const inferred = inferredReturnTypes(member, checker);
  const returns = inferred.filter((type) => !isVoidLike(type));
  if (returns.length === 0) {
    const explicitRoot = member.type === undefined ? undefined : unwrapTypeNode(member.type);
    const terminal =
      explicitRoot?.kind === ts.SyntaxKind.NeverKeyword ||
      inferred.some((type) => (type.flags & ts.TypeFlags.Never) !== 0)
        ? 'never'
        : 'void';
    const projectionStem = terminal === 'never' ? 'NeverResponse' : 'VoidResponse';
    const contractName = `${camel(projectionStem)}Contract`;
    return {
      source,
      controller,
      member,
      method,
      routePath,
      typeName: `${projectionStem}Dto`,
      contractName,
      responseContractName: contractName,
      contractFile: contractFileFor(relative(REPO_ROOT, source.fileName).replaceAll('\\', '/')),
      collection: 'value',
      schema: `adminResponse.${terminal}()`,
      asynchronous: isAsync(member),
      terminal,
    };
  }

  const collections = returns.map((type) => collectionType(type, checker));
  const collection = collections[0]?.collection;
  if (collection === undefined) return undefined;
  if (collections.some((candidate) => candidate.collection !== collection)) {
    throw new MigrationError(`${source.fileName}:${member.getStart()} mixes response collections`);
  }

  const demandKey = `${method} ${normalizedPath(routePath)}`;
  const demands = frontendDemands.get(demandKey) ?? [];
  const controllerName = controllerStem(controller);
  const memberName = member.name.getText(source);
  const backendSemanticName = semanticProjectionName(
    collections.map((candidate) => candidate.projection),
    checker,
  );
  const catalogTypes =
    backendSemanticName === undefined
      ? []
      : (frontendProjectionCatalog.get(backendSemanticName) ?? []);
  const maskCandidates = [...catalogTypes, ...demands.map((demand) => demand.projection)];
  const projectionMask = maskCandidates.find((mask) =>
    collections.every((candidate) => renderer.canProject(candidate.projection, mask)),
  );
  const semanticName = semanticProjectionName(
    projectionMask === undefined
      ? collections.map((candidate) => candidate.projection)
      : [projectionMask],
    checker,
  );
  const projectionStem =
    semanticName === undefined
      ? `${controllerName}${pascal(memberName)}Response`
      : `${controllerName}${pascal(semanticName)}`;
  const typeName = `${projectionStem}Dto`;
  const contractName = `${camel(projectionStem)}Contract`;
  const variants = [
    ...new Set(
      collections.map((candidate) =>
        projectionMask === undefined
          ? renderer.render(candidate.projection, `${controllerName}.${memberName}`)
          : renderer.renderProjected(
              candidate.projection,
              projectionMask,
              `${controllerName}.${memberName}`,
            ),
      ),
    ),
  ];
  const itemSchema =
    variants.length === 1 ? variants[0] : `adminResponse.union([${variants.join(', ')}] as const)`;
  if (itemSchema === undefined) return undefined;
  const responseContractName =
    collection === 'value' ? contractName : `${camel(projectionStem)}${pascal(collection)}Contract`;
  return {
    source,
    controller,
    member,
    method,
    routePath,
    typeName,
    contractName,
    responseContractName,
    contractFile: contractFileFor(relative(REPO_ROOT, source.fileName).replaceAll('\\', '/')),
    collection,
    schema: itemSchema,
    asynchronous: isAsync(member),
  };
}

function main(): void {
  const controllerFiles = sourceFilesUnder('apps/admin-api-service/src', '.controller.ts');
  const apiFiles = sourceFilesUnder('web/modules/admin-panel/src/services/api', '.ts').filter(
    (file) => !file.endsWith('.spec.ts'),
  );
  const program = createProgram([...controllerFiles, ...apiFiles]);
  const checker = program.getTypeChecker();
  if (repairGenerated) {
    repairGeneratedWrappers(controllerFiles);
    repairGeneratedPromiseAnnotations(program, checker, controllerFiles);
    return;
  }
  const renderer = new SchemaRenderer(checker);
  const frontendDemands = discoverFrontendProjectionDemands(program, apiFiles);
  const frontendProjectionCatalog = new Map<string, ts.Type[]>();
  for (const demands of frontendDemands.values()) {
    for (const demand of demands) {
      const name = semanticProjectionName([demand.projection], checker);
      if (name === undefined) continue;
      const bucket = frontendProjectionCatalog.get(name) ?? [];
      bucket.push(demand.projection);
      frontendProjectionCatalog.set(name, bucket);
    }
  }
  const migrations: RouteMigration[] = [];
  const failures: string[] = [];
  let bypassRoutes = 0;

  for (const file of controllerFiles) {
    const source = program.getSourceFile(resolve(REPO_ROOT, file));
    if (source === undefined) continue;
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const controllerDecorator = decoratorCall(node, new Set(['Controller']));
      if (controllerDecorator === undefined) return;
      const controllerPath = literalDecoratorPath(controllerDecorator);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const routeDecorator = decoratorCall(member, HTTP_DECORATORS);
        if (routeDecorator === undefined) continue;
        if (hasTypedResponseBypass(member, checker)) {
          bypassRoutes += 1;
          continue;
        }
        const expression = routeDecorator.expression;
        if (!ts.isIdentifier(expression)) continue;
        const route = joinedRoutePath(controllerPath, literalDecoratorPath(routeDecorator));
        try {
          const migration = migrationForRoute(
            source,
            node,
            member,
            expression.text.toUpperCase(),
            route,
            checker,
            renderer,
            frontendDemands,
            frontendProjectionCatalog,
          );
          if (migration === undefined) {
            throw new MigrationError('route produced no executable response contract');
          }
          migrations.push(migration);
        } catch (error) {
          failures.push(
            `${expression.text.toUpperCase()} ${route}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });
  }

  const groupedContracts = new Map<string, RouteMigration[]>();
  for (const migration of migrations) {
    const group = groupedContracts.get(migration.contractFile) ?? [];
    group.push(migration);
    groupedContracts.set(migration.contractFile, group);
  }
  for (const [file, group] of groupedContracts) {
    const schemas = new Map<string, string>();
    for (const migration of group) {
      const existing = schemas.get(migration.contractName);
      if (existing !== undefined && existing !== migration.schema) {
        failures.push(
          `${file}: semantic projection ${migration.typeName} resolved to multiple schemas; ` +
            'split it into explicit list/detail contracts',
        );
      } else {
        schemas.set(migration.contractName, migration.schema);
      }
    }
  }

  process.stdout.write(
    `admin response migration: ${migrations.length} executable projections, ` +
      `${migrations.filter((migration) => migration.terminal === 'void').length} void routes, ` +
      `${migrations.filter((migration) => migration.terminal === 'never').length} never routes, ` +
      `${bypassRoutes} typed bypass routes, ` +
      `${failures.length} blocked routes\n`,
  );
  if (failures.length > 0) {
    process.stdout.write(`${failures.join('\n')}\n`);
  }
  if (!write) return;
  if (failures.length > 0) {
    throw new MigrationError('refusing to write while routes are blocked');
  }

  for (const [file, group] of groupedContracts) {
    const absolute = resolve(REPO_ROOT, file);
    if (existsSync(absolute)) {
      throw new MigrationError(`${file} already exists`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contractFileContent(group), 'utf8');
  }

  const bySource = new Map<string, RouteMigration[]>();
  for (const migration of migrations) {
    const file = relative(REPO_ROOT, migration.source.fileName).replaceAll('\\', '/');
    const group = bySource.get(file) ?? [];
    group.push(migration);
    bySource.set(file, group);
  }
  for (const [file, group] of bySource) {
    const absolute = resolve(REPO_ROOT, file);
    const source = program.getSourceFile(absolute);
    if (source === undefined) continue;
    const edits: TextEdit[] = [];
    const imports = source.statements.filter(ts.isImportDeclaration);
    const importAt = imports.at(-1)?.getEnd() ?? 0;

    if (group.length > 0) {
      const contractFile = group[0]?.contractFile;
      if (contractFile === undefined) continue;
      const symbols = group
        .flatMap((migration) => [migration.responseContractName, `type ${migration.typeName}`])
        .filter((symbol, index, all) => all.indexOf(symbol) === index)
        .join(',\n  ');
      const decoratorPath = relativeImport(
        file,
        'apps/admin-api-service/src/shared/admin-response-contract.decorator.ts',
      );
      const contractPath = relativeImport(file, contractFile);
      const pageImport = group.some((migration) => migration.collection === 'page')
        ? `\nimport type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';`
        : '';
      edits.push({
        start: importAt,
        end: importAt,
        text:
          `${pageImport}\nimport { AdminResponseContract } from '${decoratorPath}';\n` +
          `import {\n  ${symbols},\n} from '${contractPath}';`,
      });
    }

    for (const migration of group) {
      edits.push({
        start: migration.member.getStart(source),
        end: migration.member.getStart(source),
        text: `@AdminResponseContract(${migration.responseContractName})\n  `,
      });
      const replacement = annotation(migration);
      if (migration.member.type === undefined) {
        const bodyStart = migration.member.body?.getStart(source);
        if (bodyStart === undefined) throw new MigrationError(`${file}: route has no body`);
        edits.push({ start: bodyStart, end: bodyStart, text: `: ${replacement} ` });
      } else {
        edits.push({
          start: migration.member.type.getStart(source),
          end: migration.member.type.getEnd(),
          text: replacement,
        });
      }
    }
    writeFileSync(absolute, applyEdits(readFileSync(absolute, 'utf8'), edits), 'utf8');
  }
}

main();
