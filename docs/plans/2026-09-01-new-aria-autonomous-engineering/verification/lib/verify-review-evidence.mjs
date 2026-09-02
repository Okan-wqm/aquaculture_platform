import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStrictJson, sha256File } from './canonical.mjs';

const verifiedTransformSets = new Set();

function add(errors, message) {
  errors.push({ code: 'REVIEW_DOSSIER', message });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameKeys(value, keys) {
  return isRecord(value) && equal(Object.keys(value).sort(), [...keys].sort());
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function verifyManifestSchema(errors, manifest, definition) {
  const top = [
    'schema_version',
    'program_id',
    'evidence_id',
    'sprint_id',
    'state',
    'claim',
    'proof_class',
    'reviewed_target',
    'predecessor',
    'reports',
    'accepted_findings',
    'review_provenance',
    'admission',
    'observed_at_utc',
    'immutable',
  ];
  const nested = [
    ['reviewed_target', ['base_sha', 'head_sha', 'verdict']],
    ['predecessor', ['evidence_uri', 'sha256', 'event_id', 'event_hash']],
    ['review_provenance', ['source', 'principal_credential_claimed', 'view_transform', 'note']],
    ['admission', ['accepted', 'reason', 'state_transition', 'fresh_corrective_review_required']],
  ];
  if (!sameKeys(manifest, top)) add(errors, `${definition.evidence_id}: manifest schema drift`);
  for (const [field, keys] of nested) {
    if (!sameKeys(manifest[field], keys))
      add(errors, `${definition.evidence_id}: ${field} schema drift`);
  }
  if (!equal(manifest.accepted_findings, definition.accepted_findings)) {
    add(errors, `${definition.evidence_id}: accepted finding roster drift`);
  }
}

function transformRuntime(errors, repositoryRoot, transform) {
  const keys = [
    'id',
    'tool',
    'tool_version',
    'argv_template',
    'config_path',
    'config_sha256',
    'lockfile_path',
    'lockfile_sha256',
  ];
  const expectedArgv = [
    'prettier',
    '--config',
    '.prettierrc',
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
      ['prettier-markdown-v1', 'prettier', '3.6.2'],
    ) ||
    !equal(transform.argv_template, expectedArgv)
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
      writeFileSync(path, readFileSync(join(planRoot, report.source_path)));
      return { path, relativePath };
    });
    const result = spawnSync(
      runtime.prettier,
      ['--config', runtime.config, '--write', ...copies.map((copy) => copy.relativePath)],
      {
        cwd: ownerRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
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

function expectedReports(definition) {
  return definition.report_roles.map((role, index) => {
    const path = definition.report_paths[index];
    const name = path.split('/').at(-1);
    const sourcePath = path.includes('/c139f40f/')
      ? `reviews/c139f40f/source/${name}.raw`
      : `reviews/source/${name}.raw`;
    return { role, path, source_path: sourcePath };
  });
}

function verifyReportRoster(errors, reports, definition) {
  const actual = reports.map(({ role, path, source_path: sourcePath }) => ({
    role,
    path,
    source_path: sourcePath,
  }));
  if (!equal(actual, expectedReports(definition))) {
    add(errors, `${definition.evidence_id}: role/report roster drift`);
  }
  if (new Set(reports.map((report) => report.path)).size !== reports.length) {
    add(errors, `${definition.evidence_id}: report reuse`);
  }
  for (const field of ['sha256', 'source_path', 'source_sha256']) {
    if (new Set(reports.map((report) => report[field])).size !== reports.length) {
      add(errors, `${definition.evidence_id}: ${field} reuse`);
    }
  }
  for (const report of reports) {
    if (!sameKeys(report, ['role', 'path', 'sha256', 'source_path', 'source_sha256'])) {
      add(errors, `${definition.evidence_id}: report schema drift`);
    }
  }
}

function verifyReportDigests(errors, planRoot, reports) {
  for (const report of reports) {
    const source = join(planRoot, report.source_path);
    const view = join(planRoot, report.path);
    if (sha256File(source) !== report.source_sha256 || sha256File(view) !== report.sha256) {
      add(errors, `${report.path}: report digest mismatch`);
    }
  }
}

function verifyReports(errors, planRoot, repositoryRoot, manifest, definition) {
  if (!Array.isArray(manifest.reports) || manifest.reports.some((report) => !isRecord(report))) {
    add(errors, `${definition.evidence_id}: reports must be an array`);
    return null;
  }
  verifyReportRoster(errors, manifest.reports, definition);
  verifyReportDigests(errors, planRoot, manifest.reports);
  const provenance = isRecord(manifest.review_provenance) ? manifest.review_provenance : {};
  const transform = provenance.view_transform;
  const runtime = transformRuntime(errors, repositoryRoot, transform);
  return runtime === null ? null : { reports: manifest.reports, runtime };
}

function verifyPackageSemantics(errors, manifest, definition) {
  const target = isRecord(manifest.reviewed_target) ? manifest.reviewed_target : {};
  const admission = isRecord(manifest.admission) ? manifest.admission : {};
  const provenance = isRecord(manifest.review_provenance) ? manifest.review_provenance : {};
  const drift = [
    manifest.evidence_id !== definition.evidence_id,
    target.head_sha !== definition.head_sha,
    target.verdict !== 'CHANGES_REQUIRED',
    admission.accepted !== false,
    manifest.state !== 'VERIFYING',
    provenance.principal_credential_claimed !== false,
  ].some(Boolean);
  if (drift) add(errors, `${definition.evidence_id}: false admission or target drift`);
}

function verifyTransformationSet(errors, planRoot, transformations) {
  if (errors.length > 0 || transformations.length === 0) return;
  const reports = transformations.flatMap((transformation) => transformation.reports);
  const runtime = transformations[0].runtime;
  const key = transformSetKey(runtime, reports);
  if (verifiedTransformSets.has(key)) return;
  verifyTransforms(errors, planRoot, runtime, reports);
  if (errors.length === 0) verifiedTransformSets.add(key);
}

export function verifyNonAdmissionPackages(planRoot, repositoryRoot, policy) {
  const errors = [];
  const transformations = [];
  for (const definition of policy.non_admission_packages) {
    const manifest = parseStrictJson(readFileSync(join(planRoot, definition.path), 'utf8'));
    verifyManifestSchema(errors, manifest, definition);
    verifyPackageSemantics(errors, manifest, definition);
    const transformation = verifyReports(errors, planRoot, repositoryRoot, manifest, definition);
    if (transformation !== null) transformations.push(transformation);
  }
  verifyTransformationSet(errors, planRoot, transformations);
  return errors;
}
