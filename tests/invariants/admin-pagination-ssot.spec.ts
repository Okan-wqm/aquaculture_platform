import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

const REPO_ROOT = process.cwd();
const PLATFORM_MODULE = '@platform/pagination-contracts';
const BACKEND_BRIDGE_MODULE = '@aquaculture/backend-common/pagination';

const PAGINATION_CONSUMER_ROOTS = [
  'apps/admin-api-service/src',
  'web/modules/admin-panel/src/services',
  'apps/farm-service/src',
  'web/modules/farm-module/src',
] as const;

function productionTypeScriptFiles(root: string): string[] {
  const absoluteRoot = join(REPO_ROOT, root);
  const files: string[] = [];
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visitDirectory(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(?:spec|test)\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visitDirectory(absoluteRoot);
  return files.sort();
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function staticPropertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isStandardPageFieldSet(fields: ReadonlySet<string>): boolean {
  return (
    fields.has('total') &&
    fields.has('page') &&
    fields.has('limit') &&
    (fields.has('items') || fields.has('data'))
  );
}

function typeMemberNames(members: ts.NodeArray<ts.TypeElement | ts.ClassElement>): Set<string> {
  return new Set(
    members
      .map((member) => ('name' in member ? staticPropertyName(member.name) : null))
      .filter((name): name is string => name !== null),
  );
}

function objectPropertyNames(node: ts.ObjectLiteralExpression): Set<string> {
  return new Set(
    node.properties
      .map((property) => staticPropertyName(property.name))
      .filter((name): name is string => name !== null),
  );
}

function moduleName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

describe('platform pagination single source of truth', () => {
  it('has no local result-shape declarations or hand-written result objects', () => {
    const violations: string[] = [];

    for (const root of PAGINATION_CONSUMER_ROOTS) {
      for (const path of productionTypeScriptFiles(root)) {
        const source = sourceFile(path);
        const displayPath = relative(REPO_ROOT, path);

        const visit = (node: ts.Node): void => {
          if (
            (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) &&
            isStandardPageFieldSet(typeMemberNames(node.members))
          ) {
            violations.push(
              `${displayPath}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} declares a pagination result shape`,
            );
          }
          if (
            ts.isTypeAliasDeclaration(node) &&
            ts.isTypeLiteralNode(node.type) &&
            isStandardPageFieldSet(typeMemberNames(node.type.members))
          ) {
            violations.push(
              `${displayPath}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} declares a pagination result type`,
            );
          }
          if (
            ts.isObjectLiteralExpression(node) &&
            isStandardPageFieldSet(objectPropertyNames(node))
          ) {
            violations.push(
              `${displayPath}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} constructs a pagination result object`,
            );
          }
          if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
            const importsFactory =
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.some(
                (element) =>
                  (element.propertyName ?? element.name).text === 'createStandardPaginatedResult',
              );
            if (importsFactory && moduleName(node) !== BACKEND_BRIDGE_MODULE) {
              violations.push(
                `${displayPath}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} imports the pagination factory outside the backend bridge`,
              );
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(source);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps each consumer bridge bound to the versioned platform authority', () => {
    const baseConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    expect(baseConfig.compilerOptions?.paths?.[PLATFORM_MODULE]).toEqual([
      'platform/libs/pagination-contracts/src/index.ts',
    ]);

    const backendBridge = sourceFile(
      join(REPO_ROOT, 'libs/backend-common/src/pagination/pagination.dto.ts'),
    );
    const frontendBridge = sourceFile(
      join(REPO_ROOT, 'web/modules/admin-panel/src/services/types/common.ts'),
    );
    const sharedUiTypes = sourceFile(join(REPO_ROOT, 'web/shared-ui/src/types/index.ts'));

    expect(
      backendBridge.statements.filter(
        (statement) =>
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          moduleName(statement) === PLATFORM_MODULE,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      frontendBridge.statements.some(
        (statement) =>
          ts.isExportDeclaration(statement) && moduleName(statement) === PLATFORM_MODULE,
      ),
    ).toBe(true);
    expect(
      sharedUiTypes.statements.some(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
          statement.name.text === 'StandardPaginatedResult',
      ),
    ).toBe(false);
  });
});
