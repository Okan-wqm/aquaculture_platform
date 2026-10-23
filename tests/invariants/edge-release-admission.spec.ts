import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { stripComments } from './helpers/ts-source';

/**
 * ADR-048 DEC-3.8, DEC-20 — a release is named only after admission.
 *
 * The cloud puts a release into a provisioning manifest or an update statement
 * only as an `AdmittedRelease` (apps/sensor-service/src/edge-device/
 * edge-release-catalog.service.ts): a class with a private member, so no object
 * literal is one. What the type cannot say is who calls its constructor, so this
 * spec does: in every backend source file but the catalog, no `new AdmittedRelease(`
 * exists, and inside the catalog the provenance verifier runs before the release is
 * constructed. Comment-stripped source, so documentation naming the class does not
 * trip it.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const CATALOG = 'apps/sensor-service/src/edge-device/edge-release-catalog.service.ts';
const WORKFLOW = '.github/workflows/edge-agent-release.yml';

function backendSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*.ts', 'libs/*.ts', 'platform/*.ts'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.d.ts') &&
        !/\/(__tests__|__mocks__|test-helpers|testing)\//.test(path),
    );
}

describe('release admission (ADR-048 DEC-3.8, DEC-20)', () => {
  it('only the release catalog constructs an AdmittedRelease', () => {
    const offenders: string[] = [];
    for (const path of backendSources()) {
      if (path === CATALOG) continue;
      const lines = stripComments(readFileSync(join(REPO_ROOT, path), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (/\bnew\s+AdmittedRelease\s*\(/.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the catalog verifies the provenance before it constructs the release', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, CATALOG), 'utf8'));
    const verify = source.indexOf('this.verifyProvenance(');
    const construct = source.indexOf('new AdmittedRelease(');
    expect(verify).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(verify);
  });

  it('the provenance verifier expects the workflow that exists', () => {
    const verifier = readFileSync(
      join(REPO_ROOT, 'apps/sensor-service/src/edge-device/edge-release-provenance.ts'),
      'utf8',
    );
    expect(verifier).toContain(`EDGE_RELEASE_WORKFLOW_PATH = '${WORKFLOW}'`);
    expect(() => readFileSync(join(REPO_ROOT, WORKFLOW), 'utf8')).not.toThrow();
  });
});
