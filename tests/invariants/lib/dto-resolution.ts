/**
 * Request-DTO resolution — what type does a `@Body()` / `@Query()` parameter
 * actually name, and is that type a validated class? (CONTRACT-CRITICAL-003)
 *
 * An `interface`-typed body compiles to `design:paramtypes = Object`, so
 * `ValidationPipe` skips the parameter entirely and Swagger emits `{}`. The
 * declaration therefore has to be followed to its source: a name imported
 * from a barrel, re-exported through `export * from`, or reached by a
 * tsconfig path alias must still land on a `class`. Anything that cannot be
 * resolved is reported rather than assumed good — the gate fails closed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export type DeclarationKind = 'class' | 'interface' | 'type-alias' | 'builtin' | 'unresolved';

export interface RequestDtoParameter {
  /** `<repo-relative controller>#<method>(<parameter>)` */
  readonly id: string;
  readonly file: string;
  readonly method: string;
  readonly decorator: 'Body' | 'Query';
  /** `@Body('key')` picks one property out of the payload; only unkeyed binds the whole DTO. */
  readonly keyed: boolean;
  readonly typeText: string;
  readonly kind: DeclarationKind;
  /** Where the class was declared, when it resolved to one. */
  readonly declaredIn: string | null;
  readonly line: number;
}

/** Types that are never a DTO class and never need to be. */
const BUILTIN = new Set([
  'string',
  'number',
  'boolean',
  'Date',
  'Buffer',
  'Record',
  'Array',
  'Object',
  'unknown',
  'any',
]);

const sourceCache = new Map<string, ts.SourceFile | null>();

function parseFile(absNoExt: string): ts.SourceFile | null {
  const cached = sourceCache.get(absNoExt);
  if (cached !== undefined) return cached;
  for (const candidate of [absNoExt, `${absNoExt}.ts`, join(absNoExt, 'index.ts')]) {
    try {
      const parsed = ts.createSourceFile(
        candidate,
        readFileSync(candidate, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      sourceCache.set(absNoExt, parsed);
      return parsed;
    } catch {
      // try the next shape
    }
  }
  sourceCache.set(absNoExt, null);
  return null;
}

let pathAliases: Record<string, string[]> | null = null;

function aliasTarget(specifier: string): string | null {
  if (pathAliases === null) {
    const raw = readFileSync(resolve(REPO_ROOT, 'tsconfig.base.json'), 'utf8').replace(
      /^\s*\/\/.*$/gm,
      '',
    );
    const parsed = JSON.parse(raw) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    pathAliases = parsed.compilerOptions?.paths ?? {};
  }
  const mapped = pathAliases[specifier]?.[0];
  return mapped === undefined ? null : resolve(REPO_ROOT, mapped);
}

function moduleTarget(fromFile: string, specifier: string): string | null {
  return specifier.startsWith('.') ? resolve(dirname(fromFile), specifier) : aliasTarget(specifier);
}

export interface Resolution {
  readonly kind: DeclarationKind;
  readonly file: string | null;
  readonly node: ts.ClassDeclaration | null;
  /**
   * The interface declaration when `kind === 'interface'`. The DTO gates only
   * care whether a body resolved to a class, but the money-typing gate
   * (BILLING-CRITICAL-002) needs the members of a jsonb column's value type,
   * and those are almost always an interface.
   */
  readonly interfaceNode?: ts.InterfaceDeclaration | null;
}

const UNRESOLVED: Resolution = { kind: 'unresolved', file: null, node: null };

/** Follow `name` from `file` through imports and re-exports to its declaration. */
export function resolveDeclaration(
  file: string,
  name: string,
  seen = new Set<string>(),
): Resolution {
  if (BUILTIN.has(name)) return { kind: 'builtin', file: null, node: null };
  const key = `${file}#${name}`;
  if (seen.has(key)) return UNRESOLVED;
  seen.add(key);

  const source = parseFile(file);
  if (!source) return UNRESOLVED;

  let found: Resolution | null = null;
  const reexports: string[] = [];

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isClassDeclaration(node) && node.name?.text === name) {
      found = { kind: 'class', file: source.fileName, node };
    } else if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = { kind: 'interface', file: source.fileName, node: null, interfaceNode: node };
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = { kind: 'type-alias', file: source.fileName, node: null };
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if (element.name.text !== name) continue;
        const target = moduleTarget(source.fileName, node.moduleSpecifier.text);
        found = target
          ? resolveDeclaration(target, (element.propertyName ?? element.name).text, seen)
          : UNRESOLVED;
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = moduleTarget(source.fileName, node.moduleSpecifier.text);
      if (target) reexports.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found) return found;

  for (const target of reexports) {
    const resolved = resolveDeclaration(target, name, seen);
    if (resolved.kind !== 'unresolved') return resolved;
  }
  return UNRESOLVED;
}

