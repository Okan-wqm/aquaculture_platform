import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';
import { hermeticGitEnv } from '../gates/hermetic-git';

import { ADAPTER_EXCLUDED_DIRS, containedWorkspace } from './adapter-fs';
import { analyzeDocStaleness, isPointInTimeRecord } from './doc-staleness-adapter';

const workspace = makeFixtureTree('aria-doc-staleness-');
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
const recordWorkspace = makeFixtureTree('aria-doc-staleness-records-');
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
const roleWorkspace = makeFixtureTree('aria-doc-staleness-roles-');
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

// ---------------------------------------------------------------------------
// DET scope-5 (B16): the scan surface is the manifest's roots, and the roots
// are the live documentation, not docs/ alone: the code directories that carry
// service and library READMEs and the five live root documents, each file root
// read as that file. sens-api-gateway/, mcp/ and the claim prefixes
// (PATH_PREFIXES) stay as they were until a labelled sample exists. Each
// scenario runs on its own, so one run reports every failing one.
// ---------------------------------------------------------------------------
const REPO_ROOT = resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'doc-staleness-adapter.tool.json'), 'utf8'),
) as {
  declared_scope: string[];
  allowed_read_globs: string[];
  default_input: { roots: string[] };
};
const DIRECTORY_ROOTS = [
  'apps',
  'docs',
  'e2e',
  'infra',
  'infrastructure',
  'libs',
  'platform',
  'web',
];
const FILE_ROOTS = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'SECURITY.md'];
// A directory root declares `<root>/**/*.md`; a file root declares itself.
const SCOPE = [...DIRECTORY_ROOTS.map((root) => `${root}/**/*.md`), ...FILE_ROOTS].sort();
// Root-level markdown the scan skips on purpose: dated reports, plans and logs
// whose date sits in a body header (isPointInTimeRecord reads the path), and
// one empty file. A new root-level document is a root or listed here, never
// silently unread.
const ROOT_DOCS_NOT_SCANNED = [
  ...[
    'ARIA-MIMARI-SEMALARI',
    'ARIA-VERIMLILIK-DEGERLENDIRMESI',
    'DISCOVERY_LOG',
    'okn',
    'scada-plan',
  ],
  ...['DEPLOY-FAZ0', 'DEPLOY-FAZ1', 'DEPLOY-FAZ2', 'DEPLOY-FAZ3', 'FARM-AI-PROGRAM-2026-09-18'],
].map((name) => `${name}.md`);
const DELETED = 'apps/farm-service/src/old.service.ts';

const scopeFailures: string[] = [];
function scenario(name: string, body: () => void): void {
  try {
    body();
  } catch (error) {
    scopeFailures.push(`--- ${name}\n${error instanceof Error ? error.message : String(error)}`);
  }
}
function put(workspace: string, path: string, body: string): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), body, 'utf8');
}
// A document whose line 2 says `ref` is part of the repository, as it stands.
const claims = (ref: string): string => ['# Doc', `Lives in \`${ref}\`.`, ''].join('\n');

// The manifest owns the surface. The exact set also keeps sens-api-gateway/
// (+20 findings in 124 docs) and mcp/ (6 false claims) out, as the RCA decided.
scenario('the manifest names the documentation roots and their globs', () => {
  const roots = [...DIRECTORY_ROOTS, ...FILE_ROOTS].sort();
  assert.deepEqual([...manifest.default_input.roots].sort(), roots);
  assert.deepEqual([...manifest.declared_scope].sort(), SCOPE);
  assert.deepEqual([...manifest.allowed_read_globs].sort(), SCOPE);
});

scenario('a file root is read as that file', () => {
  const ws = makeFixtureTree('aria-doc-staleness-fileroot-');
  put(ws, 'README.md', ['# Platform', 'Shared code lives in `libs/gone/`.', ''].join('\n'));
  put(ws, 'docs/runbooks/other.md', claims(DELETED));
  const scan = (roots: string[], allowed?: string[]): ReturnType<typeof analyzeDocStaleness> =>
    analyzeDocStaleness({ roots, repo_snapshot: { allowed_paths: allowed } }, ws);

  assert.doesNotThrow(() => scan(['README.md']), 'a file root is not walked as a directory');
  const output = scan(['README.md']);
  assert.deepEqual(output.read_paths, ['README.md']);
  assert.deepEqual(
    output.findings.map((item) => `${item.path}:${item.line}`),
    ['README.md:2'],
  );
  // A root the workspace lacks, file or directory, is skipped beside one it has.
  assert.deepEqual(scan(['README.md', 'AGENTS.md', 'e2e']).read_paths, ['README.md']);
  // The snapshot's allowed paths still decide what is read; a file root is no way around them.
  assert.deepEqual(scan(['README.md'], ['docs/runbooks/other.md']).read_paths, []);
  // Green at the base: a root leading out of the workspace stays refused.
  assert.throws(() => scan(['../x']), /escapes workspace root/);
});

// A document is a markdown file, as the directory walk already filters: a file root that
// is not one is a manifest mistake, refused rather than parsed as documentation.
scenario('a file root that is not markdown is refused', () => {
  const ws = makeFixtureTree('aria-doc-staleness-nonmd-');
  put(ws, 'package.json', '{"main": "`libs/gone/`"}\n');
  assert.throws(
    () => analyzeDocStaleness({ roots: ['package.json'] }, ws),
    /scan root is not a markdown file: .*package\.json/,
  );
});

