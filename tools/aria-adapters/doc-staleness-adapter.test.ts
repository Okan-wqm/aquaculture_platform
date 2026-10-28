import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';
import { hermeticGitEnv } from '../gates/hermetic-git';

import { ADAPTER_EXCLUDED_DIRS, containedWorkspace } from './adapter-fs';
import {
  analyzeDocStaleness,
  isPointInTimeRecord,
  referenceRole,
  scanDocReferences,
  type UnclaimedRole,
} from './doc-staleness-adapter';

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

// ---------------------------------------------------------------------------
// DOCROLES (ARIA-MEDIUM-1108): the roles that made the adapter's false alarms.
// Three rules, all inside the adapter that owns the roles:
//   1. a document whose first 40 lines carry a Status of Proposed, Draft,
//      Superseded, Deprecated or Rejected is a point-in-time record;
//   2. a document whose base name holds the token report, review, audit,
//      verification, spec, plan, inventory, findings or retro is a record;
//   3. a table row with a cell that is exactly Create or New claims nothing
//      about the reference in it.
// A GUARD below is green at the base on purpose (the base claims no role at
// all): it holds a near miss that must stay flagged, and fails the day a rule
// claims more than its three sentences. The peer's measurement is a hypothesis
// explored on its own sample; no fixture here is a copy of that sample.
// ---------------------------------------------------------------------------
const STATUS_WORDS = ['Proposed', 'Draft', 'Superseded', 'Deprecated', 'Rejected'];
const FILE_NAME_TOKENS = [
  'report',
  'review',
  'audit',
  'verification',
  'spec',
  'plan',
  'inventory',
  'findings',
  'retro',
];
// A document no other role reaches: not an archive, not under reviews/ or
// audits/, no date in a segment, no token in its base name.
const LIVE_DOC = 'docs/adr/020-storage.md';

// A document of `position` lines whose last line is `text`: a heading, then
// background notes, so `text` sits on line `position` and nothing follows it.
const docEndingWith = (position: number, text: string): string[] => [
  '# ADR',
  ...Array.from({ length: position - 2 }, (_, index) => `Background note ${index + 1}.`),
  text,
];
const failing = <T>(items: readonly T[], holds: (item: T) => boolean): T[] =>
  items.filter((item) => !holds(item));

scenario('a Status of Proposed, Draft, Superseded, Deprecated or Rejected makes a record', () => {
  const spellings = [
    ...STATUS_WORDS.map((status) => `Status: ${status}`),
    '**Status:** Draft',
    '- Status: Superseded',
    '- **Status:** Deprecated',
    '* Status: Rejected',
    '| Status | Superseded |',
    '| Status | Proposed |',
    'status: proposed',
    'STATUS: DRAFT',
    'Status: Proposed (2026-04-21)',
    'Status: Draft 2026-04-21',
    // The qualifier inside the parenthesis may name another status.
    '**Status:** Proposed (opened 2026-04-19; target Accepted 2026-05-03)',
  ];
  assert.deepEqual(
    failing(spellings, (text) => isPointInTimeRecord(LIVE_DOC, docEndingWith(3, text))),
    [],
    'these Status spellings are not read as a record',
  );
});

// GUARD: the value must be exactly one of the five words (the mutants: a sixth
// word, Accepted, added; the word read as a prefix or inside a longer value).
scenario('any other Status value is not a record', () => {
  const notStatuses = [
    'Status: Accepted',
    '**Status:** Accepted',
    '- Status: Accepted',
    '| Status | Accepted |',
    'Status: Approved',
    'Status: Implemented',
    'Status: Active',
    'Status: Proposed-then-accepted-by-the-board',
    'Status: Drafting',
    'Status: Accepted (previously Draft)',
    'Status: Historical',
    'Status: Snapshot',
  ];
  assert.deepEqual(
    failing(notStatuses, (text) => !isPointInTimeRecord(LIVE_DOC, docEndingWith(3, text))),
    [],
    'these Status values make a record, and none of them is one of the five words',
  );
});

