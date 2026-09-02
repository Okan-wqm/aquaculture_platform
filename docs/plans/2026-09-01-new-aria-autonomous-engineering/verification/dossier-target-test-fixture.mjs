import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256, sha256File } from './lib/canonical.mjs';
import { bundleDigest, expectedPaths, runtimeProvenance } from './lib/verify-provenance.mjs';
import { REVIEW_ROLE_POLICY } from './lib/review-evidence-policy.mjs';
import { signedEnvelope } from './dossier-crypto-test-fixture.mjs';
import { runtimeTools, writeRuntimeFixture } from './target-control-test-fixture.mjs';

const relativePlan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
const reviewedRef = 'refs/remotes/origin/review';
function git(root, args, binary = false) {
  return execFileSync('git', args, { cwd: root, encoding: binary ? null : 'utf8' });
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function writeRepositoryFile(root, path, value) {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeReviewSources(root) {
  const sources = new Set(
    Object.values(REVIEW_ROLE_POLICY).flatMap(({ source_paths: sourcePaths }) => sourcePaths),
  );
  for (const path of sources) {
    if (!existsSync(join(root, path))) writeRepositoryFile(root, path, `fixture source: ${path}\n`);
  }
}

function initializeRepository(root) {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Fixture']);
  git(root, ['config', 'user.email', 'd0@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeRepositoryFile(
    root,
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    '# fixture design\n',
  );
  writeRepositoryFile(root, 'tools/quality/format-scope.json', '{}\n');
  writeRepositoryFile(root, '.prettierrc', '{}\n');
  writeRepositoryFile(root, 'package.json', '{"private":true}\n');
  writeRuntimeFixture(root);
  writeRepositoryFile(root, `${relativePlan}/BASELINE.md`, 'baseline\n');
}

function targetManifest(root, baseSha) {
  return {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-verification-target',
    program_instance: 'new-aria-autonomous-engineering:D0:2026-09-01',
    repository_slug: 'Okan-wqm/aquaculture_platform',
    base_ref: 'refs/remotes/origin/main',
    base_sha: baseSha,
    base_tree: git(root, ['rev-parse', `${baseSha}^{tree}`]).trim(),
    reviewed_ref: reviewedRef,
    head_policy: 'CHECKOUT_EXACT',
    scope_policy: 'D0_PLAN_ONLY',
  };
}

function provenanceMetadata(repositoryRoot, records) {
  return {
    schema_version: '2.0.0',
    kind: 'metadata',
    verifier_version: '2.0.0',
    claim: 'verifier input provenance; not an admission record',
    recorded_at_utc: new Date().toISOString(),
    verifier_script: `${relativePlan}/verification/verify-d0.mjs`,
    required_flags: [
      '--repo-root',
      '--mode',
      '--base',
      '--head',
      '--reviewed-ref',
      '--base-tree',
      '--head-tree',
      '--diff-sha256',
      '--design-sha256',
      '--format-scope-sha256',
    ],
    cwd_contract: 'repository root',
    runtime: runtimeProvenance(repositoryRoot),
    input_bundle_algorithm: 'sha256(path + NUL + sha256 + LF, lexicographic path order)',
    input_bundle_sha256: bundleDigest(records),
  };
}

function writeProvenance(repositoryRoot, planRoot) {
  const records = expectedPaths(planRoot).map((path) => ({
    schema_version: '2.0.0',
    kind: 'input',
    path,
    sha256: sha256File(resolve(planRoot, path)),
  }));
  const rows = [provenanceMetadata(repositoryRoot, records), ...records];
  const bytes = Buffer.from(`${rows.map(canonicalJson).join('\n')}\n`, 'utf8');
  writeFileSync(join(planRoot, 'verification/verifier-inputs.jsonl'), bytes);
  return bytes;
}

function declaredTarget(root, baseSha, headSha) {
  const object = (value) => git(root, ['rev-parse', '--verify', value]).trim();
  const diff = git(
    root,
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--find-copies',
      `${baseSha}..${headSha}`,
      '--',
    ],
    true,
  );
  return {
    base_sha: baseSha,
    base_tree: object(`${baseSha}^{tree}`),
    head_sha: headSha,
    head_tree: object(`${headSha}^{tree}`),
    reviewed_ref: reviewedRef,
    committed_diff_sha256: sha256(diff),
    design_sha256: sha256File(
      join(root, 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md'),
    ),
    format_scope_sha256: sha256File(join(root, 'tools/quality/format-scope.json')),
  };
}

function writeTargetAuthority(root, externalRoot, manifest, target) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { credential: { key_id: 'target-key-1' }, privateKey };
  const authorityRoot = join(externalRoot, 'target');
  const contextPath = join(authorityRoot, 'target-context.json');
  const trustRootPath = join(authorityRoot, 'trust-root.json');
  const manifestBytes = readFileSync(join(root, relativePlan, 'verification/target-manifest.json'));
  const authorityTarget = { ...target, ...runtimeTools(root) };
  const payload = {
    contract_id: 'new-aria-d0-target-authority-v1',
    manifest_sha256: sha256(manifestBytes),
    manifest,
    operator_principal_id: 'target-operator',
    target: authorityTarget,
  };
  const trustRootBytes = Buffer.from(
    `${JSON.stringify({
      schema_version: '1.0.0',
      kind: 'new-aria-external-trust-root',
      algorithm: 'Ed25519',
      key_id: signer.credential.key_id,
      principal_id: payload.operator_principal_id,
      capabilities: ['d0-target-authority'],
      public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    })}\n`,
    'utf8',
  );
  mkdirSync(authorityRoot, { recursive: true });
  const envelopeBytes = signedEnvelope('new-aria-d0-target-authority', payload, signer);
  writeFileSync(contextPath, envelopeBytes);
  writeFileSync(trustRootPath, trustRootBytes);
  return {
    envelopeBytes,
    target: authorityTarget,
    options: {
      targetAuthorityRoot: authorityRoot,
      targetContextEnvelopePath: contextPath,
      targetTrustRootPath: trustRootPath,
      targetTrustRootSha256: sha256(trustRootBytes),
    },
  };
}

export function createTargetFixture(ownerRoot, policy) {
  const repositoryRoot = join(ownerRoot, 'repository');
  const externalRoot = join(ownerRoot, 'external');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(externalRoot, { recursive: true });
  initializeRepository(repositoryRoot);
  const baseSha = commit(repositoryRoot, 'test: establish dossier target base');
  git(repositoryRoot, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  const manifest = targetManifest(repositoryRoot, baseSha);
  writeRepositoryFile(repositoryRoot, `${relativePlan}/D0-candidate.md`, 'candidate\n');
  writeRepositoryFile(
    repositoryRoot,
    `${relativePlan}/verification/review-policy.json`,
    `${JSON.stringify(policy)}\n`,
  );
  writeRepositoryFile(
    repositoryRoot,
    `${relativePlan}/verification/target-manifest.json`,
    `${JSON.stringify(manifest)}\n`,
  );
  writeReviewSources(repositoryRoot);
  const planRoot = join(repositoryRoot, relativePlan);
  const provenanceBytes = writeProvenance(repositoryRoot, planRoot);
  const headSha = commit(repositoryRoot, 'test: establish reviewed dossier target');
  git(repositoryRoot, ['update-ref', reviewedRef, headSha]);
  const signedTarget = declaredTarget(repositoryRoot, baseSha, headSha);
  const authority = writeTargetAuthority(repositoryRoot, externalRoot, manifest, signedTarget);
  return {
    repositoryRoot,
    externalRoot,
    gitTool: authority.target.git_tool,
    provenanceBytes,
    targetEnvelopeBytes: authority.envelopeBytes,
    targetOptions: authority.options,
    reviewedTarget: {
      ...signedTarget,
      authority_bundle_sha256: sha256(authority.envelopeBytes),
      verifier_inputs_sha256: sha256(provenanceBytes),
      input_bundle_sha256: provenanceMetadata(
        repositoryRoot,
        expectedPaths(planRoot).map((path) => ({
          path,
          sha256: sha256File(resolve(planRoot, path)),
        })),
      ).input_bundle_sha256,
      target_operator_principal_id: 'target-operator',
    },
  };
}
