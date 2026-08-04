import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import {
  getOperationAST,
  GraphQLError,
  Kind,
  OperationTypeNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

const VALIDATION_ERROR_CODE = 'QUERY_VALIDATION_FAILED';

const DEFAULT_SENSITIVE_MUTATION_FIELDS = Object.freeze([
  'login',
  'loginWithCredentials',
  'refreshToken',
  'resetPassword',
  'forgotPassword',
  'verifyMfaLogin',
  'changePassword',
]);

export const DEFAULT_GRAPHQL_OPERATION_LIMITS = Object.freeze({
  maxDepth: 10,
  maxQueryFields: 50,
  maxMutationFields: 10,
  maxRepeatedFields: 5,
  maxSensitiveMutationOccurrences: 1,
});
export const MAX_GRAPHQL_SELECTION_VISITS = 10_000;

/**
 * Expensive farm-environment reads are deliberately single-execution fields.
 * Both the public gateway and the farm subgraph consume this policy so direct
 * subgraph access cannot bypass the gateway's amplification fence.
 */
export const ENVIRONMENT_READ_OPERATION_FIELD_LIMITS: Readonly<Record<string, number>> =
  Object.freeze({
    siteEnvironmentCurrent: 1,
    siteEnvironmentHistory: 1,
    siteEnvironmentForecast: 1,
    environmentLayerCatalog: 1,
    environmentScenes: 1,
  });

export interface GraphqlOperationLimitOptions {
  readonly maxDepth?: number;
  readonly maxQueryFields?: number;
  readonly maxMutationFields?: number;
  readonly maxRepeatedFields?: number;
  readonly maxOccurrencesByField?: Readonly<Record<string, number>>;
  readonly sensitiveMutationFields?: readonly string[];
  readonly maxSensitiveMutationOccurrences?: number;
}

export interface GraphqlTopLevelField {
  readonly fieldName: string;
  readonly responseName: string;
}

export interface GraphqlTopLevelOperation {
  readonly operation: OperationDefinitionNode['operation'];
  readonly fields: readonly GraphqlTopLevelField[];
}

interface NormalizedGraphqlOperationLimitOptions {
  readonly maxDepth: number;
  readonly maxQueryFields: number;
  readonly maxMutationFields: number;
  readonly maxRepeatedFields: number;
  readonly maxOccurrencesByField: Readonly<Record<string, number>>;
  readonly sensitiveMutationFields: ReadonlySet<string>;
  readonly maxSensitiveMutationOccurrences: number;
}

function operationLimitError(
  message: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: VALIDATION_ERROR_CODE,
      reason,
      ...details,
    },
  });
}

