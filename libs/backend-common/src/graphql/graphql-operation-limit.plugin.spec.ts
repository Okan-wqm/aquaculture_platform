import { getIntrospectionQuery, GraphQLError, parse } from 'graphql';

import {
  collectGraphqlTopLevelFields,
  ENVIRONMENT_READ_OPERATION_FIELD_LIMITS,
  MAX_GRAPHQL_SELECTION_VISITS,
  validateGraphqlOperationLimits,
} from './graphql-operation-limit.plugin';

function captureGraphqlError(action: () => unknown): GraphQLError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    return error as GraphQLError;
  }
  throw new Error('Expected GraphQL validation to fail');
}

describe('GraphQL operation amplification limits', () => {
  it('blocks direct aliases of the same top-level query field', () => {
    const document = parse(`
      query EnvironmentAttack {
        first: environmentLayerCatalog(siteId: "site-1")
        second: environmentLayerCatalog(siteId: "site-1")
      }
    `);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'EnvironmentAttack', {
        maxRepeatedFields: 10,
        maxOccurrencesByField: ENVIRONMENT_READ_OPERATION_FIELD_LIMITS,
      }),
    );

    expect(error.extensions).toMatchObject({
      code: 'QUERY_VALIDATION_FAILED',
      reason: 'REPEATED_FIELD_LIMIT',
      fieldName: 'environmentLayerCatalog',
      actual: 2,
      maximum: 1,
    });
  });

  it('expands named fragments before enforcing repeated-field limits', () => {
    const document = parse(`
      query FragmentAttack {
        ...EnvironmentAliases
      }

      fragment EnvironmentAliases on Query {
        a: siteEnvironmentHistory(input: { siteId: "site-1" })
        b: siteEnvironmentHistory(input: { siteId: "site-1" })
      }
    `);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'FragmentAttack', {
        maxRepeatedFields: 1,
      }),
    );

    expect(error.extensions['reason']).toBe('REPEATED_FIELD_LIMIT');
    expect(error.extensions['fieldName']).toBe('siteEnvironmentHistory');
  });

  it('expands inline fragments before enforcing top-level field limits', () => {
    const document = parse(`
      query InlineFragmentAttack {
        ... on Query {
          one
          two
          three
        }
      }
    `);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'InlineFragmentAttack', {
        maxQueryFields: 2,
      }),
    );

    expect(error.extensions).toMatchObject({
      reason: 'TOP_LEVEL_FIELD_LIMIT',
      operationType: 'query',
      actual: 3,
      maximum: 2,
    });
  });

  it('validates only the operation selected by operationName', () => {
    const document = parse(`
      query AllowedOperation {
        health
      }

      query UnselectedAttack {
        a: environmentScenes(input: { siteId: "site-1" })
        b: environmentScenes(input: { siteId: "site-1" })
      }
    `);

    expect(() =>
      validateGraphqlOperationLimits(document, 'AllowedOperation', {
        maxRepeatedFields: 1,
      }),
    ).not.toThrow();

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'UnselectedAttack', {
        maxRepeatedFields: 1,
      }),
    );
    expect(error.extensions['reason']).toBe('REPEATED_FIELD_LIMIT');
  });

  it('fails closed when a multi-operation document has no operationName', () => {
    const document = parse(`
      query One { health }
      query Two { health }
    `);

    const error = captureGraphqlError(() => validateGraphqlOperationLimits(document));

    expect(error.extensions).toMatchObject({
      code: 'QUERY_VALIDATION_FAILED',
      reason: 'OPERATION_SELECTION_FAILED',
    });
  });

  it('blocks sensitive mutation aliases hidden in a named fragment', () => {
    const document = parse(`
      mutation LoginAttack {
        ...LoginAttempts
      }

      fragment LoginAttempts on Mutation {
        first: login
        second: login
      }
    `);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'LoginAttack', {
        maxRepeatedFields: 10,
      }),
    );

    expect(error.extensions).toMatchObject({
      reason: 'SENSITIVE_MUTATION_LIMIT',
      fieldName: 'login',
      actual: 2,
      maximum: 1,
    });
  });

  it('counts merged response keys once while preserving distinct aliases', () => {
    const merged = collectGraphqlTopLevelFields(
      parse(
        `query Merged { status status ...StatusFragment } fragment StatusFragment on Query { status }`,
      ),
      'Merged',
    );

    expect(merged.fields).toEqual([{ fieldName: 'status', responseName: 'status' }]);
  });

  it('fails closed on cyclic fragment graphs instead of recursing indefinitely', () => {
    const document = parse(`
      query Cyclic { ...One }
      fragment One on Query { ...Two }
      fragment Two on Query { ...One }
    `);

    const error = captureGraphqlError(() => validateGraphqlOperationLimits(document, 'Cyclic'));

    expect(error.extensions['reason']).toBe('INVALID_FRAGMENT_GRAPH');
  });

  it('rejects excessive nested depth before recursive complexity estimators run', () => {
    const document = parse(`
      query Deep {
        one { two { three { four { five { six } } } } }
      }
    `);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'Deep', { maxDepth: 5 }),
    );

    expect(error.extensions).toMatchObject({
      reason: 'OPERATION_DEPTH_LIMIT',
      actual: 6,
      maximum: 5,
    });
  });

  it('allows the standard introspection document when the boundary enables introspection', () => {
    const document = parse(getIntrospectionQuery());

    expect(() => validateGraphqlOperationLimits(document, 'IntrospectionQuery')).not.toThrow();
  });

  it('bounds acyclic fragment DAG expansion without recursion or exponential work', () => {
    const fragments = ['fragment F0 on Query { health }'];
    for (let index = 1; index <= 14; index += 1) {
      fragments.push(`fragment F${index} on Query { ...F${index - 1} ...F${index - 1} }`);
    }
    const document = parse(`query FragmentDag { ...F14 } ${fragments.join('\n')}`);

    const error = captureGraphqlError(() =>
      validateGraphqlOperationLimits(document, 'FragmentDag'),
    );

    expect(error.extensions).toMatchObject({
      reason: 'SELECTION_TRAVERSAL_LIMIT',
      maximum: MAX_GRAPHQL_SELECTION_VISITS,
    });
  });

  it('rejects invalid configuration during plugin construction/validation', () => {
    expect(() =>
      validateGraphqlOperationLimits(parse('query Valid { health }'), 'Valid', {
        maxRepeatedFields: 0,
      }),
    ).toThrow('maxRepeatedFields must be a positive safe integer');
  });
});
