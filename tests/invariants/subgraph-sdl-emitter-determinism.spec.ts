import {
  compileResolverConstructorRegistry,
  type ResolverModuleSource,
} from '../../tools/scripts/lib/resolver-metadata-registry';

class AlphaResolver {}
class BetaResolver {}
class ZuluResolver {}

function coordinates(sources: readonly ResolverModuleSource[]): string[] {
  return compileResolverConstructorRegistry(sources).map(
    (registration) =>
      `${registration.sourcePath}#${registration.exportName}:${registration.runtimeName}`,
  );
}

describe('subgraph resolver metadata compiler', () => {
  it('is byte-order independent across filesystem and module export permutations', () => {
    const first: readonly ResolverModuleSource[] = [
      {
        sourcePath: 'zeta/z.resolver.ts',
        exports: { ZuluResolver, AlphaResolver },
      },
      {
        sourcePath: 'alpha/a.resolver.ts',
        exports: { ignored: 1, BetaResolver },
      },
    ];
    const second: readonly ResolverModuleSource[] = [
      {
        sourcePath: 'alpha/a.resolver.ts',
        exports: { BetaResolver, ignored: 1 },
      },
      {
        sourcePath: 'zeta/z.resolver.ts',
        exports: { AlphaResolver, ZuluResolver },
      },
    ];

    expect(coordinates(first)).toEqual(coordinates(second));
    expect(coordinates(first)).toEqual([
      'alpha/a.resolver.ts#BetaResolver:BetaResolver',
      'zeta/z.resolver.ts#AlphaResolver:AlphaResolver',
      'zeta/z.resolver.ts#ZuluResolver:ZuluResolver',
    ]);
  });

  it('rejects duplicate source, constructor and runtime-name identities', () => {
    expect(() =>
      coordinates([
        { sourcePath: 'a\\one.resolver.ts', exports: { AlphaResolver } },
        { sourcePath: 'a/one.resolver.ts', exports: { BetaResolver } },
      ]),
    ).toThrow(/duplicate resolver source/i);

    expect(() =>
      coordinates([
        { sourcePath: 'a.resolver.ts', exports: { AlphaResolver } },
        { sourcePath: 'b.resolver.ts', exports: { AliasResolver: AlphaResolver } },
      ]),
    ).toThrow(/duplicate resolver constructor/i);

    const FirstResolver = class SharedResolver {};
    const SecondResolver = class SharedResolver {};
    expect(() =>
      coordinates([
        { sourcePath: 'a.resolver.ts', exports: { FirstResolver } },
        { sourcePath: 'b.resolver.ts', exports: { SecondResolver } },
      ]),
    ).toThrow(/duplicate resolver runtime name/i);
  });
});