scenario('the Status header is read in the first 40 lines: line 40 is in, line 41 is out', () => {
  const statuses = ['Status: Draft', '**Status:** Proposed', '| Status | Superseded |'];
  assert.equal(docEndingWith(40, statuses[0]).length, 40);
  assert.deepEqual(
    failing(statuses, (text) => isPointInTimeRecord(LIVE_DOC, docEndingWith(40, text))),
    [],
    'a Status on line 40 is inside the window',
  );
  assert.deepEqual(
    failing(statuses, (text) => !isPointInTimeRecord(LIVE_DOC, docEndingWith(41, text))),
    [],
    'a Status on line 41 is outside the window',
  );
  assert.deepEqual(
    failing(statuses, (text) => !isPointInTimeRecord(LIVE_DOC, docEndingWith(80, text))),
    [],
    'a Status deep in the body is prose about a status, not the document header',
  );
});

scenario('a base name holding a point-in-time token makes a record', () => {
  const separators = (token: string): string[] => [
    `${token}.md`,
    `ops-${token}.md`,
    `ops_${token}_notes.md`,
    `ops.${token}.md`,
    `ops ${token} notes.md`,
  ];
  const names = FILE_NAME_TOKENS.flatMap(separators).map((name) => `docs/guides/${name}`);
  assert.deepEqual(
    failing(names, (name) => isPointInTimeRecord(name, ['# Guide', '', 'Body.'])),
    [],
    'these base names are not read as a record',
  );
});

// GUARD: a token, not a substring; and the token rule reads the base name, so a
// directory named for a token (or `reviews`/`audits`/dated/archive, as before)
// keeps the rule it had.
scenario('a token is not a substring, and a directory name keeps its own rule', () => {
  const substrings = [
    'planning-guide.md',
    'explainer.md',
    'inspector.md',
    'explanation.md',
    'reviewer-guide.md',
    'auditing.md',
    'retrospective.md',
    'specification-guide.md',
    'ops-guide.md',
    'README.md',
  ].map((name) => `docs/guides/${name}`);
  assert.deepEqual(
    failing(substrings, (name) => !isPointInTimeRecord(name, ['# Guide', '', 'Body.'])),
    [],
    'a name that only contains a token as a substring is read as a record',
  );
  const tokenDirectories = [...FILE_NAME_TOKENS, 'plans', 'specs', 'reports', 'rollback-plan'].map(
    (directory) => `docs/${directory}/ops-guide.md`,
  );
  assert.deepEqual(
    failing(tokenDirectories, (name) => !isPointInTimeRecord(name, ['# Guide', '', 'Body.'])),
    [],
    'a directory named for a token makes its documents a record',
  );
  const recordDirectories = [
    'docs/reviews/ops-guide.md',
    'docs/audits/ops-guide.md',
    'docs/plans/2026-04-21-refactor/ops-guide.md',
    'docs/plans/_archive/ops-guide.md',
  ];
  assert.deepEqual(
    failing(recordDirectories, (name) => isPointInTimeRecord(name, ['# Guide', '', 'Body.'])),
    [],
    'the directory names that were records are still records',
  );
});

// GUARD: the peer's measurement shows these cost real findings (old documents
// still cited as current): a date, or the word historical, is not a role.
scenario('a dated or historical header does not make a record', () => {
  const headers = [
    ['# Sensor runbook', '', 'Date: 2026-03-14'],
    ['# Sensor runbook (2026-03-14)'],
    ['# 2026-03-14 sensor runbook'],
    ['Last updated: 2026-03-14', '', '# Sensor runbook'],
    ['# Sensor runbook', '', 'Historical notes, kept as they were.'],
    ['# Historical sensor runbook'],
    ['# Tarihsel sensör belgesi'],
    ['# Sensor runbook', '', 'A point-in-time snapshot of the setup.'],
    ['# Sensor runbook', '', 'Status: Historical'],
  ];
  assert.deepEqual(
    failing(headers, (lines) => !isPointInTimeRecord('docs/runbooks/ops.md', lines)),
    [],
    'a dated or historical header makes a record',
  );
});

const ROW_REF = 'apps/farm-service/src/fx-handler.ts';
const ROW_SPAN = `\`${ROW_REF}\``;
const rowRole = (row: string): UnclaimedRole | undefined =>
  referenceRole([row], 0, new Set<string>(), ROW_REF);

