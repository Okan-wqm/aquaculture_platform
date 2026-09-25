import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeDocStaleness, isPointInTimeRecord } from './doc-staleness-adapter';

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

// The scan surface is declared once, in doc-staleness-adapter.tool.json
// (default_input.roots). A test that omitted it used to inherit a second
// copy inside the adapter, so it could keep passing while production
// scanned a different set. It says what it scans now.
const output = analyzeDocStaleness({ roots: ['docs'] }, workspace);

assert.equal(output.findings.length, 1, JSON.stringify(output.findings));
const [finding] = output.findings;
assert.equal(finding.rule, 'doc_references_missing_path');
assert.equal(finding.path, 'docs/runbooks/ops.md');
assert.equal(finding.line, 4);
assert.ok(finding.message.includes('deleted.service.ts'));
assert.equal(output.observations[0].details?.missingRefs, 1);

// ARIA-HIGH-202: point-in-time records are read, never flagged. Each of
// these cites the same dead path the runbook does; none of them is stale.
const deadRef = 'Cites `apps/farm-service/src/deleted.service.ts` as of its date.';
const records: Record<string, string> = {
  'docs/reviews/farm-expert/review.md': deadRef,
  'docs/audits/admin-panel/audit.md': deadRef,
  'docs/plans/_archive/old-plan.md': deadRef,
  'docs/plans/2026-04-21-refactor.md': deadRef,
  'docs/plans/2026-04-24-deferred-items/phase-1.md': deadRef,
  'docs/security-audit-2026-03-30.md': deadRef,
  'docs/aria/plans/001-historical.md': `<!-- ARIA-HISTORICAL: Historical plan document. -->\n\n${deadRef}`,
};
const recordWorkspace = mkdtempSync(join(tmpdir(), 'aria-doc-staleness-records-'));
for (const [path, body] of Object.entries(records)) {
  mkdirSync(join(recordWorkspace, path, '..'), { recursive: true });
  writeFileSync(join(recordWorkspace, path), body, 'utf8');
}
mkdirSync(join(recordWorkspace, 'docs/runbooks'), { recursive: true });
writeFileSync(join(recordWorkspace, 'docs/runbooks/live.md'), deadRef, 'utf8');
const recordOutput = analyzeDocStaleness({ roots: ['docs'] }, recordWorkspace);
assert.deepEqual(
  recordOutput.findings.map((item) => item.path),
  ['docs/runbooks/live.md'],
  JSON.stringify(recordOutput.findings),
);
assert.equal(recordOutput.metadata.recordDocs, Object.keys(records).length);
// A record is still read: its path stays in the evidence the run declares.
assert.ok(recordOutput.read_paths.includes('docs/reviews/farm-expert/review.md'));

// A version-like or numeric name is not a date, and a marker below the head
// is prose about markers, not a header.
assert.equal(isPointInTimeRecord('docs/adr/028-clamav-topology.md', ['# ADR']), false);
assert.equal(isPointInTimeRecord('docs/runbooks/v12026-04-211.md', ['# x']), false);
assert.equal(
  isPointInTimeRecord('docs/runbooks/ops.md', [
    '# Ops',
    '',
    '',
    '',
    '',
    'mentions ARIA-HISTORICAL',
  ]),
  false,
);

process.stdout.write('doc-staleness-adapter tests passed\n');
