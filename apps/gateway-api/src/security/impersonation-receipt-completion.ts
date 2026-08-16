import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import type { ImpersonationOperationDescriptor } from '@aquaculture/shared-contracts';
import { ForbiddenException } from '@nestjs/common';
import { GraphQLError } from 'graphql';

import type { GatewayContext, RequestWithUser } from '../federation/authenticated-data-source';

export interface ImpersonationReceiptCompletionState {
  readonly impersonationSessionId?: string;
}

export interface ImpersonationReceiptLedgerSnapshotV1 {
  readonly schemaVersion: 'impersonation-receipt-ledger.v1';
  readonly routeConsumerId: string;
  readonly expected: readonly string[];
  readonly committed: readonly string[];
  readonly dispatched: readonly string[];
}

interface MutableImpersonationReceiptLedgerV1 {
  readonly routeConsumerId: string;
  readonly expected: Set<string>;
  readonly committed: Set<string>;
  readonly dispatched: Set<string>;
}

const receiptLedgers = new WeakMap<object, MutableImpersonationReceiptLedgerV1>();

function operationKeys(operations: readonly ImpersonationOperationDescriptor[]): readonly string[] {
  if (operations.length === 0) {
    throw new ForbiddenException('Impersonation operation authority is missing');
  }
  const keys = operations.map(
    (operation) => `${operation.authority}\u0000${operation.module}\u0000${operation.operation}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new ForbiddenException('Impersonation operation set contains duplicate coordinates');
  }
  return keys;
}

function ledger(state: object): MutableImpersonationReceiptLedgerV1 {
  const current = receiptLedgers.get(state);
  if (!current) {
    throw new ForbiddenException('Impersonation receipt ledger is not initialized');
  }
  return current;
}

function addExactStage(
  state: object,
  operations: readonly ImpersonationOperationDescriptor[],
  stage: 'expected' | 'committed' | 'dispatched',
): void {
  const current = ledger(state);
  const keys = operationKeys(operations);
  const target = current[stage];
  const prerequisite = stage === 'committed' ? current.expected : current.committed;
  for (const key of keys) {
    if (target.has(key)) {
      throw new ForbiddenException(`Impersonation operation already entered ${stage} stage`);
    }
    if (stage !== 'expected' && !prerequisite.has(key)) {
      throw new ForbiddenException(`Impersonation operation skipped the ${stage} prerequisite`);
    }
  }
  for (const key of keys) target.add(key);
}

export function initializeImpersonationReceiptLedger(state: object, routeConsumerId: string): void {
  if (receiptLedgers.has(state) || routeConsumerId.length === 0) {
    throw new ForbiddenException('Impersonation receipt ledger initialization is not canonical');
  }
  receiptLedgers.set(state, {
    routeConsumerId,
    expected: new Set<string>(),
    committed: new Set<string>(),
    dispatched: new Set<string>(),
  });
}

export function expectImpersonationOperationDispatch(
  state: object,
  operations: readonly ImpersonationOperationDescriptor[],
): void {
  addExactStage(state, operations, 'expected');
}

export function commitImpersonationOperationReceipt(
  state: object,
  operations: readonly ImpersonationOperationDescriptor[],
): void {
  addExactStage(state, operations, 'committed');
}

export function markImpersonationOperationDispatched(
  state: object,
  operations: readonly ImpersonationOperationDescriptor[],
): void {
  addExactStage(state, operations, 'dispatched');
}

export function impersonationReceiptLedgerSnapshot(
  state: object,
): ImpersonationReceiptLedgerSnapshotV1 | undefined {
  const current = receiptLedgers.get(state);
  if (!current) return undefined;
  return Object.freeze({
    schemaVersion: 'impersonation-receipt-ledger.v1',
    routeConsumerId: current.routeConsumerId,
    expected: Object.freeze([...current.expected].sort()),
    committed: Object.freeze([...current.committed].sort()),
    dispatched: Object.freeze([...current.dispatched].sort()),
  });
}

function hasActiveImpersonation(state: ImpersonationReceiptCompletionState): boolean {
  return state.impersonationSessionId !== undefined;
}

function equalCoordinates(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertImpersonationReceiptLedgerReconciled(
  state: object & ImpersonationReceiptCompletionState,
): void {
  if (!hasActiveImpersonation(state)) return;
  const snapshot = impersonationReceiptLedgerSnapshot(state);
  if (
    !snapshot ||
    snapshot.expected.length === 0 ||
    !equalCoordinates(snapshot.expected, snapshot.committed) ||
    !equalCoordinates(snapshot.expected, snapshot.dispatched)
  ) {
    throw new ForbiddenException(
      'Impersonation receipt ledger does not reconcile expected, committed, and dispatched operations',
    );
  }
}

/** Authorization may return only after every expected durable receipt exists. */
export function assertImpersonationReceiptLedgerCommitted(
  state: object & ImpersonationReceiptCompletionState,
): void {
  if (!hasActiveImpersonation(state)) return;
  const snapshot = impersonationReceiptLedgerSnapshot(state);
  if (
    !snapshot ||
    snapshot.expected.length === 0 ||
    !equalCoordinates(snapshot.expected, snapshot.committed) ||
    snapshot.dispatched.length !== 0
  ) {
    throw new ForbiddenException(
      'Impersonation receipt ledger does not reconcile expected and committed operations before dispatch',
    );
  }
}

function ledgerHasActivity(state: object): boolean {
  const snapshot = impersonationReceiptLedgerSnapshot(state);
  return (
    snapshot !== undefined &&
    (snapshot.expected.length > 0 ||
      snapshot.committed.length > 0 ||
      snapshot.dispatched.length > 0)
  );
}

/** Apollo completion is the request-level fence for every federated dispatch. */
export function createImpersonationReceiptCompletionPlugin(): ApolloServerPlugin<GatewayContext> {
  return {
    requestDidStart(): Promise<GraphQLRequestListener<GatewayContext>> {
      return Promise.resolve({
        async willSendResponse({ contextValue, response }): Promise<void> {
          const successfulSingleResponse =
            response.body.kind === 'single' &&
            (response.body.singleResult.errors?.length ?? 0) === 0;
          if (successfulSingleResponse || ledgerHasActivity(contextValue.req)) {
            try {
              assertImpersonationReceiptLedgerReconciled(contextValue.req);
            } catch {
              throw new GraphQLError(
                'Impersonation receipt ledger does not reconcile expected, committed, and dispatched operations',
                { extensions: { code: 'FORBIDDEN' } },
              );
            }
          }
        },
      });
    },
  };
}

export function assertGatewayImpersonationReceiptLedgerReconciled(request: RequestWithUser): void {
  assertImpersonationReceiptLedgerReconciled(request);
}
