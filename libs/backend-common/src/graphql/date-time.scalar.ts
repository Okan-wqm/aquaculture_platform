import { GraphQLScalarType, Kind, GraphQLError } from 'graphql';

/**
 * Platform `DateTime` scalar (SSoT — backend-common/graphql, beside
 * `DecimalScalar`).
 *
 * WHY this exists: TypeORM's Postgres driver hydrates `date` columns to
 * date-only STRINGS ("2026-10-17"), while @nestjs/graphql's built-in
 * GraphQLISODateTime serializes ONLY real `Date` instances
 * (`value instanceof Date ? value.toISOString() : null`). A hydrated
 * date-only string therefore reaches the default scalar, serialize returns
 * null, and every query selecting that field dies with
 * `Expected DateTime.serialize("YYYY-MM-DD") to return non-nullable value`
 * (seen in production on purchaseOrders.expectedDeliveryDate and
 * workOrders.dueDate). This scalar accepts every date representation the
 * platform actually produces — `Date`, date-only string, ISO string,
 * epoch number — so date columns serialize instead of crashing the query.
 *
 * Register once per subgraph (no per-entity transformers):
 * ```typescript
 * GraphQLModule.forRoot({
 *   ...
 *   scalarsMap: [{ type: Date, scalar: DateTimeScalar }],
 * })
 * ```
 */
export const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description:
    'A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format.',

  serialize(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'string') {
      const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return null;
  },

  parseValue(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
      throw new GraphQLError(`DateTime cannot represent value: ${String(value)}`);
    }
    throw new GraphQLError(`DateTime cannot represent value: ${String(value)}`);
  },

  parseLiteral(ast): Date {
    if (ast.kind === Kind.STRING) {
      const date = new Date(ast.value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
      throw new GraphQLError(`DateTime cannot represent value: ${ast.value}`);
    }
    if (ast.kind === Kind.INT) {
      const date = new Date(ast.value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    throw new GraphQLError('DateTime cannot represent non-string, non-integer value');
  },
});
