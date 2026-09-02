import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256, sha256File } from './lib/canonical.mjs';
import { observeGitTool } from './lib/hermetic-git.mjs';
import { observeRuntimeDependencies } from './lib/runtime-dependencies.mjs';

const manifestPath =
  'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/target-manifest.json';

export function git(root, args, binary = false) {
  return execFileSync('git', args, { cwd: root, encoding: binary ? null : 'utf8' });
}

export function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

export function declaredTarget(root, baseSha, headSha, reviewedRef = 'refs/remotes/origin/review') {
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
    baseSha,
    headSha,
    reviewedRef,
    baseTree: object(`${baseSha}^{tree}`),
    headTree: object(`${headSha}^{tree}`),
    diffSha256: sha256(diff),
    designSha256: sha256File(
      join(root, 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md'),
    ),
    formatScopeSha256: sha256File(join(root, 'tools/quality/format-scope.json')),
  };
}

export function targetManifest(root, baseSha, reviewedRef = 'refs/remotes/origin/review') {
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

export function writeManifest(root, manifest) {
  const path = join(root, manifestPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function nodeTool() {
  return {
    logical_name: 'node',
    version: process.version,
    executable_sha256: sha256File(realpathSync(process.execPath)),
    environment_policy: 'new-aria-hermetic-node-v1',
  };
}

export function runtimeTools(repositoryRoot) {
  return {
    git_tool: observeGitTool(),
    node_tool: nodeTool(),
    ...observeRuntimeDependencies(repositoryRoot),
  };
}

export function writeRuntimeFixture(repositoryRoot) {
  const packages = {};
  writeFileSync(join(repositoryRoot, '.gitignore'), 'node_modules/\n');
  for (const [index, name] of ['graphql', 'prettier', 'typescript'].entries()) {
    const version = `1.0.${index}`;
    const root = join(repositoryRoot, 'node_modules', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version })}\n`);
    writeFileSync(join(root, 'index.mjs'), `export const name = '${name}';\n`);
    packages[`node_modules/${name}`] = { name, version };
  }
  writeFileSync(
    join(repositoryRoot, 'package-lock.json'),
    `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages })}\n`,
  );
}

function trustRoot(keys) {
  return {
    schema_version: '1.0.0',
    kind: 'new-aria-external-trust-root',
    algorithm: 'Ed25519',
    key_id: 'operator-test-key',
    principal_id: 'target-operator',
    capabilities: ['d0-target-authority'],
    public_key_spki_base64: keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
  };
}

function authorityTarget(root, manifest, mutateTarget) {
  const target = declaredTarget(
    root,
    manifest.base_sha,
    git(root, ['rev-parse', 'HEAD']).trim(),
    manifest.reviewed_ref,
  );
  const signed = {
    base_sha: target.baseSha,
    base_tree: target.baseTree,
    head_sha: target.headSha,
    head_tree: target.headTree,
    reviewed_ref: target.reviewedRef,
    committed_diff_sha256: target.diffSha256,
    design_sha256: target.designSha256,
    format_scope_sha256: target.formatScopeSha256,
    ...runtimeTools(root),
  };
  mutateTarget(signed);
  return signed;
}

function signedAuthority(payload, root, keys) {
  return {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-target-authority',
    algorithm: 'Ed25519',
    key_id: root.key_id,
    payload,
    signature_base64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey).toString(
      'base64',
    ),
  };
}

export function writeAuthority(root, operatorRoot, manifest, mutateTarget = () => {}) {
  const keys = generateKeyPairSync('ed25519');
  const authorityRoot = trustRoot(keys);
  const payload = {
    contract_id: 'new-aria-d0-target-authority-v1',
    manifest_sha256: sha256File(writeManifest(root, manifest)),
    manifest,
    operator_principal_id: authorityRoot.principal_id,
    target: authorityTarget(root, manifest, mutateTarget),
  };
  const envelope = signedAuthority(payload, authorityRoot, keys);
  const contextPath = join(operatorRoot, 'target-context.json');
  const trustRootPath = join(operatorRoot, 'trust-root.json');
  const trustRootBytes = Buffer.from(`${JSON.stringify(authorityRoot, null, 2)}\n`);
  mkdirSync(operatorRoot, { recursive: true });
  writeFileSync(contextPath, `${JSON.stringify(envelope, null, 2)}\n`);
  writeFileSync(trustRootPath, trustRootBytes);
  return {
    authorityRoot: operatorRoot,
    contextPath,
    trustRootPath,
    trustRootSha256: sha256(trustRootBytes),
  };
}
