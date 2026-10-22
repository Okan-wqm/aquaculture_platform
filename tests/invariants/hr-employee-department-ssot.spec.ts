/**
 * HR employee-department SSoT invariant
 * ============================================================================
 *
 * An employee's department is `Employee.departmentHrId` -> `departments_hr` and nothing else. The
 * legacy `employees.department` enum (GraphQL `HRDepartment`) and `employees.isFarmWorker` are
 * retired from the code and the API: a second way to say "which department" cannot say which
 * MODULE a person belongs to. The DB columns stay behind as orphans (old containers still read
 * them during a blue-green rollout; `dropOrphanedColumns` removes them later), so the retirement
 * is only safe if two things hold, both read from source (no service boots):
 *
 *   1. CODE   — nothing declares or reads the retired fields: not the entity, not the GraphQL
 *      surface (resolvers/DTOs), not a query builder or raw SQL.
 *   2. SCHEMA — an orphan column must not turn a new INSERT into a not-null violation: every
 *      column the Baseline gave `employees` that the entity no longer declares is nullable,
 *      defaulted, or relaxed by a later migration (Postgres rejects the row at write time, in
 *      production, while every unit test is green).
 *
 * The migration that moves the legacy value across is tested where it lives: its statements in
 * `apps/hr-service/src/database/migrations/__tests__/1802500000000-RetireEmployeeLegacyDepartment.spec.ts`,
 * its data on a real PostgreSQL in
 * `libs/migration-harness/src/__tests__/hr-retire-employee-department.integration.spec.ts`.
 * `db-migration-check.yml` migrates a fresh database with no legacy employees, so it proves the
 * chain applies, not that any employee is placed.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import ts from 'typescript';

import { REPO_ROOT } from './helpers/farm-graphql-surface';

const HR_SRC = 'apps/hr-service/src';
const EMPLOYEE_ENTITY = `${HR_SRC}/hr/entities/employee.entity.ts`;
const MIGRATIONS_DIR = `${HR_SRC}/database/migrations`;
const BASELINE = `${MIGRATIONS_DIR}/1800000000000-Baseline.ts`;

/** Entity/DTO field names of the retired mechanism. */
const RETIRED_FIELDS: ReadonlySet<string> = new Set(['department', 'isFarmWorker']);
/** GraphQL root fields of the retired mechanism. */
const RETIRED_ROOT_FIELDS: readonly string[] = ['employeesByDepartment', 'toggleFarmWorker'];
/** Reads of a retired column through an alias or a quoted SQL identifier, or the bare name as a string. */
const RETIRED_COLUMN_TEXT =
  /^(department|isFarmWorker)$|[\w"]\."?(department|isFarmWorker)\b|"(department|isFarmWorker)"/;

const read = (repoPath: string): string => readFileSync(join(REPO_ROOT, repoPath), 'utf8');

function parseText(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

const parse = (repoPath: string): ts.SourceFile => parseText(repoPath, read(repoPath));

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

/** Production sources of hr-service: no specs, no test folders, no migrations (they are history). */
function hrSourceFiles(directory = HR_SRC): string[] {
  return readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || path === MIGRATIONS_DIR ? [] : hrSourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The property names of `class <className>`. */
function classProperties(source: ts.SourceFile, className: string): string[] {
  const names: string[] = [];
  visit(source, (node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
        names.push(member.name.text);
      }
    }
  });
  return names;
}

/** GraphQL root field names: the `name` option of @Query/@Mutation/@Subscription, else the method name. */
function rootFields(source: ts.SourceFile): string[] {
  const fields: string[] = [];
  visit(source, (node) => {
    if (!ts.isMethodDeclaration(node) || !ts.isIdentifier(node.name)) return;
    for (const decorator of ts.getDecorators(node) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
      if (!['Query', 'Mutation', 'Subscription'].includes(call.expression.text)) continue;
      const options = call.arguments.find(ts.isObjectLiteralExpression);
      const named = options?.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'name' &&
          ts.isStringLiteral(property.initializer),
      );
      fields.push(
        named !== undefined && ts.isStringLiteral(named.initializer)
          ? named.initializer.text
          : node.name.text,
      );
    }
  });
  return fields;
}