/** Names imported from `class-validator` in one file — the decorators that arm validation. */
function validatorImports(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'class-validator' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) names.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // `@TenantIdCarrier()` is `Allow()` under a name that says what the key is
  // for (ADMIN-CRITICAL-009); it arms the whitelist exactly like a validator.
  names.add('TenantIdCarrier');
  return names;
}

/** Does this class — or a class it extends — carry a class-validator property decorator? */
export function hasValidatorDecorator(
  node: ts.ClassDeclaration,
  file: string,
  seen = new Set<string>(),
): boolean {
  const source = node.getSourceFile();
  const validators = validatorImports(source);
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    for (const decorator of ts.getDecorators(member) ?? []) {
      const expression = decorator.expression;
      const name = ts.isCallExpression(expression)
        ? ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : ''
        : ts.isIdentifier(expression)
          ? expression.text
          : '';
      if (validators.has(name)) return true;
    }
  }
  // Inheritance: `extends Base` and `extends PartialType(Base)` both keep the
  // base's validators, so a derived class that adds no property of its own is
  // still validated.
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      const baseNames: string[] = [];
      if (ts.isIdentifier(type.expression)) baseNames.push(type.expression.text);
      else if (ts.isCallExpression(type.expression)) {
        for (const argument of type.expression.arguments) {
          if (ts.isIdentifier(argument)) baseNames.push(argument.text);
        }
      }
      for (const baseName of baseNames) {
        const key = `${file}#${baseName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const base = resolveDeclaration(file, baseName);
        if (base.node && base.file && hasValidatorDecorator(base.node, base.file, seen))
          return true;
      }
    }
  }
  return false;
}

/** Every `@Body()` / `@Query()` parameter declared by one controller file. */
export function requestDtoParametersIn(file: string): RequestDtoParameter[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(REPO_ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parameters: RequestDtoParameter[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      for (const parameter of node.parameters) {
        for (const decorator of ts.getDecorators(parameter) ?? []) {
          const expression = decorator.expression;
          if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) continue;
          const decoratorName = expression.expression.text;
          if (decoratorName !== 'Body' && decoratorName !== 'Query') continue;
          const first = expression.arguments[0];
          const keyed = first !== undefined && ts.isStringLiteral(first);
          const type = parameter.type;
          let kind: DeclarationKind = 'unresolved';
          let declaredIn: string | null = null;
          if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
            const resolved = resolveDeclaration(resolve(REPO_ROOT, file), type.typeName.text);
            kind = resolved.kind;
            declaredIn = resolved.file;
          } else if (type) {
            kind = 'builtin';
          }
          parameters.push({
            id: `${file}#${node.name.text}(${parameter.name.getText(source)})`,
            file,
            method: node.name.text,
            decorator: decoratorName,
            keyed,
            typeText: type ? type.getText(source).replace(/\s+/g, ' ') : '(untyped)',
            kind,
            declaredIn,
            line: source.getLineAndCharacterOfPosition(parameter.getStart()).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parameters;
}
