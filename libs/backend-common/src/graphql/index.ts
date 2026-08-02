/**
 * `@aquaculture/backend-common/graphql` — shared GraphQL primitives.
 *
 * Home of the platform Shared-Kernel scalars (ADR-0004). Referenced from
 * code-first `@Field(() => DecimalScalar)` in any subgraph; Apollo Federation
 * composes the `Decimal` scalar by name across subgraphs.
 */
export { DecimalScalar } from './decimal.scalar';
export * from './graphql-operation-limit.plugin';
