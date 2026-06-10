import { GraphQLError } from 'graphql';
import type {
  DocumentNode,
  OperationDefinitionNode,
  FieldNode,
} from 'graphql';
import type { ApolloServerPlugin } from '@apollo/server';
import { Logger } from '@nestjs/common';

/**
 * Sensitive authentication mutations that must not be aliased.
 * Each is limited to at most 1 occurrence per request to prevent
 * brute-force attacks via GraphQL aliases (e.g., sending 100 login
 * attempts in a single request to bypass rate limiting).
 *
 * SECURITY (H-10): Mutation names must match the actual GraphQL schema.
 * The auth-service exposes 'login' (not 'loginWithCredentials'), plus
 * 'forgotPassword' and 'verifyMfaLogin' which are sensitive authentication
 * operations that must also be protected against alias brute-force.
 */
const SENSITIVE_MUTATIONS = new Set([
  'login',
  'loginWithCredentials',
  'refreshToken',
  'resetPassword',
  'forgotPassword',
  'verifyMfaLogin',
  'changePassword',
]);

/** Maximum number of top-level fields allowed in a single mutation request. */
const MAX_MUTATION_FIELDS = 10;

/**
 * Creates an Apollo Server plugin that limits GraphQL alias abuse.
 *
 * Protects against two attack vectors:
 * 1. Alias brute-force: Attackers alias sensitive mutations (e.g., login)
 *    many times in a single request, bypassing per-request rate limits.
 * 2. Mutation batching: Sending an excessive number of top-level mutation
 *    fields in one request to amplify resource consumption.
 */
export function createAliasLimitPlugin(): ApolloServerPlugin {
  const logger = new Logger('AliasLimitPlugin');

  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document }: { document: DocumentNode }) {
          const operationDef = document.definitions.find(
            (def): def is OperationDefinitionNode =>
              def.kind === 'OperationDefinition',
          );

          if (!operationDef || operationDef.operation !== 'mutation') {
            return;
          }

          const topLevelFields = operationDef.selectionSet.selections.filter(
            (sel): sel is FieldNode => sel.kind === 'Field',
          );

          // Check total mutation field count
          if (topLevelFields.length > MAX_MUTATION_FIELDS) {
            logger.warn(
              `Mutation rejected: ${topLevelFields.length} top-level fields exceeds limit of ${MAX_MUTATION_FIELDS}`,
            );
            throw new GraphQLError(
              `Too many mutation fields: ${topLevelFields.length}. Maximum allowed: ${MAX_MUTATION_FIELDS}.`,
              { extensions: { code: 'QUERY_VALIDATION_FAILED' } },
            );
          }

          // Check sensitive mutation aliasing
          const sensitiveFieldCounts = new Map<string, number>();

          for (const field of topLevelFields) {
            const fieldName = field.name.value;

            if (SENSITIVE_MUTATIONS.has(fieldName)) {
              const count = (sensitiveFieldCounts.get(fieldName) ?? 0) + 1;
              sensitiveFieldCounts.set(fieldName, count);

              if (count > 1) {
                logger.warn(
                  `Alias brute-force attempt blocked: mutation "${fieldName}" appeared ${count} times`,
                );
                throw new GraphQLError(
                  `Duplicate mutation not allowed: "${fieldName}" can only appear once per request.`,
                  { extensions: { code: 'QUERY_VALIDATION_FAILED' } },
                );
              }
            }
          }
        },
      };
    },
  };
}
