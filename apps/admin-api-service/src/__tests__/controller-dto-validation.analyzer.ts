import * as path from 'path';

import * as ts from 'typescript';

const NEST_COMMON_PACKAGE = '@nestjs/common';
const DTO_METADATA_PACKAGES = ['class-validator', 'class-transformer'] as const;
const REQUEST_BINDINGS = ['Body', 'Query'] as const;

type RequestBinding = (typeof REQUEST_BINDINGS)[number];

export type ControllerDtoViolationCode =
  | 'ambiguous-binding'
  | 'any'
  | 'inline-object'
  | 'interface'
  | 'missing-type'
  | 'no-validation-metadata'
  | 'non-class'
  | 'object'
  | 'partial'
  | 'record'
  | 'type-alias'
  | 'type-only-import'
  | 'unknown'
  | 'unresolved';

export interface ControllerDtoViolation {
  readonly binding: `@${RequestBinding}()`;
  readonly code: ControllerDtoViolationCode;
  readonly file: string;
  readonly handler: string;
  readonly parameter: string;
  readonly reason: string;
}

export interface ControllerDtoAnalysis {
  readonly inspectedBindings: number;
  readonly violations: readonly ControllerDtoViolation[];
}

export interface ControllerDtoProgram {
  readonly controllerFiles: readonly string[];
  readonly program: ts.Program;
}

interface TypeClassification {
  readonly code: ControllerDtoViolationCode;
  readonly reason: string;
}

interface BindingClassification {
  readonly binding: RequestBinding;
  readonly wholeObject: boolean;
  readonly problem?: TypeClassification;
}

const TYPE_CLASSIFICATIONS: Readonly<Record<ControllerDtoViolationCode, string>> = {
  'ambiguous-binding':
    'decorator argument can be either a property name or a pipe, so whole-object binding cannot be proven',
  any: 'typed as `any`',
  'inline-object': 'typed as an inline object literal',
  interface: 'typed as a TypeScript interface, which emits Object metadata',
  'missing-type': 'has no type annotation and therefore emits Object metadata',
  'no-validation-metadata':
    'class and its base classes carry no class-validator/class-transformer property metadata',
  'non-class': 'type is not a direct class reference',
  object: 'typed as `object`/`Object`',
  partial: 'typed with `Partial`, which erases the DTO constructor',
  record: 'typed with `Record`, which erases the DTO constructor',
  'type-alias': 'typed through a type alias, which does not provide a DTO constructor',
  'type-only-import':
    'DTO class is imported with `import type` and has no runtime constructor binding',
  unknown: 'typed as `unknown`',
  unresolved: 'type does not resolve to a declaration',
};

function classification(code: ControllerDtoViolationCode): TypeClassification {
  return { code, reason: TYPE_CLASSIFICATIONS[code] };
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replaceAll('\\', '/');
}

function symbolAt(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  const seen = new Set<ts.Symbol>();

  while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    if (seen.has(symbol)) return undefined;
    seen.add(symbol);
    const target = checker.getAliasedSymbol(symbol);
    if (target === symbol) break;
    symbol = target;
  }

  return symbol;
}

function declarationComesFromPackage(declaration: ts.Declaration, packageName: string): boolean {
  const fileName = normalizePath(declaration.getSourceFile().fileName);
  return fileName.includes(`/node_modules/${packageName}/`);
}

function symbolComesFromPackage(symbol: ts.Symbol, packageName: string): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) =>
    declarationComesFromPackage(declaration, packageName),
  );
}

function decoratorCallee(decorator: ts.Decorator): ts.Expression {
  return ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
}

function decoratorSymbol(decorator: ts.Decorator, checker: ts.TypeChecker): ts.Symbol | undefined {
  const callee = decoratorCallee(decorator);
  if (ts.isPropertyAccessExpression(callee)) {
    return symbolAt(callee.name, checker) ?? symbolAt(callee, checker);
  }
  return symbolAt(callee, checker);
}

