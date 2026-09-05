import { loadVerifiedPayload } from './verify-signature.mjs';
import { assertRuntimeDependencyRoster } from './runtime-dependencies.mjs';
import { assertCommitSignaturePolicy } from './commit-signatures.mjs';

export const targetManifestPath =
  'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/target-manifest.json';

const manifestKeys = [
  'base_ref',
  'base_sha',
  'base_tree',
  'head_policy',
  'kind',
  'program_instance',
  'repository_slug',
  'reviewed_ref',
  'schema_version',
  'scope_policy',
];
const gitToolKeys = ['environment_policy', 'executable_sha256', 'logical_name', 'version'];
const nodeToolKeys = ['environment_policy', 'executable_sha256', 'logical_name', 'version'];
const payloadKeys = [
  'commit_signature_policy',
  'contract_id',
  'manifest',
  'manifest_sha256',
  'operator_principal_id',
  'target',
];
const targetKeys = [
  'base_sha',
  'base_tree',
  'head_sha',
  'head_tree',
  'reviewed_ref',
  'committed_diff_sha256',
  'design_sha256',
  'format_scope_sha256',
  'introduced_commit_signatures_sha256',
  'git_tool',
  'node_tool',
  'package_lock_sha256',
  'runtime_dependencies',
];
const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactRemoteRef = /^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function manifestIdentityMatches(value) {
  return (
    value.schema_version === '1.0.0' &&
    value.kind === 'new-aria-d0-verification-target' &&
    value.program_instance === 'new-aria-autonomous-engineering:D0:2026-09-01' &&
    value.repository_slug === 'Okan-wqm/aquaculture_platform' &&
    value.head_policy === 'CHECKOUT_EXACT' &&
    value.scope_policy === 'D0_PLAN_ONLY'
  );
}

function cloneRef(value) {
  return exactRemoteRef.test(value) && !value.includes('..');
}

function assertGitTool(value) {
  if (
    !exactKeys(value, gitToolKeys) ||
    value.logical_name !== 'git' ||
    !/^git version (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version) ||
    !exactDigest.test(value.executable_sha256) ||
    value.environment_policy !== 'new-aria-hermetic-git-v1'
  ) {
    throw new Error('signed target Git tool identity or policy mismatch');
  }
}

function assertNodeTool(value) {
  if (
    !exactKeys(value, nodeToolKeys) ||
    value.logical_name !== 'node' ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
    !exactDigest.test(value.executable_sha256) ||
    value.environment_policy !== 'new-aria-hermetic-node-v1'
  ) {
    throw new Error('signed target Node tool identity or policy mismatch');
  }
}

function assertManifest(value) {
  if (!exactKeys(value, manifestKeys)) throw new Error('target manifest schema is open or drifted');
  if (!manifestIdentityMatches(value))
    throw new Error('target manifest identity or policy mismatch');
  if (!exactSha.test(value.base_sha) || !exactSha.test(value.base_tree)) {
    throw new Error('target manifest base must use exact SHA values');
  }
  for (const field of ['base_ref', 'reviewed_ref']) {
    if (!cloneRef(value[field])) {
      throw new Error(`target manifest ${field} must be a clone-reproducible origin ref`);
    }
  }
  if (value.base_ref !== 'refs/remotes/origin/main' || value.reviewed_ref === value.base_ref) {
    throw new Error('target manifest base/reviewed ref policy mismatch');
  }
}

function assertSignedTarget(value, manifest) {
  if (!exactKeys(value, targetKeys)) throw new Error('signed target schema is open or drifted');
  assertGitTool(value.git_tool);
  assertNodeTool(value.node_tool);
  assertRuntimeDependencyRoster(value.runtime_dependencies);
  for (const field of ['base_sha', 'base_tree', 'head_sha', 'head_tree']) {
    if (!exactSha.test(value[field])) throw new Error(`signed target ${field} must be exact SHA`);
  }
  for (const field of [
    'committed_diff_sha256',
    'design_sha256',
    'format_scope_sha256',
    'introduced_commit_signatures_sha256',
  ]) {
    if (!exactDigest.test(value[field])) {
      throw new Error(`signed target ${field} must be exact SHA-256`);
    }
  }
  if (!exactDigest.test(value.package_lock_sha256)) {
    throw new Error('signed target package_lock_sha256 must be exact SHA-256');
  }
  const contradictions = [
    value.base_sha !== manifest.base_sha,
    value.base_tree !== manifest.base_tree,
    value.reviewed_ref !== manifest.reviewed_ref,
    value.base_sha === value.head_sha,
  ];
  if (contradictions.some(Boolean)) {
    throw new Error('signed target contradicts manifest or selects an empty range');
  }
}

function authorityOptions(options) {
  return {
    authorityRoot: options.authorityRoot ?? process.env.ARIA_D0_AUTHORITY_ROOT,
    envelopePath: options.contextPath ?? process.env.ARIA_D0_TARGET_CONTEXT,
    trustRootPath: options.trustRootPath ?? process.env.ARIA_D0_TRUST_ROOT,
    trustRootSha256: options.trustRootSha256 ?? process.env.ARIA_D0_TRUST_ROOT_SHA256,
  };
}

export function loadTargetAuthority(repositoryRoot, options = {}) {
  const verified = loadVerifiedPayload({
    repositoryRoot,
    ...authorityOptions(options),
    expectedKind: 'new-aria-d0-target-authority',
    expectedCapability: 'd0-target-authority',
  });
  const { envelopeBytes, payload, signer } = verified;
  if (
    !exactKeys(payload, payloadKeys) ||
    payload.contract_id !== 'new-aria-d0-target-authority-v1' ||
    !exactDigest.test(payload.manifest_sha256)
  ) {
    throw new Error('signed target authority payload schema or manifest digest mismatch');
  }
  assertManifest(payload.manifest);
  if (
    typeof payload.operator_principal_id !== 'string' ||
    payload.operator_principal_id.length === 0 ||
    payload.operator_principal_id !== signer.principalId
  ) {
    throw new Error('signed target authority principal does not match its trust root');
  }
  const commitSignaturePolicy = assertCommitSignaturePolicy(payload.commit_signature_policy, {
    manifest: payload.manifest,
    operatorKeySha256: signer.public_key_sha256,
    operatorPrincipalId: signer.principalId,
  });
  assertSignedTarget(payload.target, payload.manifest);
  return {
    envelopeBytes,
    manifest: payload.manifest,
    manifestSha256: payload.manifest_sha256,
    signer,
    commitSignaturePolicy,
    target: payload.target,
  };
}

export function loadTargetManifest(repositoryRoot, options = {}) {
  return loadTargetAuthority(repositoryRoot, options).manifest;
}

export function targetFromManifest(repositoryRoot, options = {}) {
  const { target } = loadTargetAuthority(repositoryRoot, options);
  return {
    baseSha: target.base_sha,
    headSha: target.head_sha,
    reviewedRef: target.reviewed_ref,
    baseTree: target.base_tree,
    headTree: target.head_tree,
    diffSha256: target.committed_diff_sha256,
    designSha256: target.design_sha256,
    formatScopeSha256: target.format_scope_sha256,
  };
}
