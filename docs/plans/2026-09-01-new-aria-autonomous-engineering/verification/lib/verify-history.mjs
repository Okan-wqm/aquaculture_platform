import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStrictJson, sha256, sha256File } from './canonical.mjs';
import { loadReviewPolicy } from './verify-dossier.mjs';
import { verifyEvents } from './verify-events.mjs';
import { verifyNonAdmissionPackages } from './verify-review-evidence.mjs';

const historicalHead = 'c6065d6dac97306f147de67ef58a96e3a67524ac';
const oldEvidenceDigest = '0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558';

function add(errors, message) {
  errors.push({ code: 'HISTORICAL_EVIDENCE', message });
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

function verifyHistoricalManifest(planRoot, repositoryRoot) {
  const errors = [];
  const path = join(planRoot, 'progress/evidence/D0-plan-materialization.json');
  if (sha256File(path) !== oldEvidenceDigest) {
    add(errors, 'materialization manifest raw digest changed');
    return errors;
  }
  const manifest = parseStrictJson(readFileSync(path, 'utf8'));
  const bundle = [];
  for (const entry of manifest.authority) {
    try {
      if (sha256(gitObject(repositoryRoot, historicalHead, entry.path)) !== entry.sha256) {
        add(errors, `${entry.path}: historical digest mismatch`);
      }
      bundle.push(`${entry.path}\0${entry.sha256}\n`);
    } catch (error) {
      add(errors, error.message);
    }
  }
  if (sha256(Buffer.from(bundle.join(''), 'utf8')) !== manifest.artifact.digest) {
    add(errors, 'historical authority bundle mismatch');
  }
  return errors;
}

export function verifyHistory(planRoot, repositoryRoot) {
  const policy = loadReviewPolicy(planRoot);
  return [
    ...verifyHistoricalManifest(planRoot, repositoryRoot),
    ...verifyNonAdmissionPackages(planRoot, repositoryRoot, policy),
    ...verifyEvents(planRoot),
  ];
}
