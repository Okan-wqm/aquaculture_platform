/**
 * Platform-wide invariant — ORPHAN-087:
 *
 * `libs/shared-contracts` is a NARROW cross-stack constant lib (zero-dependency
 * values that must be byte-identical on the backend trust boundary AND the
 * standalone aquamobil Vite bundle — today only the messaging media MIME
 * allowlist). It MUST NOT declare domain `enum`s.
 *
 * # Why
 *
 * This lib's tsconfig is deliberately isolated (no cross-lib paths) so it cannot
 * import @platform/event-contracts — the canonical SSoT for cross-service domain
 * enums. Any `enum` declared here is therefore a SILENT DUPLICATE that drifts
 * from the canonical (pre-ORPHAN-087 it carried dead duplicate copies of
 * PlanTier / SubscriptionStatus / BillingCycle / PlanVisibility / Impersonation*
 * / DataRequest* with zero importers, making a dead lib look authoritative).
 * This guard fails any re-introduced enum so the drift surface cannot grow back.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT (ORPHAN-087): shared-contracts declares no domain enums', () => {
  it('no file under libs/shared-contracts/src declares an `export enum`', () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'libs/shared-contracts/src/**/*.ts'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.spec.ts'));

    const enumRe = /^\s*export\s+enum\s+\w+/m;
    const offenders: string[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (enumRe.test(src)) {
        offenders.push(rel);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `shared-contracts must not declare domain enums (it cannot import the\n` +
          `canonical @platform/event-contracts, so an enum here silently drifts).\n` +
          `Move the enum to @platform/event-contracts. Offenders:\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });

  it('the public barrel only re-exports the cross-stack media MIME allowlist', () => {
    const index = readFileSync(
      resolve(REPO_ROOT, 'libs/shared-contracts/src/index.ts'),
      'utf8',
    );
    const exportFroms = [...index.matchAll(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+'([^']+)'/g)].map(
      (m) => m[1],
    );
    for (const from of exportFroms) {
      expect(from).toBe('./enums/messaging-media-mime');
    }
  });
});
