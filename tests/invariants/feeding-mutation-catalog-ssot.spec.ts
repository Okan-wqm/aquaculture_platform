import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import {
  canonicalJsonSha256,
  createCanonicalJsonDocumentV1,
} from '../../libs/shared-contracts/src/canonical-json';

import {
  FEEDING_DURABLE_RELATION_AUTHORITY,
  FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
  FEEDING_MUTATION_SINK_RELATIONS,
  FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
} from '../../libs/feeding-contracts/src/feeding-durable-relation-authority';
import { assertExactAuthoritySetV1 } from '../../libs/feeding-contracts/src/authority-exact-set';
import {
  FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1,
  FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY,
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
  FEEDING_MUTATION_AUTHORITY_CATALOG_CANONICAL_JSON_V1,
  FEEDING_MUTATION_AUTHORITY_CATALOG_DIGEST_V1,
  FEEDING_MUTATION_AUTHORITY_CATALOG_REVISION_V1,
  FEEDING_MUTATION_RUNTIME_PROVIDER_AUTHORITIES_V1,
  FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1,
} from '../../libs/feeding-contracts/src/feeding-mutation-catalog';
import { FEEDING_SCHEDULER_APPLICATION_MODULE_IDS } from '../../apps/farm-feeding-scheduler/src/scheduler-application-authority';
import { FEEDING_CONTROL_PLANE_RELATIONS } from '../../apps/farm-service/src/database/feeding-operation-database-authority';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SOURCE_ROOT = join(REPO_ROOT, 'apps/farm-service/src');
const FEEDING_SOURCE_ROOTS = [
  join(REPO_ROOT, 'apps/farm-service/src/feeding'),
  join(REPO_ROOT, 'apps/farm-service/src/feeding-protocol'),
  join(REPO_ROOT, 'apps/farm-feeding-scheduler/src'),
];
const SCHEDULER_SOURCE_ROOT = join(REPO_ROOT, 'apps/farm-feeding-scheduler/src');
const SCHEDULER_EXTERNAL_IMPORT_AUTHORITIES = new Set([
  'node:crypto',
  '@nestjs/common',
  '@nestjs/config',
  '@nestjs/core',
  '@nestjs/core/application-config',
  '@nestjs/schedule',
  '@nestjs/typeorm',
  '@aquaculture/backend-common/constants',
  '@aquaculture/backend-common/database',
  '@aquaculture/backend-common/logging',
  '@aquaculture/backend-common/metrics',
  '@aquaculture/feeding-contracts',
  '@aquaculture/shared-contracts',
  '@platform/service-catalog',
  'prom-client',
  'reflect-metadata',
  'typeorm',
]);

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFilesBelow(path);
    }
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const SOURCE_FILES = FEEDING_SOURCE_ROOTS.flatMap(sourceFilesBelow);
const sourceFileSet = new Set(SOURCE_FILES);
const FARM_RUNTIME_SOURCE_FILES = sourceFilesBelow(FARM_SOURCE_ROOT);

const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const program = ts.createProgram(SOURCE_FILES, parsedConfig.options);
const checker = program.getTypeChecker();

function importCoordinateOf(symbol: ts.Symbol): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration)) continue;
    if (!ts.isStringLiteral(importDeclaration.moduleSpecifier)) continue;
    const importedName = declaration.propertyName?.text ?? declaration.name.text;
    return `${importDeclaration.moduleSpecifier.text}:${importedName}`;
  }
  return undefined;
}

function isImportedDecorator(
  decorator: ts.Decorator,
  moduleName: string,
  exportName: string,
): boolean {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  return symbol ? importCoordinateOf(symbol) === `${moduleName}:${exportName}` : false;
}

function decoratedMethodCoordinates(moduleName: string, exportName: string): string[] {
  const coordinates: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFileSet.has(sourceFile.fileName)) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
        if (decorators.some((item) => isImportedDecorator(item, moduleName, exportName))) {
          coordinates.push(`${statement.name.text}.${member.name.text}`);
        }
      }
    }
  }
  return coordinates.sort();
}

