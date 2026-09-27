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

// ARIA-HIGH-212: a missing path is stale only where the doc says it exists.
// Each false-positive class the operator-feedback ledger labelled on
// aria/state has one case below; each true-positive shape has one too.
const roleWorkspace = mkdtempSync(join(tmpdir(), 'aria-doc-staleness-roles-'));
mkdirSync(join(roleWorkspace, 'docs/guides'), { recursive: true });
mkdirSync(join(roleWorkspace, 'apps/farm-service/src'), { recursive: true });
writeFileSync(join(roleWorkspace, 'apps/farm-service/src/live.service.ts'), 'export {};\n', 'utf8');
const roleDoc = [
  '# Guide', // 1
  '', // 2
  '`apps/farm-service/src/gone.service.ts` — CI gate scans every entry.', // 3 TP: plain present-tense claim
  '', // 4
  '**Dosyalar:**', // 5
  '- `apps/farm-service/src/api-key.service.ts` — YENİ', // 6 FP: creation marker
  '- `apps/farm-service/src/erasure.interface.ts` (NEW) -- define the handler', // 7 FP: creation marker
  '- `apps/farm-service/src/dsr.service.ts` (new — orchestrates Art 15/17)', // 8 FP: creation marker
  '', // 9
  'Add one versioned catalog, proposed at', // 10
  '`apps/farm-service/src/catalog.yaml`, with a strict schema.', // 11 FP: proposal paragraph
  '', // 12
  'Önerilen yön, `apps/farm-service/src/aria` altında bir modül', // 13 FP: proposal paragraph
  'kurmaktır.', // 14
  '', // 15
  '- Agent spec: `apps/farm-service/src/cost-metrics.yml` — file does not exist.', // 16 FP: absence asserted
  'Scan scope: excluding `node_modules`, `apps/farm-service/playwright-report`.', // 17 FP: exclusion
  '', // 18
  '- **Files to change:**', // 19
  '  - `apps/farm-service/src/live.service.ts`', // 20 exists
  '  - `apps/farm-service/src/module-icon.ts`', // 21 FP: change target, never evidenced
  '  - `apps/farm-service/src/tenant-config.service.ts`', // 22 TP: evidenced at line 26
  '', // 23
  '**Evidence**', // 24
  '', // 25
  '- `apps/farm-service/src/tenant-config.service.ts:349-358` — writes no audit row.', // 26 TP: line-pinned evidence
  '', // 27
  '**Files:**', // 28
  '- Create: `apps/farm-service/src/harness-new.sh`', // 29 FP: creation verb
  '- Modify: `apps/farm-service/src/harness.sh`', // 30 TP: modify asserts existence
  '', // 31
  '| Path | Note |', // 32
  '| `apps/farm-service/src/row-new.ts` | (new) |', // 33 FP: creation marker in its own row
  '| `apps/farm-service/src/row-old.ts` | wired |', // 34 TP: the neighbouring row is not new
  '', // 35
  'Writers: `apps/farm-service/src/{create,update}-x.handler.ts`; FE: `apps/farm-service/src/Page.tsx`.', // 36 TP: marker words inside another span do not count
  '', // 37
  '## Files', // 38
  '', // 39
  '- `apps/farm-service/src/personas/operator.ts` - Operator persona', // 40 TP: a bare Files heading describes code as it stands
  '', // 41
  'Search for `x` in .tsx files returned nothing:', // 42
  '- `apps/farm-service/src/routes/sensor.routes.ts` -- propagates the header', // 43 TP: prose mentioning files is not a change list
].join('\n');
writeFileSync(join(roleWorkspace, 'docs/guides/roles.md'), roleDoc, 'utf8');
const roleOutput = analyzeDocStaleness({ roots: ['docs'] }, roleWorkspace);
assert.deepEqual(
  roleOutput.findings.map((item) => item.line).sort((a, b) => a - b),
  [3, 22, 26, 30, 34, 36, 40, 43],
  JSON.stringify(roleOutput.findings),
);
assert.deepEqual(roleOutput.metadata.unclaimedRefs, {
  creation: 5,
  proposal: 2,
  absence: 2,
  change_target: 1,
});

process.stdout.write('doc-staleness-adapter tests passed\n');
