import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import * as ts from 'typescript';

import { pointWrites, unclosedPointWrites } from './helpers/point-retirement-scan';

/**
 * INVARIANT (FARM-HIGH-373, plan D12): every write that retires a measurement
 * point — deletes or deactivates a tank, system, equipment or site, through an
 * entity, a repository, a request payload under any name, or raw SQL — is
 * followed, inside the same function, by closeSourcesAtPoints.
 *
 * - Without the close, a source left live at a retired point keeps counting as
 *   bound: its parameter's update, delete, declare, clear and template
 *   overwrite refuse with 409 forever, and no read names the source.
 * - Before the write, or in another function, the close leaves a window: a
 *   bind holding the point FOR SHARE commits a live source after the close.
 *
 * The scan is an AST walk with the type checker (helpers/point-retirement-scan):
 * a write is recognised by the property it sets and the type it sets it on,
 * never by a variable name.
 */
const FARM_SRC = resolve(__dirname, '..', '..');
const FARM_ROOT = resolve(FARM_SRC, '..');
const POINT_ENTITY_IMPORT = /\/(tank|system|equipment|site)\.entity'/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'migrations' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.entity.ts')
    ) {
      found.push(full);
    }
  }
  return found;
}

function farmProgram(rootNames: string[]): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(FARM_ROOT, 'tsconfig.app.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error('cannot read apps/farm-service/tsconfig.app.json');
  return ts.createProgram({ rootNames, options: { ...config.options, noEmit: true } });
}

/** An in-memory program: point and non-point entities plus one snippet. */
function scanSnippet(snippet: string): string[] {
  const files: Record<string, string> = {
    '/v/entities.ts': [
      'export class Tank { isActive!: boolean; isDeleted!: boolean; }',
      'export class Department { isActive!: boolean; }',
      'export interface Repo<T> { update(c: unknown, v: Partial<T>): Promise<void>; }',
      'export declare function closeSourcesAtPoints(...args: unknown[]): Promise<number>;',
    ].join('\n'),
    '/v/snippet.ts': [
      "import { Tank, Department, Repo, closeSourcesAtPoints } from './entities';",
      'declare const tank: Tank; declare const department: Department;',
      'declare const repo: Repo<Tank>; declare const m: { query(sql: string): Promise<void> };',
      'declare const data: { isActive?: boolean; name?: string };',
      snippet,
    ].join('\n'),
  };
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const defaultGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) =>
    files[name] !== undefined
      ? ts.createSourceFile(name, files[name], version, true)
      : defaultGet(name, version, ...rest);
  const defaultExists = host.fileExists.bind(host);
  host.fileExists = (name) => files[name] !== undefined || defaultExists(name);
  host.resolveModuleNames = (names) =>
    names.map((name) => ({
      resolvedFileName: name.replace('./', '/v/') + '.ts',
      extension: '.ts',
    }));
  const program = ts.createProgram(['/v/snippet.ts'], options, host);
  const source = program.getSourceFile('/v/snippet.ts');
  if (!source) throw new Error('snippet program has no source');
  return unclosedPointWrites(source, program.getTypeChecker()).map((write) => write.text);
}

describe('INVARIANT: retiring a measurement point closes its water-quality sources', () => {
  describe('the scanner', () => {
    it.each([
      [
        'a close before the write',
        'async function f() { await closeSourcesAtPoints(); tank.isDeleted = true; }',
      ],
      [
        'a close in another function',
        'async function f() { tank.isActive = false; }\n' +
          'async function g() { await closeSourcesAtPoints(); }',
      ],
      ['a payload under any name', 'async function f() { tank.isActive = data.isActive ?? true; }'],
      ['Object.assign from a payload', 'async function f() { Object.assign(tank, data); }'],
      ['a repository update', 'async function f() { await repo.update({}, { isActive: false }); }'],
      [
        'raw SQL',
        'async function f() { await m.query(`UPDATE tanks SET "isActive" = false WHERE id = $1`); }',
      ],
    ])('flags %s', (_shape, snippet) => {
      expect(scanSnippet(snippet)).toHaveLength(1);
    });

    it.each([
      [
        'a write then a close in the same function',
        'async function f() { tank.isActive = false; await closeSourcesAtPoints(); }',
      ],
      ['a non-point row', 'async function f() { department.isActive = false; }'],
      ['activation', 'async function f() { tank.isActive = true; }'],
      [
        'a view built in memory',
        'function f() { const view = new Tank(); view.isActive = data.isActive ?? false; }',
      ],
    ])('passes %s', (_shape, snippet) => {
      expect(scanSnippet(snippet)).toEqual([]);
    });
  });

  describe('farm-service', () => {
    const candidates = sourceFiles(FARM_SRC).filter((file) =>
      POINT_ENTITY_IMPORT.test(readFileSync(file, 'utf8')),
    );
    const program = farmProgram(candidates);
    const checker = program.getTypeChecker();
    const scanned = candidates.map((file) => {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`${file} not in the program`);
      return { file: relative(FARM_SRC, file), source };
    });
    const writers = new Set(
      scanned
        .filter(({ source }) => pointWrites(source, checker).length > 0)
        .map(({ file }) => file),
    );

    it('finds the known point retirers (the scan is not vacuous)', () => {
      expect([...writers]).toEqual(
        expect.arrayContaining([
          'tank/handlers/delete-tank.handler.ts',
          'system/handlers/delete-system.handler.ts',
          'equipment/handlers/delete-equipment.handler.ts',
          'department/handlers/delete-department.handler.ts',
          'site/handlers/delete-site.handler.ts',
          'system/handlers/update-system.handler.ts',
          'site/handlers/update-site.handler.ts',
          'equipment/handlers/update-equipment.handler.ts',
        ]),
      );
    });

    it('closes the sources after every point write, in the same function', () => {
      const violations = scanned.flatMap(({ file, source }) =>
        unclosedPointWrites(source, checker).map(({ line, text }) => `${file}:${line} ${text}`),
      );
      expect(violations).toEqual([]);
    });
  });
});