function decoratedClassNames(moduleName: string, exportName: string): string[] {
  const names: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFileSet.has(sourceFile.fileName)) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const decorators = ts.canHaveDecorators(statement) ? (ts.getDecorators(statement) ?? []) : [];
      if (decorators.some((item) => isImportedDecorator(item, moduleName, exportName))) {
        names.push(statement.name.text);
      }
    }
  }
  return names.sort();
}

function moduleSpecifierOf(statement: ts.Statement): string | undefined {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    statement.moduleReference.expression &&
    ts.isStringLiteral(statement.moduleReference.expression)
  ) {
    return statement.moduleReference.expression.text;
  }
  return undefined;
}

function decoratorTailName(decorator: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function directNamedImportAliases(
  source: ts.SourceFile,
  moduleName: string,
  exportName: string,
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    for (const element of statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements
      : []) {
      if ((element.propertyName?.text ?? element.name.text) === exportName) {
        aliases.add(element.name.text);
      }
    }
  }
  return aliases;
}

function usesDirectDecorator(
  decorators: readonly ts.Decorator[],
  aliases: ReadonlySet<string>,
): boolean {
  return decorators.some((decorator) => {
    const expression = ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression
      : decorator.expression;
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  });
}

function syntacticModuleAuthorityViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const moduleAliases = directNamedImportAliases(source, '@nestjs/common', 'Module');
  const authorityAliases = directNamedImportAliases(
    source,
    './scheduler-application-authority',
    'FeedingSchedulerApplicationModule',
  );
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const decorators = ts.canHaveDecorators(statement) ? (ts.getDecorators(statement) ?? []) : [];
    const decoratorNames = decorators.flatMap((decorator) => decoratorTailName(decorator) ?? []);
    const claimsModule = decoratorNames.includes('Module');
    const claimsAuthority = decoratorNames.includes('FeedingSchedulerApplicationModule');
    if (
      (claimsModule || claimsAuthority) &&
      (!claimsModule ||
        !claimsAuthority ||
        !usesDirectDecorator(decorators, moduleAliases) ||
        !usesDirectDecorator(decorators, authorityAliases))
    ) {
      violations.push(statement.name.text);
    }
  }
  return violations;
}

function dynamicModuleLoadingKinds(source: ts.SourceFile): string[] {
  const kinds: string[] = [];
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      kinds.push('import()');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      kinds.push('require()');
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return kinds;
}

