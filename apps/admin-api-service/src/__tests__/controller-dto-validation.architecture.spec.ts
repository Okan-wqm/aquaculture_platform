/**
 * Architecture invariant — Phase-1 RC-2: interface-typed @Body()/@Query() bypass
 * the global ValidationPipe.
 *
 * The platform installs `ValidationPipe({ whitelist:true, forbidNonWhitelisted:true,
 * transform:true })` globally (libs/backend-common/src/bootstrap/create-service-app.ts).
 * class-validator / class-transformer can only act on a parameter whose reflected
 * design-type is a CLASS carrying validation metadata. When a controller types a
 * whole-object `@Body()` or `@Query()` parameter as a TypeScript interface, a bare
 * `Record`/`object`/`any`, or an inline object literal, the reflected metatype erases
 * to `Object` and the pipe validates and transforms NOTHING — arbitrary unshaped
 * input flows straight into handlers (and, for sortBy, into raw SQL ORDER BY).
 *
 * This gate statically resolves the declared type of every whole-object `@Body()`
 * and `@Query()` parameter across `apps/admin-api-service/src/**\/*.controller.ts`
 * and FAILS unless that type resolves to a class declaration whose properties carry
 * class-validator / class-transformer decorators.
 *
 * There is deliberately NO allowlist. A new interface-typed request body cannot be
 * excepted here — it must be converted to a decorated DTO class.
 */

import * as path from 'path';

import * as ts from 'typescript';

interface Violation {
  file: string;
  handler: string;
  param: string;
  reason: string;
}

const SERVICE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const VALIDATION_DECORATOR_MODULES = new Set(['class-validator', 'class-transformer']);

// ---------------------------------------------------------------------------
// TypeScript program (type resolution across files, no emit, no type-check gate)
// ---------------------------------------------------------------------------

function loadProgram(): { program: ts.Program; checker: ts.TypeChecker; controllerFiles: string[] } {
  const configPath = path.resolve(SERVICE_ROOT, '../tsconfig.spec.json');
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {
      /* resolution diagnostics are irrelevant to this structural gate */
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (!parsed) {
    throw new Error(`Unable to parse ${configPath}`);
  }

  const controllerFiles = collectControllerFiles(SERVICE_ROOT);
  const program = ts.createProgram({
    rootNames: controllerFiles,
    options: parsed.options,
  });
  return { program, checker: program.getTypeChecker(), controllerFiles };
}

function collectControllerFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of ts.sys.readDirectory(dir, ['.ts'])) {
    if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      results.push(entry);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Decorator helpers
// ---------------------------------------------------------------------------

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function decoratorArgCount(decorator: ts.Decorator): number {
  const expr = decorator.expression;
  return ts.isCallExpression(expr) ? expr.arguments.length : 0;
}

function findParamDecorator(
  param: ts.ParameterDeclaration,
  name: string,
): ts.Decorator | undefined {
  if (!ts.canHaveDecorators(param)) return undefined;
  return ts.getDecorators(param)?.find((d) => decoratorName(d) === name);
}

// Collect the local binding names imported from class-validator / class-transformer
// in a given source file (handles aliased imports).
const validatorImportCache = new WeakMap<ts.SourceFile, Set<string>>();
function validatorNamesInFile(sf: ts.SourceFile): Set<string> {
  const cached = validatorImportCache.get(sf);
  if (cached) return cached;
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!VALIDATION_DECORATOR_MODULES.has(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        names.add(el.name.text);
      }
    }
  }
  validatorImportCache.set(sf, names);
  return names;
}

// ---------------------------------------------------------------------------
// Type classification
// ---------------------------------------------------------------------------

