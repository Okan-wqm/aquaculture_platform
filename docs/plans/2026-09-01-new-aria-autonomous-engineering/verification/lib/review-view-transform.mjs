import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, sha256File } from './canonical.mjs';

const verifiedTransformSets = new Set();
const readerViewPreamble =
  '<!-- markdownlint-disable MD013 MD033 -->\n' +
  '<!-- Historical review text preserves long evidence tokens and placeholders. -->\n\n';

function add(errors, message) {
  errors.push({ code: 'REVIEW_DOSSIER', message });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameKeys(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort())
  );
}

export function transformRuntime(errors, repositoryRoot, transform) {
  const keys = [
    'id',
    'tool',
    'tool_version',
    'argv_template',
    'preamble',
    'preamble_sha256',
    'config_path',
    'config_sha256',
    'lockfile_path',
    'lockfile_sha256',
  ];
  const expectedArgv = [
    'prettier',
    '--config',
    '.prettierrc',
    '--print-width',
    '110',
    '--prose-wrap',
    'always',
    '--stdin-filepath',
    '<reader-view.md>',
  ];
  if (!sameKeys(transform, keys)) {
    add(errors, 'view transform schema drift');
    return null;
  }
  if (
    !equal(
      [transform.id, transform.tool, transform.tool_version],
      ['prettier-markdown-v2', 'prettier', '3.6.2'],
    ) ||
    !equal(transform.argv_template, expectedArgv) ||
    transform.preamble !== readerViewPreamble ||
    transform.preamble_sha256 !== sha256(Buffer.from(readerViewPreamble, 'utf8'))
  ) {
    add(errors, 'view transform identity drift');
  }
  for (const [pathKey, digestKey] of [
    ['config_path', 'config_sha256'],
    ['lockfile_path', 'lockfile_sha256'],
  ]) {
    if (sha256File(join(repositoryRoot, transform[pathKey])) !== transform[digestKey]) {
      add(errors, `${transform[pathKey]}: transform digest mismatch`);
    }
  }
  const prettier = join(repositoryRoot, 'node_modules/.bin/prettier');
  const version = spawnSync(prettier, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== transform.tool_version) {
    add(errors, 'Prettier runtime mismatch');
  }
  return { prettier, config: join(repositoryRoot, transform.config_path) };
}

function verifyTransforms(errors, planRoot, runtime, reports) {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-review-transform-'));
  try {
    const copies = reports.map((report, index) => {
      const relativePath = join(String(index), 'reader-view.md');
      const directory = join(ownerRoot, String(index));
      const path = join(directory, 'reader-view.md');
      mkdirSync(directory);
      const source = readFileSync(join(planRoot, report.source_path));
      writeFileSync(path, Buffer.concat([Buffer.from(readerViewPreamble, 'utf8'), source]));
      return { path, relativePath };
    });
    const result = spawnSync(
      runtime.prettier,
      [
        '--config',
        runtime.config,
        '--print-width',
        '110',
        '--prose-wrap',
        'always',
        '--write',
        ...copies.map((copy) => copy.relativePath),
      ],
      { cwd: ownerRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      add(errors, 'Prettier source-to-view transform failed');
      return;
    }
    reports.forEach((report, index) => {
      const view = readFileSync(join(planRoot, report.path));
      if (!readFileSync(copies[index].path).equals(view)) {
        add(errors, `${report.path}: deterministic source-to-view mismatch`);
      }
    });
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
}

function transformSetKey(runtime, reports) {
  return JSON.stringify({
    config: runtime.config,
    reports: reports.map((report) => [
      report.path,
      report.sha256,
      report.source_path,
      report.source_sha256,
    ]),
  });
}

export function verifyTransformationSet(errors, planRoot, transformations) {
  if (errors.length > 0 || transformations.length === 0) return;
  const reports = transformations.flatMap((transformation) => transformation.reports);
  const runtime = transformations[0].runtime;
  const key = transformSetKey(runtime, reports);
  if (verifiedTransformSets.has(key)) return;
  verifyTransforms(errors, planRoot, runtime, reports);
  if (errors.length === 0) verifiedTransformSets.add(key);
}
