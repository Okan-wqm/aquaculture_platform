/**
 * Entity → table map, and where money is typed (BILLING-CRITICAL-002).
 *
 * Two questions the plan-catalogue gate asks, both needing the AST rather
 * than a grep:
 *
 *   1. Which entity classes declare which `schema.table`, and which of them
 *      are writable? admin-api legitimately maps other services' tables
 *      read-only (`synchronize: false`), so "who owns this table" is not
 *      "who names it" — it is "who names it WITHOUT that flag".
 *
 *   2. Which properties carry money, and in what type? A `numeric` column
 *      read through a Decimal transformer is exact; the same value as a
 *      `number` field inside a `jsonb` blob is an IEEE-754 double the
 *      database cannot constrain, index, or sum without loss.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

import { resolveDeclaration } from './dto-resolution';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const NOT_PRODUCTION = /(^|\/)(__tests__|__mocks__|dist|\.archive)\/|\.(spec|test)\.ts$/;

export interface EntityDeclaration {
  /** `<repo-relative file>#<ClassName>` */
  readonly id: string;
  readonly file: string;
  readonly className: string;
  readonly table: string;
  /** `null` when `@Entity()` declares no schema (per-tenant table, ADR-011). */
  readonly schema: string | null;
  /** `synchronize: false` — a read-only mapping of a table another service owns. */
  readonly readOnly: boolean;
  readonly line: number;
}

export interface JsonbMoneyField {
  /** `<repo-relative file>#<ValueType>.<property>` */
  readonly id: string;
  /** Where the jsonb column is declared. */
  readonly entityFile: string;
  readonly entityClass: string;
  readonly column: string;
  readonly valueType: string;
  readonly property: string;
  readonly propertyType: string;
}

/**
 * Property names that hold an amount of money. `rate`, `percent`, `count` and
 * the period words are deliberately excluded: they are not money, and a
 * `number` is the right type for them.
 */
const MONEY_NAME = /(price|amount|cost|fee|total|subtotal|balance|charge|revenue|payout)/i;
const NOT_MONEY_NAME = /(percent|rate|count|qty|quantity|days|months|years|multiplier|threshold)/i;