function requirePositiveInteger(value: number, optionName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${optionName} must be a positive safe integer`);
  }
  return value;
}

function normalizeOptions(
  options: GraphqlOperationLimitOptions,
): NormalizedGraphqlOperationLimitOptions {
  const maxOccurrencesByField: Record<string, number> = {};
  for (const [fieldName, maximum] of Object.entries(options.maxOccurrencesByField ?? {})) {
    if (fieldName.trim().length === 0) {
      throw new TypeError('maxOccurrencesByField cannot contain an empty field name');
    }
    maxOccurrencesByField[fieldName] = requirePositiveInteger(
      maximum,
      `maxOccurrencesByField.${fieldName}`,
    );
  }

  return {
    maxDepth: requirePositiveInteger(
      options.maxDepth ?? DEFAULT_GRAPHQL_OPERATION_LIMITS.maxDepth,
      'maxDepth',
    ),
    maxQueryFields: requirePositiveInteger(
      options.maxQueryFields ?? DEFAULT_GRAPHQL_OPERATION_LIMITS.maxQueryFields,
      'maxQueryFields',
    ),
    maxMutationFields: requirePositiveInteger(
      options.maxMutationFields ?? DEFAULT_GRAPHQL_OPERATION_LIMITS.maxMutationFields,
      'maxMutationFields',
    ),
    maxRepeatedFields: requirePositiveInteger(
      options.maxRepeatedFields ?? DEFAULT_GRAPHQL_OPERATION_LIMITS.maxRepeatedFields,
      'maxRepeatedFields',
    ),
    maxOccurrencesByField: Object.freeze(maxOccurrencesByField),
    sensitiveMutationFields: new Set(
      options.sensitiveMutationFields ?? DEFAULT_SENSITIVE_MUTATION_FIELDS,
    ),
    maxSensitiveMutationOccurrences: requirePositiveInteger(
      options.maxSensitiveMutationOccurrences ??
        DEFAULT_GRAPHQL_OPERATION_LIMITS.maxSensitiveMutationOccurrences,
      'maxSensitiveMutationOccurrences',
    ),
  };
}

/**
 * Expands the selected operation's top-level selections through inline and
 * named fragments. Fields are de-duplicated by response name because GraphQL
 * executes merged fields with the same response key once; aliases with unique
 * response names remain separate resolver executions.
 */
export function collectGraphqlTopLevelFields(
  document: DocumentNode,
  operationName?: string | null,
  maximumDepth = Number.MAX_SAFE_INTEGER,
): GraphqlTopLevelOperation {
  const operation = getOperationAST(document, operationName ?? undefined);
  if (!operation) {
    throw operationLimitError(
      'Unable to identify exactly one requested GraphQL operation.',
      'OPERATION_SELECTION_FAILED',
    );
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(definition.name.value)) {
        throw operationLimitError(
          `Duplicate GraphQL fragment "${definition.name.value}".`,
          'INVALID_FRAGMENT_GRAPH',
          { fragmentName: definition.name.value },
        );
      }
      fragments.set(definition.name.value, definition);
    }
  }

  const fieldsByResponseName = new Map<string, GraphqlTopLevelField>();
  interface SelectionFrame {
    readonly selectionSet: SelectionSetNode;
    readonly fieldDepth: number;
    readonly fragmentName: string | null;
    index: number;
  }
  const stack: SelectionFrame[] = [
    {
      selectionSet: operation.selectionSet,
      fieldDepth: 0,
      fragmentName: null,
      index: 0,
    },
  ];
  const activeFragments = new Set<string>();
  let selectionVisits = 0;

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.index >= frame.selectionSet.selections.length) {
      if (frame.fragmentName) {
        activeFragments.delete(frame.fragmentName);
      }
      continue;
    }
    const selection = frame.selectionSet.selections[frame.index];
    if (selection === undefined) {
      throw operationLimitError(
        'GraphQL selection graph contains an invalid empty selection.',
        'INVALID_SELECTION_GRAPH',
      );
    }
    frame.index += 1;
    stack.push(frame);
    selectionVisits += 1;
    if (selectionVisits > MAX_GRAPHQL_SELECTION_VISITS) {
      throw operationLimitError(
        `GraphQL selection traversal exceeds ${MAX_GRAPHQL_SELECTION_VISITS} nodes.`,
        'SELECTION_TRAVERSAL_LIMIT',
        { maximum: MAX_GRAPHQL_SELECTION_VISITS },
      );
    }

    if (selection.kind === Kind.FIELD) {
      const fieldName = selection.name.value;
      const fieldDepth = frame.fieldDepth + 1;

      // GraphQL reserves the `__` namespace for introspection. Preserve the
      // top-level occurrence accounting used by the amplification limits, but
      // do not charge or traverse introspection subtrees for application depth.
      // This matches graphql-depth-limit's long-standing behaviour and keeps
      // the standard tooling introspection document usable when introspection
      // is explicitly enabled by the boundary.
      if (fieldName.startsWith('__')) {
        if (fieldDepth === 1) {
          const responseName = selection.alias?.value ?? fieldName;
          const existing = fieldsByResponseName.get(responseName);
          if (existing && existing.fieldName !== fieldName) {
            throw operationLimitError(
              `Conflicting top-level GraphQL response name "${responseName}".`,
              'INVALID_TOP_LEVEL_SELECTION',
              { responseName },
            );
          }
          if (!existing) {
            fieldsByResponseName.set(responseName, { fieldName, responseName });
          }
        }
        continue;
      }

      if (fieldDepth > maximumDepth) {
        throw operationLimitError(
          `GraphQL operation depth ${fieldDepth} exceeds maximum ${maximumDepth}.`,
          'OPERATION_DEPTH_LIMIT',
          { actual: fieldDepth, maximum: maximumDepth },
        );
      }

      const responseName = selection.alias?.value ?? fieldName;
      if (fieldDepth === 1) {
        const existing = fieldsByResponseName.get(responseName);
        if (existing && existing.fieldName !== fieldName) {
          throw operationLimitError(
            `Conflicting top-level GraphQL response name "${responseName}".`,
            'INVALID_TOP_LEVEL_SELECTION',
            { responseName },
          );
        }
        if (!existing) {
          fieldsByResponseName.set(responseName, { fieldName, responseName });
        }
      }
      if (selection.selectionSet) {
        stack.push({
          selectionSet: selection.selectionSet,
          fieldDepth,
          fragmentName: null,
          index: 0,
        });
      }
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      stack.push({
        selectionSet: selection.selectionSet,
        fieldDepth: frame.fieldDepth,
        fragmentName: null,
        index: 0,
      });
      continue;
    }

    const fragmentName = selection.name.value;
    const fragment = fragments.get(fragmentName);
    if (!fragment) {
      throw operationLimitError(
        `Unknown GraphQL fragment "${fragmentName}".`,
        'INVALID_FRAGMENT_GRAPH',
        { fragmentName },
      );
    }
    if (activeFragments.has(fragmentName)) {
      throw operationLimitError(
        `Cyclic GraphQL fragment "${fragmentName}".`,
        'INVALID_FRAGMENT_GRAPH',
        { fragmentName },
      );
    }
    activeFragments.add(fragmentName);
    stack.push({
      selectionSet: fragment.selectionSet,
      fieldDepth: frame.fieldDepth,
      fragmentName,
      index: 0,
    });
  }

  return {
    operation: operation.operation,
    fields: [...fieldsByResponseName.values()],
  };
}

function assertGraphqlOperationLimits(
  document: DocumentNode,
  operationName: string | null | undefined,
  options: NormalizedGraphqlOperationLimitOptions,
): GraphqlTopLevelOperation {
  const collected = collectGraphqlTopLevelFields(document, operationName, options.maxDepth);
  const maximumTopLevelFields =
    collected.operation === OperationTypeNode.MUTATION
      ? options.maxMutationFields
      : options.maxQueryFields;

  if (collected.fields.length > maximumTopLevelFields) {
    throw operationLimitError(
      `Too many top-level ${collected.operation} fields: ${collected.fields.length}. Maximum allowed: ${maximumTopLevelFields}.`,
      'TOP_LEVEL_FIELD_LIMIT',
      {
        operationType: collected.operation,
        actual: collected.fields.length,
        maximum: maximumTopLevelFields,
      },
    );
  }

  const occurrences = new Map<string, number>();
  for (const field of collected.fields) {
    occurrences.set(field.fieldName, (occurrences.get(field.fieldName) ?? 0) + 1);
  }

  for (const [fieldName, actual] of occurrences) {
    const configuredMaximum = options.maxOccurrencesByField[fieldName] ?? options.maxRepeatedFields;
    const isSensitiveMutation =
      collected.operation === OperationTypeNode.MUTATION &&
      options.sensitiveMutationFields.has(fieldName);
    const maximum = isSensitiveMutation
      ? Math.min(configuredMaximum, options.maxSensitiveMutationOccurrences)
      : configuredMaximum;

    if (actual > maximum) {
      throw operationLimitError(
        `Too many occurrences of top-level GraphQL field "${fieldName}": ${actual}. Maximum allowed: ${maximum}.`,
        isSensitiveMutation ? 'SENSITIVE_MUTATION_LIMIT' : 'REPEATED_FIELD_LIMIT',
        {
          operationType: collected.operation,
          fieldName,
          actual,
          maximum,
        },
      );
    }
  }

  return collected;
}

export function validateGraphqlOperationLimits(
  document: DocumentNode,
  operationName?: string | null,
  options: GraphqlOperationLimitOptions = {},
): GraphqlTopLevelOperation {
  return assertGraphqlOperationLimits(document, operationName, normalizeOptions(options));
}

/** Apollo admission plugin backed by the fragment-aware shared validator. */
export function createGraphqlOperationLimitPlugin(
  options: GraphqlOperationLimitOptions = {},
): ApolloServerPlugin<BaseContext> {
  const normalizedOptions = normalizeOptions(options);

  return {
    requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
      return Promise.resolve({
        didResolveOperation({ document, operationName, logger }): Promise<void> {
          try {
            assertGraphqlOperationLimits(document, operationName, normalizedOptions);
          } catch (error) {
            if (error instanceof GraphQLError) {
              const reason = error.extensions['reason'];
              logger.warn(
                `action=graphql_operation_rejected reason=${typeof reason === 'string' ? reason : 'limit'}`,
              );
            }
            throw error;
          }
          return Promise.resolve();
        },
      });
    },
  };
}
