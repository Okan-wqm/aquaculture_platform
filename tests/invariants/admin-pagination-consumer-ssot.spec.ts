import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

import { compileAdminHttpContractsV1 } from '../../tools/codegen/admin-contracts/compiler';

const REPO_ROOT = process.cwd();
const ADMIN_API_ROOT = resolve(REPO_ROOT, 'apps/admin-api-service/src');
const PANEL_ROOT = resolve(REPO_ROOT, 'web/modules/admin-panel/src');
const PANEL_API_ROOT = join(PANEL_ROOT, 'services/api');

interface ClientOperation {
  readonly authority: string;
  readonly file: string;
  readonly method: string;
  readonly name: string;
  readonly paginated: boolean;
  readonly path: string;
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(?:spec|test)\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function programFromConfig(configPath: string): ts.Program {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function hasProperties(type: ts.Type, names: readonly string[]): boolean {
  const properties = new Set(type.getProperties().map(({ name }) => name));
  return names.every((name) => properties.has(name));
}

function isServerPaginationType(type: ts.Type): boolean {
  return hasProperties(type, [
    'items',
    'total',
    'page',
    'limit',
    'totalPages',
    'hasNextPage',
    'hasPreviousPage',
  ]);
}

function isBrowserPaginationType(type: ts.Type): boolean {
  return hasProperties(type, [
    'data',
    'total',
    'page',
    'limit',
    'totalPages',
    'hasNextPage',
    'hasPreviousPage',
  ]);
}

function canonicalPath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  return `/${withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? ':' : segment))
    .join('/')}`;
}

function staticEndpointPath(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return canonicalPath(expression.text);
  }
  if (!ts.isTemplateExpression(expression)) return null;
  let path = expression.head.text;
  for (const span of expression.templateSpans) {
    path += `:${span.literal.text}`;
  }
  return canonicalPath(path);
}

function staticMethod(options: ts.Expression | undefined): string {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'GET';
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'method' &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return 'GET';
}

function firstApiFetch(node: ts.Node): ts.CallExpression | null {
  let result: ts.CallExpression | null = null;
  const visit = (child: ts.Node): void => {
    if (result) return;
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'apiFetch'
    ) {
      result = child;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

function clientOperations(): readonly ClientOperation[] {
  const program = programFromConfig(resolve(REPO_ROOT, 'web/modules/admin-panel/tsconfig.json'));
  const checker = program.getTypeChecker();
  const operations: ClientOperation[] = [];

  for (const file of productionTypeScriptFiles(PANEL_API_ROOT)) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`Admin-panel program omitted ${file}`);
    for (const statement of source.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        statement.declarationList.declarations.length !== 1
      ) {
        continue;
      }
      const declaration = statement.declarationList.declarations[0];
      if (
        !declaration ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        continue;
      }
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        const call = firstApiFetch(property.initializer);
        const endpoint = call?.arguments[0];
        const path = endpoint ? staticEndpointPath(endpoint) : null;
        if (!call || !path) continue;
        const responseType = call.typeArguments?.[0];
        operations.push({
          authority: declaration.name.text,
          file: relative(REPO_ROOT, file),
          method: staticMethod(call.arguments[1]),
          name: property.name.text,
          paginated:
            responseType !== undefined && isBrowserPaginationType(checker.getTypeFromTypeNode(responseType)),
          path,
        });
      }
    }
  }
  return operations;
}

