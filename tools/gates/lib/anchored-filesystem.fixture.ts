import {
  openHermeticExecutableAuthorityAtOwnedFixtureBoundary,
  type HermeticExecutableAuthorityV1,
  type HermeticExecutableContractV1,
} from './anchored-filesystem.kernel';

/**
 * Test-only facade for an isolated mode-0700 OS-temp trust boundary. Reverse-import authority
 * permits this capability only here and permits this facade only in anchored-filesystem.spec.ts.
 */
export function testOnlyOpenHermeticExecutableAuthorityForOwnedFixture(
  contract: HermeticExecutableContractV1,
  fixtureRoot: string,
  operationDeadlineMs?: number,
): HermeticExecutableAuthorityV1 {
  return openHermeticExecutableAuthorityAtOwnedFixtureBoundary(
    contract,
    fixtureRoot,
    operationDeadlineMs,
  );
}