function realPathIsInside(root: string, candidate: string): boolean {
  const realRoot = realpathSync.native(root);
  const realCandidate = realpathSync.native(candidate);
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}/`);
}

function expectExactSet(actual: readonly string[], expected: readonly string[]): void {
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
}

interface DiscoveredEntityProjection {
  readonly symbol: string;
  readonly relation: string;
  readonly decoratorSchema: string | null;
}

function stringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (name === propertyName && ts.isStringLiteral(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function discoverGovernedEntityProjections(): DiscoveredEntityProjection[] {
  const governedRelations = new Set(
    FEEDING_DURABLE_RELATION_AUTHORITY.flatMap((relation) =>
      relation.entity === null ? [] : [relation.physical.relation],
    ),
  );
  const projections: DiscoveredEntityProjection[] = [];
  for (const file of FARM_RUNTIME_SOURCE_FILES) {
    const source = ts.createSourceFile(
      file,
      ts.sys.readFile(file) ?? '',
      ts.ScriptTarget.Latest,
      true,
    );
    const entityAliases = directNamedImportAliases(source, 'typeorm', 'Entity');
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const decorators = ts.canHaveDecorators(statement) ? (ts.getDecorators(statement) ?? []) : [];
      const decorator = decorators.find((item) => usesDirectDecorator([item], entityAliases));
      if (!decorator || !ts.isCallExpression(decorator.expression)) continue;
      const argument = decorator.expression.arguments[0];
      const relation =
        argument && ts.isStringLiteral(argument)
          ? argument.text
          : argument && ts.isObjectLiteralExpression(argument)
            ? stringProperty(argument, 'name')
            : undefined;
      if (!relation || !governedRelations.has(relation)) continue;
      const decoratorSchema =
        argument && ts.isObjectLiteralExpression(argument)
          ? (stringProperty(argument, 'schema') ?? null)
          : null;
      projections.push({
        symbol: statement.name.text,
        relation,
        decoratorSchema,
      });
    }
  }
  return projections;
}

interface DiscoveredEventSubscription {
  readonly coordinate: string;
  readonly authorityImport: string | undefined;
}

function enclosingNode<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T | undefined {
  let candidate: ts.Node | undefined = node.parent;
  while (candidate) {
    if (predicate(candidate)) return candidate;
    candidate = candidate.parent;
  }
  return undefined;
}

function discoverEventSubscriptions(): DiscoveredEventSubscription[] {
  const discoveries: DiscoveredEventSubscription[] = [];
  for (const source of program.getSourceFiles()) {
    if (!sourceFileSet.has(source.fileName)) continue;
    const inspect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'subscribeWildcard'
      ) {
        const method = enclosingNode(node, ts.isMethodDeclaration);
        const owner = method ? enclosingNode(method, ts.isClassDeclaration) : undefined;
        if (
          !method ||
          !owner?.name ||
          !ts.isIdentifier(method.name) ||
          !node.arguments[0] ||
          !ts.isIdentifier(node.arguments[0])
        ) {
          discoveries.push({ coordinate: '<unresolved>', authorityImport: undefined });
          return;
        }
        const handlerMethods = new Set<string>();
        if (node.arguments[1]) {
          const inspectHandler = (candidate: ts.Node): void => {
            if (
              ts.isPropertyAccessExpression(candidate) &&
              candidate.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
              handlerMethods.add(candidate.name.text);
            }
            ts.forEachChild(candidate, inspectHandler);
          };
          inspectHandler(node.arguments[1]);
        }
        handlerMethods.delete('eventBus');
        const loopVariable = node.arguments[0].text;
        const forOf = enclosingNode(node, ts.isForOfStatement);
        const declaration = forOf?.initializer;
        const iteratedAuthority = forOf?.expression;
        const bindsArgument =
          declaration !== undefined &&
          ts.isVariableDeclarationList(declaration) &&
          declaration.declarations.length === 1 &&
          ts.isIdentifier(declaration.declarations[0]!.name) &&
          declaration.declarations[0]!.name.text === loopVariable;
        const authoritySymbol =
          bindsArgument &&
          iteratedAuthority &&
          ts.isPropertyAccessExpression(iteratedAuthority) &&
          iteratedAuthority.name.text === 'eventTypes' &&
          ts.isIdentifier(iteratedAuthority.expression)
            ? checker.getSymbolAtLocation(iteratedAuthority.expression)
            : undefined;
        discoveries.push({
          coordinate: `${owner.name.text}.${method.name.text}->${[...handlerMethods].sort().join('+')}`,
          authorityImport: authoritySymbol ? importCoordinateOf(authoritySymbol) : undefined,
        });
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  return discoveries;
}

function discoverTenantTransactionHandlerBindings(): string[] {
  const bindings: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!sourceFileSet.has(source.fileName)) continue;
    const inspect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'execute' &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.expression.name.text === 'transactions'
      ) {
        const handler = enclosingNode(node, ts.isClassDeclaration);
        const identifier = node.arguments[0];
        if (
          !handler?.name ||
          !identifier ||
          !ts.isPropertyAccessExpression(identifier) ||
          !ts.isIdentifier(identifier.expression) ||
          identifier.name.text !== 'name' ||
          identifier.expression.text !== handler.name.text
        ) {
          bindings.push('<unresolved>');
        } else {
          bindings.push(handler.name.text);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  return bindings.sort();
}

describe('feeding mutation catalog source/runtime SSOT', () => {
  it('has one immutable byte authority and no duplicate ingress identity', () => {
    expect(Object.isFrozen(FEEDING_MUTATION_AUTHORITY_CATALOG_V1)).toBe(true);
    expect(
      canonicalJsonSha256(
        {
          domain: 'aquaculture.feeding-mutation-authority-catalog',
          schemaVersion: FEEDING_MUTATION_AUTHORITY_CATALOG_REVISION_V1,
        },
        createCanonicalJsonDocumentV1(
          JSON.parse(FEEDING_MUTATION_AUTHORITY_CATALOG_CANONICAL_JSON_V1) as unknown,
        ),
      ),
    ).toBe(FEEDING_MUTATION_AUTHORITY_CATALOG_DIGEST_V1);
    expect(FEEDING_MUTATION_AUTHORITY_CATALOG_DIGEST_V1).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(FEEDING_MUTATION_AUTHORITY_CATALOG_V1.map((item) => item.id)).size).toBe(
      FEEDING_MUTATION_AUTHORITY_CATALOG_V1.length,
    );
  });

  it('keeps catalog sinks set-equal to the typed durable-relation authority', () => {
    const owners = new Map<string, Set<string>>();
    for (const mutation of FEEDING_MUTATION_AUTHORITY_CATALOG_V1) {
      for (const sink of mutation.durableSinks) {
        const coordinateOwners = owners.get(sink.coordinate) ?? new Set<string>();
        coordinateOwners.add(sink.writer);
        owners.set(sink.coordinate, coordinateOwners);
      }
    }
    for (const coordinateOwners of owners.values()) expect(coordinateOwners.size).toBe(1);
    expectExactSet(
      [...owners].flatMap(([coordinate, writers]) =>
        [...writers].map((writer) => `${coordinate}:${writer}`),
      ),
      FEEDING_MUTATION_SINK_RELATIONS.map(
        (relation) => `${relation.coordinate}:${relation.writer}`,
      ),
    );
  });

  it('binds every tenant transaction to the one catalog-consuming runtime provider', () => {
    const catalogHandlers = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.flatMap((authority) =>
      authority.transaction.boundary === 'tenant_transaction' && authority.commandHandler
        ? [authority.commandHandler]
        : [],
    );
    expectExactSet(discoverTenantTransactionHandlerBindings(), catalogHandlers);
    expectExactSet(
      FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1,
      FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
        (authority) => authority.transaction.boundary === 'tenant_transaction',
      ).map((authority) => authority.id),
    );

    const transactionAuthority = readFileSync(
      join(FARM_SOURCE_ROOT, 'feeding-protocol/feeding-mutation-transaction.authority.ts'),
      'utf8',
    );
    expect(transactionAuthority).toContain('return runInTenantTransaction(');
    for (const handlerPath of [
      'feeding-protocol/handlers/protocol-crud.handlers.ts',
      'feeding-protocol/handlers/protocol-assignment.handlers.ts',
    ]) {
      const source = readFileSync(join(FARM_SOURCE_ROOT, handlerPath), 'utf8');
      expect(source).not.toContain('runInTenantTransaction(');
      expect(source).not.toContain('.transaction(');
    }
  });

  it('fails closed when a tenant transaction runtime binding is missing or duplicated', () => {
    const catalogIds = FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1;
    const first = catalogIds[0];
    if (!first) throw new Error('Tenant transaction catalog unexpectedly has no identities');
    expect(() =>
      assertExactAuthoritySetV1(
        [...catalogIds, first],
        catalogIds,
        'Feeding tenant transaction mutation',
      ),
    ).toThrow('runtime contains duplicate coordinates');
    expect(() =>
      assertExactAuthoritySetV1(
        catalogIds.slice(1),
        catalogIds,
        'Feeding tenant transaction mutation',
      ),
    ).toThrow('registry differs');
  });

  it('projects shared runtime providers once while preserving their exact mutation method set', () => {
    const farmCatalog = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (authority) => authority.runtimeServiceId === 'farm-service',
    );
    const farmProviders = FEEDING_MUTATION_RUNTIME_PROVIDER_AUTHORITIES_V1.filter(
      (authority) => authority.runtimeServiceId === 'farm-service',
    );
    expect(new Set(farmProviders.map((authority) => authority.provider)).size).toBe(
      farmProviders.length,
    );
    expectExactSet(
      farmProviders.flatMap((authority) =>
        authority.methods.map((method) => `${authority.provider}.${method}`),
      ),
      farmCatalog.map((authority) => `${authority.ingress.provider}.${authority.ingress.method}`),
    );
    const protocolResolver = farmProviders.find(
      (authority) => authority.provider === 'FeedingProtocolV2Resolver',
    );
    expect(protocolResolver?.methods.length).toBeGreaterThan(1);
    expect(() =>
      assertExactAuthoritySetV1(
        farmProviders.map((authority) => authority.provider),
        farmProviders.map((authority) => authority.provider),
        'Feeding mutation component',
      ),
    ).not.toThrow();
  });

  it('keeps entity decorators set-equal to durable entity projections in both directions', () => {
    const actual = discoverGovernedEntityProjections().map(
      (entity) => `${entity.symbol}:${entity.decoratorSchema ?? '<tenant>'}.${entity.relation}`,
    );
    const expected = FEEDING_DURABLE_RELATION_AUTHORITY.flatMap((relation) =>
      relation.entity === null
        ? []
        : [
            `${relation.entity.symbol}:${relation.entity.decoratorSchema ?? '<tenant>'}.${relation.physical.relation}`,
          ],
    );
    expect(actual).toHaveLength(new Set(actual).size);
    expectExactSet(actual, expected);
  });

  it('projects only fixed-schema control-plane relations into fixed database ownership', () => {
    expectExactSet(
      FEEDING_CONTROL_PLANE_RELATIONS.map((relation) => `${relation.kind}:${relation.name}`),
      FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES.map(
        (relation) =>
          `${relation.relationKind === 'view' ? 'VIEW' : 'TABLE'}:${relation.coordinate}`,
      ),
    );
    expect(
      FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES.every(
        (relation) => relation.physical.scope === 'tenant_schema',
      ),
    ).toBe(true);
    expect(
      FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES.some((relation) =>
        FEEDING_CONTROL_PLANE_RELATIONS.some((fixed) => fixed.name === relation.coordinate),
      ),
    ).toBe(false);
  });

  it('keeps every event subscription linked to its typed ingress authority', () => {
    const discovered = discoverEventSubscriptions();
    const expected = FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1.map((authority) => ({
      coordinate: `${authority.provider}.${authority.subscriptionMethod}->${authority.handlerMethod}`,
      authorityImport: '@aquaculture/feeding-contracts:FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY',
    }));
    expect(discovered).toEqual(expected);
    expect(FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY).toBe(
      FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1[0],
    );
  });

  it('matches every live @nestjs/graphql Mutation by TypeScript import symbol in both directions', () => {
    const sourceMutations = decoratedMethodCoordinates('@nestjs/graphql', 'Mutation');
    const catalogMutations = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (item) => item.ingress.kind === 'graphql_mutation',
    ).map((item) => `${item.ingress.provider}.${item.ingress.method}`);

    expect(sourceMutations.length).toBeGreaterThan(0);
    expectExactSet(sourceMutations, catalogMutations);
  });

  it('matches every feeding @platform/cqrs CommandHandler by TypeScript import symbol', () => {
    const sourceHandlers = decoratedClassNames('@platform/cqrs', 'CommandHandler');
    const catalogHandlers = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.flatMap((item) =>
      item.commandHandler === null ? [] : [item.commandHandler],
    );

    expect(sourceHandlers.length).toBeGreaterThan(0);
    expectExactSet(sourceHandlers, catalogHandlers);
  });

  it('matches every feeding @nestjs/schedule Cron ingress by TypeScript import symbol', () => {
    const sourceCron = decoratedMethodCoordinates('@nestjs/schedule', 'Cron');
    const catalogCron = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (item) => item.ingress.kind === 'cron',
    ).map((item) => `${item.ingress.provider}.${item.ingress.method}`);

    expect(sourceCron).toHaveLength(1);
    expectExactSet(sourceCron, catalogCron);
  });

  it('matches every feeding @nestjs/schedule Interval ingress by TypeScript import symbol', () => {
    const sourceIntervals = decoratedMethodCoordinates('@nestjs/schedule', 'Interval');
    const catalogIntervals = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (item) => item.ingress.kind === 'interval',
    ).map((item) => `${item.ingress.provider}.${item.ingress.method}`);

    expect(sourceIntervals).toHaveLength(1);
    expectExactSet(sourceIntervals, catalogIntervals);
  });

  it('assigns each mutation ingress to exactly one process identity', () => {
    const schedulerEntries = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (item) => item.runtimeServiceId === 'farm-feeding-scheduler',
    );
    expect(schedulerEntries).toHaveLength(1);
    expect(schedulerEntries[0]?.ingress.kind).toBe('cron');
    expect(
      FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
        (item) => item.runtimeServiceId === 'farm-service',
      ).length,
    ).toBe(FEEDING_MUTATION_AUTHORITY_CATALOG_V1.length - 1);
  });

  it('keeps the scheduler process inside its exact import-capability boundary', () => {
    const violations: string[] = [];
    const schedulerFiles = sourceFilesBelow(SCHEDULER_SOURCE_ROOT);
    const schedulerRealRoot = realpathSync.native(SCHEDULER_SOURCE_ROOT);
    const reachable = new Set<string>();
    const queue = [join(SCHEDULER_SOURCE_ROOT, 'main.ts')];
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || reachable.has(file)) continue;
      reachable.add(file);
      const source = ts.createSourceFile(
        file,
        ts.sys.readFile(file) ?? '',
        ts.ScriptTarget.Latest,
        true,
      );
      const inspect = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          violations.push(`${relative(REPO_ROOT, file)}: dynamic module loading is forbidden`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
      for (const statement of source.statements) {
        const specifier = moduleSpecifierOf(statement);
        if (!specifier) continue;
        if (specifier.startsWith('.')) {
          const resolvedModule = ts.resolveModuleName(
            specifier,
            file,
            parsedConfig.options,
            ts.sys,
          ).resolvedModule;
          if (!resolvedModule || !existsSync(resolvedModule.resolvedFileName)) {
            violations.push(
              `${relative(REPO_ROOT, file)}: unresolved relative import (${specifier})`,
            );
            continue;
          }
          const destination = realpathSync.native(resolvedModule.resolvedFileName);
          const insideScheduler =
            destination === schedulerRealRoot || destination.startsWith(`${schedulerRealRoot}/`);
          if (!insideScheduler) {
            violations.push(
              `${relative(REPO_ROOT, file)}: relative import escapes scheduler source (${specifier})`,
            );
          } else if (destination.endsWith('.ts')) {
            queue.push(destination);
          }
        } else if (!SCHEDULER_EXTERNAL_IMPORT_AUTHORITIES.has(specifier)) {
          violations.push(
            `${relative(REPO_ROOT, file)}: undeclared external capability (${specifier})`,
          );
        }
      }
    }
    const unreachable = schedulerFiles
      .map((file) => realpathSync.native(file))
      .filter((file) => !reachable.has(file))
      .map((file) => relative(REPO_ROOT, file));
    if (unreachable.length > 0) {
      violations.push(
        `scheduler source is outside the executable module graph: ${unreachable.join(',')}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('assigns every scheduler @Module to the exact application authority registry', () => {
    const schedulerFileSet = new Set(sourceFilesBelow(SCHEDULER_SOURCE_ROOT));
    const moduleClasses: string[] = [];
    const authorityClasses: string[] = [];
    const authorityIds: string[] = [];
    for (const sourceFile of program.getSourceFiles()) {
      if (!schedulerFileSet.has(sourceFile.fileName)) continue;
      for (const statement of sourceFile.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;
        const decorators = ts.canHaveDecorators(statement)
          ? (ts.getDecorators(statement) ?? [])
          : [];
        if (decorators.some((item) => isImportedDecorator(item, '@nestjs/common', 'Module'))) {
          moduleClasses.push(statement.name.text);
        }
        for (const decorator of decorators) {
          if (
            !isImportedDecorator(
              decorator,
              './scheduler-application-authority',
              'FeedingSchedulerApplicationModule',
            ) ||
            !ts.isCallExpression(decorator.expression)
          ) {
            continue;
          }
          authorityClasses.push(statement.name.text);
          const id = decorator.expression.arguments[0];
          if (id && ts.isStringLiteral(id)) authorityIds.push(id.text);
        }
      }
    }
    expect(moduleClasses.length).toBeGreaterThan(0);
    expectExactSet(authorityClasses, moduleClasses);
    expectExactSet(authorityIds, FEEDING_SCHEDULER_APPLICATION_MODULE_IDS);
  });

  it.each([
    [
      'namespace import',
      `import * as Nest from '@nestjs/common';\n@Nest.Module({}) class DangerousModule {}`,
    ],
    [
      'local decorator spoof',
      `function Module(_: unknown) {}\n@Module({}) class DangerousModule {}`,
    ],
    [
      'barrel re-export',
      `import { Module } from './barrel';\n@Module({}) class DangerousModule {}`,
    ],
    [
      'ImportEquals',
      `import Nest = require('@nestjs/common');\n@Nest.Module({}) class DangerousModule {}`,
    ],
  ])('rejects scheduler module authority evasion through %s', (_label, text) => {
    const fixture = ts.createSourceFile(
      'dangerous-module.fixture.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(syntacticModuleAuthorityViolations(fixture)).toEqual(['DangerousModule']);
  });

  it('rejects dynamic import and require capability escapes', () => {
    const fixture = ts.createSourceFile(
      'dynamic-loading.fixture.ts',
      `void import('./escape');\nrequire('./escape');`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(dynamicModuleLoadingKinds(fixture).sort()).toEqual(['import()', 'require()']);
  });

  it('resolves symlinks before enforcing the scheduler source boundary', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'feeding-scheduler-boundary-'));
    try {
      const schedulerRoot = join(fixtureRoot, 'scheduler');
      const outsideRoot = join(fixtureRoot, 'outside');
      mkdirSync(schedulerRoot);
      mkdirSync(outsideRoot);
      const escape = join(schedulerRoot, 'escape');
      symlinkSync(outsideRoot, escape, 'dir');
      expect(realPathIsInside(schedulerRoot, escape)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps GraphQL queries outside the durable mutation catalog', () => {
    const sourceQueries = decoratedMethodCoordinates('@nestjs/graphql', 'Query');
    const catalogCoordinates = new Set(
      FEEDING_MUTATION_AUTHORITY_CATALOG_V1.map(
        (item) => `${item.ingress.provider}.${item.ingress.method}`,
      ),
    );
    expect(sourceQueries.filter((coordinate) => catalogCoordinates.has(coordinate))).toEqual([]);
  });

  it('makes every live writer classification, admission, transaction and sink explicit', () => {
    for (const mutation of FEEDING_MUTATION_AUTHORITY_CATALOG_V1) {
      expect(mutation.classification).not.toBe('retired');
      expect(mutation.lifecycle).not.toBe('retired');
      expect(mutation.admissionOwners.length).toBeGreaterThan(0);
      expect(mutation.transaction.provider).not.toHaveLength(0);
      expect(mutation.transaction.method).not.toHaveLength(0);
      expect(mutation.transaction.schema).toBe('farm');
      expect(mutation.transaction.boundary).not.toBe('repository_autocommit');
      expect(mutation.durableSinks.length).toBeGreaterThan(0);
      for (const sink of mutation.durableSinks) {
        expect(sink.coordinate).toMatch(/^(farm|public)\./);
        expect(sink.writer).not.toHaveLength(0);
      }
    }
  });
});
