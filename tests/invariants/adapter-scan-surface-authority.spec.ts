/**
 * PROGRAM H / H-1 — an adapter's scan surface is declared ONCE.
 *
 * Measured 2026-08-19. The same list of roots lived in three places:
 *
 *   manifest `declared_scope`        identity + read allowlist, hashed into
 *                                    parse_window_signature
 *   manifest `default_input.roots`   what actually runs — cycle.py:1099 reads
 *                                    it and hands it to the tool runner
 *   adapter `DEFAULT_ROOTS`          a fallback that never fired in production
 *
 * The third copy was the dangerous one precisely because it was dead in
 * production: it governed tests and standalone runs, so a manifest edit could
 * leave the fixtures validating a file set production never scans, with every
 * test still green. The three agreed on the day this was written. Nothing made
 * them agree.
 *
 * Worse, nothing ran those tests: `tools/aria-adapters/project.json` declared
 * only a `lint` target, so nine passing test files were invisible to every
 * gate. Both halves are pinned here — the single authority, and the runner
 * that makes the pin load-bearing.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'tools', 'aria-adapters');

function manifests(): { toolId: string; manifest: Record<string, unknown> }[] {
  return fs
    .readdirSync(ADAPTER_DIR)
    .filter((name) => name.endsWith('.tool.json'))
    .map((name) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, name), 'utf8')) as Record<
        string,
        unknown
      >;
      return { toolId: String(manifest.tool_id), manifest };
    });
}

/** The literal prefix of a glob, up to its first wildcard. */
function globPrefix(glob: string): string {
  const cut = glob.search(/[*{]/);
  return (cut < 0 ? glob : glob.slice(0, cut)).replace(/\/+$/, '');
}

describe('adapter scan surface has a single authority', () => {
  it('keeps no second copy of the roots inside the adapter source', () => {
    const offenders: string[] = [];
    for (const { toolId } of manifests()) {
      const source = path.join(ADAPTER_DIR, `${toolId}.ts`);
      if (!fs.existsSync(source)) continue;
      const body = fs.readFileSync(source, 'utf8');
      // A literal root list in the adapter can disagree with the manifest the
      // cycle actually passes, and only tests would ever read it.
      if (/const\s+DEFAULT_ROOTS\s*=/.test(body)) offenders.push(toolId);
    }
    expect(offenders).toEqual([]);
  });

  it('requires roots rather than substituting a private default', () => {
    for (const { toolId } of manifests()) {
      const source = path.join(ADAPTER_DIR, `${toolId}.ts`);
      if (!fs.existsSync(source)) continue;
      const body = fs.readFileSync(source, 'utf8');
      if (!body.includes('input.roots')) continue;
      // `input.roots ?? something` is the shape that hides a second surface.
      expect(body).not.toMatch(/input\.roots\s*\?\?/);
    }
  });

  it('declares every runtime root inside the declared scope', () => {
    for (const { toolId, manifest } of manifests()) {
      const scopePrefixes = ((manifest.declared_scope as string[]) ?? []).map(globPrefix);
      const runtimeRoots =
        (manifest.default_input as { roots?: string[] } | undefined)?.roots ?? [];
      for (const root of runtimeRoots) {
        const covered = scopePrefixes.some(
          (prefix) =>
            prefix === root || prefix.startsWith(`${root}/`) || root.startsWith(`${prefix}/`),
        );
        // A root the cycle scans but the manifest does not declare is a read
        // outside the surface the registry hashed and the allowlist permits.
        expect({ toolId, root, covered }).toEqual({ toolId, root, covered: true });
      }
    }
  });

  it('runs the adapter tests from a target, so this pin is load-bearing', () => {
    const project = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'project.json'), 'utf8')) as {
      targets?: Record<string, { options?: { commands?: string[] } }>;
    };
    const commands = project.targets?.test?.options?.commands ?? [];
    expect(commands.length).toBeGreaterThan(0);
    // Every test file next to an adapter must be in the target. A test nobody
    // runs is the state this repository just spent an afternoon discovering.
    const testFiles = fs
      .readdirSync(ADAPTER_DIR)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    const missing = testFiles.filter((name) => !commands.some((command) => command.includes(name)));
    expect(missing).toEqual([]);
  });

  it('keeps the adapter test files tracked, so the target cannot go hollow', () => {
    const tracked = execFileSync('git', ['ls-files', 'tools/aria-adapters/*.test.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
  });
});
