import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

const ADMIN_SOURCE = resolve(process.cwd(), 'apps/admin-api-service/src');
const MUTATION_DECORATORS = new Set(['Post', 'Put', 'Patch', 'Delete']);

interface ControllerMethod {
  readonly file: string;
  readonly className: string;
  readonly methodName: string;
  readonly decorators: ReadonlySet<string>;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

function decoratorNames(node: ts.Node): ReadonlySet<string> {
  if (!ts.canHaveDecorators(node)) return new Set();
  return new Set(
    (ts.getDecorators(node) ?? [])
      .map(decoratorName)
      .filter((name): name is string => name !== undefined),
  );
}

function adminControllerMethods(): {
  readonly methods: readonly ControllerMethod[];
  readonly classSkipViolations: readonly string[];
} {
  const methods: ControllerMethod[] = [];
  const classSkipViolations: string[] = [];

  for (const file of filesUnder(ADMIN_SOURCE)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const classDecorators = decoratorNames(statement);
      if (!classDecorators.has('Controller')) continue;
      const className = statement.name?.text ?? '<anonymous>';
      if (classDecorators.has('SkipThrottle')) {
        classSkipViolations.push(`${file}:${className}`);
      }

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const methodName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText();
        methods.push({
          file,
          className,
          methodName,
          decorators: decoratorNames(member),
        });
      }
    }
  }

  return { methods, classSkipViolations };
}

describe('admin mutation throttle coverage', () => {
  const catalog = adminControllerMethods();

  it('allows throttle skips only as a method-level public-probe decision', () => {
    expect(catalog.classSkipViolations).toEqual([]);
    const violations = catalog.methods
      .filter(
        (method) =>
          [...MUTATION_DECORATORS].some((name) => method.decorators.has(name)) &&
          method.decorators.has('SkipThrottle') &&
          !method.decorators.has('Public'),
      )
      .map((method) => `${method.file}:${method.className}.${method.methodName}`);
    expect(violations).toEqual([]);
  });

  it.each([
    'HealthController.resetCircuitBreaker',
    'UsersController.resetUserPassword',
    'ImpersonationController.grantPermission',
    'ImpersonationController.revokePermission',
  ])('%s uses the sensitive bucket', (qualifiedName) => {
    const method = catalog.methods.find(
      (candidate) => `${candidate.className}.${candidate.methodName}` === qualifiedName,
    );
    expect(method).toBeDefined();
    expect(method?.decorators.has('ThrottleSensitive')).toBe(true);
  });
});
