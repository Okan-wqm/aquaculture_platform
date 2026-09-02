import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';
import { readSecureArtifact } from './secure-artifact.mjs';
import { loadVerifiedPayload } from './verify-signature.mjs';
import { bundleDigest, verifyProvenance } from './verify-provenance.mjs';
import { verifyTarget } from './verify-target.mjs';

const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
const provenancePath = 'verification/verifier-inputs.jsonl';
const metadataKeys = [
  'schema_version',
  'kind',
  'verifier_version',
  'claim',
  'recorded_at_utc',
  'verifier_script',
  'required_flags',
  'cwd_contract',
  'runtime',
  'input_bundle_algorithm',
  'input_bundle_sha256',
];
const recordKeys = ['schema_version', 'kind', 'path', 'sha256'];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

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

function validateProvenanceRecord(record) {
  if (!exactKeys(record, recordKeys)) throw new Error('verifier provenance record schema drift');
  if (record.schema_version !== '2.0.0' || record.kind !== 'input') {
    throw new Error('verifier provenance input record identity mismatch');
  }
  if (typeof record.path !== 'string' || record.path.length === 0) {
    throw new Error('verifier provenance input path is required');
  }
  if (!/^[a-f0-9]{64}$/u.test(record.sha256)) {
    throw new Error('verifier provenance input digest mismatch');
  }
}

function validateProvenanceMetadata(metadata, records) {
  if (!exactKeys(metadata, metadataKeys) || records.length === 0) {
    throw new Error('verifier provenance metadata schema is closed and required');
  }
  if (
    metadata.input_bundle_algorithm !== 'sha256(path + NUL + sha256 + LF, lexicographic path order)'
  ) {
    throw new Error('verifier provenance bundle algorithm mismatch');
  }
  if (metadata.input_bundle_sha256 !== bundleDigest(records)) {
    throw new Error('verifier provenance bundle digest mismatch');
  }
}

function parseProvenance(bytes) {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new Error('verifier provenance must be non-empty newline-terminated JSONL');
  }
  const rows = bytes.toString('utf8').trimEnd().split('\n').map(parseStrictJson);
  const [metadata, ...records] = rows;
  records.forEach(validateProvenanceRecord);
  validateProvenanceMetadata(metadata, records);
  return metadata;
}

function verifiedTargetContext(repositoryRoot, options, beforeBytes) {
  const authority = targetAuthority(options);
  const verified = loadVerifiedPayload({
    repositoryRoot,
    authorityRoot: authority.authorityRoot,
    envelopePath: authority.contextPath,
    trustRootPath: authority.trustRootPath,
    trustRootSha256: authority.trustRootSha256,
    expectedKind: 'new-aria-d0-target-authority',
    expectedCapability: 'd0-target-authority',
  });
  const target = targetInput(verified.payload.target ?? {});
  const result = verifyTarget(repositoryRoot, target, authority);
  if (result.errors.length > 0) {
    throw new Error(`reviewed target rejected: ${result.errors[0].message}`);
  }
  const afterBytes = readFileSync(options.targetContextEnvelopePath);
  if (!beforeBytes.equals(afterBytes)) throw new Error('target authority changed during admission');
  return { target, signer: verified.signer, bytes: afterBytes };
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
  const targetBytes = readFileSync(options.targetContextEnvelopePath);
  const target = verifiedTargetContext(repositoryRoot, options, targetBytes);
  const root = join(repositoryRoot, planPath);
  const provenanceErrors = verifyProvenance(root);
  if (provenanceErrors.length > 0) {
    throw new Error(`verifier provenance rejected: ${provenanceErrors[0].message}`);
  }
  const provenanceBytes = readFileSync(join(root, provenancePath));
  const metadata = parseProvenance(provenanceBytes);
  return {
    reviewedTarget: reviewedTarget(
      target.target,
      target.signer,
      target.bytes,
      provenanceBytes,
      metadata,
    ),
    targetAuthorityBytes: target.bytes,
    targetSigner: target.signer,
    provenanceBytes,
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