function resolveTypeDeclarations(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.Declaration[] {
  if (!ts.isTypeReferenceNode(typeNode)) return [];
  let symbol = checker.getSymbolAtLocation(typeNode.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.getDeclarations() ?? [];
}

function classCarriesValidation(
  classDecl: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  seen: Set<ts.ClassDeclaration>,
): boolean {
  if (seen.has(classDecl)) return false;
  seen.add(classDecl);

  const validatorNames = validatorNamesInFile(classDecl.getSourceFile());
  for (const member of classDecl.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (!ts.canHaveDecorators(member)) continue;
    for (const dec of ts.getDecorators(member) ?? []) {
      const name = decoratorName(dec);
      if (name && validatorNames.has(name)) return true;
    }
  }

  // A DTO may inherit its decorated properties from a base class.
  for (const clause of classDecl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeExpr of clause.types) {
      let baseSymbol = checker.getSymbolAtLocation(typeExpr.expression);
      if (baseSymbol && baseSymbol.flags & ts.SymbolFlags.Alias) {
        baseSymbol = checker.getAliasedSymbol(baseSymbol);
      }
      for (const decl of baseSymbol?.getDeclarations() ?? []) {
        if (ts.isClassDeclaration(decl) && classCarriesValidation(decl, checker, seen)) {
          return true;
        }
      }
    }
  }
  return false;
}

// Returns a failure reason string, or null when the parameter type is an
// acceptable validated DTO class.
function classifyParamType(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): string | null {
  const typeNode = param.type;
  if (!typeNode) return 'no type annotation (metatype Object)';

  switch (typeNode.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return 'typed as `any`';
    case ts.SyntaxKind.UnknownKeyword:
      return 'typed as `unknown`';
    case ts.SyntaxKind.ObjectKeyword:
      return 'typed as `object`';
    default:
      break;
  }
  if (ts.isTypeLiteralNode(typeNode)) return 'inline object-literal type';

  if (ts.isTypeReferenceNode(typeNode)) {
    const refName = ts.isIdentifier(typeNode.typeName)
      ? typeNode.typeName.text
      : typeNode.typeName.right.text;
    if (refName === 'Record' || refName === 'Object' || refName === 'Partial') {
      return `typed as \`${refName}<...>\` (erases to Object)`;
    }
  } else {
    return 'not a class reference';
  }

  const declarations = resolveTypeDeclarations(typeNode, checker);
  if (declarations.length === 0) return 'type does not resolve to a declaration';

  const classDecl = declarations.find(ts.isClassDeclaration);
  if (classDecl) {
    if (classCarriesValidation(classDecl, checker, new Set())) return null;
    return 'class carries no class-validator/class-transformer metadata';
  }
  if (declarations.some(ts.isInterfaceDeclaration)) {
    return 'TypeScript interface (erases to Object at runtime)';
  }
  if (declarations.some(ts.isTypeAliasDeclaration)) {
    return 'type alias (not a decorated class)';
  }
  return 'not a validated DTO class';
}

// ---------------------------------------------------------------------------
// Controller walk
// ---------------------------------------------------------------------------

function collectViolations(program: ts.Program, checker: ts.TypeChecker, controllerFiles: string[]): {
  violations: Violation[];
  inspected: number;
} {
  const violations: Violation[] = [];
  const controllerSet = new Set(controllerFiles.map((f) => path.resolve(f)));
  let inspected = 0;

  for (const sf of program.getSourceFiles()) {
    if (!controllerSet.has(path.resolve(sf.fileName))) continue;
    const relFile = path.relative(REPO_ROOT, sf.fileName);

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const isController = (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined)?.some(
          (d) => decoratorName(d) === 'Controller',
        );
        if (isController) {
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            const handler = member.name.getText(sf);
            for (const param of member.parameters) {
              const bodyDec = findParamDecorator(param, 'Body');
              const queryDec = findParamDecorator(param, 'Query');

              // Whole-object bindings only: @Body() with no property arg, and
              // @Query() with no property-name arg. @Body('x')/@Query('x') pull a
              // single primitive and are not scanned here.
              const isWholeBody = bodyDec !== undefined && decoratorArgCount(bodyDec) === 0;
              const isWholeQuery = queryDec !== undefined && decoratorArgCount(queryDec) === 0;
              if (!isWholeBody && !isWholeQuery) continue;

              const reason = classifyParamType(param, checker);
              if (reason) {
                const paramName = param.name.getText(sf);
                const binding = isWholeBody ? '@Body()' : '@Query()';
                violations.push({
                  file: relFile,
                  handler,
                  param: `${binding} ${paramName}`,
                  reason,
                });
              }
              inspected++;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { violations, inspected };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Controller @Body()/@Query() ValidationPipe contract (RC-2)', () => {
  let violations: Violation[];
  let inspected: number;

  beforeAll(() => {
    const { program, checker, controllerFiles } = loadProgram();
    const result = collectViolations(program, checker, controllerFiles);
    violations = result.violations;
    inspected = result.inspected;
  }, 120_000);

  it('inspects a non-trivial number of whole-object body/query parameters', () => {
    expect(inspected).toBeGreaterThan(50);
  });

  it('every whole-object @Body()/@Query() parameter resolves to a validated DTO class', () => {
    if (violations.length > 0) {
      const lines = violations
        .map((v) => `  ${v.file} :: ${v.handler} :: ${v.param} — ${v.reason}`)
        .sort();
      throw new Error(
        `${violations.length} whole-object @Body()/@Query() parameter(s) bypass the global ValidationPipe ` +
          `because their declared type is not a class carrying class-validator metadata.\n` +
          `Convert each to a decorated DTO class (see docs/reviews .../findings, RC-2):\n${lines.join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
