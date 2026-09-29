import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

import type { PrivateExecutableSnapshot } from './verified-executable';
import { VerifiedExecutableSource } from './verified-executable';

export interface VerifierProcessRequest {
  readonly cwd: string;
  readonly tool_path: string;
  readonly tool_sha256: string;
  readonly runtime_sha256: string;
  readonly args: readonly string[];
  readonly input: Uint8Array;
}

export interface VerifierProcessObservation {
  readonly materialized_argv: readonly string[];
  readonly runtime_id: string;
  readonly runtime_version: string;
  readonly runtime_sha256: string;
  readonly tool_sha256: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly exit_code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function canonicalFile(path: string, label: string): string {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new TypeError(`${label} must be an absolute canonical path`);
  }
  const canonical = realpathSync(path);
  if (canonical !== path || !statSync(canonical).isFile()) {
    throw new TypeError(`${label} must identify a canonical regular file`);
  }
  return canonical;
}

function dispose(
  tool: PrivateExecutableSnapshot | undefined,
  runtime: PrivateExecutableSnapshot | undefined,
): void {
  let failed = false;
  try {
    tool?.dispose();
  } catch {
    failed = true;
  }
  try {
    runtime?.dispose();
  } catch {
    failed = true;
  }
  if (failed) throw new TypeError('private executable cleanup failed');
}

export function executeVerifierProcess(
  request: VerifierProcessRequest,
): VerifierProcessObservation {
  const toolSource = VerifiedExecutableSource.load(
    canonicalFile(request.tool_path, 'verifier tool'),
    request.tool_sha256,
    'verifier tool',
  );
  const runtimeSource = VerifiedExecutableSource.load(
    canonicalFile(process.execPath, 'Node runtime'),
    request.runtime_sha256,
    'runtime',
  );
  let runtimeSnapshot: PrivateExecutableSnapshot | undefined;
  let toolSnapshot: PrivateExecutableSnapshot | undefined;
  try {
    runtimeSnapshot = runtimeSource.materialize();
    toolSnapshot = toolSource.materialize();
    runtimeSnapshot.verify();
    toolSnapshot.verify();
    const startedAt = new Date(Date.now()).toISOString();
    const materializedArgv = Object.freeze([
      runtimeSnapshot.executable_path,
      toolSnapshot.executable_path,
      ...request.args,
    ]);
    const execution = spawnSync(
      materializedArgv[0] ?? '',
      materializedArgv.slice(1),
      {
        cwd: request.cwd,
        env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        input: Buffer.from(request.input),
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 30_000,
      },
    );
    const endedAt = new Date(Date.now()).toISOString();
    if (execution.error !== undefined) {
      throw new TypeError('verifier process launch failed');
    }
    if (execution.signal !== null) {
      throw new TypeError('verifier process was terminated by a signal');
    }
    if (
      execution.status === null ||
      !Buffer.isBuffer(execution.stdout) ||
      !Buffer.isBuffer(execution.stderr)
    ) {
      throw new TypeError('verifier process did not return exact captured bytes and exit code');
    }
    toolSnapshot.verify();
    runtimeSnapshot.verify();
    return Object.freeze({
      materialized_argv: materializedArgv,
      runtime_id: `node@${process.version}`,
      runtime_version: process.version,
      runtime_sha256: runtimeSource.sha256,
      tool_sha256: toolSource.sha256,
      started_at: startedAt,
      ended_at: endedAt,
      exit_code: execution.status,
      stdout: Buffer.from(execution.stdout),
      stderr: Buffer.from(execution.stderr),
    });
  } finally {
    dispose(toolSnapshot, runtimeSnapshot);
  }
}
