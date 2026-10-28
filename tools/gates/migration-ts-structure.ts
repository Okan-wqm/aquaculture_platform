/**
 * The TypeORM structure the ADR-053 R14 rule of migration-sql-lint reads from
 * a migration's source: the bodies of up() and down(), and every invocation in
 * them.
 *
 * WHY: the gate judges a migration by its SQL, and it reads SQL only from
 * `<runner>.query(\`…\`)` template literals. A helper (`addColumnWithIndex`,
 * `pinSearchPath`), a QueryRunner API (`createIndex`) or a query sent through
 * another receiver runs work that never reaches a SQL chunk. R14 sees every
 * invocation so that it can fail closed on each one whose work it did not
 * read, instead of passing a migration whose real statements it never saw.
 *
 * Pure: it reads nothing and knows no rule. migration-add-column-rules.ts
 * decides what an invocation means.
 */

import * as ts from 'typescript';

export interface Invocation {
  /** File offsets of the whole call, `new` expression or tagged template. */
  readonly start: number;
  readonly end: number;
  /** The callee as written, whitespace collapsed: `queryRunner.createIndex`, `new TableIndex`. */
  readonly callee: string;
  /**
   * For `<runner>.query(<template literal>, …)`, where `<runner>` is the
   * method's own QueryRunner parameter: the file offset of the first SQL
   * character after the backtick, which is where the gate's chunk of that call
   * starts when the gate read it. Null for every other invocation.
   */
  readonly runnerQuerySqlOffset: number | null;
}

export interface MigrationMethod {
  readonly name: 'up' | 'down';
  /** The body's range in the file text. */
  readonly start: number;
  readonly end: number;
  readonly invocations: readonly Invocation[];
}

interface MethodFunction {
  readonly body: ts.Node;
  readonly parameters: ts.NodeArray<ts.ParameterDeclaration>;
}

/** The function of `up() {…}` or of `up = async () => …`. */
function methodFunction(node: ts.Node): MethodFunction | undefined {
  if (ts.isMethodDeclaration(node)) {
    return node.body === undefined ? undefined : { body: node.body, parameters: node.parameters };
  }
  if (!ts.isPropertyDeclaration(node) || node.initializer === undefined) return undefined;
  const { initializer } = node;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? { body: initializer.body, parameters: initializer.parameters }
    : undefined;
}

/** The name of the method's first parameter (its QueryRunner), or null when it has none. */
function runnerName(parameters: ts.NodeArray<ts.ParameterDeclaration>): string | null {
  const [first] = parameters;
  return first !== undefined && ts.isIdentifier(first.name) ? first.name.text : null;
}

function collapsed(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, ' ').trim();
}

/** The SQL offset of `<runner>.query(<template literal>, …)`, or null for any other call. */
function runnerQuerySqlOffset(
  call: ts.CallExpression,
  runner: string | null,
  source: ts.SourceFile,
): number | null {
  const callee = call.expression;
  const [sql] = call.arguments;
  if (runner === null || call.questionDotToken !== undefined) return null;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  if (callee.name.text !== 'query' || !ts.isIdentifier(callee.expression)) return null;
  if (callee.expression.text !== runner || sql === undefined) return null;
  return ts.isNoSubstitutionTemplateLiteral(sql) || ts.isTemplateExpression(sql)
    ? sql.getStart(source) + 1
    : null;
}

/** Every call, `new` expression and tagged template inside `body`, nested ones included. */
function invocationsIn(
  body: ts.Node,
  runner: string | null,
  source: ts.SourceFile,
): readonly Invocation[] {
  const out: Invocation[] = [];
  const visit = (node: ts.Node): void => {
    let callee: string | null = null;
    let sqlOffset: number | null = null;
    if (ts.isCallExpression(node)) {
      callee = collapsed(node.expression, source);
      sqlOffset = runnerQuerySqlOffset(node, runner, source);
    } else if (ts.isNewExpression(node)) {
      callee = `new ${collapsed(node.expression, source)}`;
    } else if (ts.isTaggedTemplateExpression(node)) {
      callee = collapsed(node.tag, source);
    }
    if (callee !== null) {
      out.push({
        start: node.getStart(source),
        end: node.getEnd(),
        callee,
        runnerQuerySqlOffset: sqlOffset,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** The up() and down() of a TypeORM migration, with the invocations in each body. */
export function migrationMethods(text: string): readonly MigrationMethod[] {
  const source = ts.createSourceFile('migration.ts', text, ts.ScriptTarget.Latest, false);
  const methods: MigrationMethod[] = [];
  const visit = (node: ts.Node): void => {
    const name =
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)
        ? node.name.text
        : null;
    const fn = name === 'up' || name === 'down' ? methodFunction(node) : undefined;
    if ((name === 'up' || name === 'down') && fn !== undefined) {
      methods.push({
        name,
        start: fn.body.getStart(source),
        end: fn.body.getEnd(),
        invocations: invocationsIn(fn.body, runnerName(fn.parameters), source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return methods;
}
