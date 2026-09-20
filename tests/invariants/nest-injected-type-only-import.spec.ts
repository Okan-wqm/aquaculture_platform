/**
 * nest-injected-type-only-import.spec.ts — a class Nest may instantiate must
 * not depend on a type-only import.
 *
 * WHY: NestJS resolves constructor parameters through the `design:paramtypes`
 * metadata `emitDecoratorMetadata` writes for decorated classes. A type-only
 * import (`import type { X }` or `import { type X }`) is erased at compile
 * time, so the metadata for that parameter degrades to `Object`/`Function`
 * and the container fails at boot with "Nest can't resolve dependencies of
 * the Y (…, ?)". The compiler, the linter and every unit test that builds the
 * class by hand stay green; the first thing that runs the module graph is the
 * production container. billing-service carried `import type
 * { DiscountCodeService }` in ModulePricingService from 2026-09-07 and could
 * not boot until the 2026-09-20 outage exposed it.
 *
 * The same erasure hits a parameter typed with an interface or a type alias
 * declared in the file itself: `constructor(options: LimiterOptions = {})`
 * leaves `Object` in the metadata, and a `useClass` registration of that
 * class fails the same way (gateway-api's TenantConnectionLimiter, same
 * outage).
 *
 * And it hits any annotation that is not a plain class reference: a utility
 * type such as `Pick<Service, 'check'>` (farm-service's
 * TenantOnboardingEventHandler, same outage), a union, an object literal, a
 * primitive — all of them become `Object` in the metadata.
 *
 * RULE: in every class decorated with a Nest instantiation decorator
 * (@Injectable, @Controller, @Resolver), a constructor parameter that carries
 * no explicit token decorator (@Inject*, which sets the token itself) and is
 * not @Optional() must be annotated with a plain reference to a value-level
 * class: not a type-only import, not a same-file interface or type alias,
 * not a utility type, union, literal or primitive. Either import the class as
 * a value, inject the options through a token, or remove the decorator when
 * the class is built by hand (`useFactory`).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_GLOBS = ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts', 'platform/libs/*/src/**/*.ts'];
