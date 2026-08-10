import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { analyzeDocStaleness } from './doc-staleness-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-doc-staleness-'));
mkdirSync(join(workspace, 'docs/runbooks'), { recursive: true });
mkdirSync(join(workspace, 'apps/farm-service/src'), { recursive: true });
writeFileSync(join(workspace, 'apps/farm-service/src', 'main.ts'), 'export {};\n', 'utf8');

writeFileSync(
  join(workspace, 'docs/runbooks', 'ops.md'),
  [
    '# Ops runbook',
    'Live path: `apps/farm-service/src/main.ts` is real.',
    'Evidence ref style: `apps/farm-service/src/main.ts:12` also resolves.',
    'Dead path: run `apps/farm-service/src/deleted.service.ts` first.',
    'Glob stays quiet: `apps/**/*.ts` is a pattern, not a claim.',
    'Placeholder stays quiet: `apps/<service>/src/main.ts`.',
    'Prose stays quiet: `feature/some-branch` and `owner/repo`.',
  ].join('\n'),
  'utf8',
);

const output = analyzeDocStaleness({}, workspace);

assert.equal(output.findings.length, 1, JSON.stringify(output.findings, null, 2));
const [finding] = output.findings;
assert.equal(finding.rule, 'doc_references_missing_path');
assert.equal(finding.path, 'docs/runbooks/ops.md');
assert.equal(finding.line, 4);
assert.ok(finding.message.includes('deleted.service.ts'));
assert.equal(output.observations[0].details?.missingRefs, 1);

console.log('doc-staleness-adapter tests passed');
