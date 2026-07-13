/**
 * FE↔backend route-parity tripwire for admin-panel (ARCH-MEDIUM-004).
 *
 * The architectural-arbiter required the admin-panel FE↔backend route-parity
 * gate be NON-OPTIONAL. It already is: the REAL gate is a static contract
 * validator that lives with the backend it validates —
 *
 *   apps/admin-api-service/src/__tests__/contract-validation.spec.ts
 *
 * It extracts every `apiFetch(...)` path from
 * `web/modules/admin-panel/src/services/api/*.ts` and matches each against the
 * admin-api controller routes (`@Get`/`@Post`/…), with a `KNOWN_EXCEPTIONS`
 * allowlist AND a "no stale exception" guard (an exception that no longer
 * shields a real unmatched FE call fails the suite). That spec is an ordinary
 * `.spec.ts` inside admin-api-service's Jest suite, which executes in CI via
 * BOTH `nx affected --target=test` (.github/workflows/ci-affected.yml) and
 * `nx run-many --target=test --all` (test:all, .github/workflows/ci-full.yml).
 * The parity gate is therefore already enforced on every PR.
 *
 * This invariant does NOT duplicate that logic — it is a TRIPWIRE. It fails if
 * the real gate is deleted or gutted to a stub, so the parity enforcement the
 * arbiter mandated cannot be silently removed without also reddening an
 * always-on invariant. The single source of truth for the matching logic
 * remains the contract-validation spec; this file only guards its existence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The real FE↔backend parity gate (SSoT for the matching logic). */
const CONTRACT_SPEC = 'apps/admin-api-service/src/__tests__/contract-validation.spec.ts';

/**
 * Markers that must remain present. These are the load-bearing pieces of the
 * real gate: FE path extraction, BE route extraction, and the exception
 * allowlist. A stub that dropped any of them would still "exist" but no longer
 * enforce parity — so the tripwire checks for substance, not just a file.
 */
const REQUIRED_MARKERS = [
  'extractFrontendEndpoints',
  'extractBackendEndpoints',
  'KNOWN_EXCEPTIONS',
] as const;

describe('INVARIANT: admin-panel FE↔backend contract gate exists (ARCH-MEDIUM-004)', () => {
  it('the real contract-validation spec is present and still the parity validator', () => {
    const specAbs = resolve(REPO_ROOT, CONTRACT_SPEC);

    expect({ spec: CONTRACT_SPEC, exists: existsSync(specAbs) }).toEqual({
      spec: CONTRACT_SPEC,
      exists: true,
    });

    const content = readFileSync(specAbs, 'utf-8');

    // Non-trivial: a gutted stub cannot pass. The real gate is ~700 lines.
    expect(content.length).toBeGreaterThan(2000);

    for (const marker of REQUIRED_MARKERS) {
      expect({ marker, present: content.includes(marker) }).toEqual({
        marker,
        present: true,
      });
    }
  });
});