function nestRequestBinding(
  decorator: ts.Decorator,
  checker: ts.TypeChecker,
): RequestBinding | undefined {
  const symbol = decoratorSymbol(decorator, checker);
  if (!symbol || !symbolComesFromPackage(symbol, NEST_COMMON_PACKAGE)) return undefined;

  const symbolName = symbol.getName();
  return REQUEST_BINDINGS.find((binding) => binding === symbolName);
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function isDefinitelyString(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isDefinitelyString);
  return Boolean(type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral));
}

function canBeString(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(canBeString);
  return Boolean(
    type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.String |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.Unknown),
  );
}

function isDefinitelyNil(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isDefinitelyNil);
  return Boolean(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
}

function canBeNil(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(canBeNil);
  return Boolean(
    type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Null |
        ts.TypeFlags.TypeParameter |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Void),
  );
}

function classifyRequestBinding(
  decorator: ts.Decorator,
  checker: ts.TypeChecker,
): BindingClassification | undefined {
  const binding = nestRequestBinding(decorator, checker);
  if (!binding) return undefined;

  if (!ts.isCallExpression(decorator.expression) || decorator.expression.arguments.length === 0) {
    return { binding, wholeObject: true };
  }

  const firstArgument = decorator.expression.arguments[0];
  if (!firstArgument) return { binding, wholeObject: true };
  const argumentType = checker.getTypeAtLocation(firstArgument);

  // Nest treats a string first argument as a property selector. Undefined/null
  // means the whole object, while every non-string value is a pipe. A union that
  // spans those runtime categories cannot be classified safely at build time.
  if (isDefinitelyString(argumentType)) return { binding, wholeObject: false };
  if (isDefinitelyNil(argumentType)) return { binding, wholeObject: true };
  if (canBeString(argumentType) || canBeNil(argumentType)) {
    return {
      binding,
      wholeObject: true,
      problem: classification('ambiguous-binding'),
    };
  }
  return { binding, wholeObject: true };
}

function rootIdentifier(name: ts.EntityName): ts.Identifier {
  let current = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current;
}

function isTypeOnlyImportDeclaration(declaration: ts.Declaration): boolean {
  let ancestor: ts.Node | undefined = declaration.parent;
  while (ancestor && !ts.isImportClause(ancestor)) ancestor = ancestor.parent;
  const importIsTypeOnly = Boolean(ancestor && ts.isImportClause(ancestor) && ancestor.isTypeOnly);

  if (ts.isImportSpecifier(declaration)) {
    return declaration.isTypeOnly || importIsTypeOnly;
  }
  if (ts.isNamespaceImport(declaration)) {
    return importIsTypeOnly;
  }
  return false;
}

function referenceUsesTypeOnlyImport(
  typeNode: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): boolean {
  const localSymbol = checker.getSymbolAtLocation(rootIdentifier(typeNode.typeName));
  return (localSymbol?.getDeclarations() ?? []).some(isTypeOnlyImportDeclaration);
}

function rightmostTypeName(typeName: ts.EntityName): string {
  return ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
}

function metadataDecorator(decorator: ts.Decorator, checker: ts.TypeChecker): boolean {
  const symbol = decoratorSymbol(decorator, checker);
  return Boolean(
    symbol &&
      DTO_METADATA_PACKAGES.some((packageName) => symbolComesFromPackage(symbol, packageName)),
  );
}

function classDeclarationsForType(type: ts.Type): readonly ts.ClassDeclaration[] {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (symbol?.getDeclarations() ?? []).filter(ts.isClassDeclaration);
}

function classCarriesDtoMetadata(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  visited: Set<ts.ClassDeclaration>,
): boolean {
  if (visited.has(declaration)) return false;
  visited.add(declaration);

  for (const member of declaration.members) {
    if (
      (ts.isPropertyDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      decoratorsOf(member).some((decorator) => metadataDecorator(decorator, checker))
    ) {
      return true;
    }
  }

  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const heritageType of clause.types) {
      const baseType = checker.getTypeAtLocation(heritageType);
      for (const baseClass of classDeclarationsForType(baseType)) {
        if (classCarriesDtoMetadata(baseClass, checker, visited)) return true;
      }
    }
  }

  return false;
}

