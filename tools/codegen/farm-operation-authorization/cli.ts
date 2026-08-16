import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FARM_SOURCE_ROOT = resolve(REPO_ROOT, 'apps/farm-service/src');
const WEB_SOURCE_ROOT = resolve(REPO_ROOT, 'web');
const CANONICAL_OUTPUT = resolve(
  REPO_ROOT,
  'libs/event-contracts/src/farm-operation-authorization.generated.ts',
);
const FRONTEND_OUTPUT = resolve(
  REPO_ROOT,
  'web/shared-ui/src/authz/farm-mutation-authorization.generated.ts',
);
const ROLE_CODES = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER']);

type OperationKind = 'Mutation' | 'Query';

interface OperationAuthorization {
  readonly kind: OperationKind;
  readonly operation: string;
  readonly roles: readonly string[];
  readonly source: string;
}

function sourceFilesBelow(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const absolute = resolve(directory, entry);
      if (statSync(absolute).isDirectory()) return sourceFilesBelow(absolute, pattern);
      pattern.lastIndex = 0;
      return pattern.test(entry) ? [absolute] : [];
    })
    .sort();
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  if (!ts.canHaveDecorators(node)) return [];
  return ts.getDecorators(node) ?? [];
}

function decoratorCall(node: ts.Node, name: string): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    if (ts.isIdentifier(expression) && expression.text === name) return decorator.expression;
  }
  return undefined;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function operationName(method: ts.MethodDeclaration, operationCall: ts.CallExpression): string {
  for (const argument of operationCall.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'name') continue;
      if (!ts.isStringLiteral(property.initializer)) {
        throw new Error('GraphQL operation names must be string literals');
      }
      return property.initializer.text;
    }
  }

  const name = propertyName(method.name);
  if (name === undefined) throw new Error('GraphQL resolver method must have a static name');
  return name;
}

function operationRoles(rolesCall: ts.CallExpression | undefined, source: string): readonly string[] {
  if (rolesCall === undefined) {
    throw new Error(`${source}: GraphQL root operation is missing @Roles(...)`);
  }

  const roles = rolesCall.arguments.map((argument) => {
    if (
      !ts.isPropertyAccessExpression(argument) ||
      !ts.isIdentifier(argument.expression) ||
      argument.expression.text !== 'Role'
    ) {
      throw new Error(`${source}: @Roles arguments must use canonical Role.<code> members`);
    }
    const role = argument.name.text;
    if (!ROLE_CODES.has(role)) throw new Error(`${source}: unknown platform role ${role}`);
    return role;
  });

  if (roles.length === 0) throw new Error(`${source}: @Roles must not be empty`);
  return Object.freeze([...new Set(roles)].sort());
}

