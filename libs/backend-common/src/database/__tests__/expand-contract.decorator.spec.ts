import 'reflect-metadata';

import {
  EXPAND_CONTRACT_META_KEY,
  ExpandContract,
  authorizesBreaking,
  getExpandContractMetadata,
} from '../expand-contract.decorator';

describe('@ExpandContract decorator', () => {
  it('attaches phase=expand metadata', () => {
    @ExpandContract({ phase: 'expand' })
    class M {}
    const meta = getExpandContractMetadata(M);
    expect(meta).toBeDefined();
    expect(meta?.phase).toBe('expand');
    expect(meta?.dependsOn).toBeUndefined();
  });

  it('attaches phase=contract metadata with dependsOn', () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand123' })
    class M {}
    const meta = getExpandContractMetadata(M);
    expect(meta?.phase).toBe('contract');
    expect(meta?.dependsOn).toBe('AddFooExpand123');
  });

  it('stores under the shared Symbol.for key so PR gate can read it', () => {
    @ExpandContract({ phase: 'expand' })
    class M {}
    const raw: unknown = Reflect.getMetadata(EXPAND_CONTRACT_META_KEY, M);
    expect(raw).toBeDefined();
    expect(typeof raw).toBe('object');
  });

  it('throws at decoration time on invalid phase', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ExpandContract({ phase: 'nonsense' as any }),
    ).toThrow(/expand.*contract/);
  });

  it('throws when phase=contract but dependsOn missing', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ExpandContract({ phase: 'contract' } as any),
    ).toThrow(/dependsOn/);
  });

  it('throws when dependsOn is not a string', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ExpandContract({ phase: 'contract', dependsOn: 42 as any }),
    ).toThrow(/dependsOn/);
  });

  it('preserves optional reason field', () => {
    @ExpandContract({
      phase: 'expand',
      reason: 'KVKK Art 5 retention reduction',
    })
    class M {}
    expect(getExpandContractMetadata(M)?.reason).toContain('KVKK');
  });

  it('getExpandContractMetadata returns undefined for undecorated class', () => {
    class Plain {}
    expect(getExpandContractMetadata(Plain)).toBeUndefined();
  });

  it('authorizesBreaking reports "no" for undecorated class', () => {
    class Plain {}
    expect(authorizesBreaking(Plain)).toBe('no');
  });

  it('authorizesBreaking reports "expand" for expand-phase class', () => {
    @ExpandContract({ phase: 'expand' })
    class M {}
    expect(authorizesBreaking(M)).toBe('expand');
  });

  it('authorizesBreaking reports "yes" for valid contract-phase class', () => {
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFooExpand' })
    class M {}
    expect(authorizesBreaking(M)).toBe('yes');
  });
});
