/**
 * The edge agent release builds through `cross`, and cross mounts only the project and the
 * directories of its path dependencies. The agent depends on `../crates/alarm-core`, a member of
 * the repository-root workspace whose manifest it inherits from, so without the root manifest in
 * the container cargo stops at "error inheriting `edition` from workspace root manifest". Release
 * 2.0.0-rc.6 (run 40668157738) failed all three builds that way; no pull-request job builds with
 * cross, so the break had been latent since the dependency was added (2026-07-13).
 *
 * This spec makes the contract detectable at pull-request time: when a path dependency outside
 * the agent project inherits from a workspace, `Cross.toml` must mount the repository root
 * (`[build.env] volumes = ["CROSS_REPO_ROOT"]`) and the release build step must export it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENT_DIR = 'sens-api-gateway';
const MOUNT_VARIABLE = 'CROSS_REPO_ROOT';

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** Directories (relative to the repository root) of the path dependencies that leave `agentDir`. */
export function pathDependenciesOutside(agentManifest: string, agentDir: string): string[] {
  const found = new Set<string>();
  for (const match of agentManifest.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
    const resolved = path.posix.normalize(path.posix.join(agentDir, match[1]));
    if (resolved !== agentDir && !resolved.startsWith(`${agentDir}/`)) {
      found.add(resolved);
    }
  }
  return [...found].sort();
}

/** True when a crate manifest takes any value from the workspace it belongs to. */
export function inheritsFromWorkspace(crateManifest: string): boolean {
  return (
    /^\s*[\w.-]+\.workspace\s*=\s*true\b/m.test(crateManifest) ||
    /^\s*workspace\s*=\s*true\b/m.test(crateManifest)
  );
}

/** True when `[build.env] volumes` of a Cross.toml lists the mount variable. */
export function crossMountsRepoRoot(crossToml: string, variable: string): boolean {
  const buildEnv =
    crossToml.split(/^\[/m).find((section) => section.startsWith('build.env]')) ?? '';
  const volumes = /^\s*volumes\s*=\s*\[([^\]]*)\]/m.exec(buildEnv);
  return volumes !== null && new RegExp(`"${variable}"`).test(volumes[1]);
}

/** True when the release workflow exports the mount variable as the checkout. */
export function releaseExportsRepoRoot(workflow: string, variable: string): boolean {
  return new RegExp(
    `^\\s*${variable}:\\s*\\$\\{\\{\\s*github\\.workspace\\s*\\}\\}\\s*$`,
    'm',
  ).test(workflow);
}

describe('edge release: cross sees the workspace root its path dependencies inherit from', () => {
  describe('the checks themselves', () => {
    it('finds path dependencies that leave the agent project and ignores the ones inside it', () => {
      const manifest = [
        '[dependencies]',
        'alarm-core = { path = "../crates/alarm-core", version = "0.1.0" }',
        'local-helper = { path = "helpers/local" }',
      ].join('\n');
      expect(pathDependenciesOutside(manifest, 'sens-api-gateway')).toEqual(['crates/alarm-core']);
    });

    it('sees workspace inheritance in field and table form, and a self-contained manifest as none', () => {
      expect(inheritsFromWorkspace('[package]\nedition.workspace = true\n')).toBe(true);
      expect(inheritsFromWorkspace('[lints]\nworkspace = true\n')).toBe(true);
      expect(inheritsFromWorkspace('[package]\nedition = "2024"\n')).toBe(false);
    });

    it('wants the variable inside [build.env] volumes, not anywhere in the file', () => {
      const mounted = '[build.env]\npassthrough = ["RUST_LOG"]\nvolumes = ["CROSS_REPO_ROOT"]\n';
      const elsewhere =
        '[build.env]\npassthrough = ["RUST_LOG"]\n\n[target.x]\nvolumes = ["CROSS_REPO_ROOT"]\n';
      const other = '[build.env]\nvolumes = ["SOMETHING_ELSE"]\n';
      expect(crossMountsRepoRoot(mounted, MOUNT_VARIABLE)).toBe(true);
      expect(crossMountsRepoRoot(elsewhere, MOUNT_VARIABLE)).toBe(false);
      expect(crossMountsRepoRoot(other, MOUNT_VARIABLE)).toBe(false);
    });

    it('wants the checkout as the value, not a hard-coded path or an empty one', () => {
      expect(
        releaseExportsRepoRoot('  CROSS_REPO_ROOT: ${{ github.workspace }}\n', MOUNT_VARIABLE),
      ).toBe(true);
      expect(releaseExportsRepoRoot('  CROSS_REPO_ROOT: /tmp/x\n', MOUNT_VARIABLE)).toBe(false);
      expect(releaseExportsRepoRoot('  OTHER: ${{ github.workspace }}\n', MOUNT_VARIABLE)).toBe(
        false,
      );
    });
  });

  describe('the repository', () => {
    const outside = pathDependenciesOutside(read(`${AGENT_DIR}/Cargo.toml`), AGENT_DIR);
    const inheriting = outside.filter((dir) => inheritsFromWorkspace(read(`${dir}/Cargo.toml`)));

    it('has the dependency this contract exists for (otherwise delete the contract)', () => {
      expect(inheriting).toContain('crates/alarm-core');
    });

    it('mounts the repository root in cross when a path dependency inherits from a workspace', () => {
      expect(crossMountsRepoRoot(read(`${AGENT_DIR}/Cross.toml`), MOUNT_VARIABLE)).toBe(true);
    });

    it('exports the checkout as the mount in the release build step', () => {
      expect(
        releaseExportsRepoRoot(read('.github/workflows/edge-agent-release.yml'), MOUNT_VARIABLE),
      ).toBe(true);
    });
  });
});