const INSTANTIATION_DECORATORS: ReadonlySet<string> = new Set([
  'Injectable',
  'Controller',
  'Resolver',
]);
/** Type-level constructs whose metadata degrades to `Object` (or to a token nobody provides). */
const UTILITY_TYPES: ReadonlySet<string> = new Set([
  'Pick',
  'Omit',
  'Partial',
  'Required',
  'Readonly',
  'Record',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'InstanceType',
  'Parameters',
  'ConstructorParameters',
  'Awaited',
  'Promise',
  'Array',
  'ReadonlyArray',
  'Map',
  'Set',
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly className: string;
  readonly dependency: string;
}

function isTestOrDeclaration(file: string): boolean {
  return (
    file.endsWith('.d.ts') ||
    /\.(spec|test)\.tsx?$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/__mocks__/')
  );
}

/** Files that declare a class Nest may instantiate; everything else cannot violate. */
export function listCandidateFiles(): readonly string[] {
  let output = '';
  try {
    output = execFileSync(
      'git',
      ['grep', '-l', '-z', '-E', '@(Injectable|Controller|Resolver)\\(', '--', ...SOURCE_GLOBS],
      { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return [];
    }
    throw error;
  }
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => !isTestOrDeclaration(file));
}

/** Names that exist only in the type system: type-only imports, interfaces, type aliases. */
function typeOnlyNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      names.add(statement.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const clause = statement.importClause;
    if (clause.isTypeOnly) {
      if (clause.name) names.add(clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.add(element.name.text);
      }
      continue;
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

function decoratorNames(node: ts.HasDecorators): readonly string[] {
  return (ts.getDecorators(node) ?? []).flatMap((decorator) => {
    const expression = decorator.expression;
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      return [expression.expression.text];
    }
    if (ts.isIdentifier(expression)) return [expression.text];
    return [];
  });
}

/** The reason a parameter annotation cannot become an injection token, or undefined. */
function unresolvableReason(type: ts.TypeNode, typeOnly: ReadonlySet<string>): string | undefined {
  if (ts.isTypeReferenceNode(type)) {
    if (!ts.isIdentifier(type.typeName)) return undefined; // Namespace.Class — a value path
    const name = type.typeName.text;
    if (typeOnly.has(name)) return `${name} (type-only import, interface or type alias)`;
    if (UTILITY_TYPES.has(name)) return `${type.getText()} (utility type)`;
    return undefined;
  }
  return `${type.getText()} (not a class reference)`;
}

export function findViolations(file: string, source: string): readonly Violation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const typeOnly = typeOnlyNames(sourceFile);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const instantiable = decoratorNames(node).some((name) => INSTANTIATION_DECORATORS.has(name));
      const constructor = node.members.find(ts.isConstructorDeclaration);
      if (instantiable && constructor !== undefined) {
        for (const parameter of constructor.parameters) {
          // @Inject(token), @InjectRepository(Entity), @InjectDataSource() … set
          // the token explicitly; the type annotation is then documentation.
          // @Optional() resolves a missing token to undefined instead of failing.
          const names = decoratorNames(parameter);
          const explicitToken = names.some((name) => name.startsWith('Inject'));
          const optional = names.includes('Optional');
          const type = parameter.type;
          if (explicitToken || optional || type === undefined) continue;
          const reason = unresolvableReason(type, typeOnly);
          if (reason !== undefined) {
            violations.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(parameter.getStart()).line + 1,
              className: node.name.text,
              dependency: reason,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('Nest-instantiable classes import their constructor dependencies as values', () => {
  it('flags the shape that kept billing-service from booting', () => {
    const source = [
      "import { Injectable } from '@nestjs/common';",
      "import type { DiscountCodeService } from './discount-code.service';",
      "import { type Other, Value } from './other';",
      '@Injectable()',
      'export class ModulePricingService {',
      '  constructor(private readonly discounts: DiscountCodeService, private readonly o: Other, v: Value) {}',
      '}',
    ].join('\n');
    expect(
      findViolations('x.ts', source).map((v) => `${v.className}<-${v.dependency}@${v.line}`),
    ).toEqual([
      'ModulePricingService<-DiscountCodeService (type-only import, interface or type alias)@6',
      'ModulePricingService<-Other (type-only import, interface or type alias)@6',
    ]);
  });

  it('flags a same-file interface or type alias as the parameter type', () => {
    const source = [
      "import { Injectable } from '@nestjs/common';",
      'export interface LimiterOptions { maxPerTenant?: number }',
      'export type RevalidatorOptions = { intervalMs?: number };',
      '@Injectable()',
      'export class TenantConnectionLimiter {',
      '  constructor(options: LimiterOptions = {}) {}',
      '}',
      '@Injectable()',
      'export class WsTokenRevalidator {',
      '  constructor(options: RevalidatorOptions) {}',
      '}',
    ].join('\n');
    expect(findViolations('x.ts', source).map((v) => `${v.className}<-${v.dependency}`)).toEqual([
      'TenantConnectionLimiter<-LimiterOptions (type-only import, interface or type alias)',
      'WsTokenRevalidator<-RevalidatorOptions (type-only import, interface or type alias)',
    ]);
  });

  it('flags a utility type, a union, an object literal and a primitive', () => {
    const source = [
      "import { Injectable, Optional } from '@nestjs/common';",
      "import { Checker, Bus } from './real';",
      '@Injectable()',
      'export class Handler {',
      '  constructor(',
      "    private readonly checker: Pick<Checker, 'check'>,",
      '    private readonly bus: Bus | undefined,',
      '    private readonly shape: { check(): void },',
      '    private readonly name: string,',
      '    @Optional() private readonly maybe: Bus | undefined,',
      '  ) {}',
      '}',
    ].join('\n');
    expect(findViolations('x.ts', source).map((v) => v.dependency)).toEqual([
      "Pick<Checker, 'check'> (utility type)",
      'Bus | undefined (not a class reference)',
      '{ check(): void } (not a class reference)',
      'string (not a class reference)',
    ]);
  });

  it('accepts an explicit token, a value import, and an undecorated class', () => {
    const source = [
      "import { Injectable, Inject } from '@nestjs/common';",
      "import { InjectRepository } from '@nestjs/typeorm';",
      "import type { Repository } from 'typeorm';",
      "import type { Redis } from 'ioredis';",
      "import { Real } from './real';",
      '@Injectable()',
      'export class A {',
      "  constructor(@InjectRepository(E) private readonly r: Repository<E>, @Inject('REDIS') private readonly c: Redis, private readonly x: Real) {}",
      '}',
      'export class ByHand {',
      '  constructor(private readonly redis: Redis) {}',
      '}',
    ].join('\n');
    expect(findViolations('x.ts', source)).toEqual([]);
  });

  it('holds across apps/, libs/ and platform/libs/', () => {
    const violations = listCandidateFiles().flatMap((file) =>
      findViolations(file, readFileSync(resolve(REPO_ROOT, file), 'utf-8')),
    );
    const report = violations.map(
      (v) =>
        `${v.file}:${v.line} ${v.className} depends on ${v.dependency} — Nest will see ` +
        '`Object`/`Function` and refuse to boot the module. Import the class as a value, inject ' +
        'the dependency through a token, or drop the instantiation decorator when the class is ' +
        'built by hand (`useFactory`).',
    );
    expect(report).toEqual([]);
  });
});
