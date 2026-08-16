import { graphQLOperationIdentity, graphqlClient } from '@aquaculture/shared-ui';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';

import { ADMIN_GRAPHQL_OPERATION_CATALOG } from './types/generated/admin-route-contracts';

export interface AdminGraphqlRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Sole admin-panel GraphQL transport capability.
 *
 * Callers supply a generated TypedDocumentNode, so the schema-validated result
 * and variables travel with the operation and cannot be invented with a local
 * generic argument.
 */
export function executeAdminGraphql<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  variables: TVariables,
  options?: AdminGraphqlRequestOptions,
): Promise<TResult> {
  if (options !== undefined) {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'signal')
    ) {
      throw new TypeError('admin GraphQL options permit only a cancellation signal');
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new TypeError('admin GraphQL signal must be an AbortSignal');
    }
  }
  const identity = graphQLOperationIdentity(document);
  if (identity.name === null) {
    throw new TypeError('admin GraphQL operations must be explicitly named');
  }
  const authority = Reflect.get(ADMIN_GRAPHQL_OPERATION_CATALOG, identity.name) as
    | {
        readonly document: TypedDocumentNode<unknown, unknown>;
        readonly kind: string;
      }
    | undefined;
  if (
    authority === undefined ||
    authority.kind !== identity.kind ||
    authority.document !== document
  ) {
    throw new TypeError(
      `admin GraphQL operation ${identity.kind} ${identity.name} is outside the exact generated document catalog`,
    );
  }
  return graphqlClient.request(
    document,
    variables,
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
}
