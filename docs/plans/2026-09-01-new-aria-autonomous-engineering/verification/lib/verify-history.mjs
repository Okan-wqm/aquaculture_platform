import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventHash, parseStrictJson, sha256, sha256File } from './canonical.mjs';

const historicalHead = 'c6065d6dac97306f147de67ef58a96e3a67524ac';
const oldEvidenceDigest = '0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558';
const firstFourDigest = '843c22890cf8527a1d486025acbb75c13e81ee3edd039bd1761fcc01661de594';
const reviewEvidence = 'progress/evidence/D0-review-c6065d6d-changes-required.json';

function add(errors, code, message) {
  errors.push({ code, message });
}

function gitObject(repositoryRoot, revision, path) {
  const result = spawnSync('git', ['show', `${revision}:${path}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git show failed for ${revision}:${path}`);
  return result.stdout;
}

function verifyHistoricalManifest(errors, planRoot, repositoryRoot) {
  const path = join(planRoot, 'progress/evidence/D0-plan-materialization.json');
  if (sha256File(path) !== oldEvidenceDigest) {
    add(errors, 'HISTORICAL_EVIDENCE', 'materialization manifest raw digest changed');
    return;
  }
  const manifest = parseStrictJson(readFileSync(path, 'utf8'));
  const bundle = [];
  for (const entry of manifest.authority) {
    try {
      const actual = sha256(gitObject(repositoryRoot, historicalHead, entry.path));
      if (actual !== entry.sha256)
        add(errors, 'HISTORICAL_EVIDENCE', `${entry.path}: historical digest mismatch`);
      bundle.push(`${entry.path}\0${entry.sha256}\n`);
    } catch (error) {
      add(errors, 'HISTORICAL_EVIDENCE', error.message);
    }
  }
  if (sha256(Buffer.from(bundle.join(''), 'utf8')) !== manifest.artifact.digest) {
    add(errors, 'HISTORICAL_EVIDENCE', 'historical authority bundle mismatch');
  }
}

function verifyTransformInputs(errors, repositoryRoot, transform) {
  const expectedArgv = [
    'prettier',
    '--config',
    '.prettierrc',
    '--stdin-filepath',
    '<reader-view.md>',
  ];
  const identity = [transform?.id, transform?.tool, transform?.tool_version];
  if (
    JSON.stringify(identity) !== JSON.stringify(['prettier-markdown-v1', 'prettier', '3.6.2']) ||
    JSON.stringify(transform?.argv_template) !== JSON.stringify(expectedArgv)
  ) {
    add(errors, 'REVIEW_EVIDENCE', 'review view transform identity drift');
  }
  for (const [pathKey, digestKey] of [
    ['config_path', 'config_sha256'],
    ['lockfile_path', 'lockfile_sha256'],
  ]) {
    const path = join(repositoryRoot, transform[pathKey]);
    if (sha256File(path) !== transform[digestKey])
      add(errors, 'REVIEW_EVIDENCE', `${transform[pathKey]}: transform input digest mismatch`);
  }
  const prettier = join(repositoryRoot, 'node_modules/.bin/prettier');
  const version = spawnSync(prettier, ['--version'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== transform.tool_version)
    add(errors, 'REVIEW_EVIDENCE', 'Prettier runtime provenance mismatch');
  return { prettier, config: join(repositoryRoot, transform.config_path) };
}

function verifyReviewViews(errors, planRoot, repositoryRoot, manifest) {
  const transform = manifest.review_provenance.view_transform;
  const { prettier, config } = verifyTransformInputs(errors, repositoryRoot, transform);
  for (const report of manifest.reports) {
    const source = join(planRoot, report.source_path);
    if (sha256File(source) !== report.source_sha256)
      add(errors, 'REVIEW_EVIDENCE', `${report.source_path}: source digest mismatch`);
    if (report.source_sha256 === report.sha256) continue;
    const view = join(planRoot, report.path);
    const result = spawnSync(prettier, ['--config', config, '--stdin-filepath', view], {
      cwd: repositoryRoot,
      input: readFileSync(source),
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) {
      add(errors, 'REVIEW_EVIDENCE', `${report.path}: review view transformation failed`);
    } else if (!result.stdout.equals(readFileSync(view))) {
      add(errors, 'REVIEW_EVIDENCE', `${report.path}: source-to-view parity mismatch`);
    }
  }
}

function verifyReviewManifest(errors, planRoot, repositoryRoot) {
  const path = join(planRoot, reviewEvidence);
  const manifest = parseStrictJson(readFileSync(path, 'utf8'));
  const expectedFindings = [
    ...Array.from({ length: 17 }, (_, index) => `APP-P1-${String(index + 1).padStart(3, '0')}`),
    'APP-P2-018',
  ];
  if (
    manifest.reviewed_target.head_sha !== historicalHead ||
    manifest.reviewed_target.verdict !== 'CHANGES_REQUIRED'
  ) {
    add(errors, 'REVIEW_EVIDENCE', 'review target or verdict drift');
  }
  if (JSON.stringify(manifest.accepted_findings) !== JSON.stringify(expectedFindings)) {
    add(errors, 'REVIEW_EVIDENCE', 'accepted appellate finding roster drift');
  }
  if (
    manifest.reports.length !== 12 ||
    manifest.admission.accepted !== false ||
    manifest.state !== 'VERIFYING'
  ) {
    add(errors, 'REVIEW_EVIDENCE', 'review evidence is incomplete or falsely admitted');
  }
  for (const report of manifest.reports) {
    const actual = sha256File(join(planRoot, report.path));
    if (actual !== report.sha256) add(errors, 'REVIEW_EVIDENCE', `${report.path}: digest mismatch`);
  }
  verifyReviewViews(errors, planRoot, repositoryRoot, manifest);
}

function verifyEvent(errors, planRoot, line, index, previous) {
  const event = parseStrictJson(line);
  if (event.event_id !== `d0-${String(index + 1).padStart(4, '0')}`)
    add(errors, 'EVENT_CHAIN', 'event ID order mismatch');
  if (event.previous_hash !== previous || eventHash(event) !== event.event_hash)
    add(errors, 'EVENT_CHAIN', `${event.event_id}: hash mismatch`);
  if (
    event.evidence_uri &&
    sha256File(join(planRoot, event.evidence_uri)) !== event.evidence_digest
  ) {
    add(errors, 'EVENT_CHAIN', `${event.event_id}: evidence digest mismatch`);
  }
  return event;
}

function verifyEvents(errors, planRoot) {
  const lines = readFileSync(join(planRoot, 'progress/events.jsonl'), 'utf8').trimEnd().split('\n');
  if (sha256(Buffer.from(`${lines.slice(0, 4).join('\n')}\n`, 'utf8')) !== firstFourDigest)
    add(errors, 'EVENT_CHAIN', 'first four immutable event bytes changed');
  let previous = '0'.repeat(64);
  let latest;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      latest = verifyEvent(errors, planRoot, lines[index], index, previous);
      previous = latest.event_hash;
    } catch (error) {
      add(errors, 'EVENT_CHAIN', `row ${index + 1}: ${error.message}`);
    }
  }
  if (
    lines.length !== 5 ||
    latest?.to_state !== 'VERIFYING' ||
    latest?.review_verdict !== 'CHANGES_REQUIRED' ||
    latest?.admission !== false ||
    latest?.evidence_uri !== reviewEvidence
  ) {
    add(errors, 'D0_STATE', 'D0 review tail must remain non-admitted VERIFYING');
  }
}

export function verifyHistory(planRoot, repositoryRoot) {
  const errors = [];
  verifyHistoricalManifest(errors, planRoot, repositoryRoot);
  verifyReviewManifest(errors, planRoot, repositoryRoot);
  verifyEvents(errors, planRoot);
  return errors;
}