scenario('a Create or New table cell makes the reference in its row a file to create', () => {
  const rows = [
    `| Create | ${ROW_SPAN} |`,
    `| New | ${ROW_SPAN} | handler |`,
    `| ${ROW_SPAN} | Create |`,
    `| ${ROW_SPAN} | New | handler |`,
    `|   Create   | ${ROW_SPAN} |`,
    // Read with the backtick spans removed: this cell is New and nothing else.
    `| New \`v2\` | ${ROW_SPAN} |`,
    `| Oluştur | ${ROW_SPAN} |`,
    `| YENİ | ${ROW_SPAN} |`,
  ];
  assert.deepEqual(
    rows.filter((row) => rowRole(row) !== 'creation'),
    [],
    'these rows do not claim the reference as a file to create',
  );
  // The row owns the role: the neighbouring row of the same table is not new.
  const table = [
    '| Action | Path |',
    '| --- | --- |',
    `| Create | ${ROW_SPAN} |`,
    `| Modify | \`apps/farm-service/src/fx-legacy.ts\` |`,
  ];
  const scan = scanDocReferences(table, () => false);
  assert.deepEqual(
    scan.stale.map((item) => item.line),
    [4],
    'only the Modify row is a stale claim',
  );
  assert.equal(scan.unclaimed.creation, 1);
});

// GUARD: the cell is exactly the word (the mutant: a contains rule), read with
// the backtick spans removed.
scenario('a cell that merely contains the word claims nothing', () => {
  const rows = [
    `| Renewal | ${ROW_SPAN} |`,
    `| Created | ${ROW_SPAN} |`,
    `| Newsletter | ${ROW_SPAN} |`,
    `| Recreate | ${ROW_SPAN} |`,
    `| Create index | ${ROW_SPAN} |`,
    `| New tenant | ${ROW_SPAN} |`,
    `| Modify | ${ROW_SPAN} | create a new row |`,
    `| \`Create\` | ${ROW_SPAN} |`,
    `| Modify | ${ROW_SPAN} |`,
  ];
  assert.deepEqual(
    rows.filter((row) => rowRole(row) !== undefined),
    [],
    'these rows claim the reference, and none of them has a Create or New cell',
  );
});

// GUARD: `planned`, `pending`, `not yet` and `(R2)` are not roles, on the
// cited line, in its table row, or in a window of three lines around it (one
// such rule hid a living rollback runbook).
scenario('a marker word near a reference claims nothing', () => {
  const markerRef = 'apps/farm-service/src/fx-switch.sh';
  const span = `\`${markerRef}\``;
  const markers = ['planned', 'pending', 'not yet wired', '(R2)'];
  const layouts = (marker: string): { name: string; lines: string[]; index: number }[] => {
    const sentence = `The switch is ${marker}.`;
    const run = `Run ${span}.`;
    const found = [
      { name: 'same line', lines: [`Run ${span} ${marker}.`], index: 0 },
      { name: 'same row', lines: [`| Modify | ${span} | ${marker} |`], index: 0 },
    ];
    for (const distance of [1, 2, 3]) {
      const gap = Array.from({ length: distance - 1 }, () => '');
      found.push({ name: `${distance} above`, lines: [sentence, ...gap, run], index: distance });
      found.push({ name: `${distance} below`, lines: [run, ...gap, sentence], index: 0 });
    }
    return found;
  };
  const claimed = markers.flatMap((marker) =>
    layouts(marker)
      .filter(({ lines, index }) => {
        const stale = scanDocReferences(lines, () => false).stale;
        return stale.length !== 1 || stale[0].line !== index + 1;
      })
      .map(({ name }) => `${marker}: ${name}`),
  );
  assert.deepEqual(claimed, [], 'a marker word made a reference a claim of no one');
});

