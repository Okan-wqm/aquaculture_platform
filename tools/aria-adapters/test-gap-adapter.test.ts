import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { analyzeTestGaps } from './test-gap-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-test-gap-adapter-'));
const root = join(workspace, 'apps/farm-service/src');
mkdirSync(join(root, 'batch', '__tests__'), { recursive: true });
mkdirSync(join(root, 'database', 'migrations'), { recursive: true });

writeFileSync(
  join(root, 'batch', 'batch.handler.ts'),
  `
    export class BatchHandler {
      execute() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', '__tests__', 'batch.handler.spec.ts'),
  `
    import { BatchHandler } from '../batch.handler';
    test('handler', () => expect(new BatchHandler().execute()).toBe(true));
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', 'unsafe.controller.ts'),
  `
    export class UnsafeController {
      create() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'auth.guard.ts'),
  `
    export class AuthGuard {
      canActivate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'weak-only.guard.ts'),
  `
    export class WeakOnlyGuard {
      canActivate() { return true; }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'batch', '__tests__', 'weak-symbol.spec.ts'),
  `
    test('mentions symbol only', () => expect('WeakOnlyGuard').toBeTruthy());
  `,
  'utf8',
);
writeFileSync(
  join(root, 'database', 'migrations', '001-drop.ts'),
  `
    export class DropTable001 {
      async up(queryRunner: any) {
        await queryRunner.query('DROP TABLE bad');
      }
    }
  `,
  'utf8',
);
// E13 FP class (2): a hazardous migration retired into the `.archive/`
// snapshot corpus is dead code — it must produce NO finding.
mkdirSync(join(root, 'database', 'migrations', '.archive', '2026-01-01T00-00-00-000Z'), {
  recursive: true,
});
writeFileSync(
  join(root, 'database', 'migrations', '.archive', '2026-01-01T00-00-00-000Z', '000-archived-drop.ts'),
  `
    export class ArchivedDrop000 {
      async up(queryRunner: any) {
        await queryRunner.query('DROP TABLE retired');
      }
    }
  `,
  'utf8',
);
// Deliberate-break trap: this spec basename-matches unsafe.controller.ts, but
// it lives under an archived directory — if the archive filter ever stops
// excluding it from the TEST corpus it would satisfy unsafe.controller's
// coverage lookup and the finding asserted below would vanish.
mkdirSync(join(root, 'batch', 'archive'), { recursive: true });
writeFileSync(
  join(root, 'batch', 'archive', 'unsafe.controller.spec.ts'),
  `
    test('archived spec must not count as live coverage', () => expect(true).toBe(true));
  `,
  'utf8',
);

const output = analyzeTestGaps({ roots: ['apps/farm-service/src'], includeWriteBoundaryFindings: true }, workspace);

assert.equal(output.metadata.adapter, 'test-gap-adapter');
assert.equal(output.observations.some((item) => item.type === 'test_gap_source_file'), true);
assert.equal(output.observations.some((item) => item.type === 'test_gap_test_file'), true);
assert.equal(output.observations.some((item) => item.type === 'test_gap_coverage_summary'), true);
assert.equal(output.findings.some((finding) => finding.path.endsWith('batch.handler.ts')), false);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'high_risk_source_without_adjacent_test' && finding.path.endsWith('unsafe.controller.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'security_source_without_security_test' && finding.path.endsWith('auth.guard.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'security_source_without_security_test' && finding.path.endsWith('weak-only.guard.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'migration_without_test' && finding.path.endsWith('001-drop.ts'),
  ),
  true,
);
// E13 FP class (2): archived corpus is fully excluded from the scan — no
// findings against it, no observations for it, and it never appears in
// read_paths.
assert.equal(
  output.findings.some((finding) => finding.path.includes('.archive')),
  false,
);
assert.equal(
  output.read_paths.some((path) => path.includes('.archive') || path.includes('/archive/')),
  false,
);

console.log('test-gap-adapter tests passed');
