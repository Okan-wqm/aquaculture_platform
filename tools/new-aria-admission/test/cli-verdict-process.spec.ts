import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseStrictJson } from '../src/kernel/strict-json';
import { verifyExecutionReceipt } from '../src/kernel/execution-trust-root';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { loadOracleBaselineDocument } from '../src/kernel/oracle-baseline';
import { validateExecutionInputEnvelope } from '../src/runtime/execution-input-envelope';
import {
  cliPath,
  createCliInvocationFixture,
  operatorRootPin,
  record,
} from './cli-invocation-fixture';
import { bundleVerifierFixture, tamperAndRepinBundle } from './executable-run-bundle-fixture';
import type { BundleArtifactKind } from './executable-run-bundle-fixture';
import { runGit } from './git-target-fixture';

const temporaryRoots: string[] = [];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function stringField(value: ReturnType<typeof record>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new TypeError(`${key} must be a string`);
  return field;
}

function verifyPublishedArtifacts(bundlePath: string, marker: ReturnType<typeof record>): void {
  if (!Array.isArray(marker.runs) || marker.runs.length !== 5) {
    throw new TypeError('run bundle marker roster is invalid');
  }
  for (const runValue of marker.runs) {
    const run = record(runValue, 'run bundle entry');
    if (!Array.isArray(run.files) || run.files.length !== 5) {
      throw new TypeError('run bundle artifact roster is invalid');
    }
    for (const artifactValue of run.files) {
      const artifact = record(artifactValue, 'run bundle artifact');
      const bytes = readFileSync(join(bundlePath, stringField(artifact, 'path')));
      expect(bytes.byteLength).toBe(artifact.byte_length);
      expect(digest(bytes)).toBe(artifact.sha256);
    }
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('executable CLI session evidence', () => {
  it('runs and atomically publishes baseline plus four signed negative controls', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-cli-'));
    temporaryRoots.push(root);
    const bundlePath = join(root, 'run-bundle');
    const fixture = createCliInvocationFixture(root, temporaryRoots);
    const operatorPin = operatorRootPin(fixture.request_path);
    const descriptor = record(
      parseStrictJson(readFileSync(fixture.request_path)),
      'verifier invocation',
    );
    const operatorRootBytes = readFileSync(stringField(descriptor, 'operator_trust_root_path'));
    const operatorEnvelopeBytes = readFileSync(stringField(descriptor, 'operator_envelope_path'));
    const executionRootBytes = readFileSync(stringField(descriptor, 'execution_trust_root_path'));
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes,
      trust_root_bytes: operatorRootBytes,
      expected_trust_root_sha256: operatorPin,
    });
    const runArgs = [
      cliPath,
      'run-verifier',
      '--request',
      fixture.request_path,
      '--operator-trust-root-sha256',
      operatorPin,
      '--current-epoch-root',
      fixture.current_epoch_root,
      '--bundle',
      bundlePath,
    ];
    const result = spawnSync(process.execPath, runArgs, { encoding: 'utf8', timeout: 900_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"execution_verdict":"PASSED"}\n');
    expect(result.stderr).toBe('');
    const marker = record(
      parseStrictJson(readFileSync(join(bundlePath, 'COMPLETE.json'))),
      'run bundle marker',
    );
    expect(marker).toMatchObject({
      contract_id: 'new-aria-execution-session-bundle-v1',
      execution_verdict: 'PASSED',
    });
    const files = readdirSync(join(bundlePath, 'payload')).sort();
    expect(files).toHaveLength(25);
    expect(files.filter((name) => name.endsWith('-receipt.json'))).toHaveLength(5);
    expect(files.filter((name) => name.endsWith('-input-envelope.json'))).toHaveLength(5);
    expect(files.filter((name) => name.endsWith('-stderr.bin'))).toHaveLength(5);
    verifyPublishedArtifacts(bundlePath, marker);
    const verifier = bundleVerifierFixture(
      fixture,
      authority,
      operatorEnvelopeBytes,
      operatorRootBytes,
      operatorPin,
      executionRootBytes,
    );
    try {
      expect(() => verifier.verify(bundlePath)).not.toThrow();
      renameSync(join(bundlePath, 'COMPLETE.json'), join(bundlePath, 'CANDIDATE.json'));
      unlinkSync(stringField(descriptor, 'execution_private_key_path'));
      for (let index = 0; index < 5; index += 1) {
        unlinkSync(join(root, `input-${index.toString()}.json`));
      }
      for (const expectedMarker of ['CANDIDATE.json', 'COMPLETE.json']) {
        expect(readFileSync(join(bundlePath, expectedMarker))).toBeDefined();
        const recovered = spawnSync(process.execPath, runArgs, {
          encoding: 'utf8',
          timeout: 900_000,
        });
        expect(recovered.status).toBe(0);
        expect(recovered.stdout).toBe('{"execution_verdict":"PASSED"}\n');
        expect(recovered.stderr).toBe('');
      }
      unlinkSync(fixture.request_path);
      for (let index = 0; index < 5; index += 1) {
        const prefix = `run-${index.toString().padStart(2, '0')}`;
        const input = validateExecutionInputEnvelope(
          readFileSync(join(bundlePath, 'payload', `${prefix}-input-envelope.json`)),
        );
        const baseline = loadOracleBaselineDocument(input.object_bytes[0] ?? Buffer.alloc(0));
        const runId =
          index === 0
            ? 'BASELINE'
            : authority.authority.document.required_negative_control_ids[index - 1];
        if (runId === undefined) throw new TypeError('expected run identifier is absent');
        expect(input.object_count).toBe(index === 0 ? 4 : 6);
        expect(() =>
          verifyExecutionReceipt({
            receipt_bytes: readFileSync(join(bundlePath, 'payload', `${prefix}-receipt.json`)),
            trust_root_bytes: executionRootBytes,
            authority,
            expected_run_id: runId,
            expected_run_context_sha256: baseline.run_context_sha256,
          }),
        ).not.toThrow();
      }
      expect(() => verifier.verify(bundlePath)).not.toThrow();
      const verification = spawnSync(
        process.execPath,
        [
          cliPath,
          'verify-bundle',
          '--request',
          fixture.bundle_verification_request_path,
          '--operator-trust-root-sha256',
          operatorPin,
          '--current-epoch-root',
          fixture.current_epoch_root,
          '--bundle',
          bundlePath,
        ],
        { encoding: 'utf8', timeout: 900_000 },
      );
      expect(verification.status).toBe(0);
      expect(verification.stdout).toBe('{"execution_verdict":"PASSED"}\n');
      expect(verification.stderr).toBe('');
      for (const kind of [
        'evidence',
        'input',
        'stdout',
        'stderr',
      ] as const satisfies readonly BundleArtifactKind[]) {
        const tamperedPath = join(root, `tampered-${kind}`);
        tamperAndRepinBundle(bundlePath, tamperedPath, kind);
        expect(() => verifier.verify(tamperedPath)).toThrow();
      }
      verifier.advance_epoch();
      writeFileSync(join(fixture.repository.root, 'reviewed.txt'), 'newer head\n');
      runGit(fixture.repository.root, 'commit', '--quiet', '-am', 'newer head');
      runGit(
        fixture.repository.root,
        'update-ref',
        fixture.repository.reviewed_ref,
        runGit(fixture.repository.root, 'rev-parse', 'HEAD'),
      );
      expect(() => verifier.verify(bundlePath)).toThrow(/changed after verification/);
      const historical = spawnSync(
        process.execPath,
        [
          cliPath,
          'verify-bundle-history',
          '--request',
          fixture.bundle_verification_request_path,
          '--operator-trust-root-sha256',
          operatorPin,
          '--bundle',
          bundlePath,
        ],
        { encoding: 'utf8', timeout: 900_000 },
      );
      expect(historical.status).toBe(0);
      expect(historical.stdout).toBe(
        '{"current":false,"historical_verdict":"HISTORICALLY_VALID"}\n',
      );
      expect(historical.stderr).toBe('');
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(authority.valid_until) + 1);
      expect(verifier.verify_historical(bundlePath)).toMatchObject({
        current: false,
        historical_verdict: 'HISTORICALLY_VALID',
      });
      clock.mockRestore();
    } finally {
      verifier.close();
    }
  });
});
