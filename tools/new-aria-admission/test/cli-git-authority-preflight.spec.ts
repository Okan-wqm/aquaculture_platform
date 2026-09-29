import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { parseStrictJson } from '../src/kernel/strict-json';

import {
  cliPath,
  createCliInvocationFixture,
  operatorRootPin,
  record,
} from './cli-invocation-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthority,
} from './operator-authority-fixture';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('CLI executable authority preflight', () => {
  it('does not execute a request-selected Git binary before signed binding checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-cli-git-preflight-'));
    temporaryRoots.push(root);
    const markerPath = join(root, 'UNAUTHORIZED-GIT-EXECUTED');
    const maliciousGit = join(root, 'malicious-git');
    writeFileSync(maliciousGit, `#!/bin/sh\nprintf hit > '${markerPath}'\nexit 1\n`);
    chmodSync(maliciousGit, 0o700);
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    const request = record(
      parseStrictJson(readFileSync(fixture.request_path)),
      'verifier invocation',
    );
    writeFileSync(
      fixture.request_path,
      canonicalJsonBytes({
        ...request,
        git_path: maliciousGit,
        git_sha256: digest(readFileSync(maliciousGit)),
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'run-verifier',
        '--request',
        fixture.request_path,
        '--operator-trust-root-sha256',
        operatorRootPin(fixture.request_path),
        '--current-epoch-root',
        fixture.current_epoch_root,
        '--bundle',
        join(root, 'bundle'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(() => readFileSync(markerPath)).toThrow();
  });

  it('does not execute completion Git bytes that differ from historical signed authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-completion-git-preflight-'));
    temporaryRoots.push(root);
    const markerPath = join(root, 'UNAUTHORIZED-COMPLETION-GIT');
    const maliciousGit = join(root, 'malicious-git');
    writeFileSync(maliciousGit, `#!/bin/sh\nprintf hit > '${markerPath}'\nexit 1\n`, {
      mode: 0o700,
    });
    const operatorRoot = operatorTrustRootBytes();
    const authorityDocument = s01ProgressAuthority();
    const operatorEnvelope = operatorEnvelopeBytes({
      authorityBytes: canonicalJsonBytes(authorityDocument),
    });
    const targetPath = join(root, 'target.json');
    writeFileSync(
      targetPath,
      canonicalJsonBytes({
        repository_id: authorityDocument.repository_id,
        workspace_id: authorityDocument.workspace_id,
        repository_root: join(root, 'missing-repository'),
        reviewed_ref: 'refs/remotes/origin/reviewed',
        base_sha: authorityDocument.base_sha,
        head_sha: authorityDocument.head_sha,
      }),
    );
    const envelopePath = join(root, 'operator-envelope.json');
    const rootPath = join(root, 'operator-root.json');
    writeFileSync(envelopePath, operatorEnvelope);
    writeFileSync(rootPath, operatorRoot);
    const missing = join(root, 'must-not-be-read');
    const requestPath = join(root, 'completion-request.json');
    const outputPath = join(root, 'projection.json');
    writeFileSync(
      requestPath,
      canonicalJsonBytes({
        schema_version: '1.0.0',
        contract_id: 'new-aria-completion-admission-request-v1',
        target_request_path: targetPath,
        git_path: maliciousGit,
        git_sha256: digest(readFileSync(maliciousGit)),
        operator_envelope_path: envelopePath,
        operator_trust_root_path: rootPath,
        evidence_trust_root_path: missing,
        execution_trust_root_path: missing,
        event_policy_path: missing,
        freshness_policy_path: missing,
        event_chain_path: missing,
        manifest_paths: [missing],
        objects: [{ path: missing, uri: `aria-evidence://sha256/${'5'.repeat(64)}` }],
        evidence_attestation_path: missing,
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'admit-completion',
        '--request',
        requestPath,
        '--operator-trust-root-sha256',
        digest(operatorRoot),
        '--current-epoch-root',
        missing,
        '--output',
        outputPath,
        '--bundle',
        join(root, 'completion-bundle'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });
});
