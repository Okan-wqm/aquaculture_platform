import type { ApolloServerPlugin } from '@apollo/server';
import type { GraphQLFormattedError } from 'graphql';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

/**
 * Shared subgraph GraphQL hardening preset (SEC-MEDIUM-077 / SEC-LOW-116 —
 * 2026-08-23 scan №22/№61).
 *
 * The gateway enforces depth/complexity/batching on the only public path,
 * but the repo's own rule is that subgraphs must also enforce it "in case a
 * subgraph becomes directly accessible" — five subgraphs (billing, alert,
 * config, notification, auth) shipped without the complexity plugin and/or a
 * production error mask, so raw TypeORM error text (row values included)
 * could ride the gateway's message passthrough to external clients.
 *
 * Zero-effort defaults: every subgraph spreads these into its
 * GraphQLModule config instead of hand-rolling its own variants.
 */

/**
 * Mask internal error messages in production; dev keeps them verbatim.
 * Apollo operational codes (validation, bad input) keep their message —
 * they are safe and actionable; everything else collapses to a generic
 * message so DB/driver text never leaks.
 */
export function subgraphFormatError(
  isProduction: boolean,
): ((formattedError: GraphQLFormattedError, error: unknown) => GraphQLFormattedError) | undefined {
  if (!isProduction) return undefined;
  return (formattedError: GraphQLFormattedError): GraphQLFormattedError => {
    const code = formattedError.extensions?.['code'];
    const keepMessage = code === 'BAD_USER_INPUT' || code === 'GRAPHQL_VALIDATION_FAILED';
    if (keepMessage) return formattedError;
    return {
      message: 'An error occurred while processing your request',
      extensions: {
        code: typeof code === 'string' ? code : 'INTERNAL_SERVER_ERROR',
      },
    };
  };
}

/** didResolveOperation context fields used by the complexity plugin. */
interface QueryComplexityOperationContext {
  request: { operationName?: string | null; variables?: Record<string, unknown> | null };
  document: Parameters<typeof getComplexity>[0]['query'];
  schema: Parameters<typeof getComplexity>[0]['schema'];
}

/** No-op stand-in when no logger is supplied (the plugin stays silent). */
const consoleSilent = { warn: (_message: string): void => undefined };

/**
 * Apollo Server plugin rejecting operations above `maxComplexity`
 * (mirror of sensor-service's battle-tested shape — the SSoT pattern).
 */
export function subgraphComplexityPlugin(
  maxComplexity: number,
  logger: { warn: (message: string) => unknown } = consoleSilent,
): ApolloServerPlugin {
  return {
    // Neither hook awaits anything — the complexity estimate is synchronous — so
    // both return their promise explicitly instead of being `async` for a
    // contract they never use (the shape gateway-api's plugin already uses).
    requestDidStart: () =>
      Promise.resolve({
        didResolveOperation: ({
          request,
          document,
          schema,
        }: QueryComplexityOperationContext): Promise<void> => {
          const complexity = getComplexity({
            schema,
            operationName: request.operationName ?? undefined,
            query: document,
            variables: request.variables ?? undefined,
            estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
          });
          if (complexity > maxComplexity) {
            logger.warn(`Query complexity ${complexity} exceeds max ${maxComplexity}`);
            const error = new GraphQLError(
              `Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`,
              { extensions: { code: 'QUERY_COMPLEXITY_EXCEEDED' } },
            );
            throw error;
          }
          return Promise.resolve();
        },
      }),
  };
}
