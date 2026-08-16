import type { ImpersonationOperationDescriptor } from '@aquaculture/shared-contracts';
import { ForbiddenException } from '@nestjs/common';

import {
  assertImpersonationReceiptLedgerCommitted,
  assertImpersonationReceiptLedgerReconciled,
  commitImpersonationOperationReceipt,
  createImpersonationReceiptCompletionPlugin,
  expectImpersonationOperationDispatch,
  impersonationReceiptLedgerSnapshot,
  initializeImpersonationReceiptLedger,
  markImpersonationOperationDispatched,
} from './impersonation-receipt-completion';

const OPERATION: readonly ImpersonationOperationDescriptor[] = Object.freeze([
  Object.freeze({ authority: 'data.read', module: 'auth', operation: 'Query.tenantUsers' }),
]);

function impersonatedState(): { readonly impersonationSessionId: string } {
  return { impersonationSessionId: '11111111-1111-4111-8111-111111111111' };
}

describe('impersonation receipt completion ledger', () => {
  it('does not apply to a request without an impersonation session', () => {
    expect(() => assertImpersonationReceiptLedgerReconciled({})).not.toThrow();
  });

  it('requires exact expected → committed → dispatched stage order', () => {
    const state = impersonatedState();
    initializeImpersonationReceiptLedger(state, 'POST /graphql');
    expect(() => commitImpersonationOperationReceipt(state, OPERATION)).toThrow(ForbiddenException);
    expectImpersonationOperationDispatch(state, OPERATION);
    expect(() => markImpersonationOperationDispatched(state, OPERATION)).toThrow(
      ForbiddenException,
    );
    commitImpersonationOperationReceipt(state, OPERATION);
    expect(() => assertImpersonationReceiptLedgerCommitted(state)).not.toThrow();
    markImpersonationOperationDispatched(state, OPERATION);
    expect(() => assertImpersonationReceiptLedgerCommitted(state)).toThrow(ForbiddenException);

    expect(impersonationReceiptLedgerSnapshot(state)).toEqual({
      schemaVersion: 'impersonation-receipt-ledger.v1',
      routeConsumerId: 'POST /graphql',
      expected: ['data.read\u0000auth\u0000Query.tenantUsers'],
      committed: ['data.read\u0000auth\u0000Query.tenantUsers'],
      dispatched: ['data.read\u0000auth\u0000Query.tenantUsers'],
    });
    expect(() => assertImpersonationReceiptLedgerReconciled(state)).not.toThrow();
  });

  it('rejects missing, duplicate, and cardinality-divergent lifecycle stages', () => {
    const missing = impersonatedState();
    expect(() => assertImpersonationReceiptLedgerReconciled(missing)).toThrow(ForbiddenException);

    const partial = impersonatedState();
    initializeImpersonationReceiptLedger(partial, 'POST /graphql');
    expectImpersonationOperationDispatch(partial, OPERATION);
    commitImpersonationOperationReceipt(partial, OPERATION);
    expect(() => assertImpersonationReceiptLedgerReconciled(partial)).toThrow(ForbiddenException);
    expect(() => expectImpersonationOperationDispatch(partial, OPERATION)).toThrow(
      ForbiddenException,
    );
  });

  it('runs the exact ledger fence from Apollo willSendResponse', async () => {
    const plugin = createImpersonationReceiptCompletionPlugin();
    const listener = await plugin.requestDidStart?.({} as never);
    if (!listener?.willSendResponse) throw new Error('Apollo completion hook is absent');

    const complete = impersonatedState();
    initializeImpersonationReceiptLedger(complete, 'POST /graphql');
    expectImpersonationOperationDispatch(complete, OPERATION);
    commitImpersonationOperationReceipt(complete, OPERATION);
    markImpersonationOperationDispatched(complete, OPERATION);
    await expect(
      listener.willSendResponse({
        contextValue: { req: complete },
        response: { body: { kind: 'single', singleResult: { data: { ok: true } } } },
      } as never),
    ).resolves.toBeUndefined();

    const incomplete = impersonatedState();
    initializeImpersonationReceiptLedger(incomplete, 'POST /graphql');
    await expect(
      listener.willSendResponse({
        contextValue: { req: incomplete },
        response: { body: { kind: 'single', singleResult: { data: { ok: true } } } },
      } as never),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('preserves a pre-dispatch GraphQL validation error but rejects partial dispatch evidence', async () => {
    const plugin = createImpersonationReceiptCompletionPlugin();
    const listener = await plugin.requestDidStart?.({} as never);
    if (!listener?.willSendResponse) throw new Error('Apollo completion hook is absent');
    const validationFailure = impersonatedState();
    await expect(
      listener.willSendResponse({
        contextValue: { req: validationFailure },
        response: { body: { kind: 'single', singleResult: { errors: [new Error('invalid')] } } },
      } as never),
    ).resolves.toBeUndefined();

    const partial = impersonatedState();
    initializeImpersonationReceiptLedger(partial, 'POST /graphql');
    expectImpersonationOperationDispatch(partial, OPERATION);
    await expect(
      listener.willSendResponse({
        contextValue: { req: partial },
        response: { body: { kind: 'single', singleResult: { errors: [new Error('failed')] } } },
      } as never),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});