function collectOperations(): readonly OperationAuthorization[] {
  const operations: OperationAuthorization[] = [];
  const resolverFiles = sourceFilesBelow(FARM_SOURCE_ROOT, /\.resolver\.ts$/u);

  for (const file of resolverFiles) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        const mutation = decoratorCall(node, 'Mutation');
        const query = decoratorCall(node, 'Query');
        const operation = mutation ?? query;
        if (operation !== undefined) {
          const kind: OperationKind = mutation === undefined ? 'Query' : 'Mutation';
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const source = `${relative(REPO_ROOT, file)}:${line}`;
          operations.push({
            kind,
            operation: operationName(node, operation),
            roles: operationRoles(decoratorCall(node, 'Roles'), source),
            source,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const byIdentity = new Map<string, OperationAuthorization>();
  for (const operation of operations) {
    const key = `${operation.kind}:${operation.operation}`;
    const previous = byIdentity.get(key);
    if (previous !== undefined) {
      throw new Error(
        `Duplicate GraphQL operation ${key}: ${previous.source} and ${operation.source}`,
      );
    }
    byIdentity.set(key, operation);
  }
  return Object.freeze(
    [...byIdentity.values()].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.operation.localeCompare(right.operation),
    ),
  );
}

function collectFrontendMutationDemands(): readonly string[] {
  const demands = new Set<string>();
  const sourceFiles = sourceFilesBelow(WEB_SOURCE_ROOT, /\.tsx?$/u).filter(
    (file) => !file.includes('/generated/') && !file.includes('/__tests__/'),
  );

  for (const file of sourceFiles) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useCanMutate'
      ) {
        const argument = node.arguments[0];
        if (argument === undefined || !ts.isStringLiteral(argument)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          throw new Error(
            `${relative(REPO_ROOT, file)}:${line}: useCanMutate requires a static mutation name`,
          );
        }
        demands.add(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return Object.freeze([...demands].sort());
}

function renderRoleArray(roles: readonly string[]): string {
  return `Object.freeze([${roles.map((role) => `Role.${role}`).join(', ')}] as const)`;
}

function renderCanonical(operations: readonly OperationAuthorization[]): string {
  const mutations = operations.filter((operation) => operation.kind === 'Mutation');
  const queries = operations.filter((operation) => operation.kind === 'Query');
  const renderMap = (entries: readonly OperationAuthorization[]): string =>
    entries
      .map((entry) => `  ${entry.operation}: ${renderRoleArray(entry.roles)},`)
      .join('\n');

  return `/* eslint-disable */\n// GENERATED by tools/codegen/farm-operation-authorization/cli.ts. DO NOT EDIT.\nimport { Role } from './roles';\n\nexport const FARM_MUTATION_AUTHORIZATION = Object.freeze({\n${renderMap(mutations)}\n} as const);\n\nexport const FARM_QUERY_AUTHORIZATION = Object.freeze({\n${renderMap(queries)}\n} as const);\n\nexport type FarmMutationName = keyof typeof FARM_MUTATION_AUTHORIZATION;\nexport type FarmQueryName = keyof typeof FARM_QUERY_AUTHORIZATION;\n`;
}

function renderFrontendProjection(
  mutationNames: readonly string[],
  mutationNamesInContract: ReadonlySet<string>,
): string {
  for (const name of mutationNames) {
    if (!mutationNamesInContract.has(name)) {
      throw new Error(`Frontend useCanMutate demand '${name}' is not a farm GraphQL mutation`);
    }
  }
  const properties = mutationNames
    .map((name) => `  ${name}: FARM_MUTATION_AUTHORIZATION.${name},`)
    .join('\n');
  return `/* eslint-disable */\n// GENERATED by tools/codegen/farm-operation-authorization/cli.ts. DO NOT EDIT.\nimport { FARM_MUTATION_AUTHORIZATION } from '@platform/event-contracts';\n\nexport const FRONTEND_MUTATION_ROLES = Object.freeze({\n${properties}\n} as const);\n\nexport type FrontendMutationName = keyof typeof FRONTEND_MUTATION_ROLES;\n`;
}

function writeOrCheck(path: string, expected: string, check: boolean): void {
  if (check) {
    const actual = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (actual !== expected) throw new Error(`${relative(REPO_ROOT, path)} is stale; run codegen:farm-authorization`);
    return;
  }
  writeFileSync(path, expected);
}

function main(): void {
  const check = process.argv.includes('--check');
  const operations = collectOperations();
  const mutationNames = new Set(
    operations
      .filter((operation) => operation.kind === 'Mutation')
      .map((operation) => operation.operation),
  );
  const frontendDemands = collectFrontendMutationDemands();
  writeOrCheck(CANONICAL_OUTPUT, renderCanonical(operations), check);
  writeOrCheck(
    FRONTEND_OUTPUT,
    renderFrontendProjection(frontendDemands, mutationNames),
    check,
  );
  process.stdout.write(
    `farm authorization codegen: ${operations.length} operations; ${mutationNames.size} mutations; ${frontendDemands.length} frontend demands${check ? '; up to date' : ''}\n`,
  );
}

main();
