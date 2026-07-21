import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ACTION_PATH = join(
  REPO_ROOT,
  '.github',
  'actions',
  'install-platform-binaries',
  'action.yml',
);

interface CompositeAction {
  runs: {
    steps: Array<{ run?: string }>;
  };
}

interface FixtureOptions {
  integrity?: 'valid' | 'missing' | 'mismatch';
  manifestName?: string;
  ownerVersion?: string;
  resolved?: string;
}

function actionScript(): string {
  const parsed = yaml.load(readFileSync(ACTION_PATH, 'utf8')) as CompositeAction;
  const script = parsed.runs.steps[0]?.run;
  if (typeof script !== 'string') {
    throw new Error('platform-binary composite action has no shell program');
  }
  return script;
}

function installerProbeScript(): string {
  const script = actionScript();
  const callBoundary = script.indexOf('# SWC (needed by NX');
  if (callBoundary < 0) {
    throw new Error('platform-binary installer call boundary is missing');
  }
  return `${script.slice(0, callBoundary)}\ninstall_pkg '@esbuild/linux-x64' 'node_modules/@esbuild/linux-x64' 'node_modules/esbuild'\n`;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runFixture(options: FixtureOptions = {}): {
  directory: string;
  destinationExecutable: string;
  extractMarker: string;
  result: ReturnType<typeof spawnSync>;
  runnerTemp: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'aqua-platform-installer-authority-'));
  const sourceRoot = join(directory, 'archive-source');
  const packageRoot = join(sourceRoot, 'package');
  const runnerTemp = join(directory, 'runner-temp');
  const fakeBin = join(directory, 'fake-bin');
  const tarball = join(directory, 'platform-package.tgz');
  const extractMarker = join(directory, 'tar-extracted');
  const destination = join(directory, 'node_modules', '@esbuild', 'linux-x64');
  const destinationExecutable = join(destination, 'bin', 'esbuild');
  const version = '1.2.3';
  const expectedResolved = 'https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-1.2.3.tgz';

  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: options.manifestName ?? '@esbuild/linux-x64',
      version,
      bin: { esbuild: 'bin/esbuild' },
    }),
  );
  writeExecutable(join(packageRoot, 'bin', 'esbuild'), "printf 'VERIFIED_EXECUTABLE\\n'");
  const archive = spawnSync('/usr/bin/tar', ['czf', tarball, '-C', sourceRoot, 'package'], {
    encoding: 'utf8',
  });
  if (archive.status !== 0) {
    throw new Error(`fixture tar creation failed: ${archive.stderr}`);
  }

  const digest = createHash('sha512').update(readFileSync(tarball)).digest('base64');
  const integrity =
    options.integrity === 'missing'
      ? undefined
      : options.integrity === 'mismatch'
        ? `sha512-${Buffer.alloc(64, 7).toString('base64')}`
        : `sha512-${digest}`;
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/esbuild': { version: options.ownerVersion ?? version },
        'node_modules/@esbuild/linux-x64': {
          version,
          resolved: options.resolved ?? expectedResolved,
          ...(integrity === undefined ? {} : { integrity }),
          optional: true,
          os: ['linux'],
          cpu: ['x64'],
        },
      },
    }),
  );

  mkdirSync(join(destination, 'bin'), { recursive: true });
  writeFileSync(
    join(destination, 'package.json'),
    JSON.stringify({
      name: '@esbuild/linux-x64',
      version,
      bin: { esbuild: 'bin/esbuild' },
    }),
  );
  writeExecutable(destinationExecutable, "printf 'TAMPERED_EXECUTABLE\\n'");

  writeExecutable(
    join(fakeBin, 'curl'),
    [
      'output=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) output=$2; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      ': "${output:?curl output path missing}"',
      '/bin/cp -- "${FIXTURE_TARBALL:?}" "${output}"',
    ].join('\n'),
  );
  writeExecutable(
    join(fakeBin, 'tar'),
    [
      ': "${EXTRACT_MARKER:?extract marker missing}"',
      '/usr/bin/touch "${EXTRACT_MARKER}"',
      'exec /usr/bin/tar "$@"',
    ].join('\n'),
  );

  const result = spawnSync('/bin/bash', ['-c', installerProbeScript()], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      RUNNER_TEMP: runnerTemp,
      FIXTURE_TARBALL: tarball,
      EXTRACT_MARKER: extractMarker,
    },
  });

  return { directory, destinationExecutable, extractMarker, result, runnerTemp };
}

describe('Linux platform-binary installer authority', () => {
  it('fails before extraction when committed integrity is missing or mismatched', () => {
    for (const integrity of ['missing', 'mismatch'] as const) {
      const fixture = runFixture({ integrity });
      try {
        expect(fixture.result.status).not.toBe(0);
        expect(() => readFileSync(fixture.extractMarker, 'utf8')).toThrow();
        expect(readFileSync(fixture.destinationExecutable, 'utf8')).toContain(
          'TAMPERED_EXECUTABLE',
        );
        expect(readdirSync(fixture.runnerTemp)).toEqual([]);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it('binds the tarball to the exact owner version, registry URL, package name, and version', () => {
    for (const options of [
      { ownerVersion: '9.9.9' },
      { resolved: 'https://registry.example.invalid/platform-package.tgz' },
      { manifestName: '@esbuild/not-linux-x64' },
    ]) {
      const fixture = runFixture(options);
      try {
        expect(fixture.result.status).not.toBe(0);
        expect(readFileSync(fixture.destinationExecutable, 'utf8')).toContain(
          'TAMPERED_EXECUTABLE',
        );
        expect(readdirSync(fixture.runnerTemp)).toEqual([]);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it('replaces a pre-existing tampered executable only after complete verification', () => {
    const fixture = runFixture();
    try {
      expect(fixture.result.status).toBe(0);
      expect(readFileSync(fixture.extractMarker, 'utf8')).toBe('');
      expect(readFileSync(fixture.destinationExecutable, 'utf8')).toContain('VERIFIED_EXECUTABLE');
      expect(readFileSync(fixture.destinationExecutable, 'utf8')).not.toContain(
        'TAMPERED_EXECUTABLE',
      );
      expect(readdirSync(fixture.runnerTemp)).toEqual([]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('installs status-preserving EXIT and signal cleanup before any download', () => {
    const script = actionScript();
    const trapIndex = script.indexOf('trap cleanup_installer_tmp EXIT');
    const downloadIndex = script.indexOf('curl -sfL');

    expect(trapIndex).toBeGreaterThan(0);
    expect(trapIndex).toBeLessThan(downloadIndex);
    expect(script).toContain("trap 'exit 129' HUP");
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");
    expect(script).toContain('trap - EXIT HUP INT TERM');
    expect(script).not.toContain('::warning::Integrity mismatch');
    expect(script).not.toContain('skipping hash check');
    expect(script).not.toContain('Skipping ${target}');
  });

  it('removes private temporary state when the installer receives a termination signal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-platform-installer-signal-'));
    const runnerTemp = join(directory, 'runner-temp');
    const script = installerProbeScript();
    const setupOnly = script.slice(0, script.lastIndexOf("install_pkg '@esbuild/linux-x64'"));
    try {
      mkdirSync(runnerTemp);
      writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: {} }));
      const result = spawnSync('/bin/bash', ['-c', `${setupOnly}\nkill -TERM "$$"\n`], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: runnerTemp },
      });

      expect(result.status).toBe(143);
      expect(readdirSync(runnerTemp)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