scenario('the manifest roots read the widened directories and the root documents', () => {
  const ws = makeFixtureTree('aria-doc-staleness-scope-');
  put(ws, 'apps/farm-service/src/main.ts', 'export {};\n');
  put(ws, 'apps/farm-service/README.md', claims(DELETED)); // TP
  put(ws, 'docs/runbooks/ops.md', claims(DELETED)); // TP: docs/ is still read
  put(
    ws,
    'README.md',
    [
      '# Platform', // 1
      'Shared code lives in `libs/gone/`.', // 2 TP: a deleted directory
      'Entry point: `apps/farm-service/src/main.ts`.', // 3 exists
      // 4: prefixes outside PATH_PREFIXES stay unclaimed (RCA: labelled sample first).
      'Elsewhere: `tests/gone.spec.ts`, `aria-kernel/gone.py`, `docs/gone.md`, `infra/gone.tf`, `crates/gone.rs`.',
      '- `apps/farm-service/src/fresh.service.ts` (new) -- the export handler', // 5 creation
      '',
    ].join('\n'),
  );
  const directories = ['libs', 'web', 'infra', 'infrastructure', 'e2e', 'platform'];
  for (const directory of directories) {
    put(ws, `${directory}/svc/README.md`, claims(`libs/gone-from-${directory}.ts`)); // TP
  }
  const rootDocs = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md'];
  for (const doc of rootDocs) {
    put(ws, doc, claims(`libs/gone-from-${doc.slice(0, -3).toLowerCase()}.ts`)); // TP
  }
  // Read, never flagged: a README naming what exists; a record under a widened directory.
  put(ws, 'web/modules/dash/README.md', claims('apps/farm-service/src/main.ts'));
  put(ws, 'libs/shared/docs/reviews/review.md', claims(DELETED));
  // Not read: a dated root document, the two tracked directories, a directory no root
  // names (an `mcp/`-style README's `tools/x` is relative to its package), node_modules.
  for (const path of ['DEPLOY-FAZ9.md', 'sens-api-gateway/docs/guide.md', 'tests/README.md']) {
    put(ws, path, claims(DELETED));
  }
  put(ws, 'mcp/README.md', claims('tools/relative.ts'));
  put(ws, 'apps/farm-service/node_modules/dep/README.md', claims(DELETED));

  const output = analyzeDocStaleness({ roots: manifest.default_input.roots }, ws);
  const flagged = [
    ...['README.md', 'apps/farm-service/README.md', 'docs/runbooks/ops.md', ...rootDocs],
    ...directories.map((directory) => `${directory}/svc/README.md`),
  ].sort();
  assert.deepEqual(
    output.findings.map((item) => `${item.path}:${item.line}`).sort(),
    flagged.map((path) => `${path}:2`),
    JSON.stringify(output.findings),
  );
  assert.deepEqual(
    output.read_paths,
    [...flagged, 'libs/shared/docs/reviews/review.md', 'web/modules/dash/README.md'].sort(),
  );
  assert.equal(output.metadata.recordDocs, 1);
  assert.equal((output.metadata.unclaimedRefs as { creation: number }).creation, 1);
});

const trackedMarkdown = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', '*.md'], {
  encoding: 'utf8',
  env: hermeticGitEnv(),
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter((path) => path.length > 0);

scenario('every tracked root-level markdown file is a root or declared unscanned', () => {
  const rootDocs = trackedMarkdown.filter((path) => !path.includes('/'));
  const roots = new Set(manifest.default_input.roots);
  assert.deepEqual(
    rootDocs.filter((path) => !roots.has(path) && !ROOT_DOCS_NOT_SCANNED.includes(path)),
    [],
    'a root-level document is neither a doc-staleness root nor listed as unscanned',
  );
  assert.deepEqual(
    ROOT_DOCS_NOT_SCANNED.filter((path) => !rootDocs.includes(path) || roots.has(path)),
    [],
    'the unscanned list names a document that is untracked or is also a root',
  );
});

// The surface over this checkout, not a fixture: every tracked document under
// a root is read.
scenario('the real repository: the scan reads what the roots hold', () => {
  const real = analyzeDocStaleness({ roots: manifest.default_input.roots }, REPO_ROOT);
  const workspace = containedWorkspace(REPO_ROOT);
  const read = new Set(real.read_paths);
  const unread = trackedMarkdown.filter(
    (path) =>
      (FILE_ROOTS.includes(path) || DIRECTORY_ROOTS.some((root) => path.startsWith(`${root}/`))) &&
      !path
        .split('/')
        .slice(0, -1)
        .some((segment) => ADAPTER_EXCLUDED_DIRS.has(segment)) &&
      workspace.entry(path) === 'file' &&
      !read.has(path),
  );
  assert.deepEqual(unread, [], 'a tracked document under a root is not read');
});

assert.ok(
  scopeFailures.length === 0,
  `${scopeFailures.length} DET scope-5 scenario(s) failed:\n\n${scopeFailures.join('\n\n')}`,
);

process.stdout.write('doc-staleness-adapter tests passed\n');
