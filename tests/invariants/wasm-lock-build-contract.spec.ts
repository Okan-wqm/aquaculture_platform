import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WASM_BINDGEN_VERSION = '0.2.127';

const CONTRACTS = [
  {
    name: 'alarm-core',
    project: 'libs/alarm-core/project.json',
    manifest: 'crates/alarm-core-wasm/Cargo.toml',
    lock: 'crates/alarm-core-wasm/Cargo.lock',
    script: 'libs/alarm-core/scripts/build-wasm.sh',
    generated: 'libs/alarm-core/src/generated',
    wasm: 'target/wasm32-unknown-unknown/release/alarm_core_wasm.wasm',
  },
  {
    name: 'protocol-codec',
    project: 'libs/protocol-codec/project.json',
    manifest: 'crates/protocol-codec-wasm/Cargo.toml',
    lock: 'crates/protocol-codec-wasm/Cargo.lock',
    script: 'libs/protocol-codec/scripts/build-wasm.sh',
    generated: 'libs/protocol-codec/src/generated',
    wasm: 'target/wasm32-unknown-unknown/release/protocol_codec_wasm.wasm',
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

    const arrayHeader = line.match(/^\[\[([^[\]]+)\]\]$/);
    const tableHeader = line.match(/^\[([^[\]]+)\]$/);
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

interface ToolInvocation {
  readonly args: readonly string[];
  readonly workingDirectory: string;
}

interface ScriptExecution {
  readonly cargoInvocations: readonly ToolInvocation[];
  readonly copiedScriptMatches: boolean;
  readonly error: string | undefined;
  readonly executedScriptPath: string;
  readonly fixtureGenerated: boolean;
  readonly fixtureOldSentinelExists: boolean;
  readonly fixtureRoot: string;
  readonly outsideGenerated: boolean;
  readonly outsideSentinel: string | undefined;
  readonly repositoryGeneratedDigestAfter: string;
  readonly repositoryGeneratedDigestBefore: string;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly wasmBindgenInvocations: readonly ToolInvocation[];
}

type ContainmentAttack = 'parent-traversal' | 'symlink-parent';

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
}

function digestDirectory(path: string): string {
  const hash = createHash('sha256');

  function visit(directory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      hash.update(relative(path, entryPath));
      hash.update('\0');
      if (entry.isDirectory()) {
        hash.update('directory\0');
        visit(entryPath);
      } else {
        hash.update('file\0');
        hash.update(readFileSync(entryPath));
        hash.update('\0');
      }
    }
  }

  visit(path);
  return hash.digest('hex');
}

function parseInvocationLog(path: string): readonly ToolInvocation[] {
  if (!existsSync(path)) return [];

  const fields = readFileSync(path).toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const invocations: ToolInvocation[] = [];
  let offset = 0;

  while (offset < fields.length) {
    const workingDirectory = fields[offset];
    const argumentCountText = fields[offset + 1];
    const argumentCount = Number(argumentCountText);
    if (
      workingDirectory === undefined ||
      argumentCountText === undefined ||
      !Number.isSafeInteger(argumentCount) ||
      argumentCount < 0 ||
      offset + 2 + argumentCount > fields.length
    ) {
      throw new Error(`Malformed tool invocation log at ${path}`);
    }

    invocations.push({
      workingDirectory,
      args: fields.slice(offset + 2, offset + 2 + argumentCount),
    });
    offset += 2 + argumentCount;
  }

  return invocations;
}

