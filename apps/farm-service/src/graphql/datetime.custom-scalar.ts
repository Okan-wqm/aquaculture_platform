/**
 * DateTime custom-scalar provider (PLAT-CRITICAL-931 follow-up).
 *
 * WHY a provider: the ApolloFederationDriver's schema factory takes the
 * scalars map from the ScalarsExplorer ONLY — `GraphQLModule.forRoot({
 * scalarsMap: [...] })` is silently ignored on that path
 * (graphql-federation.factory.js builds `scalarsMap` from
 * `scalarsExplorerService.getScalarsMap()` and spreads it OVER
 * buildSchemaOptions). The explorer discovers scalars through the
 * `@Scalar(name, type)` metadata on providers, so this class is the ONE
 * registration the federation subgraph actually honours.
 *
 * WHAT it fixes: TypeORM's Postgres driver hydrates `date` columns to
 * date-only strings ("2026-10-17") while the default GraphQLISODateTime
 * serialises only real `Date` instances and returns null for them — every
 * query selecting such a field crashed with
 * `Expected DateTime.serialize("YYYY-MM-DD") to return non-nullable value`
 * (production: purchaseOrders.expectedDeliveryDate, workOrders.dueDate).
 * The serialisation logic lives on the shared platform instance in
 * backend-common (SSoT beside DecimalScalar); this provider only binds it.
 */
import { Scalar, type CustomScalar } from '@nestjs/graphql';
import type { GraphQLScalarType } from 'graphql';
import { DateTimeScalar as PlatformDateTimeScalar } from '@aquaculture/backend-common/graphql';

@Scalar('DateTime', () => Date)
export class DateTimeCustomScalar implements CustomScalar<string, Date> {
  readonly description = PlatformDateTimeScalar.description ?? undefined;

  serialize(value: unknown): string | null {
    return PlatformDateTimeScalar.serialize(value);
  }

  parseValue(value: unknown): Date {
    return PlatformDateTimeScalar.parseValue(value);
  }

  parseLiteral(ast: Parameters<GraphQLScalarType['parseLiteral']>[0]): Date {
    return PlatformDateTimeScalar.parseLiteral(ast);
  }
}
