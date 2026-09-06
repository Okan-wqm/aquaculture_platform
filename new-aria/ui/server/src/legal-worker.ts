// Case workers receive only a copied archive, immutable code, and job-local output.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';

export interface LegalWorkerRequest {
  readonly caseId: string;
  readonly runKey: string;
  readonly snapshotDir: string;
  readonly toolsDir: string;
  readonly inputFile: string;
  readonly runtimeProfileFile?: string;
}
export type LegalWorker = (request: LegalWorkerRequest) => Promise<void>;
const OUTPUT_LIMIT = 16 * 1024 * 1024;

async function systemMounts(): Promise<string[]> {
  const argv = ['--ro-bind', '/usr', '/usr'];
  for (const path of ['/bin', '/lib', '/lib64']) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) argv.push('--symlink', await realpath(path), path);
      else argv.push('--ro-bind', path, path);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  try { await access('/opt/venv', constants.R_OK); argv.push('--ro-bind', '/opt/venv', '/opt/venv'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  return argv;
}

async function invoke(argv: ReadonlyArray<string>, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('/usr/bin/bwrap', [...argv], { env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;
    const stop = (): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = 'legal_worker_kill_failed'; }
    };
    const timer = setTimeout(() => { failure = 'legal_worker_timeout'; stop(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { failure = 'legal_worker_output_limit'; stop(); }
      else chunks.push(chunk);
    });
    // stderr is deliberately not returned to the case-facing job table.
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { failure = 'legal_worker_output_limit'; stop(); } });
    child.on('error', () => { clearTimeout(timer); reject(new HttpError(503, 'legal_worker_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure !== null || code !== 0) reject(new HttpError(503, failure ?? 'legal_worker_failed'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** A kernel registration and run in fresh namespaces; no direct-spawn fallback. */
export async function runLegalWorker(config: ServerConfig, request: LegalWorkerRequest): Promise<void> {
  if (config.workspaceRoot === null) throw new HttpError(409, 'workspace_root_not_configured');
  const root = config.workspaceRoot;
  await mkdir(request.toolsDir, { recursive: true, mode: 0o700 });
  const base = [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    ...await systemMounts(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/work', '--dir', '/runtime',
    '--ro-bind', config.kernelBin, '/runtime/bin/aria',
    '--ro-bind', join(root, 'aria-kernel'), '/runtime/aria-kernel',
    '--ro-bind', join(root, 'tools/shared'), '/runtime/tools/shared',
    '--ro-bind', join(root, 'packs/legal'), '/work/packs/legal',
    '--ro-bind', join(root, 'tools/gates/tsconfig.json'), '/work/tools/gates/tsconfig.json',
    // Keep dependencies outside the observed workspace. The kernel's non-git
    // source walker does not traverse directory symlinks; Node resolves them.
    '--ro-bind', await realpath(join(root, 'node_modules')), '/runtime/node_modules',
    '--symlink', '/runtime/node_modules', '/work/node_modules',
    '--ro-bind', request.snapshotDir, `/work/data/legal-cases/${request.caseId}/archive`,
    '--ro-bind', request.inputFile, '/input.json', '--bind', request.toolsDir, '/output',
    ...(request.runtimeProfileFile === undefined ? [] : ['--ro-bind', request.runtimeProfileFile, '/output/runtime-profile.json']),
    '--clearenv', '--setenv', 'PATH', '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LOGNAME', 'legal-worker',
    '--setenv', 'ARIA_HOME', '/runtime', '--setenv', 'ARIA_TOOLS_DIR', '/output',
    '--setenv', 'ARIA_ACTOR', '{"kind":"service","id":"legal-inventory-worker"}',
    '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--setenv', 'PYTHONUNBUFFERED', '1',
    '--chdir', '/work', '--', '/runtime/bin/aria',
  ];
  await invoke([...base, 'tool', 'register', '--tools-dir', '/output', '--file', '/work/packs/legal/adapters/legal-document-inventory.tool.json'], config.actionTimeoutMs);
  const output = await invoke([...base, 'tool', 'run', '--tools-dir', '/output', '--workspace-root', '/work', '--tool-id', 'legal-document-inventory', '--cycle-id', request.runKey, '--input-file', '/input.json'], config.actionTimeoutMs);
  await writeFile(join(request.toolsDir, 'kernel-result.json'), output, { flag: 'wx', mode: 0o600 });
}