function executeBuildScript(
  contract: (typeof CONTRACTS)[number],
  cliVersion: string | undefined,
  containmentAttack?: ContainmentAttack,
): ScriptExecution {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'aqua-wasm-build-contract-'));

  try {
    const fixtureRoot = join(sandboxRoot, 'fixture');
    const outsideRoot = join(sandboxRoot, 'outside');
    const fakeBin = join(fixtureRoot, 'bin');
    const cargoLog = join(fixtureRoot, 'cargo-invocations');
    const wasmBindgenLog = join(fixtureRoot, 'wasm-bindgen-invocations');
    const executedScriptPath = resolve(fixtureRoot, contract.script);
    const fixtureCrateDirectory = dirname(resolve(fixtureRoot, contract.manifest));
    const fixtureGeneratedDirectory = resolve(fixtureRoot, contract.generated);
    const fixtureOldSentinel = join(fixtureGeneratedDirectory, 'must-be-removed');
    const fixtureGenerated = join(fixtureGeneratedDirectory, 'generated-by-test');
    const outsideGeneratedDirectory = join(outsideRoot, 'generated');
    const outsideSentinel = join(outsideGeneratedDirectory, 'must-not-be-removed');
    const outsideGenerated = join(outsideGeneratedDirectory, 'generated-by-test');
    const repositoryGeneratedDirectory = resolve(REPO_ROOT, contract.generated);
    const repositoryGeneratedDigestBefore = digestDirectory(repositoryGeneratedDirectory);

    mkdirSync(dirname(executedScriptPath), { recursive: true });
    mkdirSync(fixtureCrateDirectory, { recursive: true });
    mkdirSync(outsideGeneratedDirectory, { recursive: true });
    writeFileSync(outsideSentinel, 'outside the fixture root\n');
    if (containmentAttack === 'symlink-parent') {
      mkdirSync(dirname(dirname(fixtureGeneratedDirectory)), { recursive: true });
      symlinkSync(outsideRoot, dirname(fixtureGeneratedDirectory));
    } else {
      mkdirSync(fixtureGeneratedDirectory, { recursive: true });
    }
    mkdirSync(dirname(resolve(fixtureRoot, contract.wasm)), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    const repositoryScript = readFileSync(resolve(REPO_ROOT, contract.script));
    const fixtureScript =
      containmentAttack === 'parent-traversal'
        ? repositoryScript
            .toString('utf8')
            .replace(
              `OUT_DIR="$REPO_ROOT/${contract.generated}"`,
              `OUT_DIR="$REPO_ROOT/${relative(fixtureRoot, outsideGeneratedDirectory)}"`,
            )
        : repositoryScript;
    writeFileSync(executedScriptPath, fixtureScript, { mode: 0o700 });
    if (containmentAttack !== 'symlink-parent') {
      writeFileSync(fixtureOldSentinel, 'the copied script must remove this file\n');
    }
    writeFileSync(resolve(fixtureRoot, contract.wasm), 'fixture wasm input\n');

    for (const tool of ['dirname', 'pwd', 'realpath'] as const) {
      symlinkSync(`/usr/bin/${tool}`, join(fakeBin, tool));
    }
    for (const tool of ['mkdir', 'rm'] as const) {
      writeExecutable(
        join(fakeBin, tool),
        `canonical_fixture_root="$(realpath -m -- "$FIXTURE_ROOT")"
canonical_arguments=()
for argument in "$@"; do
  case "$argument" in
    -*) canonical_arguments+=("$argument") ;;
    *)
      canonical_argument="$(realpath -m -- "$argument")"
      case "$canonical_argument" in
        "$canonical_fixture_root"|"$canonical_fixture_root"/*)
          canonical_arguments+=("$canonical_argument") ;;
        *) printf '%s\\n' 'refusing ${tool} outside the test fixture' >&2; exit 98 ;;
      esac
      ;;
  esac
done
exec /usr/bin/${tool} "\${canonical_arguments[@]}"`,
      );
    }

    if (cliVersion !== undefined) {
      writeExecutable(
        join(fakeBin, 'wasm-bindgen'),
        `if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'wasm-bindgen ${cliVersion}'
  exit 0
fi
printf '%s\\0%s\\0' "$PWD" "$#" >> "$WASM_BINDGEN_LOG"
printf '%s\\0' "$@" >> "$WASM_BINDGEN_LOG"
out_dir=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--out-dir' ]; then
    out_dir="\${2:-}"
    shift 2
  else
    shift
  fi
done
if [ -z "$out_dir" ]; then
  exit 97
fi
canonical_fixture_root="$(realpath -m -- "$FIXTURE_ROOT")"
canonical_out_dir="$(realpath -m -- "$out_dir")"
case "$canonical_out_dir" in
  "$canonical_fixture_root"|"$canonical_fixture_root"/*) ;;
  *) printf '%s\\n' 'refusing generation outside the test fixture' >&2; exit 98 ;;
esac
/usr/bin/mkdir -p -- "$canonical_out_dir"
printf '%s\\n' 'generated entirely inside the test fixture' > "$canonical_out_dir/generated-by-test"`,
      );
    }
    writeExecutable(
      join(fakeBin, 'cargo'),
      `printf '%s\\0%s\\0' "$PWD" "$#" >> "$CARGO_LOG"
printf '%s\\0' "$@" >> "$CARGO_LOG"`,
    );

    const result = spawnSync('/bin/bash', [executedScriptPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        CARGO_LOG: cargoLog,
        FIXTURE_ROOT: fixtureRoot,
        LC_ALL: 'C',
        PATH: fakeBin,
        WASM_BINDGEN_LOG: wasmBindgenLog,
      },
      killSignal: 'SIGKILL',
      timeout: 5_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      executedScriptPath,
      fixtureRoot,
      copiedScriptMatches: readFileSync(executedScriptPath).equals(
        readFileSync(resolve(REPO_ROOT, contract.script)),
      ),
      cargoInvocations: parseInvocationLog(cargoLog),
      wasmBindgenInvocations: parseInvocationLog(wasmBindgenLog),
      fixtureGenerated: existsSync(fixtureGenerated),
      fixtureOldSentinelExists: existsSync(fixtureOldSentinel),
      outsideGenerated: existsSync(outsideGenerated),
      outsideSentinel: existsSync(outsideSentinel)
        ? readFileSync(outsideSentinel, 'utf8')
        : undefined,
      repositoryGeneratedDigestBefore,
      repositoryGeneratedDigestAfter: digestDirectory(repositoryGeneratedDirectory),
      signal: result.signal,
      error: result.error?.message,
    };
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
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
  test.each(CONTRACTS)('$name refuses generated-output parent traversal', (contract) => {
    const execution = executeBuildScript(contract, WASM_BINDGEN_VERSION, 'parent-traversal');

    expect(execution.status).toBe(98);
    expect(execution.stderr).toContain('outside the test fixture');
    expect(execution.outsideSentinel).toBe('outside the fixture root\n');
    expect(execution.outsideGenerated).toBe(false);
    expect(execution.repositoryGeneratedDigestAfter).toBe(
      execution.repositoryGeneratedDigestBefore,
    );
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
  });

  test.each(CONTRACTS)('$name refuses a generated-output symlink escape', (contract) => {
    const execution = executeBuildScript(contract, WASM_BINDGEN_VERSION, 'symlink-parent');

    expect(execution.status).toBe(98);
    expect(execution.stderr).toContain('outside the test fixture');
    expect(execution.outsideSentinel).toBe('outside the fixture root\n');
    expect(execution.outsideGenerated).toBe(false);
    expect(execution.repositoryGeneratedDigestAfter).toBe(
      execution.repositoryGeneratedDigestBefore,
    );
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
  });

  test.each(CONTRACTS)('$name executes only a temporary script copy', (contract) => {
    const execution = executeBuildScript(contract, WASM_BINDGEN_VERSION);

    expect(execution.executedScriptPath.startsWith(`${REPO_ROOT}/`)).toBe(false);
    expect(execution.executedScriptPath).toBe(resolve(execution.fixtureRoot, contract.script));
    expect(execution.copiedScriptMatches).toBe(true);
    expect(execution.repositoryGeneratedDigestAfter).toBe(
      execution.repositoryGeneratedDigestBefore,
    );
    expect(execution.fixtureOldSentinelExists).toBe(false);
    expect(execution.fixtureGenerated).toBe(true);
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
  });

  test.each(CONTRACTS)('$name rejects a missing binding CLI before cargo', (contract) => {
    const execution = executeBuildScript(contract, undefined);

    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain(
      `error: wasm-bindgen CLI not found. Install: cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`,
    );
    expect(execution.cargoInvocations).toEqual([]);
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
  });

  test.each(CONTRACTS)('$name rejects a mismatched binding CLI before cargo', (contract) => {
    const execution = executeBuildScript(contract, '0.2.126');

    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain(
      `error: expected wasm-bindgen ${WASM_BINDGEN_VERSION}, got wasm-bindgen 0.2.126`,
    );
    expect(execution.cargoInvocations).toEqual([]);
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
  });

  test.each(CONTRACTS)('$name sends the exact locked build to cargo', (contract) => {
    const execution = executeBuildScript(contract, WASM_BINDGEN_VERSION);

    expect(execution.status).toBe(0);
    expect(execution.cargoInvocations).toEqual([
      {
        workingDirectory: dirname(resolve(execution.fixtureRoot, contract.manifest)),
        args: ['build', '--locked', '--target', 'wasm32-unknown-unknown', '--release'],
      },
    ]);
    expect(execution.wasmBindgenInvocations).toEqual([
      {
        workingDirectory: execution.fixtureRoot,
        args: [
          '--target',
          'nodejs',
          '--out-dir',
          resolve(execution.fixtureRoot, contract.generated),
          resolve(execution.fixtureRoot, contract.wasm),
        ],
      },
    ]);
    expect(execution.error).toBeUndefined();
    expect(execution.signal).toBeNull();
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
