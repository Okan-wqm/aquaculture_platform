/**
 * Invariant: no farm-service reader identifies a water-quality measurement's
 * unit by one column (FARM-HIGH-367, FARM-HIGH-372).
 *
 * A measurement's unit is COALESCE(tankId, equipmentId). Keying on `tankId`
 * alone dropped every non-tank unit — the dashboard's critical list; keying on
 * `equipmentId` alone made `update()` validate a tank row as unit-less. Readers
 * use measurement-unit-reader.ts (measurementUnitIdSql, measurementUnitMatchSql,
 * measurementUnitIdOf), the one owner of the expression.
 *
 * The scan (helpers/unit-key-scan.ts) walks the TypeScript AST with a type
 * checker and flags, for the entity's unit columns and relations:
 * - query-builder strings over an alias of the entity (any quote style), from
 *   `createQueryBuilder(Entity, 'a')` or `repo.createQueryBuilder('a')` where
 *   the repo is injected or comes from any repository accessor given the entity
 *   (`getScopedRepository(…, Entity)`, `tenantManagerRepo(…, Entity)`, …);
 * - raw SQL over `water_quality_measurements` naming a unit column;
 * - object-form `where({ tankId })` on such a builder, and find-family `where`
 *   (manager or repository form, `*By` included) naming a unit column or the
 *   `tank` / `equipment` relation;
 * - a read of `row.tankId` / `row.equipmentId` on a measurement, unless it is
 *   written to or copied into a property of the same name (event payloads).
 * Selecting a column into an array (`select(['wq.tankId'])`) is allowed.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

import { ENTITY, unitKeyViolations, unitShapeOf, type UnitShape } from './helpers/unit-key-scan';

jest.setTimeout(180_000);

const FARM_ROOT = join(__dirname, '..', '..', '..');
const FARM_SRC = join(FARM_ROOT, 'src');
const ENTITY_FILE = join(
  FARM_SRC,
  'water-quality',
  'entities',
  'water-quality-measurement.entity.ts',
);
const EXEMPT = new Set([
  ENTITY_FILE,
  join(FARM_SRC, 'water-quality', 'services', 'measurement-unit-reader.ts'),
]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'migrations' || entry === 'node_modules') continue;
      files.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
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

/** An in-memory program: the entity's unit shape plus one snippet. */
function scanSnippet(snippet: string): string[] {
  const files: Record<string, string> = {
    '/v/entity.ts': [
      `export class ${ENTITY} {`,
      '  @Column() tankId?: string;',
      "  @ManyToOne(() => Tank) @JoinColumn({ name: 'tankId' }) tank?: Tank;",
      '  @Column() equipmentId?: string;',
      "  @ManyToOne('Equipment') @JoinColumn({ name: 'equipmentId' }) equipment?: unknown;",
      '}',
      'export class FeedingRecord { tankId?: string; }',
      'declare class Tank {}',
      'declare function Column(): PropertyDecorator;',
      'declare function ManyToOne(target: unknown): PropertyDecorator;',
      'declare function JoinColumn(options: { name: string }): PropertyDecorator;',
    ].join('\n'),
    '/v/snippet.ts': [
      `import { ${ENTITY}, FeedingRecord } from './entity';`,
      'declare const m: any; declare const q: any; declare const id: string;',
      'declare function validate(unit?: string): void;',
      'declare function InjectRepository(e: unknown): ParameterDecorator;',
      'declare function tenantManagerRepo(m: unknown, e: unknown): any;',
      'declare function measurementUnitMatchSql(a: string, c: string): string;',
      snippet,
    ].join('\n'),
  };
  const options: ts.CompilerOptions = { experimentalDecorators: true, noEmit: true, strict: false };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, version) =>
    files[name] !== undefined ? ts.createSourceFile(name, files[name], version, true) : undefined;
  host.fileExists = (name) => files[name] !== undefined;
  host.readFile = (name) => files[name];
  host.resolveModuleNames = (names) =>
    names.map((name) => ({
      resolvedFileName: name.replace('./', '/v/') + '.ts',
      extension: '.ts',
    }));
  const program = ts.createProgram(['/v/snippet.ts', '/v/entity.ts'], options, host);
  const entity = program.getSourceFile('/v/entity.ts');
  const source = program.getSourceFile('/v/snippet.ts');
  if (!entity || !source) throw new Error('snippet program has no sources');
  return unitKeyViolations(source, program.getTypeChecker(), unitShapeOf(entity)).map(
    (v) => v.shape,
  );
}

