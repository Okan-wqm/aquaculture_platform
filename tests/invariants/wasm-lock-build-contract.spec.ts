import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WASM_BINDGEN_VERSION = '0.2.127';

const CONTRACTS = [
  {
    name: 'alarm-core',
    project: 'libs/alarm-core/project.json',
    manifest: 'crates/alarm-core-wasm/Cargo.toml',
    lock: 'crates/alarm-core-wasm/Cargo.lock',
    script: 'libs/alarm-core/scripts/build-wasm.sh',
  },
  {
    name: 'protocol-codec',
    project: 'libs/protocol-codec/project.json',
    manifest: 'crates/protocol-codec-wasm/Cargo.toml',
    lock: 'crates/protocol-codec-wasm/Cargo.lock',
    script: 'libs/protocol-codec/scripts/build-wasm.sh',
  },
] as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

interface TomlAssignment {
  readonly key: string;
  readonly value: string;
}

interface TomlSection {
  readonly assignments: TomlAssignment[];
  readonly isArray: boolean;
  readonly name: string;
}

function withoutTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return line.slice(0, index);
  }

  return line;
}

function parseTomlSections(source: string): readonly TomlSection[] {
  const root: TomlSection = { name: '', isArray: false, assignments: [] };
  const sections: TomlSection[] = [root];
  let current = root;

  for (const sourceLine of source.split(/\r?\n/)) {
    const line = withoutTomlComment(sourceLine).trim();
    if (line.length === 0) continue;

    const arrayHeader = line.match(/^\[\[([^\[\]]+)\]\]$/);
    const tableHeader = line.match(/^\[([^\[\]]+)\]$/);
    if (arrayHeader !== null || tableHeader !== null) {
      current = {
        name: (arrayHeader?.[1] ?? tableHeader?.[1] ?? '').trim(),
        isArray: arrayHeader !== null,
        assignments: [],
      };
      sections.push(current);
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (assignment !== null) {
      const [, key, value] = assignment;
      if (key !== undefined && value !== undefined) {
        current.assignments.push({ key, value: value.trim() });
      }
    }
  }

  return sections;
}

function parseTomlString(value: string): string | undefined {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function manifestSatisfiesContract(manifest: string): boolean {
  const sections = parseTomlSections(manifest);
  const workspaceSections = sections.filter(
    (section) => section.name === 'workspace' || section.name.startsWith('workspace.'),
  );
  const [workspace] = workspaceSections;
  if (
    workspaceSections.length !== 1 ||
    workspace === undefined ||
    workspace.name !== 'workspace' ||
    workspace.isArray ||
    workspace.assignments.length !== 0
  ) {
    return false;
  }

  const bindingDependencies = sections.flatMap((section) => {
    if (!/(^|\.)dependencies$/.test(section.name)) return [];
    return section.assignments
      .filter((assignment) => assignment.key === 'wasm-bindgen')
      .map((assignment) => ({ section: section.name, value: parseTomlString(assignment.value) }));
  });
  const [bindingDependency] = bindingDependencies;

  return (
    bindingDependencies.length === 1 &&
    bindingDependency?.section === 'dependencies' &&
    bindingDependency.value === `=${WASM_BINDGEN_VERSION}`
  );
}

function lockSatisfiesContract(lock: string): boolean {
  const family = parseTomlSections(lock)
    .filter((section) => section.isArray && section.name === 'package')
    .map((section) => {
      const names = section.assignments.filter((assignment) => assignment.key === 'name');
      const versions = section.assignments.filter((assignment) => assignment.key === 'version');
      const [name] = names;
      const [version] = versions;
      return {
        name: names.length === 1 && name !== undefined ? parseTomlString(name.value) : undefined,
        version:
          versions.length === 1 && version !== undefined
            ? parseTomlString(version.value)
            : undefined,
      };
    })
    .filter((entry) => entry.name?.startsWith('wasm-bindgen'));
  const expectedNames = [
    'wasm-bindgen',
    'wasm-bindgen-macro',
    'wasm-bindgen-macro-support',
    'wasm-bindgen-shared',
  ];

  return (
    family.length === expectedNames.length &&
    expectedNames.every(
      (expectedName) =>
        family.filter(
          (entry) => entry.name === expectedName && entry.version === WASM_BINDGEN_VERSION,
        ).length === 1,
    )
  );
}

interface ScriptExecution {
  readonly cargoArgs: readonly string[] | undefined;
  readonly cargoWorkingDirectory: string | undefined;
  readonly status: number | null;
  readonly stderr: string;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
}

function executeBuildScript(
  contract: (typeof CONTRACTS)[number],
  cliVersion: string | undefined,
): ScriptExecution {
  const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-wasm-build-contract-'));
  const cargoLog = join(fakeBin, 'cargo');
  try {
    if (cliVersion !== undefined) {
      writeExecutable(
        join(fakeBin, 'wasm-bindgen'),
        `if [ "\${1:-}" = "--version" ]; then\n  printf '%s\\n' 'wasm-bindgen ${cliVersion}'\n  exit 0\nfi\nexit 97`,
      );
    }
    writeExecutable(
      join(fakeBin, 'cargo'),
      `printf '%s\\n' "$PWD" > "\${CARGO_LOG}.cwd"\nprintf '%s\\n' "$@" > "\${CARGO_LOG}.args"\nexit 73`,
    );

    const result = spawnSync('/bin/bash', [resolve(REPO_ROOT, contract.script)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CARGO_LOG: cargoLog,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      cargoArgs: existsSync(`${cargoLog}.args`)
        ? readFileSync(`${cargoLog}.args`, 'utf8').trim().split(/\r?\n/)
        : undefined,
      cargoWorkingDirectory: existsSync(`${cargoLog}.cwd`)
        ? readFileSync(`${cargoLog}.cwd`, 'utf8').trim()
        : undefined,
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

describe('contract checker mutation resistance', () => {
  test('rejects a pin that exists only in a comment', () => {
    const manifest = `
# wasm-bindgen = "=0.2.127"
[dependencies]
wasm-bindgen = "=0.2.126"

[workspace]
`;

    expect(manifestSatisfiesContract(manifest)).toBe(false);
  });

  test('rejects a workspace that gains members', () => {
    const manifest = `
[dependencies]
wasm-bindgen = "=0.2.127"

[workspace]
members = ["../not-standalone"]
`;

    expect(manifestSatisfiesContract(manifest)).toBe(false);
  });

  test('rejects a second target-specific wasm-bindgen dependency', () => {
    const manifest = `
[dependencies]
wasm-bindgen = "=0.2.127"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "=0.2.127"

[workspace]
`;

    expect(manifestSatisfiesContract(manifest)).toBe(false);
  });

  test('rejects one mixed version in an otherwise complete binding family', () => {
    const lock = `
[[package]]
name = "wasm-bindgen"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-macro"
version = "0.2.126"

[[package]]
name = "wasm-bindgen-macro-support"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-shared"
version = "0.2.127"
`;

    expect(lockSatisfiesContract(lock)).toBe(false);
  });

  test('rejects an obsolete backend added to the exact binding family', () => {
    const lock = `
[[package]]
name = "wasm-bindgen"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-macro"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-macro-support"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-shared"
version = "0.2.127"

[[package]]
name = "wasm-bindgen-backend"
version = "0.2.100"
`;

    expect(lockSatisfiesContract(lock)).toBe(false);
  });
});

describe('standalone WASM build script behavior', () => {
  test.each(CONTRACTS)('$name rejects a missing binding CLI before cargo', (contract) => {
    const execution = executeBuildScript(contract, undefined);

    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain(
      `error: wasm-bindgen CLI not found. Install: cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`,
    );
    expect(execution.cargoArgs).toBeUndefined();
  });

  test.each(CONTRACTS)('$name rejects a mismatched binding CLI before cargo', (contract) => {
    const execution = executeBuildScript(contract, '0.2.126');

    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain(
      `error: expected wasm-bindgen ${WASM_BINDGEN_VERSION}, got wasm-bindgen 0.2.126`,
    );
    expect(execution.cargoArgs).toBeUndefined();
  });

  test.each(CONTRACTS)('$name sends the exact locked build to cargo', (contract) => {
    const execution = executeBuildScript(contract, WASM_BINDGEN_VERSION);

    expect(execution.status).toBe(73);
    expect(execution.cargoArgs).toEqual([
      'build',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--release',
    ]);
    expect(execution.cargoWorkingDirectory).toBe(dirname(resolve(REPO_ROOT, contract.manifest)));
  });
});

describe('standalone WASM lock/build contract', () => {
  test.each(CONTRACTS)('$name pins one binding toolchain and consumes its lock', (contract) => {
    const project = JSON.parse(read(contract.project)) as {
      targets?: { 'build-wasm'?: { inputs?: string[] } };
    };
    const manifest = read(contract.manifest);
    const lock = read(contract.lock);

    expect(project.targets?.['build-wasm']?.inputs).toContain(`{workspaceRoot}/${contract.lock}`);
    expect(manifestSatisfiesContract(manifest)).toBe(true);
    expect(lockSatisfiesContract(lock)).toBe(true);
  });
});
