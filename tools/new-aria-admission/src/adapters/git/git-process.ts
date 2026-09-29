import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import {
  assertVerifiedExecutableSource,
  VerifiedExecutableSource,
} from '../../runtime/verified-executable';

export interface GitCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitBinaryCommandResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface GitProcessOptions {
  readonly input?: Uint8Array;
  readonly max_output_bytes?: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const processStates = new WeakMap<GitProcess, VerifiedExecutableSource>();

export class GitProcess {
  constructor(executable: VerifiedExecutableSource) {
    assertVerifiedExecutableSource(executable);
    processStates.set(this, executable);
    Object.freeze(this);
  }

  runBytes(
    repositoryRoot: string,
    args: readonly string[],
    options: GitProcessOptions = {},
  ): GitBinaryCommandResult {
    const maxOutputBytes = options.max_output_bytes ?? 72 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > 272 * 1024 * 1024
    ) {
      throw new TypeError('Git process output bound is invalid');
    }
    const input = options.input === undefined ? undefined : Buffer.from(options.input);
    const executable = processStates.get(this);
    if (executable === undefined) throw new TypeError('Git process capability is not authentic');
    const snapshot = executable.materialize();
    let primaryError: unknown;
    let commandResult: GitBinaryCommandResult | undefined;
    try {
      snapshot.verify();
      const result = spawnSync(
        snapshot.executable_path,
        [
          '--no-optional-locks',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.commitGraph=false',
          '-c',
          'credential.helper=',
          '-c',
          'core.attributesFile=/dev/null',
          '-C',
          repositoryRoot,
          ...args,
        ],
        {
          cwd: repositoryRoot,
          env: {
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_OPTIONAL_LOCKS: '0',
            LANG: 'C',
            LC_ALL: 'C',
            PATH: dirname(snapshot.executable_path),
          },
          input,
          maxBuffer: maxOutputBytes,
          shell: false,
          timeout: 10_000,
        },
      );
      if (result.error !== undefined) {
        throw new TypeError('Git process launch failed');
      }
      if (result.signal !== null) throw new TypeError('Git process was terminated by a signal');
      if (result.status === null) throw new TypeError('Git process did not report an exit code');
      if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) {
        throw new TypeError('Git process streams were not captured as bytes');
      }
      snapshot.verify();
      commandResult = { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        snapshot.dispose();
      } catch {
        if (primaryError === undefined) {
          primaryError = new TypeError('private Git executable cleanup failed');
        }
      }
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof Error) throw primaryError;
      throw new TypeError('Git process failed with a non-error value');
    }
    if (commandResult === undefined) throw new TypeError('Git process produced no result');
    return commandResult;
  }

  run(repositoryRoot: string, args: readonly string[]): GitCommandResult {
    const result = this.runBytes(repositoryRoot, args);
    return {
      status: result.status,
      stdout: utf8.decode(result.stdout),
      stderr: utf8.decode(result.stderr),
    };
  }
}

Object.freeze(GitProcess.prototype);
Object.freeze(GitProcess);
