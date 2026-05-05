/**
 * Platform-wide invariant — CIRCUIT-CRITICAL-004:
 *
 * The canonical CircuitBreaker library MUST exist at
 * `libs/backend-common/src/resilience/circuit-breaker/` and expose the
 * minimum public surface every consumer expects:
 *
 *   - `CircuitBreakerService` (Injectable)
 *   - `CircuitBreakerModule` (@Global)
 *   - `CircuitOpenError` (distinct error class)
 *   - `DEFAULT_BREAKER_OPTIONS`
 *   - Type exports: CircuitBreakerOptions, FailureMode, CircuitState, CircuitStats
 *
 * # Why
 *
 * The audit captured 5 incompatible ad-hoc breaker implementations
 * across the repo (gateway proxy, OPA enforcer, messaging-redis,
 * admin-email, claude-budget-stub). Adding a sixth ad-hoc impl on top
 * of the canonical library would re-introduce the drift this finding
 * closes. This invariant guards the surface — consumers can rely on
 * the lib being there with the documented API. The W3 wave migrates
 * the existing 5 ad-hoc impls onto this library.
 *
 * Source-only check; no DB or NATS dependency. Cheap to run on every PR.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LIB_BARREL = 'libs/backend-common/src/resilience/circuit-breaker/index.ts';

const REQUIRED_EXPORTS = [
  'CircuitBreakerService',
  'CircuitBreakerModule',
  'CircuitOpenError',
  'DEFAULT_BREAKER_OPTIONS',
];

const REQUIRED_TYPE_EXPORTS = [
  'CircuitBreakerOptions',
  'FailureMode',
  'CircuitState',
  'CircuitStats',
];

describe('INVARIANT (CIRCUIT-CRITICAL-004): canonical CircuitBreaker library', () => {
  it('the canonical lib exists at libs/backend-common/src/resilience/circuit-breaker/', () => {
    const tsFiles = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'libs/backend-common/src/resilience/circuit-breaker/*.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(tsFiles).toContain(LIB_BARREL);
    expect(tsFiles).toContain('libs/backend-common/src/resilience/circuit-breaker/circuit-breaker.service.ts');
    expect(tsFiles).toContain('libs/backend-common/src/resilience/circuit-breaker/circuit-breaker.module.ts');
    expect(tsFiles).toContain('libs/backend-common/src/resilience/circuit-breaker/circuit-breaker.types.ts');
  });

  it('the barrel re-exports the required public surface', () => {
    const src = readFileSync(resolve(REPO_ROOT, LIB_BARREL), 'utf8');
    for (const name of REQUIRED_EXPORTS) {
      expect(src).toMatch(new RegExp(`export\\s+\\{[^}]*\\b${name}\\b`));
    }
    for (const name of REQUIRED_TYPE_EXPORTS) {
      expect(src).toMatch(new RegExp(`export\\s+type\\s+\\{[^}]*\\b${name}\\b`));
    }
  });

  it('the resilience subtree barrel re-exports circuit-breaker', () => {
    const subtreeBarrel = resolve(
      REPO_ROOT,
      'libs/backend-common/src/resilience/index.ts',
    );
    const src = readFileSync(subtreeBarrel, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/circuit-breaker['"]/);
  });

  it('the canonical service has unit-test coverage', () => {
    // Defence-in-depth: prevents accidentally deleting the spec while
    // refactoring. The presence of __tests__/circuit-breaker.service.spec.ts
    // is the precondition for trusting the library's behaviour.
    const tests = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files',
       'libs/backend-common/src/resilience/circuit-breaker/__tests__/*.spec.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(tests).toContain('libs/backend-common/src/resilience/circuit-breaker/__tests__/circuit-breaker.service.spec.ts');
  });
});