/** Declarations or reads of a retired field in one file (comments are not code and drop out with the parse). */
function retiredReferences(source: ts.SourceFile): string[] {
  const file = source.fileName;
  const hits: string[] = [];
  visit(source, (node) => {
    if (ts.isPropertyAccessExpression(node) && RETIRED_FIELDS.has(node.name.text)) {
      hits.push(`${file}: .${node.name.text}`);
    } else if (
      (ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      RETIRED_FIELDS.has(node.name.text)
    ) {
      hits.push(`${file}: ${node.name.text}:`);
    } else if (ts.isIdentifier(node) && node.text === 'isFarmWorker') {
      hits.push(`${file}: isFarmWorker`);
    } else if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      RETIRED_COLUMN_TEXT.test(node.text)
    ) {
      hits.push(`${file}: "${node.text.trim().slice(0, 60)}"`);
    }
  });
  return [...new Set(hits)];
}

/** `"column" definition` pairs of one `CREATE TABLE IF NOT EXISTS "<table>"` in the Baseline. */
function baselineColumns(table: string): Map<string, string> {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\((.*?), CONSTRAINT "PK_`).exec(
    read(BASELINE),
  )?.[1];
  if (body === undefined) throw new Error(`Baseline does not create ${table}`);
  return new Map(
    [...body.matchAll(/"([A-Za-z]+)" (.*?)(?=, "[A-Za-z]+" |$)/g)].flatMap(
      (match): Array<[string, string]> =>
        match[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]]],
    ),
  );
}

const isInsertableByOmission = (definition: string): boolean =>
  !/\bNOT NULL\b/.test(definition) || /\bDEFAULT\b/.test(definition);

