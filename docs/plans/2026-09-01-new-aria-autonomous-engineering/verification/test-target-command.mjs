#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
const manifestPath = `${planPath}/verification/target-manifest.json`;
const designPath = 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
const formatScopePath = 'tools/quality/format-scope.json';
const reviewedRef = 'refs/remotes/origin/docs/new-aria-autonomous-engineering-plan';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    env: options.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function git(root, args, encoding = 'utf8') {
  const result = run('git', args, { cwd: root, encoding });
  requireSuccess(result, `git ${args.join(' ')}`);
  return result.stdout;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function copyCandidate(cloneRoot) {
  const destination = join(cloneRoot, planPath);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(sourceRoot, planPath), destination, { recursive: true });
  for (const path of [designPath, formatScopePath]) {
    mkdirSync(dirname(join(cloneRoot, path)), { recursive: true });
    cpSync(join(sourceRoot, path), join(cloneRoot, path));
  }
}

function prepareCandidate(cloneRoot) {
  copyCandidate(cloneRoot);
  git(cloneRoot, ['add', planPath, designPath]);
  const commands = [
    [`${planPath}/verification/render-api-contract.mjs`, '--repo-root', '.'],
    [`${planPath}/verification/render-projections.mjs`, '--repo-root', '.'],
  ];
  for (const args of commands) {
    requireSuccess(run(process.execPath, args, { cwd: cloneRoot }), `node ${args[0]}`);
  }
  git(cloneRoot, ['add', planPath]);
  const format = ['tools/quality/quality.mjs', 'format-scope', 'generate'];
  requireSuccess(run(process.execPath, format, { cwd: cloneRoot }), 'format-scope generation');
  git(cloneRoot, ['add', formatScopePath]);
  const provenance = [
    `${planPath}/verification/record-verifier-inputs.mjs`,
    '--repo-root',
    '.',
    '--observed-at',
    '2026-09-02T00:00:00Z',
  ];
  requireSuccess(run(process.execPath, provenance, { cwd: cloneRoot }), 'provenance generation');
  git(cloneRoot, ['add', planPath, designPath, formatScopePath]);
  git(cloneRoot, ['commit', '-m', 'test: materialize exact D0 candidate']);
  const headSha = git(cloneRoot, ['rev-parse', 'HEAD']).trim();
  git(cloneRoot, ['update-ref', reviewedRef, headSha]);
  return headSha;
}

function exactTarget(cloneRoot, manifest, headSha) {
  const resolve = (value) => git(cloneRoot, ['rev-parse', '--verify', value]).trim();
  const diff = git(
    cloneRoot,
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--find-copies',
      `${manifest.base_sha}..${headSha}`,
      '--',
    ],
    null,
  );
  return {
    base_sha: manifest.base_sha,
    base_tree: resolve(`${manifest.base_sha}^{tree}`),
    head_sha: headSha,
    head_tree: resolve(`${headSha}^{tree}`),
    reviewed_ref: reviewedRef,
    committed_diff_sha256: sha256(diff),
    design_sha256: sha256File(
      join(
        cloneRoot,
        'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
      ),
    ),
    format_scope_sha256: sha256File(join(cloneRoot, 'tools/quality/format-scope.json')),
  };
}