function serverPaginationOperations(): ReadonlySet<string> {
  const program = programFromConfig(resolve(REPO_ROOT, 'apps/admin-api-service/tsconfig.app.json'));
  const checker = program.getTypeChecker();
  const paginatedOperationIds = new Set<string>();

  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(ADMIN_API_ROOT) || !source.fileName.endsWith('.controller.ts')) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
          const signature = checker.getSignatureFromDeclaration(member);
          if (!signature) continue;
          const declared = checker.getReturnTypeOfSignature(signature);
          const delivered = checker.getPromisedTypeOfPromise(declared) ?? declared;
          if (isServerPaginationType(delivered)) {
            paginatedOperationIds.add(`${node.name.text}.${member.name.text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return paginatedOperationIds;
}

function calledClientOperation(node: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const { expression, name } = node.expression;
  if (!ts.isIdentifier(expression)) return null;
  return `${expression.text}.${name.text}`;
}

function forbiddenConsumerGuards(paginatedClients: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const file of productionTypeScriptFiles(PANEL_ROOT)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isAwaitExpression(node.initializer) &&
        ts.isCallExpression(node.initializer.expression)
      ) {
        const client = calledClientOperation(node.initializer.expression);
        if (client && paginatedClients.has(client)) {
          const variable = node.name.text;
          const scope = node.parent.parent.parent;
          const scan = (candidate: ts.Node): void => {
            if (candidate.pos <= node.end) {
              ts.forEachChild(candidate, scan);
              return;
            }
            if (
              ts.isCallExpression(candidate) &&
              ts.isPropertyAccessExpression(candidate.expression) &&
              ts.isIdentifier(candidate.expression.expression) &&
              candidate.expression.expression.text === 'Array' &&
              candidate.expression.name.text === 'isArray' &&
              candidate.arguments.some(
                (argument) =>
                  (ts.isIdentifier(argument) && argument.text === variable) ||
                  (ts.isPropertyAccessExpression(argument) &&
                    ts.isIdentifier(argument.expression) &&
                    argument.expression.text === variable &&
                    argument.name.text === 'data'),
              )
            ) {
              violations.push(`${relative(REPO_ROOT, file)}:${client} uses Array.isArray`);
            }
            if (
              ts.isPropertyAccessExpression(candidate) &&
              ts.isIdentifier(candidate.expression) &&
              candidate.expression.text === variable &&
              candidate.name.text === 'items'
            ) {
              violations.push(`${relative(REPO_ROOT, file)}:${client} reads .items`);
            }
            if (
              ts.isPropertyAccessChain(candidate) &&
              ts.isIdentifier(candidate.expression) &&
              candidate.expression.text === variable &&
              candidate.name.text === 'data'
            ) {
              violations.push(`${relative(REPO_ROOT, file)}:${client} optional-chains .data`);
            }
            if (
              ts.isBinaryExpression(candidate) &&
              (candidate.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
              ts.isPropertyAccessExpression(candidate.left) &&
              ts.isIdentifier(candidate.left.expression) &&
              candidate.left.expression.text === variable &&
              candidate.left.name.text === 'data'
            ) {
              violations.push(`${relative(REPO_ROOT, file)}:${client} falls back from .data`);
            }
            ts.forEachChild(candidate, scan);
          };
          scan(scope);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(violations)].sort();
}

describe('admin pagination producer/client/consumer set equality', () => {
  const compilation = compileAdminHttpContractsV1(REPO_ROOT);
  const serverPages = serverPaginationOperations();
  const clients = clientOperations();

  it('binds every matching frontend endpoint to the backend pagination authority', () => {
    expect(compilation.diagnostics).toEqual([]);
    expect(serverPages.size).toBeGreaterThan(20);
    expect(clients.filter(({ paginated }) => paginated).length).toBeGreaterThan(20);

    const backendByRoute = new Map(
      compilation.manifest.operations.map((operation) => [
        `${operation.method} ${canonicalPath(operation.path)}`,
        operation,
      ]),
    );
    const violations: string[] = [];
    for (const client of clients) {
      const backend = backendByRoute.get(`${client.method} ${client.path}`);
      if (!backend) continue;
      const serverPaginated = serverPages.has(backend.operationId);
      if (serverPaginated !== client.paginated) {
        violations.push(
          `${client.file}:${client.authority}.${client.name} declares paginated=${String(client.paginated)} ` +
            `for ${backend.operationId} paginated=${String(serverPaginated)}`,
        );
      }
    }
    expect(violations.sort()).toEqual([]);
  });

  it('does not hide canonical page contract failures behind empty-list guards', () => {
    const paginatedClients = new Set(
      clients
        .filter(({ paginated }) => paginated)
        .map(({ authority, name }) => `${authority}.${name}`),
    );
    expect(forbiddenConsumerGuards(paginatedClients)).toEqual([]);
  });
});
