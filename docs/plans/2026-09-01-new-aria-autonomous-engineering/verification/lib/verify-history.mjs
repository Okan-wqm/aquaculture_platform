import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson, sha256, sha256File } from './canonical.mjs';
import { readCommitFile } from './git-objects.mjs';
import { createGitSession } from './hermetic-git.mjs';
import { loadReviewPolicy } from './verify-dossier.mjs';
import { verifyEvents } from './verify-events.mjs';
import { verifyNonAdmissionPackages } from './verify-review-evidence.mjs';

const historicalHead = 'c6065d6dac97306f147de67ef58a96e3a67524ac';
const oldEvidenceDigest = '0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558';

function add(errors, message) {
  errors.push({ code: 'HISTORICAL_EVIDENCE', message });
}

function verifyHistoricalManifest(planRoot, repositoryRoot, gitTool) {
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
      if (
        sha256(
          readCommitFile(repositoryRoot, historicalHead, { path: entry.path }, gitTool).bytes,
        ) !== entry.sha256
      ) {
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

export function verifyHistory(planRoot, options) {
  const { gitRepositoryRoot, sourceRepositoryRoot, runtimeRepositoryRoot, gitTool } = options;
  const policy = loadReviewPolicy(planRoot);
  const git = createGitSession(gitTool);
  return [
    ...verifyHistoricalManifest(planRoot, gitRepositoryRoot, git),
    ...verifyNonAdmissionPackages(planRoot, sourceRepositoryRoot, policy, runtimeRepositoryRoot),
    ...verifyEvents(planRoot),
  ];
}
