import {
  decodeCanonicalImpersonationPermissionsV1,
  evaluateImpersonationAuthorization,
  isImpersonationModule,
  type ImpersonationModule,
  type ImpersonationOperationDescriptor,
  type ImpersonationPermissionsContract,
} from '@aquaculture/shared-contracts';
import { ForbiddenException } from '@nestjs/common';
import {
  Kind,
  parse,
  visit,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { IMPERSONATION_GRAPHQL_OPERATION_POLICY } from './generated/impersonation-graphql-operation-policy.generated';
import { resolveImpersonationRestOperationPolicy } from './impersonation-route-consumer-catalog';

function operationDefinition(
  document: DocumentNode,
  operationName?: string,
): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operationName) {
    return operations.find((operation) => operation.name?.value === operationName);
  }
  return operations.length === 1 ? operations[0] : undefined;
}

function collectRootFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  fields: Set<string>,
  visitedFragments: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.name.value.startsWith('__')) fields.add(selection.name.value);
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectRootFields(selection.selectionSet, fragments, fields, visitedFragments);
      continue;
    }
    const fragmentName = selection.name.value;
    if (visitedFragments.has(fragmentName)) continue;
    const fragment = fragments.get(fragmentName);
    if (!fragment) {
      throw new ForbiddenException('Impersonation GraphQL fragment is unresolved');
    }
    visitedFragments.add(fragmentName);
    collectRootFields(fragment.selectionSet, fragments, fields, visitedFragments);
  }
}

function containsIntrospectionField(selectionSet: SelectionSetNode): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith('__')) return true;
      if (selection.selectionSet && containsIntrospectionField(selection.selectionSet)) return true;
      continue;
    }
    if (
      selection.kind === Kind.INLINE_FRAGMENT &&
      containsIntrospectionField(selection.selectionSet)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Introspection and other locally-resolved GraphQL successes have no subgraph
 * adapter at which an exact receipt can be committed, so impersonation rejects
 * them before Apollo execution.
 */
export function assertImpersonationGraphqlEnvelope(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForbiddenException('Impersonation GraphQL envelope is invalid');
  }
  const envelope = value as Readonly<Record<string, unknown>>;
  const envelopeKeys = Object.keys(envelope);
  if (
    envelopeKeys.some((key) => !['operationName', 'query', 'variables'].includes(key)) ||
    (envelope.operationName !== undefined &&
      envelope.operationName !== null &&
      typeof envelope.operationName !== 'string') ||
    (envelope.variables !== undefined &&
      envelope.variables !== null &&
      (typeof envelope.variables !== 'object' || Array.isArray(envelope.variables)))
  ) {
    throw new ForbiddenException('Impersonation GraphQL envelope shape is not canonical');
  }
  if (typeof envelope.query !== 'string') {
    throw new ForbiddenException('Impersonation GraphQL query is missing');
  }
  let document: DocumentNode;
  try {
    document = parse(envelope.query);
  } catch {
    throw new ForbiddenException('Impersonation GraphQL query is invalid');
  }
  const operationName =
    typeof envelope.operationName === 'string' ? envelope.operationName : undefined;
  const operation = operationDefinition(document, operationName);
  let hasIncrementalDirective = false;
  visit(document, {
    Directive(node): void {
      if (node.name.value === 'defer' || node.name.value === 'stream') {
        hasIncrementalDirective = true;
      }
    },
  });
  const hasIntrospection = document.definitions.some(
    (definition) =>
      (definition.kind === Kind.OPERATION_DEFINITION ||
        definition.kind === Kind.FRAGMENT_DEFINITION) &&
      containsIntrospectionField(definition.selectionSet),
  );
  if (
    !operation ||
    operation.operation === 'subscription' ||
    hasIncrementalDirective ||
    hasIntrospection
  ) {
    throw new ForbiddenException(
      'Impersonation GraphQL request has no exact outward operation authority',
    );
  }
}

/**
 * Resolve the actual subgraph document, never the caller-controlled operation
 * label. Every root coordinate must exist in the generated live-SDL policy;
 * unknown fields fail closed instead of falling through to a generic grant.
 */
export function resolveGraphqlImpersonationOperations(input: {
  readonly query: string;
  readonly operationName?: string;
  readonly module: string;
}): readonly ImpersonationOperationDescriptor[] {
  if (!isImpersonationModule(input.module)) {
    throw new ForbiddenException('Impersonation target module is not canonical');
  }
  const module: ImpersonationModule = input.module;

  let document: DocumentNode;
  try {
    document = parse(input.query);
  } catch {
    throw new ForbiddenException('Impersonation GraphQL operation is invalid');
  }
  const operation = operationDefinition(document, input.operationName);
  if (!operation) {
    throw new ForbiddenException('Impersonation GraphQL operation is ambiguous');
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const rootFields = new Set<string>();
  collectRootFields(operation.selectionSet, fragments, rootFields, new Set<string>());
  if (rootFields.size === 0) {
    throw new ForbiddenException('Impersonation GraphQL operation has no authorized root field');
  }
  const rootType =
    operation.operation === 'query'
      ? 'Query'
      : operation.operation === 'mutation'
        ? 'Mutation'
        : 'Subscription';
  const policy = IMPERSONATION_GRAPHQL_OPERATION_POLICY[module];
  return Object.freeze(
    [...rootFields].map((field) => {
      const coordinate = `${rootType}.${field}`;
      const authority = policy[coordinate];
      if (!authority) {
        throw new ForbiddenException(
          `Impersonation GraphQL coordinate is absent from the closed policy: ${coordinate}`,
        );
      }
      return { authority, module, operation: coordinate };
    }),
  );
}

export function resolveRestImpersonationOperation(input: {
  readonly serviceName: string;
  readonly method: string;
  readonly path: string;
}): ImpersonationOperationDescriptor {
  const operation = resolveImpersonationRestOperationPolicy(input);
  if (!operation) {
    throw new ForbiddenException('Impersonation REST operation is absent from the closed policy');
  }
  return operation;
}

export function enforceImpersonationOperations(
  permissions: ImpersonationPermissionsContract,
  operations: readonly ImpersonationOperationDescriptor[],
): void {
  if (operations.length === 0) {
    throw new ForbiddenException('Impersonation operation authority is missing');
  }
  const canonicalPermissions = decodeCanonicalImpersonationPermissionsV1(permissions);
  if (!canonicalPermissions) {
    throw new ForbiddenException('Impersonation permission snapshot is not canonical');
  }
  const decision = evaluateImpersonationAuthorization(canonicalPermissions, operations);
  if (!decision.allowed) {
    throw new ForbiddenException('Impersonation session does not authorize this operation');
  }
}
