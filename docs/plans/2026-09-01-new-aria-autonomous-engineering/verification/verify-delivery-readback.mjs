#!/usr/bin/env node

import { canonicalJson } from './lib/canonical.mjs';
import { verifyDeliveryReadback } from './delivery-readback.mjs';
import { fileURLToPath } from 'node:url';

const flags = new Map([
  ['--repository-root', 'repositoryRoot'],
  ['--readback-authority-root', 'readbackAuthorityRoot'],
  ['--readback-context-envelope', 'readbackContextEnvelope'],
  ['--readback-trust-root', 'readbackTrustRoot'],
  ['--readback-trust-root-sha256', 'readbackTrustRootSha256'],
  ['--review-artifact-root', 'reviewArtifactRoot'],
  ['--review-dossier', 'reviewDossier'],
  ['--review-context-envelope', 'reviewContextEnvelope'],
  ['--review-trust-root', 'reviewTrustRoot'],
  ['--review-authority-root', 'reviewAuthorityRoot'],
  ['--review-trust-root-sha256', 'reviewTrustRootSha256'],
  ['--reviewer-authority-root', 'reviewerAuthorityRoot'],
  ['--reviewer-authority-bundle', 'reviewerAuthorityBundle'],
  ['--reviewer-authority-bundle-sha256', 'reviewerAuthorityBundleSha256'],
  ['--target-authority-root', 'targetAuthorityRoot'],
  ['--target-context-envelope', 'targetContextEnvelope'],
  ['--target-trust-root', 'targetTrustRoot'],
  ['--target-trust-root-sha256', 'targetTrustRootSha256'],
]);

export function argumentsFrom(argv) {
  if (argv.length !== flags.size * 2) throw new Error('eighteen exact option/value pairs required');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = flags.get(argv[index]);
    if (!field || !argv[index + 1] || field in values) throw new Error('invalid readback options');
    values[field] = argv[index + 1];
  }
  return {
    repositoryRoot: values.repositoryRoot,
    authorityRoot: values.readbackAuthorityRoot,
    envelopePath: values.readbackContextEnvelope,
    trustRootPath: values.readbackTrustRoot,
    trustRootSha256: values.readbackTrustRootSha256,
    dossierAdmission: {
      repositoryRoot: values.repositoryRoot,
      artifactRoot: values.reviewArtifactRoot,
      dossierPath: values.reviewDossier,
      contextEnvelopePath: values.reviewContextEnvelope,
      trustRootPath: values.reviewTrustRoot,
      authorityRoot: values.reviewAuthorityRoot,
      trustRootSha256: values.reviewTrustRootSha256,
      reviewerAuthorityRoot: values.reviewerAuthorityRoot,
      reviewerAuthorityBundlePath: values.reviewerAuthorityBundle,
      reviewerAuthorityBundleSha256: values.reviewerAuthorityBundleSha256,
      targetAuthorityRoot: values.targetAuthorityRoot,
      targetContextEnvelopePath: values.targetContextEnvelope,
      targetTrustRootPath: values.targetTrustRoot,
      targetTrustRootSha256: values.targetTrustRootSha256,
    },
  };
}

export async function runDeliveryReadbackCli(argv, environment = process.env) {
  return verifyDeliveryReadback({
    ...argumentsFrom(argv),
    githubToken: environment.GITHUB_TOKEN,
  });
}

async function main() {
  try {
    const result = await runDeliveryReadbackCli(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    process.stderr.write(`delivery readback failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
