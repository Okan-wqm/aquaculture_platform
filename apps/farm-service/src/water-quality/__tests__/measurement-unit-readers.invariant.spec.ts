/**
 * Invariant: no farm-service reader identifies a water-quality measurement's
 * unit by the `tankId` column alone.
 *
 * A measurement's unit is COALESCE(tankId, equipmentId): a tank is filed as
 * `tankId`, a biofilter or sump as `equipmentId`, and the old batch writer
 * filed tanks only as `equipmentId`. A reader keyed on `tankId` silently drops
 * every other row — the life-safety critical list did (FARM-HIGH-367). Readers
 * use measurement-unit-reader.ts (measurementUnitIdSql, measurementUnitMatchSql,
 * measurementUnitIdOf); this scan fails the build when a new one does not.
 *
 * Flagged, for every source file outside tests and migrations:
 * - a query builder over WaterQualityMeasurement whose alias's `tankId` is
 *   compared, grouped or joined on (selecting the column is allowed);
 * - raw SQL over `water_quality_measurements` that names `"tankId"`;
 * - a find over WaterQualityMeasurement (manager or injected repository)
 *   whose `where` names `tankId`.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const FARM_SRC = join(__dirname, '..', '..');
const OWNER = join('water-quality', 'services', 'measurement-unit-reader.ts');

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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

interface Literal {
  text: string;
  /** The code just before the literal, trimmed (to tell a select item from a predicate). */
  before: string;
}

function stringLiterals(source: string): Literal[] {
  const literals: Literal[] = [];
  const pattern = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    literals.push({ text: match[0], before: source.slice(0, match.index).trimEnd().slice(-1) });
  }
  return literals;
}

/** The balanced `{…}` or `[…]` that starts at `open`. */
function balanced(source: string, open: number): string {
  const opener = source[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opener) depth++;
    if (source[i] === closer) depth--;
    if (depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

function findWhereNamesTankId(source: string, callPattern: RegExp): boolean {
  for (let match = callPattern.exec(source); match !== null; match = callPattern.exec(source)) {
    const options = balanced(source, match.index + match[0].length - 1);
    const where = /\bwhere\s*:\s*/.exec(options);
    if (where === null) continue;
    const clause = balanced(options, where.index + where[0].length);
    if (/\btankId\b/.test(clause)) return true;
  }
  return false;
}

/** The ways `source` identifies a measurement's unit by `tankId` alone. */
function unitKeyViolations(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const violations: string[] = [];
  const literals = stringLiterals(source);

  const aliasPattern = /createQueryBuilder\(\s*WaterQualityMeasurement\s*,\s*'(\w+)'/g;
  const aliases = new Set<string>();
  for (let m = aliasPattern.exec(source); m !== null; m = aliasPattern.exec(source)) {
    aliases.add(m[1] as string);
  }
  for (const alias of aliases) {
    const column = new RegExp(`(\\b${alias}\\.tankId\\b|"${alias}"\\."tankId")`);
    for (const literal of literals) {
      if (!column.test(literal.text)) continue;
      const selectItem = literal.text === `'${alias}.tankId'` && /[[,]/.test(literal.before);
      if (!selectItem) violations.push(`query builder '${alias}': ${literal.text}`);
    }
  }

  for (const literal of literals) {
    if (/water_quality_measurements/.test(literal.text) && /"tankId"/.test(literal.text)) {
      violations.push(`raw SQL: ${literal.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }

  const managerFind =
    /\.(?:find|findOne|findAndCount|findBy|findOneBy|count|exists)\(\s*WaterQualityMeasurement\s*,\s*\{/g;
  if (findWhereNamesTankId(source, managerFind)) {
    violations.push('find(WaterQualityMeasurement) where names tankId');
  }
  const repository =
    /@InjectRepository\(\s*WaterQualityMeasurement\s*\)\s*(?:private|public|protected|readonly|\s)*(\w+)/.exec(
      source,
    );
  if (repository !== null) {
    const repositoryFind = new RegExp(
      `\\.${repository[1]}\\.(?:find|findOne|findAndCount|findBy|findOneBy|count|exists)\\(\\s*\\{`,
      'g',
    );
    if (findWhereNamesTankId(source, repositoryFind)) {
      violations.push(`${repository[1]}.find where names tankId`);
    }
  }
  return violations;
}

describe('measurement-unit readers invariant', () => {
  describe('the detector', () => {
    it.each([
      [
        'a query-builder predicate',
        "m.createQueryBuilder(WaterQualityMeasurement, 'wq').where('wq.tankId = :tankId')",
      ],
      [
        'a query-builder grouping',
        "m.createQueryBuilder(WaterQualityMeasurement, 'wq').groupBy('wq.tankId')",
      ],
      [
        'a quoted query-builder join',
        "m.createQueryBuilder(WaterQualityMeasurement, 'x').innerJoin('t', 't', `t.id = \"x\".\"tankId\"`)",
      ],
      [
        'raw SQL',
        'q.query(`SELECT 1 FROM water_quality_measurements m JOIN tanks t ON t.id = m."tankId"`)',
      ],
      [
        'a manager find',
        'm.findOne(WaterQualityMeasurement, { where: { tenantId, tankId }, order: { a: 1 } })',
      ],
      [
        'an injected repository find',
        '@InjectRepository(WaterQualityMeasurement) private readonly repo: R; ' +
          'f() { this.repo.find({ where: [{ tankId: x }] }); }',
      ],
    ])('flags %s keyed on tankId', (_label, source) => {
      expect(unitKeyViolations(source)).not.toHaveLength(0);
    });

    it('allows selecting the column, a tank relation, and the shared helpers', () => {
      const source = [
        "m.createQueryBuilder(WaterQualityMeasurement, 'wq')",
        "  .select(['wq.id', 'wq.tankId', 'wq.equipmentId'])",
        "  .leftJoinAndSelect('wq.tank', 'tank')",
        "  .andWhere(measurementUnitMatchSql('wq', '= :unitId'), { unitId })",
        'm.find(WaterQualityMeasurement, { select: { tankId: true }, where: { tenantId } })',
      ].join('\n');
      expect(unitKeyViolations(source)).toEqual([]);
    });
  });

  it('no farm-service reader keys a measurement’s unit on tankId alone', () => {
    const files = sourceFiles(FARM_SRC).filter((file) => relative(FARM_SRC, file) !== OWNER);
    const readers = files.filter((file) =>
      /WaterQualityMeasurement|water_quality_measurements/.test(readFileSync(file, 'utf8')),
    );
    // Non-vacuous: the scan reaches the readers this invariant exists for.
    expect(readers.map((file) => relative(FARM_SRC, file))).toEqual(
      expect.arrayContaining([
        join('water-quality', 'query-handlers', 'list-critical-water-quality.handler.ts'),
        join('water-quality', 'services', 'water-temperature.service.ts'),
        join('batch', 'query-handlers', 'get-batch-traceability.handler.ts'),
      ]),
    );
    const violations = readers.flatMap((file) =>
      unitKeyViolations(readFileSync(file, 'utf8')).map(
        (violation) => `${relative(FARM_SRC, file)}: ${violation}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
