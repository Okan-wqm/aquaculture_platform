import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { cliPath } from './cli-invocation-fixture';
import {
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';

const temporaryRoots: string[] = [];
const wrongExternalPin = '0'.repeat(64);

function write(root: string, name: string, bytes: Uint8Array): string {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

function publicAuthority(root: string): { readonly envelope: string; readonly trustRoot: string } {
  const authorityBytes = s01ProgressAuthorityBytes();
  return {
    envelope: write(root, 'operator-envelope.json', operatorEnvelopeBytes({ authorityBytes })),
    trustRoot: write(root, 'operator-root.json', operatorTrustRootBytes()),
  };
}

function inaccessibleResources(root: string): string {
  const path = join(root, 'must-not-be-read');
  execFileSync('mkfifo', [path]);
  return path;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('CLI pre-authorization boundary', () => {
  it.each(['run-verifier', 'admit-completion'] as const)(
    'does not read private resources or publish output before %s authority succeeds',
    (command) => {
      const root = mkdtempSync(join(tmpdir(), 'new-aria-preauth-'));
      temporaryRoots.push(root);
      const authority = publicAuthority(root);
      const blocked = inaccessibleResources(root);
      const requestPath = join(root, 'request.json');
      const outputPath = join(root, 'output');
      const completionBundlePath = join(root, 'completion-bundle');
      const common = {
        git_path: blocked,
        git_sha256: '1'.repeat(64),
        operator_envelope_path: authority.envelope,
        operator_trust_root_path: authority.trustRoot,
        schema_version: '1.0.0',
        target_request_path: blocked,
      };
      const descriptor =
        command === 'run-verifier'
          ? {
              ...common,
              args: ['--mode', 'full'],
              contract_id: 'new-aria-verifier-invocation-v2',
              evidence_trust_root_path: blocked,
              execution_private_key_path: blocked,
              execution_trust_root_path: blocked,
              runs: Array.from({ length: 5 }, (_, index) => ({
                input_envelope_path: blocked,
                run_context_sha256: '2'.repeat(64),
                run_id: index === 0 ? 'BASELINE' : `NC-${index.toString()}`,
              })),
              runtime_sha256: '3'.repeat(64),
              tool_id: 'new-aria-admission-verifier',
              tool_path: blocked,
              tool_sha256: '4'.repeat(64),
            }
          : {
              ...common,
              contract_id: 'new-aria-completion-admission-request-v1',
              event_chain_path: blocked,
              event_policy_path: blocked,
              evidence_attestation_path: blocked,
              evidence_trust_root_path: blocked,
              execution_trust_root_path: blocked,
              freshness_policy_path: blocked,
              manifest_paths: [blocked],
              objects: [{ path: blocked, uri: `aria-evidence://sha256/${'5'.repeat(64)}` }],
            };
      writeFileSync(requestPath, canonicalJsonBytes(descriptor));
      const terminalFlag = command === 'run-verifier' ? '--bundle' : '--output';
      const completionArgs =
        command === 'admit-completion' ? ['--bundle', completionBundlePath] : [];
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          command,
          '--request',
          requestPath,
          '--operator-trust-root-sha256',
          wrongExternalPin,
          '--current-epoch-root',
          blocked,
          terminalFlag,
          outputPath,
          ...completionArgs,
        ],
        { encoding: 'utf8', timeout: 3_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('new-aria-admission: COMMAND_FAILED\n');
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(completionBundlePath)).toBe(false);
    },
  );
});
