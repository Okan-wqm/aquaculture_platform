import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_ROOTS = ['apps', 'libs', 'platform', 'web'] as const;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly registerEnumTarget: string;
  readonly reason: string;
}

function listRegisterEnumTypeFiles(): readonly string[] {
  const args = [
    'grep',
    '-l',
    '-z',
    'registerEnumType',
    '--',
    ...SOURCE_ROOTS.flatMap((root) => [`${root}/**/*.ts`, `${root}/**/*.tsx`]),
  ];
  let output = '';
  try {
    output = execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 1
    ) {
      return [];
    }
    throw error;
  }

  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.endsWith('.d.ts'));
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function objectProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | undefined {
  return objectLiteral.properties.find((property): property is ts.PropertyAssignment => {
    return (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === propertyName
    );
  });
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return line + 1;
}

function registerEnumTarget(node: ts.CallExpression): string {
  const target = node.arguments[0];
  return target && ts.isIdentifier(target) ? target.text : '<non-identifier enum target>';
}

function valuesMapViolations(file: string): readonly Violation[] {
  const body = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const sourceFile = ts.createSourceFile(
    file,
    body,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerEnumType'
    ) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const valuesMap = objectProperty(options, 'valuesMap');
        if (valuesMap && ts.isObjectLiteralExpression(valuesMap.initializer)) {
          for (const enumEntry of valuesMap.initializer.properties) {
            if (ts.isSpreadAssignment(enumEntry)) {
              violations.push({
                file,
                line: sourceLine(sourceFile, enumEntry),
                registerEnumTarget: registerEnumTarget(node),
                reason: 'valuesMap entries must be explicit metadata objects; spread can hide unsupported fields',
              });
              continue;
            }
            if (!ts.isPropertyAssignment(enumEntry)) {
              continue;
            }
            if (!ts.isObjectLiteralExpression(enumEntry.initializer)) {
              violations.push({
                file,
                line: sourceLine(sourceFile, enumEntry),
                registerEnumTarget: registerEnumTarget(node),
                reason: 'valuesMap entry must be an object literal metadata block',
              });
              continue;
            }
            const valueOverride = objectProperty(enumEntry.initializer, 'value');
            if (valueOverride) {
              violations.push({
                file,
                line: sourceLine(sourceFile, valueOverride),
                registerEnumTarget: registerEnumTarget(node),
                reason: 'NestJS registerEnumType valuesMap does not support value overrides',
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('GraphQL enum valuesMap metadata contract', () => {
  it('keeps registerEnumType valuesMap entries metadata-only', () => {
    const violations = listRegisterEnumTypeFiles().flatMap(valuesMapViolations);

    expect(violations).toEqual([]);
  });
});
