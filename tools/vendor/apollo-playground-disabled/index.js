'use strict';

/**
 * Nest Apollo imports this legacy symbol even when Playground is disabled.
 * Keeping the module resolvable avoids an Apollo 4 production dependency,
 * while throwing here makes any accidental attempt to re-enable Playground
 * fail closed. Development GraphQL UI is provided through Nest's GraphiQL
 * integration instead.
 */
function ApolloServerPluginLandingPageGraphQLPlayground() {
  throw new Error(
    'Deprecated Apollo Playground is disabled; configure the supported GraphiQL integration.',
  );
}

module.exports = { ApolloServerPluginLandingPageGraphQLPlayground };
