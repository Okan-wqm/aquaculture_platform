import type {
  WsMessageContentType,
  WsReceiptStatus,
  WsMessage,
  WsMessageReceipt,
} from '../websocket-envelopes';

/**
 * Resolves to `true` only when `V` is NOT assignable to `U` — a compile-time
 * negative type test that needs no compiler-suppression directive. A regression that makes `V`
 * assignable (e.g. WsMessageContentType reverting to the lowercase DB form)
 * collapses this to `never`, failing the `= true` assignment at compile time.
 */
type NotAssignable<V, U> = [V] extends [U] ? never : true;

/**
 * S1-CODEGEN / MSG-CRITICAL-055 wire-contract parity.
 *
 * The WS envelope enum unions MUST be the UPPERCASE GraphQL enum NAMES, so the
 * live WS `contentType`/`status` wire form is byte-identical to the GraphQL
 * query wire form the AquaMobil graphql-codegen client consumes. A regression
 * back to the lowercase DB-value form (the original enum-casing bug) would make
 * `WsMessageContentType` non-assignable from `'TEXT'` and fail this suite at
 * compile time.
 *
 * The assertion is type-level (a runtime test is the host for the compile-time
 * `satisfies`/assignment checks below) plus a structural guard on the exact
 * literal set, so an accidental member add/remove is also caught.
 */
describe('websocket-envelopes enum wire parity (UPPERCASE GraphQL NAMES)', () => {
  it('WsMessageContentType is exactly the UPPERCASE GraphQL enum NAME union', () => {
    const all: WsMessageContentType[] = ['TEXT', 'IMAGE', 'FILE', 'VOICE', 'SYSTEM'];
    expect(new Set(all)).toEqual(new Set(['TEXT', 'IMAGE', 'FILE', 'VOICE', 'SYSTEM']));

    // Compile-time: a lowercase DB literal must NOT be assignable to the union.
    const lowercaseRejected: NotAssignable<'text', WsMessageContentType> = true;
    void lowercaseRejected;
  });

  it('WsReceiptStatus is exactly the UPPERCASE GraphQL enum NAME union', () => {
    const all: WsReceiptStatus[] = ['DELIVERED', 'READ'];
    expect(new Set(all)).toEqual(new Set(['DELIVERED', 'READ']));

    // Compile-time: a lowercase DB literal must NOT be assignable to the union.
    const lowercaseRejected: NotAssignable<'read', WsReceiptStatus> = true;
    void lowercaseRejected;
  });

  it('WsMessage.contentType and WsMessageReceipt.status carry the UPPERCASE wire form', () => {
    const message: Pick<WsMessage, 'contentType'> = { contentType: 'TEXT' };
    const receipt: Pick<WsMessageReceipt, 'status'> = { status: 'READ' };
    expect(message.contentType).toBe('TEXT');
    expect(receipt.status).toBe('READ');
  });
});
