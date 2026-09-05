import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ServerConfig } from './config.ts';

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalPath(dirname(absolute)), basename(absolute));
}

/** Permanent adjacent lock inodes; never unlink these while an installation exists. */
export class InstallationLock {
  private closed = false;
  private readonly descriptors: ReadonlyArray<{ fd: number; path: string }>;
  private readonly identities: ReadonlySet<string>;

  static acquire(paths: ReadonlyArray<string>): InstallationLock {
    if (process.platform !== 'linux') throw new Error('installation locking requires Linux flock');
    const identities = new Set(paths.map(canonicalPath));
    if (identities.size === 0) throw new Error('installation storage identity required');
    const descriptors: { fd: number; path: string }[] = [];
    try {
      for (const identity of [...identities].sort()) {
        const path = `${identity}.writer.lock`;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        descriptors.push({ fd, path });
        const result = spawnSync('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
        if (result.error !== undefined || result.status !== 0) {
          throw new Error(result.status === 1 ? 'installation writer already active' : 'installation locking unavailable');
        }
      }
      return new InstallationLock(descriptors, identities);
    } catch (error) {
      for (const { fd } of descriptors) closeSync(fd);
      throw error;
    }
  }

  private constructor(descriptors: ReadonlyArray<{ fd: number; path: string }>, identities: ReadonlySet<string>) {
    this.descriptors = descriptors;
    this.identities = identities;
  }

  assertOwns(path: string): void {
    if (this.closed || !this.identities.has(canonicalPath(path))) throw new Error('active installation writer lock required');
    for (const descriptor of this.descriptors) {
      const held = fstatSync(descriptor.fd);
      const named = statSync(descriptor.path);
      if (held.dev !== named.dev || held.ino !== named.ino) throw new Error('installation lock inode changed');
    }
  }

  childFileDescriptors(): ReadonlyArray<number> {
    if (this.closed) throw new Error('active installation writer lock required');
    for (const identity of this.identities) this.assertOwns(identity);
    return this.descriptors.map(({ fd }) => fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { fd } of this.descriptors) closeSync(fd);
  }
}

/** Linux flock locks the inherited open-file description, retained by this process. */
export function acquireInstallationLock(paths: ReadonlyArray<string>): InstallationLock {
  return InstallationLock.acquire(paths);
}

export function installationStoragePaths(config: ServerConfig): ReadonlyArray<string> {
  return [config.toolsDir, config.workspaceBase, config.legalCasesDir, config.ledgerKeyFile, ...(config.principalsFile === null ? [] : [config.principalsFile])];
}