export function listEntityFiles(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--', 'apps/*/src/**/*.entity.ts', 'libs/**/*.entity.ts'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => !NOT_PRODUCTION.test(file));
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(resolve(REPO_ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function literalText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function readEntityOptions(call: ts.CallExpression): {
  table: string | null;
  schema: string | null;
  readOnly: boolean;
} {
  let table = literalText(call.arguments[0]);
  let schema: string | null = null;
  let readOnly = false;
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      if (property.name.text === 'name') table = literalText(property.initializer) ?? table;
      if (property.name.text === 'schema') schema = literalText(property.initializer);
      if (property.name.text === 'synchronize') {
        readOnly = property.initializer.kind === ts.SyntaxKind.FalseKeyword;
      }
    }
  }
  return { table, schema, readOnly };
}

/** Every `@Entity(...)` class in the fleet, with the table it claims. */
export function allEntityDeclarations(): EntityDeclaration[] {
  const declarations: EntityDeclaration[] = [];
  for (const file of listEntityFiles()) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const decorator of ts.getDecorators(node) ?? []) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
          if (call.expression.text !== 'Entity') continue;
          const { table, schema, readOnly } = readEntityOptions(call);
          if (!table) continue;
          declarations.push({
            id: `${file}#${node.name.text}`,
            file,
            className: node.name.text,
            table,
            schema,
            readOnly,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return declarations;
}

export interface StripeIdentifierProperty {
  /** `<repo-relative file>#<Class>.<property>` */
  readonly id: string;
  readonly file: string;
  readonly className: string;
  readonly property: string;
  readonly table: string;
  readonly schema: string | null;
  readonly readOnly: boolean;
}

/** `stripeCustomerId`, `stripePriceIds`, … — a reference to an object Stripe owns. */
const STRIPE_IDENTIFIER = /^stripe[A-Z]\w*Ids?$/;

/**
 * Every `@Column`-mapped Stripe identifier in the fleet, with the entity that
 * declares it and whether that entity is writable.
 *
 * A Stripe object has exactly one owner. Two WRITABLE homes for the same
 * identifier means two services can mint a product, a price or a customer for
 * the same thing, and neither row can be trusted afterwards; a read-only
 * mapping of someone else's column is fine and is not a duplicate.
 */
export function allStripeIdentifierProperties(): StripeIdentifierProperty[] {
  const byFileClass = new Map(
    allEntityDeclarations().map((entity) => [entity.id, entity] as const),
  );
  const properties: StripeIdentifierProperty[] = [];
  for (const file of listEntityFiles()) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const entity = byFileClass.get(`${file}#${node.name.text}`);
        if (entity) {
          for (const member of node.members) {
            if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
            if (!STRIPE_IDENTIFIER.test(member.name.text)) continue;
            const mapped = (ts.getDecorators(member) ?? []).some((decorator) => {
              const call = decorator.expression;
              return (
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === 'Column'
              );
            });
            if (!mapped) continue;
            properties.push({
              id: `${file}#${node.name.text}.${member.name.text}`,
              file,
              className: node.name.text,
              property: member.name.text,
              table: entity.table,
              schema: entity.schema,
              readOnly: entity.readOnly,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return properties;
}

function isJsonColumn(call: ts.CallExpression): boolean {
  for (const argument of call.arguments) {
    if (ts.isStringLiteralLike(argument) && /^(jsonb|json|simple-json)$/.test(argument.text)) {
      return true;
    }
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      if (property.name.text !== 'type') continue;
      const value = literalText(property.initializer);
      if (value && /^(jsonb|json|simple-json)$/.test(value)) return true;
    }
  }
  return false;
}

/** Strip `Foo[]`, `Foo | null`, `Record<string, Foo>` down to the named type. */
function namedTypeOf(type: ts.TypeNode): string | null {
  if (ts.isArrayTypeNode(type)) return namedTypeOf(type.elementType);
  if (ts.isUnionTypeNode(type)) {
    for (const member of type.types) {
      const named = namedTypeOf(member);
      if (named) return named;
    }
    return null;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    if (name === 'Array' || name === 'Record' || name === 'Partial' || name === 'Readonly') {
      const argument = type.typeArguments?.[type.typeArguments.length - 1];
      return argument ? namedTypeOf(argument) : null;
    }
    return name;
  }
  return null;
}

function membersOf(file: string, typeName: string): ts.NodeArray<ts.Node> | null {
  const resolved = resolveDeclaration(resolve(REPO_ROOT, file), typeName);
  if (resolved.interfaceNode) return resolved.interfaceNode.members;
  if (resolved.node) return resolved.node.members;
  return null;
}

/**
 * The money surface: entities that live in a billing module or map a table in
 * the `billing` schema.
 *
 * The jsonb-money rule is scoped to these on purpose. A name-based detector
 * cannot tell `totalFeedGiven` (kilograms) from `totalAmount` (currency), so
 * running it fleet-wide would be a heuristic dressed as an invariant. On the
 * billing surface the words mean money, and that is the surface the finding
 * is about.
 */
export function billingSurfaceEntityFiles(): string[] {
  const declarations = allEntityDeclarations();
  const billingSchemaFiles = new Set(
    declarations.filter((entity) => entity.schema === 'billing').map((entity) => entity.file),
  );
  return listEntityFiles().filter(
    (file) => file.includes('/billing/entities/') || billingSchemaFiles.has(file),
  );
}

/**
 * Every money-named property typed `number` inside a jsonb column's value
 * type, on the billing surface. A money field typed `string` is the
 * exact-decimal shape and passes.
 */
export function allJsonbMoneyFields(): JsonbMoneyField[] {
  const findings: JsonbMoneyField[] = [];
  for (const file of billingSurfaceEntityFiles()) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
          const isJson = (ts.getDecorators(member) ?? []).some((decorator) => {
            const call = decorator.expression;
            return (
              ts.isCallExpression(call) &&
              ts.isIdentifier(call.expression) &&
              call.expression.text === 'Column' &&
              isJsonColumn(call)
            );
          });
          if (!isJson || !member.type) continue;
          const valueType = namedTypeOf(member.type);
          if (!valueType) continue;
          const members = membersOf(file, valueType);
          if (!members) continue;
          for (const field of members) {
            if (
              (!ts.isPropertySignature(field) && !ts.isPropertyDeclaration(field)) ||
              !ts.isIdentifier(field.name) ||
              !field.type
            ) {
              continue;
            }
            const propertyName = field.name.text;
            if (!MONEY_NAME.test(propertyName) || NOT_MONEY_NAME.test(propertyName)) continue;
            const propertyType = field.type.getText(field.getSourceFile()).replace(/\s+/g, ' ');
            if (!/\bnumber\b/.test(propertyType)) continue;
            findings.push({
              id: `${file}#${valueType}.${propertyName}`,
              entityFile: file,
              entityClass: node.name.text,
              column: member.name.text,
              valueType,
              property: propertyName,
              propertyType,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
