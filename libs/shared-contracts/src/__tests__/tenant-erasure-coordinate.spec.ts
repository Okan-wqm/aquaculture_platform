import { TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE } from '../index';

describe('tenant erasure storage coordinates', () => {
  it('publishes one stable proof-ledger table coordinate', () => {
    expect(TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE).toBe('tenant_erasure_target_proofs');
  });
});
