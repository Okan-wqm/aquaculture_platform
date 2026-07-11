import Decimal from 'decimal.js';
import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * `Decimal` — the platform Shared-Kernel GraphQL scalar for exact numbers
 * (ADR-0004). Serialises to a decimal STRING so monetary and other
 * precision-sensitive values cross the wire without IEEE-754 float loss
 * (DATA-MEDIUM-009), the way `@platform/event-contracts` money already does.
 *
 * # Wire-only — the DB axis is untouched
 *
 * A resolver may return a JS `number` (columns using `DecimalTransformer`) OR a
 * `Decimal.js` instance (columns using `@MoneyColumn`) OR a string; `serialize`
 * normalises all three to the canonical decimal string. Money values are stored
 * as `numeric(_, 2..4)`, so a `number` read back is the exact round-trip of a
 * fixed-scale decimal (e.g. `12345.67`) and `new Decimal(n).toString()` reproduces
 * `"12345.67"` — no float artefacts enter the string.
 *
 * # Co-ownership
 *
 * billing-expert (money-domain) + data-expert (shared-infra). Any change here or
 * to the FE `formatCurrency` signature requires their joint sign-off (ADR-0004).
 */

/** Normalise number | Decimal | string to the canonical exact decimal string. */
function toDecimalString(value: unknown): string {
  // decimal.js accepts number, string, and Decimal instances; it reads a JS
  // number via its shortest round-trip representation, so a fixed-scale money
  // number serialises exactly.
  const decimal = value instanceof Decimal ? value : new Decimal(value as Decimal.Value);
  return decimal.toString();
}

export const DecimalScalar = new GraphQLScalarType<string | null, string | null>({
  name: 'Decimal',
  description:
    'An exact decimal number serialised as a string to avoid IEEE-754 float loss ' +
    '(monetary and other precision-sensitive values). ADR-0004 Shared-Kernel scalar.',

  /** Resolver value (number | Decimal | string) → decimal string on the wire. */
  serialize(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    try {
      return toDecimalString(value);
    } catch {
      throw new TypeError(`Decimal cannot serialize a non-numeric value (type ${typeof value})`);
    }
  },

  /** Inbound variable (string | number) → canonical decimal string. */
  parseValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`Decimal must be a string or number, got ${typeof value}`);
    }
    try {
      return toDecimalString(value);
    } catch {
      // value is narrowed to string | number here, so interpolation is safe.
      throw new TypeError(`Decimal received a non-numeric value: ${value}`);
    }
  },

  /** Inbound literal (string/int/float) → canonical decimal string. */
  parseLiteral(ast: ValueNode): string | null {
    if (ast.kind === Kind.NULL) {
      return null;
    }
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT || ast.kind === Kind.FLOAT) {
      try {
        return toDecimalString(ast.value);
      } catch {
        throw new TypeError(`Decimal received a non-numeric literal: ${ast.value}`);
      }
    }
    throw new TypeError(`Decimal can only parse string, int, or float literals, got ${ast.kind}`);
  },
});
