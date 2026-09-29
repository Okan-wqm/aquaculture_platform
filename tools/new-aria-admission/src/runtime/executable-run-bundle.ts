import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../kernel/canonical-json';

import { AtomicDirectoryPublication } from './atomic-directory-publication';
import { assertVerifiedExecutableRunBundle } from './executable-run-bundle-verifier';
import type { ExecutableRunResult } from './executable-run-result';
import { consumeFinalizedRepositoryExecutionRoster } from './repository-execution-session';

interface PublishedArtifact {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonLine = (value: unknown): Buffer =>
  Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);

function artifact(path: string, bytes: Uint8Array): PublishedArtifact {
  return { path: `payload/${path}`, byte_length: bytes.byteLength, sha256: digest(bytes) };
}

function validRoster(results: readonly ExecutableRunResult[]): boolean {
  if (results.length !== 5 || results[0]?.evidence.run_id !== 'BASELINE') return false;
  const identifiers = results.map((result) => result.evidence.run_id);
  if (new Set(identifiers).size !== identifiers.length) return false;
  return results.every((result, index) =>
    index === 0
      ? result.evidence.result.semantic_verdict === 'PASSED' &&
        result.evidence.result.final_exit_code === 0
      : result.evidence.result.semantic_verdict === 'FAILED' &&
        result.evidence.result.final_exit_code === 1,
  );
}

export class ExecutableRunBundlePublication {
  private readonly publication: AtomicDirectoryPublication;
  private released = false;
  private stagedMarkerSha256: string | undefined;

  constructor(bundlePath: string) {
    this.publication = new AtomicDirectoryPublication(bundlePath);
  }

  stageSession(roster: unknown): void {
    if (this.released) throw new TypeError('run bundle publication is closed');
    const snapshots = consumeFinalizedRepositoryExecutionRoster(roster);
    if (!validRoster(snapshots)) throw new TypeError('run bundle session roster is invalid');
    try {
      const runs = snapshots.map((snapshot, index) => {
        const prefix = `run-${index.toString().padStart(2, '0')}`;
        const evidenceName = `${prefix}-evidence.json`;
        const inputName = `${prefix}-input-envelope.json`;
        const stdoutName = `${prefix}-stdout.bin`;
        const stderrName = `${prefix}-stderr.bin`;
        const receiptName = `${prefix}-receipt.json`;
        const evidence = jsonLine(snapshot.evidence);
        this.publication.write(evidenceName, evidence);
        this.publication.write(inputName, snapshot.input_envelope);
        this.publication.write(stdoutName, snapshot.stdout);
        this.publication.write(stderrName, snapshot.stderr);
        this.publication.write(receiptName, snapshot.execution_receipt.bytes);
        return {
          run_id: snapshot.evidence.run_id,
          semantic_verdict: snapshot.evidence.result.semantic_verdict,
          final_exit_code: snapshot.evidence.result.final_exit_code,
          failure:
            snapshot.evidence.result.final_exit_code === 0
              ? null
              : {
                  code: 'EXPECTED_NEGATIVE_CONTROL_REJECTION',
                  stderr_sha256: snapshot.evidence.stderr.sha256,
                  stderr_byte_length: snapshot.evidence.stderr.byte_length,
                },
          files: [
            artifact(evidenceName, evidence),
            artifact(inputName, snapshot.input_envelope),
            artifact(stdoutName, snapshot.stdout),
            artifact(stderrName, snapshot.stderr),
            artifact(receiptName, snapshot.execution_receipt.bytes),
          ],
        };
      });
      this.publication.commitPayload();
      const marker = jsonLine({
        schema_version: '1.0.0',
        contract_id: 'new-aria-execution-session-bundle-v1',
        execution_verdict: 'PASSED',
        runs,
      });
      this.publication.stageCandidate(marker);
      this.stagedMarkerSha256 = digest(marker);
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  completeSession(verifiedBundle: unknown): void {
    if (this.released || this.stagedMarkerSha256 === undefined) {
      throw new TypeError('run bundle publication has no verified candidate');
    }
    assertVerifiedExecutableRunBundle(verifiedBundle);
    if (verifiedBundle.bundle_sha256 !== this.stagedMarkerSha256) {
      throw new TypeError('verified run bundle differs from staged candidate');
    }
    this.publication.completeCandidate();
    this.released = true;
  }

  abort(): void {
    if (this.released) return;
    try {
      this.publication.abort();
    } finally {
      this.released = true;
    }
  }
}

Object.freeze(ExecutableRunBundlePublication.prototype);
Object.freeze(ExecutableRunBundlePublication);
