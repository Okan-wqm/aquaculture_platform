import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { FEEDING_DURABLE_RELATION_AUTHORITY } from '../../libs/feeding-contracts/src/feeding-durable-relation-authority';
import { FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 } from '../../libs/shared-contracts/src/farm-durable-mutation-authority';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SOURCE_ROOT = join(REPO_ROOT, 'apps/farm-service/src');
const BATCH_PORT = join(FARM_SOURCE_ROOT, 'batch/batch-aggregate-mutation.port.ts');
const FEEDING_PORT = join(
  FARM_SOURCE_ROOT,
  'feeding-protocol/feeding-aggregate-mutation.writer.ts',
);
const SESSION_AUTHORITY = join(
  REPO_ROOT,
  'libs/backend-common/src/database/tenant-mutation-session.ts',
);
const TRANSACTION_AUTHORITY = join(
  REPO_ROOT,
  'libs/backend-common/src/database/tenant-transaction.ts',
);
const DATABASE_BARREL = join(REPO_ROOT, 'libs/backend-common/src/database/index.ts');
const STOCK_MUTATION_LOCK_AUTHORITY = join(
  FARM_SOURCE_ROOT,
  'storage/services/stock-mutation-lock.authority.ts',
);
const MUTATION_PORT_FILES = new Set([BATCH_PORT, FEEDING_PORT]);
const AGGREGATE_PORT_WRITERS: ReadonlySet<string> = new Set([
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE,
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.FEEDING_AGGREGATE,
]);
const GOVERNED_ENTITIES = new Set(
  FEEDING_DURABLE_RELATION_AUTHORITY.flatMap((relation) =>
    relation.entity !== null &&
    relation.writer !== null &&
    AGGREGATE_PORT_WRITERS.has(relation.writer)
      ? [relation.entity.symbol]
      : [],
  ),
);
const MUTATION_PRIMITIVES = new Set([
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'remove',
  'softDelete',
  'softRemove',
  'restore',
  'increment',
  'decrement',
]);
const RETIRED_CALLABLE_SINGLETONS = new Set([
  'BATCH_AGGREGATE_MUTATION_PORT',
  'BATCH_AGGREGATE_MUTATION_WRITER',
  'FEEDING_AGGREGATE_MUTATION_PORT',
  'FEEDING_AGGREGATE_MUTATION_WRITER',
]);

function runtimeSourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      if (path === join(FARM_SOURCE_ROOT, 'database/migrations')) return [];
      return runtimeSourceFilesBelow(path);
    }
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const SOURCE_FILES = runtimeSourceFilesBelow(FARM_SOURCE_ROOT);
const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const program = ts.createProgram(
  [...SOURCE_FILES, SESSION_AUTHORITY, TRANSACTION_AUTHORITY, DATABASE_BARREL],
  parsedConfig.options,
);
const checker = program.getTypeChecker();
const sourceFileSet = new Set(SOURCE_FILES);

