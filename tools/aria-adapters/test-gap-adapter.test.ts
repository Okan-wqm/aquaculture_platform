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

console.log('test-gap-adapter tests passed');
