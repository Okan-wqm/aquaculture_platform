#!/usr/bin/env node

import { canonicalJson } from './lib/canonical.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';

const optionsByFlag = new Map([
  ['--repository-root', 'repositoryRoot'],
  ['--artifact-root', 'artifactRoot'],
  ['--dossier', 'dossierPath'],
  ['--context-envelope', 'contextEnvelopePath'],
  ['--trust-root', 'trustRootPath'],
  ['--authority-root', 'authorityRoot'],
  ['--trust-root-sha256', 'trustRootSha256'],
  ['--reviewer-authority-root', 'reviewerAuthorityRoot'],
  ['--reviewer-authority-bundle', 'reviewerAuthorityBundlePath'],
  ['--reviewer-authority-bundle-sha256', 'reviewerAuthorityBundleSha256'],
  ['--target-authority-root', 'targetAuthorityRoot'],
  ['--target-context-envelope', 'targetContextEnvelopePath'],
  ['--target-trust-root', 'targetTrustRootPath'],
  ['--target-trust-root-sha256', 'targetTrustRootSha256'],
]);

function parseArguments(argv) {
  if (argv.length !== optionsByFlag.size * 2) {
    throw new Error('fourteen exact option/value pairs required');
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = optionsByFlag.get(argv[index]);
    const value = argv[index + 1];
    if (name === undefined || typeof value !== 'string' || value.length === 0 || name in options) {
      throw new Error('unknown, duplicate, or empty dossier admission option');
    }
    options[name] = value;
  }
  return options;
}

try {
  const result = admitReviewDossier(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`dossier admission failed: ${error.message}\n`);
  process.exitCode = 1;
}