// The curated cases the nightly fixture lane runs, replayed here: each names the
// findings that must remain (path and line under the workspace's docs/), the
// documents read as records and the references read as files to create. The
// counts a case declares must agree with what the adapter reports.
const FIXTURE_DIR = 'tools/aria-adapters/fixtures/doc-staleness-adapter';
interface RoleCase {
  readonly lane: string;
  readonly input: Parameters<typeof analyzeDocStaleness>[0];
  readonly expected: { readonly findings_count: number };
  readonly curation: {
    readonly gold_set: {
      readonly true_positive_count: number;
      readonly known_false_positive_count: number;
    };
  };
}
const ROLE_CASES: readonly {
  readonly name: string;
  readonly workspace: string;
  readonly flagged: readonly string[];
  readonly recordDocs: number;
  readonly creation: number;
}[] = [
  {
    // Five status spellings and a Status on line 40 are records; the document
    // that says Accepted is the one live claim left.
    name: 'semantic-status-header-records',
    workspace: 'status-header-records',
    flagged: ['docs/adr/006-edge.md:5'],
    recordDocs: 6,
    creation: 0,
  },
  {
    // Nine tokens make records; a name that only contains one, and a document
    // under a directory named for one, are live.
    name: 'semantic-file-name-records',
    workspace: 'file-name-records',
    flagged: [
      'docs/guides/explainer.md:3',
      'docs/guides/inspector.md:3',
      'docs/guides/planning-guide.md:3',
      'docs/plan/ops-guide.md:3',
    ],
    recordDocs: 9,
    creation: 0,
  },
  {
    // Four cells claim their row's file as to be created; Modify, Renewal and
    // Created do not.
    name: 'semantic-create-table-rows',
    workspace: 'create-table-rows',
    flagged: ['docs/guides/surface.md:9', 'docs/guides/surface.md:10', 'docs/guides/surface.md:11'],
    recordDocs: 0,
    creation: 4,
  },
  {
    // GUARD: Accepted, a Status on line 41, a qualified status, a dated header,
    // a historical header and Status: Historical are all live documents.
    name: 'semantic-record-near-misses',
    workspace: 'record-near-misses',
    flagged: [
      'docs/adr/010-accepted.md:5',
      'docs/adr/011-late-status.md:43',
      'docs/adr/012-qualified.md:5',
      'docs/adr/013-dated-header.md:7',
      'docs/adr/014-historical-header.md:5',
      'docs/adr/015-status-historical.md:5',
    ],
    recordDocs: 0,
    creation: 0,
  },
  {
    // GUARD: planned, pending, not yet and (R2) within three lines of a missing
    // path, and planned on the cited line, leave all five paths flagged.
    name: 'semantic-marker-words-stay-claims',
    workspace: 'marker-words-stay-claims',
    flagged: [
      'docs/runbooks/rollback.md:7',
      'docs/runbooks/rollback.md:13',
      'docs/runbooks/rollback.md:19',
      'docs/runbooks/rollback.md:25',
      'docs/runbooks/rollback.md:29',
    ],
    recordDocs: 0,
    creation: 0,
  },
];
for (const roleCase of ROLE_CASES) {
  scenario(`fixture case ${roleCase.name}`, () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO_ROOT, FIXTURE_DIR, 'cases', `${roleCase.name}.json`), 'utf8'),
    ) as RoleCase;
    const output = analyzeDocStaleness(fixture.input, REPO_ROOT);
    const under = `${FIXTURE_DIR}/workspaces/${roleCase.workspace}/`;
    assert.deepEqual(
      output.findings.map((item) => `${item.path}:${item.line}`).sort(),
      roleCase.flagged.map((flagged) => `${under}${flagged}`).sort(),
      'the findings that remain',
    );
    assert.equal(output.metadata.recordDocs, roleCase.recordDocs, 'the documents read as records');
    assert.deepEqual(
      output.metadata.unclaimedRefs,
      { creation: roleCase.creation, proposal: 0, absence: 0, change_target: 0 },
      'the references read as a role',
    );
    // The case file says the same: its count, its lane and its gold set.
    assert.equal(fixture.lane, 'semantic_regression');
    assert.equal(fixture.expected.findings_count, roleCase.flagged.length);
    assert.equal(fixture.curation.gold_set.true_positive_count, roleCase.flagged.length);
    assert.equal(
      fixture.curation.gold_set.known_false_positive_count,
      roleCase.recordDocs + roleCase.creation,
    );
  });
}

assert.ok(
  scopeFailures.length === 0,
  `${scopeFailures.length} doc-staleness scenario(s) failed:\n\n${scopeFailures.join('\n\n')}`,
);

process.stdout.write('doc-staleness-adapter tests passed\n');