function signedTarget(cloneRoot, operatorRoot, headSha) {
  const manifestBytes = readFileSync(join(cloneRoot, manifestPath));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const keys = generateKeyPairSync('ed25519');
  const trustRoot = {
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
  const payload = {
    contract_id: 'new-aria-d0-target-authority-v1',
    manifest,
    manifest_sha256: sha256(manifestBytes),
    operator_principal_id: trustRoot.principal_id,
    target: exactTarget(cloneRoot, manifest, headSha),
  };
  const envelope = {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-target-authority',
    algorithm: 'Ed25519',
    key_id: trustRoot.key_id,
    payload,
    signature_base64: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString(
      'base64',
    ),
  };
  mkdirSync(operatorRoot, { recursive: true });
  const trustRootBytes = Buffer.from(`${JSON.stringify(trustRoot, null, 2)}\n`);
  writeFileSync(
    join(operatorRoot, 'target-context.json'),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  writeFileSync(join(operatorRoot, 'trust-root.json'), trustRootBytes);
  return sha256(trustRootBytes);
}

function canonicalCommand(cloneRoot, script = 'verify-d0.mjs') {
  const evidence = readFileSync(
    join(cloneRoot, planPath, 'authority/verification-evidence.md'),
    'utf8',
  );
  const block = evidence.match(/Fresh clone canonical argv:\n\n```text\n(?<body>[\s\S]*?)```/u);
  assert(block?.groups?.body, 'canonical argv block is missing');
  const commands = block.groups.body
    .trim()
    .split('\n')
    .filter((line) => line.includes(`/verification/${script}`));
  assert.equal(commands.length, 1, `exactly one canonical ${script} command is required`);
  const argv = commands[0].trim().split(/\s+/u);
  assert(
    argv.every((value) => !/[<>]/u.test(value)),
    'canonical argv contains a placeholder',
  );
  return argv;
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-d0-command-'));
const cloneRoot = join(ownerRoot, 'repository');
try {
  requireSuccess(
    run('git', ['clone', '--shared', sourceRoot, cloneRoot], { cwd: ownerRoot }),
    'fresh git clone',
  );
  symlinkSync(join(sourceRoot, 'node_modules'), join(cloneRoot, 'node_modules'), 'dir');
  git(cloneRoot, ['config', 'user.name', 'D0 Command Test']);
  git(cloneRoot, ['config', 'user.email', 'd0-command@example.invalid']);
  git(cloneRoot, ['config', 'commit.gpgsign', 'false']);
  const baseSha = JSON.parse(readFileSync(join(sourceRoot, manifestPath), 'utf8')).base_sha;
  git(cloneRoot, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  const headSha = prepareCandidate(cloneRoot);
  const trustRootSha256 = signedTarget(cloneRoot, join(ownerRoot, 'operator-input'), headSha);
  const argv = canonicalCommand(cloneRoot);
  const authorityEnv = { ...process.env, ARIA_D0_TRUST_ROOT_SHA256: trustRootSha256 };
  const accepted = run(argv[0], argv.slice(1), { cwd: cloneRoot, env: authorityEnv });
  requireSuccess(accepted, 'documented canonical command');
  assert.match(accepted.stdout, /PASS D0 verifier/u);
  const negativeArgv = canonicalCommand(cloneRoot, 'test-negative-controls.mjs');
  const negative = run(negativeArgv[0], negativeArgv.slice(1), {
    cwd: cloneRoot,
    env: authorityEnv,
  });
  requireSuccess(negative, 'documented negative-control command');
  assert.match(negative.stdout, /PASS negative-controls=/u);

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARIA_D0_TARGET_CONTEXT;
  delete cleanEnv.ARIA_D0_TRUST_ROOT;
  delete cleanEnv.ARIA_D0_AUTHORITY_ROOT;
  delete cleanEnv.ARIA_D0_TRUST_ROOT_SHA256;
  const nodeIndex = argv.indexOf('node');
  assert(nodeIndex > 0, 'canonical command must invoke node after explicit environment settings');
  const withoutEnv = argv.slice(nodeIndex);
  const missingAuthority = run(withoutEnv[0], withoutEnv.slice(1), {
    cwd: cloneRoot,
    env: cleanEnv,
  });
  assert.notEqual(missingAuthority.status, 0, 'missing authority environment was accepted');
  assert.match(missingAuthority.stderr, /TARGET_MANIFEST.*authority root/u);

  git(cloneRoot, ['commit', '--allow-empty', '-m', 'test: advance candidate after signature']);
  git(cloneRoot, ['update-ref', reviewedRef, git(cloneRoot, ['rev-parse', 'HEAD']).trim()]);
  const staleSignature = run(argv[0], argv.slice(1), { cwd: cloneRoot, env: authorityEnv });
  assert.notEqual(staleSignature.status, 0, 'old signature accepted a different exact head commit');
  assert.match(staleSignature.stderr, /TARGET_HEAD|TARGET_REF/u);
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS target-command fresh-clone=exit0 exact-head=signature-bound\n');