function classifyParameterType(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): TypeClassification | undefined {
  const typeNode = parameter.type;
  if (!typeNode) return classification('missing-type');
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword) return classification('any');
  if (typeNode.kind === ts.SyntaxKind.UnknownKeyword) return classification('unknown');
  if (typeNode.kind === ts.SyntaxKind.ObjectKeyword) return classification('object');
  if (ts.isTypeLiteralNode(typeNode)) return classification('inline-object');
  if (!ts.isTypeReferenceNode(typeNode)) return classification('non-class');

  const typeName = rightmostTypeName(typeNode.typeName);
  if (typeName === 'Record') return classification('record');
  if (typeName === 'Partial') return classification('partial');
  if (typeName === 'Object') return classification('object');
  if (referenceUsesTypeOnlyImport(typeNode, checker)) return classification('type-only-import');

  const symbol = symbolAt(typeNode.typeName, checker);
  const declarations = symbol?.getDeclarations() ?? [];
  if (!symbol || declarations.length === 0) return classification('unresolved');
  if (declarations.some(ts.isInterfaceDeclaration)) return classification('interface');
  if (declarations.some(ts.isTypeAliasDeclaration)) return classification('type-alias');

  const classDeclaration = declarations.find(ts.isClassDeclaration);
  if (!classDeclaration) return classification('non-class');
  if (!classCarriesDtoMetadata(classDeclaration, checker, new Set())) {
    return classification('no-validation-metadata');
  }
  return undefined;
}

function methodName(method: ts.MethodDeclaration, sourceFile: ts.SourceFile): string {
  return method.name.getText(sourceFile);
}

export function analyzeControllerDtoContracts(
  program: ts.Program,
  controllerFiles: readonly string[],
  repositoryRoot: string,
): ControllerDtoAnalysis {
  const checker = program.getTypeChecker();
  const controllerPaths = new Set(controllerFiles.map(normalizePath));
  const violations: ControllerDtoViolation[] = [];
  let inspectedBindings = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (!controllerPaths.has(normalizePath(sourceFile.fileName))) continue;
    const file = path.relative(repositoryRoot, sourceFile.fileName).replaceAll('\\', '/');

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        for (const parameter of node.parameters) {
          for (const decorator of decoratorsOf(parameter)) {
            const requestBinding = classifyRequestBinding(decorator, checker);
            if (!requestBinding?.wholeObject) continue;
            inspectedBindings += 1;

            const problem = requestBinding.problem ?? classifyParameterType(parameter, checker);
            if (!problem) continue;
            violations.push({
              binding: `@${requestBinding.binding}()`,
              code: problem.code,
              file,
              handler: methodName(node, sourceFile),
              parameter: parameter.name.getText(sourceFile),
              reason: problem.reason,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    inspectedBindings,
    violations: violations.sort((left, right) =>
      `${left.file}:${left.handler}:${left.parameter}`.localeCompare(
        `${right.file}:${right.handler}:${right.parameter}`,
      ),
    ),
  };
}

export function loadControllerDtoProgram(
  serviceSourceRoot: string,
  tsconfigPath: string,
): ControllerDtoProgram {
  const parseHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, parseHost);
  if (!parsed) throw new Error(`Unable to parse TypeScript config: ${tsconfigPath}`);

  const controllerFiles = ts.sys
    .readDirectory(serviceSourceRoot, ['.ts'], undefined, ['**/*.controller.ts'])
    .filter((file) => !file.endsWith('.spec.ts') && !file.endsWith('.test.ts'))
    .sort();

  return {
    controllerFiles,
    program: ts.createProgram({ rootNames: controllerFiles, options: parsed.options }),
  };
}