describe('HR employee department SSoT - code', () => {
  const entityProperties = classProperties(parse(EMPLOYEE_ENTITY), 'Employee');

  it('the Employee entity (the parser sees the class) links by departmentHrId and declares no retired field', () => {
    expect(entityProperties).toEqual(expect.arrayContaining(['departmentHrId', 'departmentHr']));
    expect(entityProperties.filter((name) => RETIRED_FIELDS.has(name))).toEqual([]);
  });

  it('no `Department` enum is exported or registered as HRDepartment', () => {
    const offences: string[] = [];
    for (const file of hrSourceFiles()) {
      visit(parse(file), (node) => {
        const exported =
          ts.canHaveModifiers(node) &&
          ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isEnumDeclaration(node) && node.name.text === 'Department' && exported) {
          offences.push(`${file}: exported enum Department`);
        }
        if (ts.isStringLiteral(node) && node.text === 'HRDepartment') {
          offences.push(`${file}: GraphQL type name 'HRDepartment'`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  describe('the hr GraphQL surface', () => {
    const resolvers = hrSourceFiles().filter((file) => file.endsWith('.resolver.ts'));
    const surface = resolvers.flatMap((file) => rootFields(parse(file)));

    it('is actually read (resolvers found, known root fields present) and exposes no retired root field', () => {
      expect(resolvers.length).toBeGreaterThan(0);
      expect(surface).toEqual(expect.arrayContaining(['employees', 'hrDepartments']));
      expect(surface.filter((field) => RETIRED_ROOT_FIELDS.includes(field))).toEqual([]);
    });
  });

  it('nothing in hr-service reads or declares a retired field (entity, DTO, query builder, raw SQL)', () => {
    expect(hrSourceFiles().flatMap((file) => retiredReferences(parse(file)))).toEqual([]);
  });
});

describe('HR employee department SSoT - schema (orphan columns stay insertable)', () => {
  const entityColumns = new Set(classProperties(parse(EMPLOYEE_ENTITY), 'Employee'));
  const baseline = baselineColumns('employees');
  const orphans = [...baseline].filter(([column]) => !entityColumns.has(column));

  const laterMigrations = readdirSync(join(REPO_ROOT, MIGRATIONS_DIR))
    .filter((file) => /^\d{13}-/.test(file) && !file.startsWith('1800000000000-'))
    .map((file) => read(`${MIGRATIONS_DIR}/${file}`))
    .join('\n');
  const relaxedLater = (column: string): boolean =>
    laterMigrations.includes(`ALTER TABLE "employees" ALTER COLUMN "${column}" DROP NOT NULL`);

  it('the retired fields are exactly the columns the entity no longer declares', () => {
    expect(
      orphans.map(([column]) => column).filter((column) => RETIRED_FIELDS.has(column)),
    ).toEqual(['department', 'isFarmWorker']);
  });

  it('every orphan column is nullable, defaulted, or relaxed by a later migration', () => {
    const blocking = orphans
      .filter(
        ([column, definition]) => !isInsertableByOmission(definition) && !relaxedLater(column),
      )
      .map(([column, definition]) => `${column} ${definition}`);
    expect(blocking).toEqual([]);
  });

  it('the Baseline really declares department NOT NULL with no default (why the migration exists)', () => {
    const definition = baseline.get('department');
    expect(definition).toMatch(/NOT NULL/);
    expect(definition).not.toMatch(/DEFAULT/);
  });
});

describe('HR employee department SSoT - the detectors catch the retired mechanism', () => {
  // A guard that cannot fail proves nothing: feed each detector the shape it exists to forbid.
  const source = (text: string): ts.SourceFile => parseText('snippet.ts', text);

  it('flags a legacy department column and isFarmWorker on an entity class', () => {
    const entity = source(`
      export class Employee {
        @Column({ type: 'enum', enum: Department }) department!: Department;
        @Column({ default: false }) isFarmWorker!: boolean;
        @Column({ nullable: true }) departmentHrId?: string;
      }`);
    expect(classProperties(entity, 'Employee')).toEqual([
      'department',
      'isFarmWorker',
      'departmentHrId',
    ]);
  });

  it('reads root fields from the decorator name option or the method name', () => {
    const resolver = source(`
      export class R {
        @Query(() => [Employee], { name: 'employeesByDepartment' }) async byDepartment() {}
        @Mutation(() => Employee) async toggleFarmWorker() {}
        async notAnOperation() {}
      }`);
    expect(rootFields(resolver)).toEqual(['employeesByDepartment', 'toggleFarmWorker']);
  });

  it('flags property reads, DTO fields, query-builder aliases and quoted SQL of a retired field', () => {
    const offending = source(`
      class Input { department!: string; isFarmWorker?: boolean; }
      const read = employee.department;
      qb.where('employee.department = :department');
      qb.andWhere(\`e."department" = :d\`);
      qb.andWhere('"isFarmWorker" = true');
      const groupBy = 'department';`);
    expect(retiredReferences(offending)).toEqual([
      'snippet.ts: department:',
      'snippet.ts: isFarmWorker:',
      'snippet.ts: isFarmWorker',
      'snippet.ts: .department',
      'snippet.ts: "employee.department = :department"',
      'snippet.ts: "e."department" = :d"',
      'snippet.ts: ""isFarmWorker" = true"',
      'snippet.ts: "department"',
    ]);
  });

  it('does not flag comments, a local variable named department, or departmentHrId', () => {
    const clean = source(`
      // the legacy employee.department column and isFarmWorker are retired
      const department = await load();
      qb.innerJoin('employee.departmentHr', department, 'department.moduleCode = :m');
      qb.where('employee.departmentHrId = :id');
      throw new Error('Department is not available for assignment');`);
    expect(retiredReferences(clean)).toEqual([]);
  });

  it('tells a column Postgres rejects when omitted from one it accepts', () => {
    expect(isInsertableByOmission('"hr"."employees_department_enum" NOT NULL')).toBe(false);
    expect(isInsertableByOmission('boolean NOT NULL DEFAULT false')).toBe(true);
    expect(isInsertableByOmission('character varying')).toBe(true);
  });
});
