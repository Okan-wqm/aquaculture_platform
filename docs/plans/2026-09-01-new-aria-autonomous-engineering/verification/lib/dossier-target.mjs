import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { loadVerifiedProvenance } from './verify-provenance.mjs';
import { verifyAuthorizedTarget } from './verify-target.mjs';

const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function targetAuthority(options) {
  return {
    authorityRoot: options.targetAuthorityRoot,
    contextPath: options.targetContextEnvelopePath,
    trustRootPath: options.targetTrustRootPath,
    trustRootSha256: options.targetTrustRootSha256,
  };
}

function targetInput(signed) {
  return {
    baseSha: signed.base_sha,
    baseTree: signed.base_tree,
    headSha: signed.head_sha,
    headTree: signed.head_tree,
    reviewedRef: signed.reviewed_ref,
    diffSha256: signed.committed_diff_sha256,
    designSha256: signed.design_sha256,
    formatScopeSha256: signed.format_scope_sha256,
  };
}

function verifiedTargetContext(repositoryRoot, options) {
  const authority = targetAuthority(options);
  const result = verifyAuthorizedTarget(repositoryRoot, authority);
  if (result.errors.length > 0) {
    throw new Error(`reviewed target rejected: ${result.errors[0].message}`);
  }
  return {
    authority: result.authority,
    facts: result.facts,
    target: targetInput(result.authority.target),
  };
}

function reviewedTarget(target, signer, authorityBytes, provenanceBytes, metadata) {
  return {
    base_sha: target.baseSha,
    base_tree: target.baseTree,
    head_sha: target.headSha,
    head_tree: target.headTree,
    reviewed_ref: target.reviewedRef,
    committed_diff_sha256: target.diffSha256,
    design_sha256: target.designSha256,
    format_scope_sha256: target.formatScopeSha256,
    authority_bundle_sha256: sha256(authorityBytes),
    verifier_inputs_sha256: sha256(provenanceBytes),
    input_bundle_sha256: metadata.input_bundle_sha256,
    target_operator_principal_id: signer.principalId,
  };
}

export function resolveDossierTarget(options) {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const target = verifiedTargetContext(repositoryRoot, options);
  const root = join(repositoryRoot, planPath);
  const provenance = loadVerifiedProvenance(root, {
    repositoryRoot,
    revision: target.facts.head_sha,
    gitTool: target.facts.git_tool,
  });
  const { provenanceBytes } = provenance;
  return {
    reviewedTarget: reviewedTarget(
      target.target,
      target.authority.signer,
      target.authority.envelopeBytes,
      provenanceBytes,
      provenance.metadata,
    ),
    gitTool: target.authority.target.git_tool,
    targetAuthorityBytes: target.authority.envelopeBytes,
    targetSigner: target.authority.signer,
    provenanceBytes,
    verifierInputFiles: provenance.files,
  };
}

function matchesArtifact(artifactRoot, artifact, expectedBytes, label) {
  const actual = readSecureArtifact(artifactRoot, artifact.artifact_uri);
  if (artifact.sha256 !== sha256(actual) || !actual.equals(expectedBytes)) {
    throw new Error(`${label} artifact does not exactly copy its verified source bytes`);
  }
}

export function verifyDossierTargetArtifacts(artifactRoot, dossier, context, resolved) {
  if (!equal(dossier.reviewed_target, resolved.reviewedTarget)) {
    throw new Error('dossier reviewed target contradicts the verified target and provenance');
  }
  if (context.producer_artifact.artifact_uri !== dossier.producer.artifact_uri) {
    throw new Error('dossier producer artifact URI contradicts the signed context');
  }
  matchesArtifact(
    artifactRoot,
    context.producer_artifact,
    resolved.provenanceBytes,
    'producer provenance',
  );
  matchesArtifact(
    artifactRoot,
    context.authority_artifact,
    resolved.targetAuthorityBytes,
    'target authority',
  );
}