describe('measurement-unit readers invariant', () => {
  describe('the scanner', () => {
    it.each([
      [
        'a single-quoted builder predicate',
        `m.createQueryBuilder(${ENTITY}, 'wq').where('wq.tankId = :id');`,
      ],
      [
        'a double-quoted builder predicate',
        `m.createQueryBuilder(${ENTITY}, 'wq').where("wq.equipmentId = :id");`,
      ],
      ['a builder grouping', `m.createQueryBuilder(${ENTITY}, 'wq').groupBy('wq.tankId');`],
      [
        'a quoted derived-table join',
        `m.createQueryBuilder(${ENTITY}, 'x').innerJoin('t', 't', \`t.id = "x"."tankId"\`);`,
      ],
      [
        'double-quoted raw SQL',
        `q.query("SELECT 1 FROM water_quality_measurements WHERE \\"tankId\\" = $1");`,
      ],
      [
        'template raw SQL',
        'q.query(`SELECT 1 FROM water_quality_measurements m JOIN tanks t ON t.id = m."equipmentId"`);',
      ],
      [
        'an injected repository builder',
        `class S { constructor(@InjectRepository(${ENTITY}) private readonly repo: any) {} ` +
          "f(): void { this.repo.createQueryBuilder('r').where('r.tankId = :id'); } }",
      ],
      [
        'a tenantManagerRepo builder',
        `tenantManagerRepo(m, ${ENTITY}).createQueryBuilder('t').andWhere('t.equipmentId = :id');`,
      ],
      [
        'a getScopedRepository find',
        `m.getScopedRepository(${ENTITY}).find({ where: { tankId: id } });`,
      ],
      [
        'a repository findBy',
        `const r = m.getScopedRepository(${ENTITY}); r.findBy({ equipmentId: id });`,
      ],
      [
        'an object-form builder where',
        `m.createQueryBuilder(${ENTITY}, 'wq').where({ tankId: id });`,
      ],
      [
        'an object-form where on a builder variable',
        `const qb = m.createQueryBuilder(${ENTITY}, 'wq'); qb.andWhere({ equipmentId: id });`,
      ],
      ['a relation-form find', `m.find(${ENTITY}, { where: { tank: { id } } });`],
      [
        'an array-form manager find',
        `m.findOne(${ENTITY}, { where: [{ tenantId: id, tankId: id }] });`,
      ],
      [
        'a row read keyed on equipmentId alone',
        `function f(row: ${ENTITY}): void { validate(row.equipmentId); }`,
      ],
      [
        'a hand-written coalesce',
        `function f(row: ${ENTITY}): string | undefined { return row.tankId ?? row.equipmentId; }`,
      ],
    ])('flags %s', (_label, snippet) => {
      expect(scanSnippet(snippet)).not.toHaveLength(0);
    });

    it('allows a selected column, the helpers, column copies, writes and other entities', () => {
      const snippet = [
        `m.createQueryBuilder(${ENTITY}, 'wq')`,
        "  .select(['wq.id', 'wq.tankId', 'wq.equipmentId'])",
        "  .leftJoinAndSelect('wq.tank', 'tank')",
        "  .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId: id });",
        `m.find(${ENTITY}, { select: { tankId: true }, where: { tenantId: id } });`,
        `function copy(row: ${ENTITY}): object { return { tankId: row.tankId ?? null, equipmentId: row.equipmentId }; }`,
        `function write(row: ${ENTITY}): void { row.tankId = id; }`,
        "m.createQueryBuilder(FeedingRecord, 'fr').where('fr.tankId = :id');",
        'function other(r: FeedingRecord): void { validate(r.tankId); }',
      ].join('\n');
      expect(scanSnippet(snippet)).toEqual([]);
    });
  });

  it('no farm-service reader keys a measurement’s unit on one column', () => {
    const files = sourceFiles(FARM_SRC).filter((file) => !EXEMPT.has(file));
    const readers = files.filter((file) =>
      new RegExp(`${ENTITY}|water_quality_measurements`).test(readFileSync(file, 'utf8')),
    );
    // Non-vacuous: the scan reaches the readers this invariant exists for.
    expect(readers.map((file) => relative(FARM_SRC, file))).toEqual(
      expect.arrayContaining([
        join('water-quality', 'query-handlers', 'list-critical-water-quality.handler.ts'),
        join('water-quality', 'water-quality.service.ts'),
        join('water-quality', 'services', 'water-temperature.service.ts'),
        join('batch', 'query-handlers', 'get-batch-traceability.handler.ts'),
      ]),
    );
    const program = farmProgram([ENTITY_FILE, ...readers]);
    const entity = program.getSourceFile(ENTITY_FILE);
    if (!entity) throw new Error('entity not in the program');
    const unit: UnitShape = unitShapeOf(entity);
    expect([...unit.columns].sort()).toEqual(['equipmentId', 'tankId']);
    expect([...unit.relations].sort()).toEqual(['equipment', 'tank']);

    const checker = program.getTypeChecker();
    const violations = readers.flatMap((file) => {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`${file} not in the program`);
      return unitKeyViolations(source, checker, unit).map(
        (v) => `${relative(FARM_SRC, file)}:${v.line} ${v.shape}: ${v.text}`,
      );
    });
    expect(violations).toEqual([]);
  });
});
