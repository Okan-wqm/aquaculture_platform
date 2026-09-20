/**
 * nest-module-provider-duplication.spec.ts — a module must not re-provide a
 * class that another module of the same application already provides and
 * exports.
 *
 * WHY: listing a class under `providers` makes Nest build a NEW instance
 * inside that module, resolved against that module's own imports. Two things
 * go wrong. The instance is a second one, so anything stateful about it (an
 * in-memory cache, a subscription, a counter) is split between callers that
 * believe they share it; and its dependencies are resolved where the copy
 * lives, not where the class was designed to live, so a dependency the
 * exporting module satisfies (a TypeORM repository, a client) is missing and
 * the container fails at boot with "Nest can't resolve dependencies". That is
 * how sensor-service could not boot on any deploy of main from 65753cb90
 * (2026-08-26) until the 2026-09-20 outage: SensorErasureModule re-provided
 * MqttAuthService, whose EdgeDevice repository only EdgeDeviceModule
 * registers — and had it resolved, the erasure hook would have invalidated
 * the cache of an instance no request ever read.
 *
 * RULE: import the module that exports the class. A pre-existing duplicate is
 * carried in KNOWN_DUPLICATES with its tracked finding until it is removed;
 * the list only shrinks (a stale entry fails the spec too).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface ModuleDeclaration {
  readonly file: string;
  readonly app: string;
  readonly name: string;
  readonly providers: ReadonlySet<string>;
  readonly exports: ReadonlySet<string>;
}

interface Duplicate {
  readonly app: string;
  readonly module: string;
  readonly provider: string;
  readonly exportedBy: readonly string[];
  readonly file: string;
}

/**
 * Duplicates that predate this gate. Each is a second instance of a class its
 * exporting module already serves; ORPHAN-MEDIUM-833 owns their removal.
 * Key: `<app>:<module>:<provider>`.
 */
const KNOWN_DUPLICATES: ReadonlySet<string> = new Set([
  'admin-api-service:SystemModulesModule:AuthTenantProvisioningClientService',
  'farm-service:BatchModule:ProtocolRateService',
  'farm-service:BatchModule:DayPlanRecalcService',
  'farm-service:FeedingProtocolModule:BatchDomainService',
  'farm-service:FeedingModule:ProtocolRateService',
  'farm-service:FeedingModule:DayPlanRecalcService',
  'farm-service:FeedingModule:BiomassGrowthApplierService',
  'farm-service:GrowthModule:ProtocolRateService',
  'farm-service:HarvestModule:ProtocolRateService',
  'farm-service:HarvestModule:DayPlanRecalcService',
  'farm-service:WaterQualityModule:ProtocolRateService',
  'farm-service:WaterQualityModule:DayPlanRecalcService',
]);

function listModuleFiles(): readonly string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'apps/*/src/**/*.module.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean);
}

function identifierList(node: ts.Expression | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return names;
  for (const element of node.elements) {
    // Bare class identifiers only: a custom provider object (`{ provide, use… }`)
    // declares a token on purpose and is outside this rule.
    if (ts.isIdentifier(element)) names.add(element.text);
  }
  return names;
}

export function parseModules(file: string, source: string): readonly ModuleDeclaration[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const app = file.split('/')[1] ?? '';
  const modules: ModuleDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const expression = decorator.expression;
        if (
          !ts.isCallExpression(expression) ||
          !ts.isIdentifier(expression.expression) ||
          expression.expression.text !== 'Module'
        ) {
          continue;
        }
        const argument = expression.arguments[0];
        if (argument === undefined || !ts.isObjectLiteralExpression(argument)) continue;
        const property = (key: string): ts.Expression | undefined =>
          argument.properties.find(
            (candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) &&
              ts.isIdentifier(candidate.name) &&
              candidate.name.text === key,
          )?.initializer;
        modules.push({
          file,
          app,
          name: node.name.text,
          providers: identifierList(property('providers')),
          exports: identifierList(property('exports')),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return modules;
}

export function findDuplicates(modules: readonly ModuleDeclaration[]): readonly Duplicate[] {
  const duplicates: Duplicate[] = [];
  for (const module of modules) {
    for (const provider of module.providers) {
      const exporters = modules.filter(
        (other) =>
          other !== module &&
          other.app === module.app &&
          other.providers.has(provider) &&
          other.exports.has(provider),
      );
      if (exporters.length > 0) {
        duplicates.push({
          app: module.app,
          module: module.name,
          provider,
          exportedBy: exporters.map((other) => other.name),
          file: module.file,
        });
      }
    }
  }
  return duplicates;
}

const keyOf = (duplicate: Duplicate): string =>
  `${duplicate.app}:${duplicate.module}:${duplicate.provider}`;

describe('Nest modules import an exported provider instead of re-providing it', () => {
  it('flags a re-provided class and ignores the exporting module and custom providers', () => {
    const source = [
      "import { Module } from '@nestjs/common';",
      '@Module({ providers: [MqttAuthService, Other], exports: [MqttAuthService] })',
      'export class EdgeDeviceModule {}',
      '@Module({ providers: [Hook, MqttAuthService, { provide: Other, useValue: 1 }], exports: [Hook] })',
      'export class SensorErasureModule {}',
    ].join('\n');
    const duplicates = findDuplicates(parseModules('apps/sensor-service/src/x.module.ts', source));
    expect(duplicates.map(keyOf)).toEqual(['sensor-service:SensorErasureModule:MqttAuthService']);
    expect(duplicates[0]?.exportedBy).toEqual(['EdgeDeviceModule']);
  });

  it('does not pair modules across applications', () => {
    const a = parseModules(
      'apps/a/src/a.module.ts',
      '@Module({ providers: [Shared], exports: [Shared] }) export class AModule {}',
    );
    const b = parseModules(
      'apps/b/src/b.module.ts',
      '@Module({ providers: [Shared] }) export class BModule {}',
    );
    expect(findDuplicates([...a, ...b])).toEqual([]);
  });

  it('holds across apps/*/src, and the known-duplicate list only shrinks', () => {
    const modules = listModuleFiles().flatMap((file) =>
      parseModules(file, readFileSync(resolve(REPO_ROOT, file), 'utf-8')),
    );
    const duplicates = findDuplicates(modules);
    const found = new Set(duplicates.map(keyOf));

    const fresh = duplicates
      .filter((duplicate) => !KNOWN_DUPLICATES.has(keyOf(duplicate)))
      .map(
        (duplicate) =>
          `${duplicate.file}: ${duplicate.module} re-provides ${duplicate.provider}, which ` +
          `${duplicate.exportedBy.join(', ')} already provides and exports — import that module instead; ` +
          'a second instance resolves its dependencies where the copy lives and splits its state.',
      );
    expect(fresh).toEqual([]);

    const stale = [...KNOWN_DUPLICATES].filter((key) => !found.has(key));
    expect(stale).toEqual([]);
  });
});