function display(node: ts.Node): string {
  const source = node.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(REPO_ROOT, source.fileName)}:${position.line + 1}`;
}

function typeContainsGovernedEntity(type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (GOVERNED_ENTITIES.has(type.getSymbol()?.getName() ?? '')) return true;
  if (GOVERNED_ENTITIES.has(type.aliasSymbol?.getName() ?? '')) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((item) => typeContainsGovernedEntity(item, seen));
  }
  for (const argument of type.aliasTypeArguments ?? []) {
    if (typeContainsGovernedEntity(argument, seen)) return true;
  }
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const object = type as ts.ObjectType;
    if ((object.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      for (const argument of checker.getTypeArguments(object as ts.TypeReference)) {
        if (typeContainsGovernedEntity(argument, seen)) return true;
      }
    }
  }
  return false;
}

function callMutatesGovernedEntity(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (!MUTATION_PRIMITIVES.has(call.expression.name.text)) return false;
  if (typeContainsGovernedEntity(checker.getTypeAtLocation(call.expression.expression))) {
    return true;
  }
  return call.arguments.some((argument) =>
    typeContainsGovernedEntity(checker.getTypeAtLocation(argument)),
  );
}

function portNameForMethod(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(call.expression.name);
  for (const declaration of symbol?.declarations ?? []) {
    const owner = declaration.parent;
    if (!ts.isClassDeclaration(owner) || !owner.name) continue;
    if (
      owner.name.text === 'BatchAggregateMutationPort' ||
      owner.name.text === 'FeedingAggregateMutationPort'
    ) {
      return owner.name.text;
    }
  }
  return undefined;
}

function portImplementationClasses(source: ts.SourceFile, portName: string): ts.ClassDeclaration[] {
  return source.statements.filter((statement): statement is ts.ClassDeclaration => {
    if (!ts.isClassDeclaration(statement)) return false;
    return (statement.heritageClauses ?? []).some(
      (clause) =>
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some(
          (type) => ts.isIdentifier(type.expression) && type.expression.text === portName,
        ),
    );
  });
}

describe('farm durable mutation ports', () => {
  it('keeps TypeORM mutation primitives behind the two concrete aggregate ports', () => {
    const violations: string[] = [];
    for (const source of program.getSourceFiles()) {
      if (!sourceFileSet.has(source.fileName) || MUTATION_PORT_FILES.has(source.fileName)) continue;
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && callMutatesGovernedEntity(node)) {
          violations.push(`${display(node)}:${node.expression.getText(source)}`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(violations).toEqual([]);
  });

  it('has one private implementation and one provider binding per branded port', () => {
    for (const [file, portName, providerName] of [
      [BATCH_PORT, 'BatchAggregateMutationPort', 'BATCH_AGGREGATE_MUTATION_PORT_PROVIDER'],
      [FEEDING_PORT, 'FeedingAggregateMutationPort', 'FEEDING_AGGREGATE_MUTATION_PORT_PROVIDER'],
    ] as const) {
      const source = program.getSourceFile(file);
      expect(source).toBeDefined();
      const implementations = portImplementationClasses(source!, portName);
      expect(implementations).toHaveLength(1);
      expect(
        implementations[0]!.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) ?? false,
      ).toBe(false);
      const providers = source!.statements.filter(
        (statement): statement is ts.VariableStatement =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) && declaration.name.text === providerName,
          ),
      );
      expect(providers).toHaveLength(1);
    }
  });

  it('has no callable singleton escape and no direct construction of a concrete port', () => {
    const violations: string[] = [];
    for (const source of program.getSourceFiles()) {
      if (!sourceFileSet.has(source.fileName)) continue;
      const inspect = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && RETIRED_CALLABLE_SINGLETONS.has(node.text)) {
          violations.push(`${display(node)}:${node.text}`);
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /^TypeOrm(?:Batch|Feeding)AggregateMutationPort$/.test(node.expression.text)
        ) {
          violations.push(`${display(node)}:new ${node.expression.text}`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(violations).toEqual([]);
  });

  it('exposes only closed intents over the opaque tenant mutation session', () => {
    const violations: string[] = [];
    const forbiddenPublicTypeNames = new Set([
      'EntityManager',
      'Repository',
      'DataSource',
      'QueryRunner',
      'DeepPartial',
      'FindOptionsWhere',
      'QueryDeepPartialEntity',
    ]);
    const forbiddenGenericMethod = /^(save|update|delete|insert|upsert|remove)/i;
    for (const [file, portName] of [
      [BATCH_PORT, 'BatchAggregateMutationPort'],
      [FEEDING_PORT, 'FeedingAggregateMutationPort'],
    ] as const) {
      const source = program.getSourceFile(file)!;
      const port = source.statements.find(
        (statement): statement is ts.ClassDeclaration =>
          ts.isClassDeclaration(statement) && statement.name?.text === portName,
      )!;
      for (const member of port.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const memberName = member.name.text;
        if (forbiddenGenericMethod.test(memberName)) {
          violations.push(`${portName}.${memberName}: generic mutation vocabulary`);
        }
        const first = member.parameters[0];
        if (!first?.type || first.type.getText(source) !== 'TenantMutationSession') {
          violations.push(`${portName}.${memberName}: first parameter is not opaque session`);
        }
        const inspectType = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && forbiddenPublicTypeNames.has(node.text)) {
            violations.push(`${portName}.${memberName}: public ORM type ${node.text}`);
          }
          ts.forEachChild(node, inspectType);
        };
        member.parameters.forEach(inspectType);
        if (member.type) inspectType(member.type);
      }
    }
    expect(violations).toEqual([]);
  });

  it('restricts opaque-session mint/read authority to the transaction boundary and adapters', () => {
    const uses = new Map<string, Set<string>>([
      ['mintTenantMutationSession', new Set<string>()],
      ['readTenantMutationSession', new Set<string>()],
    ]);
    for (const source of program.getSourceFiles()) {
      if (!source.fileName.startsWith(REPO_ROOT)) continue;
      const inspect = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && uses.has(node.text)) {
          uses.get(node.text)!.add(source.fileName);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect([...uses.get('mintTenantMutationSession')!].sort()).toEqual(
      [SESSION_AUTHORITY, TRANSACTION_AUTHORITY].sort(),
    );
    expect([...uses.get('readTenantMutationSession')!].sort()).toEqual(
      [
        SESSION_AUTHORITY,
        DATABASE_BARREL,
        BATCH_PORT,
        FEEDING_PORT,
        STOCK_MUTATION_LOCK_AUTHORITY,
      ].sort(),
    );
  });

  it('resolves every aggregate mutation call to an abstract injected port method', () => {
    const calls: string[] = [];
    const violations: string[] = [];
    for (const source of program.getSourceFiles()) {
      if (!sourceFileSet.has(source.fileName) || MUTATION_PORT_FILES.has(source.fileName)) continue;
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const receiverType = checker.getTypeAtLocation(node.expression.expression);
          const receiverName = receiverType.getSymbol()?.getName();
          if (
            receiverName === 'BatchAggregateMutationPort' ||
            receiverName === 'FeedingAggregateMutationPort'
          ) {
            calls.push(display(node));
            const firstArgumentType = node.arguments[0]
              ? checker.getTypeAtLocation(node.arguments[0])
              : undefined;
            if (firstArgumentType?.getSymbol()?.getName() !== 'TenantMutationSession') {
              violations.push(`${display(node)}:${node.expression.getText(source)} has no session`);
            }
            if (portNameForMethod(node) !== receiverName) {
              violations.push(`${display(node)}:${node.expression.getText(source)}`);
            }
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(calls.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });
});
