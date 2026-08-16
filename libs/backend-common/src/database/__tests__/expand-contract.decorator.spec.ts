import 'reflect-metadata';

import {
  EXPAND_CONTRACT_META_KEY,
  ExpandContract,
  authorizesBreaking,
  classifyMigrationsForBreaking,
  getExpandContractMetadata,
  type ExpandContractOptions,
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
    const invalid = { phase: 'nonsense' } as unknown as ExpandContractOptions;
    expect(() => ExpandContract(invalid)).toThrow(/expand.*contract/);
  });

  it('throws when phase=contract but dependsOn missing', () => {
    const invalid = { phase: 'contract' } as unknown as ExpandContractOptions;
    expect(() => ExpandContract(invalid)).toThrow(/dependsOn/);
  });

  it('throws when dependsOn is not a string', () => {
    const invalid = {
      phase: 'contract',
      dependsOn: 42,
    } as unknown as ExpandContractOptions;
    expect(() => ExpandContract(invalid)).toThrow(/dependsOn/);
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
    class Plain {
      readonly marker = 'plain';
    }
    expect(getExpandContractMetadata(Plain)).toBeUndefined();
  });

  it('authorizesBreaking reports "no" for undecorated class', () => {
    class Plain {
      readonly marker = 'plain';
    }
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

describe('classifyMigrationsForBreaking', () => {
  it('all-authorized when every class is expand or contract with dependsOn', () => {
    @ExpandContract({ phase: 'expand' })
    class AddFoo {}
    @ExpandContract({ phase: 'contract', dependsOn: 'AddFoo' })
    class DropLegacyFoo {}

    const result = classifyMigrationsForBreaking([
      { name: 'AddFoo', ctor: AddFoo },
      { name: 'DropLegacyFoo', ctor: DropLegacyFoo },
    ]);
    expect(result.allAuthorized).toBe(true);
    expect(result.undecorated).toEqual([]);
    expect(result.classifications).toHaveLength(2);
    expect(result.classifications[0]).toMatchObject({
      name: 'AddFoo',
      authorization: 'expand',
      phase: 'expand',
    });
    expect(result.classifications[1]).toMatchObject({
      name: 'DropLegacyFoo',
      authorization: 'yes',
      phase: 'contract',
      dependsOn: 'AddFoo',
    });
  });

  it('flags an undecorated class as unauthorized', () => {
    @ExpandContract({ phase: 'expand' })
    class OkMigration {}
    class BareMigration {
      readonly marker = 'bare';
    }

    const result = classifyMigrationsForBreaking([
      { name: 'OkMigration', ctor: OkMigration },
      { name: 'BareMigration', ctor: BareMigration },
    ]);
    expect(result.allAuthorized).toBe(false);
    expect(result.undecorated).toEqual(['BareMigration']);
    expect(result.classifications[1]?.authorization).toBe('no');
    expect(result.classifications[1]?.phase).toBeUndefined();
  });

  it('empty input is trivially allAuthorized=true', () => {
    const result = classifyMigrationsForBreaking([]);
    expect(result.allAuthorized).toBe(true);
    expect(result.classifications).toEqual([]);
    expect(result.undecorated).toEqual([]);
  });

  it('preserves migration name + distinguishes phase', () => {
    @ExpandContract({ phase: 'expand' })
    class ExpandOne {}
    @ExpandContract({ phase: 'contract', dependsOn: 'ExpandOne' })
    class ContractOne {}

    const result = classifyMigrationsForBreaking([
      { name: 'ExpandOne', ctor: ExpandOne },
      { name: 'ContractOne', ctor: ContractOne },
    ]);
    const expand = result.classifications.find((c) => c.name === 'ExpandOne');
    const contract = result.classifications.find((c) => c.name === 'ContractOne');
    expect(expand?.phase).toBe('expand');
    expect(contract?.phase).toBe('contract');
    expect(contract?.dependsOn).toBe('ExpandOne');
  });

  it('a single undecorated migration in a list of decorated ones flips allAuthorized=false', () => {
    @ExpandContract({ phase: 'expand' })
    class A {}
    @ExpandContract({ phase: 'expand' })
    class B {}
    class C {
      readonly marker = 'unauthorized';
    }

    const result = classifyMigrationsForBreaking([
      { name: 'A', ctor: A },
      { name: 'B', ctor: B },
      { name: 'C', ctor: C },
    ]);
    expect(result.allAuthorized).toBe(false);
    expect(result.undecorated).toEqual(['C']);
  });
});
