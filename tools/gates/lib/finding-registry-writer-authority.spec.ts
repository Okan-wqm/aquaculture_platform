import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ARIA_AUTHORITY_HASH_SENTINEL,
  CURRENT_STATE_PATH,
  writeAriaAuthorityHash,
} from '../aria-authority-hash';
import {
  FINDING_WRITER_AUTHORITY_PATH,
  FINDING_WRITER_DECLARED_ASSET_EDGES,
  FINDING_WRITER_ENTRYPOINT_PATHS,
  FINDING_WRITER_RETIRED_MUTATION_SURFACES,
  FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY,
  FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS,
  checkFindingWriterProtocolManifest,
  createFindingWriterRepositorySnapshot,
  parseFindingWriterProtocolManifest,
  renderFindingWriterProtocolManifest,
  resolveFindingWriterGovernedPaths,
  writeFindingWriterProtocolManifest,
} from './finding-registry-writer-authority';
import {
  admitFindingWriterCliInvocation,
  FINDING_WRITER_CLI_COMMAND_CONTRACT,
  FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS,
  findingWriterCliOperationNames,
} from './finding-writer-cli-contract';
import {
  writeFindingWriterSensitiveAuthorityFixture,
  writeFindingWriterSensitiveFixtureModule,
} from './finding-registry-writer-authority.fixture';

const fixtureRoots: string[] = [];
const repositoryRoot = resolve(__dirname, '..', '..', '..');

function fixtureFileContent(path: string): string {
  if (path.endsWith('.json')) return '{}\n';
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return 'export {};\n';
  return `${path}\n`;
}

function writeFixtureFile(root: string, path: string): void {
  const absolute = join(root, path);
  if (existsSync(absolute)) return;
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, fixtureFileContent(path), 'utf8');
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'finding-writer-authority-'));
  fixtureRoots.push(root);
  for (const path of FINDING_WRITER_ENTRYPOINT_PATHS) {
    writeFixtureFile(root, path);
  }
  for (const packageAuthorityPath of ['package.json', 'package-lock.json']) {
    writeFileSync(
      join(root, packageAuthorityPath),
      readFileSync(join(repositoryRoot, packageAuthorityPath)),
    );
  }
  writeFileSync(
    join(root, 'tools/scripts/automation/tsconfig.json'),
    '{"extends":"../../../tsconfig.base.json"}\n',
    'utf8',
  );
  writeFixtureFile(root, 'tsconfig.base.json');

  const actionDirectories = new Set<string>();
  for (const edge of FINDING_WRITER_DECLARED_ASSET_EDGES) {
    writeFixtureFile(root, edge.from);
    if ('to' in edge) writeFixtureFile(root, edge.to);
    if (edge.from.startsWith('.github/actions/')) {
      actionDirectories.add(edge.from.split('/').slice(0, 3).join('/'));
    }
  }
  for (const actionDirectory of actionDirectories) {
    const manifestPath = join(root, actionDirectory, 'action.yml');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"\n',
      'utf8',
    );
  }
  writeFileSync(
    join(root, '.github/workflows/ci-full.yml'),
    `jobs:\n  authority:\n    steps:\n      - run: npm run gates:source-finding-inventory:remote\n${[
      ...actionDirectories,
    ]
      .sort()
      .map((path) => `      - uses: ./${path}`)
      .join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, '.github/workflows/finding-registry-authority.yml'),
    'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:add\n      - run: npm run findings:close\n',
    'utf8',
  );
  writeFileSync(
    join(root, '.github/workflows/finding-state-sweep.yml'),
    'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:sweep\n',
    'utf8',
  );
  writeFixtureFile(root, 'tools/gates/source-finding-inventory.ts');
  writeFindingWriterSensitiveAuthorityFixture(root);
  writeFixtureFile(root, 'aria-kernel/aria_kernel/preflight.py');
  const currentStatePath = join(root, CURRENT_STATE_PATH);
  mkdirSync(dirname(currentStatePath), { recursive: true });
  writeFileSync(currentStatePath, `${ARIA_AUTHORITY_HASH_SENTINEL}\n`, 'utf8');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  writeAriaAuthorityHash(root);
  mkdirSync(dirname(join(root, FINDING_WRITER_AUTHORITY_PATH)), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

void describe('finding writer authority generator', () => {
  void it('keeps every exported compiler-input authority deeply immutable at runtime', () => {
    for (const authority of [
      FINDING_WRITER_ENTRYPOINT_PATHS,
      FINDING_WRITER_RETIRED_MUTATION_SURFACES,
      FINDING_WRITER_DECLARED_ASSET_EDGES,
      FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY,
      FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS,
      FINDING_WRITER_CLI_COMMAND_CONTRACT,
      FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS,
    ]) {
      assert.equal(Object.isFrozen(authority), true);
      assert.throws(
        () => Reflect.apply(Array.prototype.push, authority, ['tools/gates/evil-writer.ts']),
        TypeError,
      );
    }
    assert.equal(Object.isFrozen(FINDING_WRITER_DECLARED_ASSET_EDGES[0]), true);
    for (const executable of FINDING_WRITER_CLI_COMMAND_CONTRACT) {
      assert.equal(Object.isFrozen(executable), true);
      assert.equal(Object.isFrozen(executable.operations), true);
      assert.equal(Object.isFrozen(executable.allowedArguments), true);
      for (const operation of executable.operations) {
        assert.equal(Object.isFrozen(operation), true);
      }
    }
    const sensitiveAuthority = FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY[0];
    assert.ok(sensitiveAuthority);
    assert.equal(Object.isFrozen(sensitiveAuthority), true);
    assert.equal(Object.isFrozen(sensitiveAuthority.importers), true);
    assert.equal(Reflect.set(sensitiveAuthority.importers, 0, 'tools/gates/evil-writer.ts'), false);

    const root = fixture();
    const snapshot = createFindingWriterRepositorySnapshot(root);
    const packageBefore = snapshot.readText('package.json');
    const exposedBytes = snapshot.readFile('package.json');
    exposedBytes.fill(0);
    assert.equal(snapshot.readText('package.json'), packageBefore);
    const entries = snapshot.directoryEntries('tools/gates');
    assert.equal(Object.isFrozen(entries), true);
    assert.ok(entries[0]);
    assert.equal(Object.isFrozen(entries[0]), true);
    assert.equal(Reflect.set(entries[0], 'name', 'evil.ts'), false);
  });

  void it('admits every CLI operation from one contract and keeps registry dispatch exhaustive', () => {
    for (const executable of FINDING_WRITER_CLI_COMMAND_CONTRACT) {
      for (const operation of executable.operations) {
        const arguments_ =
          executable.selectorKind === 'FIRST_ARGUMENT'
            ? [operation.selector]
            : [operation.selector, '--scope=full'];
        const admission = admitFindingWriterCliInvocation(executable.executablePath, arguments_);
        assert.equal(admission.operation, operation.operation);
        assert.equal(
          admission.mutationClass,
          operation.mutation === 'NEVER' ? 'READ_ONLY' : 'MUTATION',
        );
      }
    }
    assert.equal(
      admitFindingWriterCliInvocation('tools/gates/finding-registry.ts', ['sweep', '--dry-run'])
        .mutationClass,
      'READ_ONLY',
    );
    assert.throws(
      () =>
        admitFindingWriterCliInvocation('tools/gates/source-finding-inventory.ts', [
          '--write',
          '--scope=remote',
        ]),
      /mutation is supported only with --scope=full/,
    );
    assert.throws(
      () => admitFindingWriterCliInvocation('tools/gates/finding-registry.ts', ['unknown']),
      /operation is not governed/,
    );

    const registrySource = readFileSync(
      join(repositoryRoot, 'tools/gates/finding-registry.ts'),
      'utf8',
    );
    const handledOperations = [...registrySource.matchAll(/(?:if|else if) \(sub === '([^']+)'\)/g)]
      .map((match) => match[1] ?? '')
      .sort();
    assert.deepEqual(
      handledOperations,
      [...findingWriterCliOperationNames('tools/gates/finding-registry.ts')].sort(),
    );
  });

  void it('writes byte-identically, owns the complete path set, and detects any digest drift', () => {
    const root = fixture();
    const authorityPath = join(root, FINDING_WRITER_AUTHORITY_PATH);
    const importedHelper = 'tools/gates/imported-writer-helper.ts';
    const localAction = '.github/actions/writer-runtime/action.yml';
    const localActionHelper = '.github/actions/writer-runtime/verify.mjs';
    writeFindingWriterSensitiveFixtureModule(
      root,
      'tools/gates/finding-registry.ts',
      "import './imported-writer-helper';",
    );
    mkdirSync(dirname(join(root, importedHelper)), { recursive: true });
    writeFileSync(join(root, importedHelper), 'export const helper = true;\n', 'utf8');
    writeFileSync(
      join(root, '.github/workflows/finding-registry-authority.yml'),
      'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:add\n      - run: npm run findings:close\n      - uses: ./.github/actions/writer-runtime\n',
      'utf8',
    );
    mkdirSync(dirname(join(root, localAction)), { recursive: true });
    writeFileSync(
      join(root, localAction),
      'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: node "${{ github.action_path }}/verify.mjs"\n',
      'utf8',
    );
    writeFileSync(join(root, localActionHelper), 'process.stdout.write("verified\\n");\n', 'utf8');

    const governedPaths = resolveFindingWriterGovernedPaths(root);
    assert.ok(governedPaths.includes(importedHelper));
    assert.ok(governedPaths.includes(localAction));
    assert.ok(governedPaths.includes(localActionHelper));

    assert.equal(writeFindingWriterProtocolManifest(root), true);
    const first = readFileSync(authorityPath, 'utf8');
    assert.equal(first, renderFindingWriterProtocolManifest(root));
    assert.equal(writeFindingWriterProtocolManifest(root), false);
    assert.equal(readFileSync(authorityPath, 'utf8'), first);
    assert.doesNotThrow(() => checkFindingWriterProtocolManifest(root));

    const parsed = parseFindingWriterProtocolManifest(first, authorityPath, root);
    assert.deepEqual(Object.keys(parsed.files), governedPaths);
    assert.ok(parsed.files[importedHelper]);
    assert.ok(parsed.files['tools/gates/lib/finding-registry-writer-authority.ts']);
    assert.ok(parsed.files['tools/gates/source-finding-inventory.ts']);
    assert.ok(parsed.files['tsconfig.base.json']);
    assert.ok(parsed.files['package-lock.json']);

    const incompleteFiles = Object.fromEntries(
      Object.entries(parsed.files).filter(([path]) => path !== localActionHelper),
    );
    assert.throws(
      () =>
        parseFindingWriterProtocolManifest(
          `${JSON.stringify({ ...parsed, files: incompleteFiles })}\n`,
          authorityPath,
          root,
        ),
      /digest set is invalid/,
    );

    writeFileSync(join(root, localActionHelper), 'process.stdout.write("drifted\\n");\n', 'utf8');
    assert.throws(() => checkFindingWriterProtocolManifest(root), /is stale/);
  });

  void it('fails closed on nonliteral loaders and symlinked dependency components', () => {
    const nonliteralRoot = fixture();
    writeFindingWriterSensitiveFixtureModule(
      nonliteralRoot,
      'tools/gates/finding-registry.ts',
      "const dependency = './runtime-helper';\nvoid import(dependency);",
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(nonliteralRoot),
      /dynamic (?:relative\/sensitive-module )?edge must use one literal module/,
    );

    const symlinkRoot = fixture();
    writeFindingWriterSensitiveFixtureModule(
      symlinkRoot,
      'tools/gates/finding-registry.ts',
      "import './linked-helper';",
    );
    writeFileSync(join(symlinkRoot, 'tools/gates/real-helper.ts'), 'export {};\n', 'utf8');
    symlinkSync('real-helper.ts', join(symlinkRoot, 'tools/gates/linked-helper.ts'));
    assert.throws(
      () => resolveFindingWriterGovernedPaths(symlinkRoot),
      /symlink|non-regular entry/,
    );
  });

  void it('enforces exact reverse importers across relative, dynamic, and path-alias edges', () => {
    const relativeRoot = fixture();
    writeFileSync(
      join(relativeRoot, 'tools/gates/unknown-source-writer.ts'),
      "import { openSourceFindingWriterFenceSession } from './lib/finding-writer-fence';\nvoid openSourceFindingWriterFenceSession;\n",
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(relativeRoot),
      /openSourceFindingWriterFenceSession reverse importer set.*unknown=tools\/gates\/unknown-source-writer\.ts/,
    );

    const dynamicRoot = fixture();
    writeFileSync(
      join(dynamicRoot, 'tools/gates/unknown-dynamic-writer.ts'),
      "const target = './lib/' + 'finding-writer-fence';\nvoid import(target);\n",
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(dynamicRoot),
      /dynamic relative\/sensitive-module edge must use one literal module/,
    );

    const aliasRoot = fixture();
    writeFileSync(
      join(aliasRoot, 'tools/gates/tsconfig.attack.json'),
      `${JSON.stringify({
        compilerOptions: {
          baseUrl: '../..',
          paths: { '@internal/fence': ['tools/gates/lib/finding-writer-fence'] },
        },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(aliasRoot, 'tools/gates/unknown-alias-writer.ts'),
      "import * as fence from '@internal/fence';\nvoid fence;\n",
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(aliasRoot),
      /forbids namespace, side-effect, or dynamic access/,
    );

    const packageAliasRoot = fixture();
    const packagePath = join(packageAliasRoot, 'package.json');
    const packageDocument = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<
      string,
      unknown
    >;
    packageDocument.imports = {
      '#fence': './tools/gates/lib/finding-writer-fence.ts',
    };
    writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`, 'utf8');
    writeFileSync(
      join(packageAliasRoot, 'tools/gates/unknown-package-alias-writer.ts'),
      "import * as fence from '#fence';\nvoid fence;\n",
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(packageAliasRoot),
      /forbids namespace, side-effect, or dynamic access/,
    );

    const extendsRoot = fixture();
    writeFileSync(
      join(extendsRoot, 'tools/gates/tsconfig.attack.json'),
      '{"extends":"@untrusted/tsconfig"}\n',
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(extendsRoot),
      /forbids unknown non-relative extends/,
    );
  });

  void it('requires closed runtime-export classification for every sensitive module', () => {
    for (const target of [
      'tools/gates/lib/finding-writer-fence.ts',
      'tools/gates/lib/source-finding-publication-kernel.ts',
      'tools/gates/source-finding-inventory.ts',
      'tools/gates/lib/finding-registry-writer-authority.ts',
    ]) {
      const root = fixture();
      const targetPath = join(root, target);
      writeFileSync(
        targetPath,
        `${readFileSync(targetPath, 'utf8')}\nexport function unsafeMutationIssuer(): void {}\n`,
        'utf8',
      );
      assert.throws(
        () => resolveFindingWriterGovernedPaths(root),
        new RegExp(
          `${target.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} runtime export classification.*unknown=unsafeMutationIssuer`,
        ),
      );
    }

    const commonJsRoot = fixture();
    const commonJsTarget = join(
      commonJsRoot,
      'tools/gates/lib/source-finding-publication-kernel.ts',
    );
    writeFileSync(
      commonJsTarget,
      `${readFileSync(commonJsTarget, 'utf8')}\nmodule.exports = { unsafeMutationIssuer: true };\n`,
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(commonJsRoot),
      /forbids CommonJS export mutation/,
    );

    const source = readFileSync(
      join(repositoryRoot, 'tools/gates/source-finding-inventory.ts'),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /export\s+(?:async\s+)?function\s+runGovernedSourceFindingInventoryMutation\b/,
    );
    assert.deepEqual(
      FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY.filter(
        (authority) =>
          authority.target === 'tools/gates/lib/finding-registry-writer-authority.ts' &&
          authority.symbol === 'writeFindingWriterProtocolManifest',
      ).map((authority) => authority.importers),
      [
        [
          'tools/gates/finding-registry-store.spec.ts',
          'tools/gates/lib/finding-registry-writer-authority.spec.ts',
        ],
      ],
    );
  });

  void it('fails closed on parser-version drift and stale hash-linked ARIA runtime authority', () => {
    const parserRoot = fixture();
    const packagePath = join(parserRoot, 'package.json');
    const packageRaw = readFileSync(packagePath, 'utf8');
    const mismatchedPackage = packageRaw.replace(
      /"yaml": "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/,
      '"yaml": "0.0.0"',
    );
    assert.notEqual(mismatchedPackage, packageRaw);
    writeFileSync(packagePath, mismatchedPackage, 'utf8');
    assert.throws(
      () => resolveFindingWriterGovernedPaths(parserRoot),
      /parser authority mismatch for yaml/,
    );

    const ariaRoot = fixture();
    writeFileSync(
      join(ariaRoot, 'aria-kernel/aria_kernel/preflight.py'),
      'raise RuntimeError("changed")\n',
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(ariaRoot),
      /ARIA authority hash is stale/,
    );
  });

  void it('closes over TypeScript module variants, re-exports, loaders, declarations, and indexes', () => {
    const root = fixture();
    const chainRoot = join(root, 'tools/gates/module-chain');
    mkdirSync(chainRoot, { recursive: true });
    writeFindingWriterSensitiveFixtureModule(
      root,
      'tools/gates/finding-registry.ts',
      [
        "import type { Contract } from './module-chain/types';",
        "import { token } from './module-chain';",
        "void import('./module-chain/lazy.mjs');",
        "void require('./module-chain/required.cjs');",
        'export type WriterContract = Contract;',
        'void token;',
      ].join('\n'),
    );
    writeFileSync(join(chainRoot, 'index.ts'), "export { token } from './token.mjs';\n", 'utf8');
    writeFileSync(join(chainRoot, 'token.mts'), 'export const token = true;\n', 'utf8');
    writeFileSync(join(chainRoot, 'types.d.ts'), 'export interface Contract {}\n', 'utf8');
    writeFileSync(join(chainRoot, 'lazy.mts'), 'export const lazy = true;\n', 'utf8');
    writeFileSync(join(chainRoot, 'required.cts'), 'export const required = true;\n', 'utf8');

    const governedPaths = resolveFindingWriterGovernedPaths(root);
    for (const path of [
      'tools/gates/module-chain/index.ts',
      'tools/gates/module-chain/token.mts',
      'tools/gates/module-chain/types.d.ts',
      'tools/gates/module-chain/lazy.mts',
      'tools/gates/module-chain/required.cts',
    ]) {
      assert.ok(governedPaths.includes(path), `missing module dependency: ${path}`);
    }
  });

  void it('hashes nested inherited path aliases, relative targets, and package-self helpers', () => {
    const root = fixture();
    const inheritedConfig = 'tools/tsconfig.writer-base.json';
    const owningConfig = 'tools/gates/tsconfig.json';
    const packageAuthority = 'tools/gates/package.json';
    const inheritedHelper = 'tools/gates/inherited-alias-helper.ts';
    const relativeHelper = 'tools/gates/relative-option-helper.writer.ts';
    const shadowedRelativeHelper = 'tools/gates/relative-option-helper.ts';
    const packageHelper = 'tools/gates/package-alias-helper.ts';
    writeFileSync(
      join(root, inheritedConfig),
      `${JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          moduleSuffixes: ['.writer', ''],
          paths: { '@writer/inherited-helper': [inheritedHelper] },
        },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(root, owningConfig),
      `${JSON.stringify({ extends: '../tsconfig.writer-base.json' })}\n`,
      'utf8',
    );
    writeFileSync(
      join(root, packageAuthority),
      `${JSON.stringify({
        name: '@fixture/writer',
        exports: { './package-helper': './package-alias-helper.ts' },
      })}\n`,
      'utf8',
    );
    writeFileSync(join(root, inheritedHelper), 'export const inherited = true;\n', 'utf8');
    writeFileSync(join(root, relativeHelper), 'export const relative = true;\n', 'utf8');
    writeFileSync(join(root, shadowedRelativeHelper), 'export const relative = false;\n', 'utf8');
    writeFileSync(join(root, packageHelper), 'export const packaged = true;\n', 'utf8');
    writeFindingWriterSensitiveFixtureModule(
      root,
      'tools/gates/finding-registry.ts',
      [
        "import { inherited } from '@writer/inherited-helper';",
        "import { relative } from './relative-option-helper';",
        "import { packaged } from '@fixture/writer/package-helper';",
        'void inherited;',
        'void relative;',
        'void packaged;',
      ].join('\n'),
    );
    writeAriaAuthorityHash(root);

    const governedPaths = resolveFindingWriterGovernedPaths(root);
    for (const path of [
      inheritedConfig,
      owningConfig,
      packageAuthority,
      inheritedHelper,
      relativeHelper,
      packageHelper,
    ]) {
      assert.ok(governedPaths.includes(path), `missing effective-config authority: ${path}`);
    }
    assert.equal(governedPaths.includes(shadowedRelativeHelper), false);
    assert.equal(writeFindingWriterProtocolManifest(root), true);
    assert.doesNotThrow(() => checkFindingWriterProtocolManifest(root));
    writeFileSync(join(root, inheritedHelper), 'export const inherited = false;\n', 'utf8');
    assert.throws(() => checkFindingWriterProtocolManifest(root), /is stale/);
  });

  void it('fails closed on compiler-config cycles, missing targets, and ambiguous targets', () => {
    const cycleRoot = fixture();
    writeFileSync(
      join(cycleRoot, 'tools/gates/tsconfig.json'),
      '{"extends":"../tsconfig.cycle.json"}\n',
      'utf8',
    );
    writeFileSync(
      join(cycleRoot, 'tools/tsconfig.cycle.json'),
      '{"extends":"./gates/tsconfig.json"}\n',
      'utf8',
    );
    assert.throws(() => resolveFindingWriterGovernedPaths(cycleRoot), /extends cycle/);

    const missingRoot = fixture();
    writeFileSync(
      join(missingRoot, 'tools/gates/tsconfig.json'),
      '{"extends":"./missing-config"}\n',
      'utf8',
    );
    assert.throws(() => resolveFindingWriterGovernedPaths(missingRoot), /target is missing/);

    const ambiguousRoot = fixture();
    writeFileSync(
      join(ambiguousRoot, 'tools/gates/tsconfig.json'),
      '{"extends":"./ambiguous"}\n',
      'utf8',
    );
    writeFileSync(join(ambiguousRoot, 'tools/gates/ambiguous'), '{}\n', 'utf8');
    writeFileSync(join(ambiguousRoot, 'tools/gates/ambiguous.json'), '{}\n', 'utf8');
    assert.throws(() => resolveFindingWriterGovernedPaths(ambiguousRoot), /target is ambiguous/);
  });

  void it('discovers the repository writer import and local-action graph', () => {
    const governedPaths = resolveFindingWriterGovernedPaths();
    for (const path of [
      '.github/actions/setup-aria-kernel/action.yml',
      '.github/actions/setup-rust-workspace/action.yml',
      '.github/actions/setup-rust-workspace/resolve-toolchain.mjs',
      'tools/gates/lib/repo-root.ts',
      'tools/gates/source-finding-inventory.ts',
    ]) {
      assert.ok(governedPaths.includes(path), `missing transitive writer dependency: ${path}`);
    }
  });

  void it('rejects shell-composed package commands and closes over every mutation command', () => {
    const root = fixture();
    const packagePath = join(root, 'package.json');
    const packageDocument = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    packageDocument.scripts['gates:source-finding-inventory:generate'] =
      'ts-node --project tools/gates/tsconfig.json tools/gates/source-finding-inventory.ts --write && node tools/gates/evil.js';
    writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`, 'utf8');
    writeFixtureFile(root, 'tools/gates/evil.js');
    assert.throws(() => resolveFindingWriterGovernedPaths(root), /unsupported executable grammar/);

    for (const separator of [';', '|', '>', '$(', '`']) {
      const separatedRoot = fixture();
      const separatedPackagePath = join(separatedRoot, 'package.json');
      const separatedPackage = JSON.parse(readFileSync(separatedPackagePath, 'utf8')) as {
        scripts: Record<string, string>;
      };
      separatedPackage.scripts['gates:source-finding-inventory:refresh'] =
        `ts-node --project tools/gates/tsconfig.json tools/gates/source-finding-inventory.ts --refresh ${separator} evil`;
      writeFileSync(separatedPackagePath, `${JSON.stringify(separatedPackage)}\n`, 'utf8');
      assert.throws(
        () => resolveFindingWriterGovernedPaths(separatedRoot),
        /unsupported executable grammar/,
      );
    }

    const aliasRoot = fixture();
    const aliasPackagePath = join(aliasRoot, 'package.json');
    const aliasPackage = JSON.parse(readFileSync(aliasPackagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    aliasPackage.scripts['evil-source-alias'] =
      'ts-node --project tools/gates/tsconfig.json tools/gates/source-finding-inventory.ts --write';
    writeFileSync(aliasPackagePath, `${JSON.stringify(aliasPackage)}\n`, 'utf8');
    writeFileSync(
      join(aliasRoot, '.github/workflows/finding-registry-authority.yml'),
      'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:add\n      - run: npm run findings:close\n      - run: npm run evil-source-alias\n',
      'utf8',
    );
    const aliasGoverned = resolveFindingWriterGovernedPaths(aliasRoot);
    assert.ok(aliasGoverned.includes('.github/workflows/finding-registry-authority.yml'));
    assert.ok(aliasGoverned.includes('tools/gates/source-finding-inventory.ts'));

    const indirectAliasRoot = fixture();
    const indirectPackagePath = join(indirectAliasRoot, 'package.json');
    const indirectPackage = JSON.parse(readFileSync(indirectPackagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    indirectPackage.scripts['evil-indirect-alias'] =
      'npm run gates:source-finding-inventory:generate';
    writeFileSync(indirectPackagePath, `${JSON.stringify(indirectPackage)}\n`, 'utf8');
    writeFileSync(
      join(indirectAliasRoot, '.github/workflows/finding-registry-authority.yml'),
      'jobs:\n  mutate:\n    steps:\n      - run: npm run findings:add\n      - run: npm run findings:close\n      - run: npm run evil-indirect-alias\n',
      'utf8',
    );
    assert.doesNotThrow(() => resolveFindingWriterGovernedPaths(indirectAliasRoot));

    const unauthorizedAliasRoot = fixture();
    const unauthorizedPackagePath = join(unauthorizedAliasRoot, 'package.json');
    const unauthorizedPackage = JSON.parse(readFileSync(unauthorizedPackagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    unauthorizedPackage.scripts['auto-discovered-mutation'] =
      'npm run gates:source-finding-inventory:generate';
    writeFileSync(unauthorizedPackagePath, `${JSON.stringify(unauthorizedPackage)}\n`, 'utf8');
    writeFileSync(
      join(unauthorizedAliasRoot, '.github/workflows/unowned-source-writer.yml'),
      'jobs:\n  mutate:\n    steps:\n      - run: npm run auto-discovered-mutation\n',
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(unauthorizedAliasRoot),
      /invoked by an unauthorized workflow/,
    );

    const compoundWorkflowRoot = fixture();
    writeFileSync(
      join(compoundWorkflowRoot, '.github/workflows/ci-full.yml'),
      'jobs:\n  authority:\n    steps:\n      - run: npm run gates:source-finding-inventory:remote && true\n',
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(compoundWorkflowRoot),
      /compound or dynamic/,
    );

    const directWorkflowRoot = fixture();
    writeFileSync(
      join(directWorkflowRoot, '.github/workflows/unowned-source-writer.yml'),
      'jobs:\n  mutate:\n    steps:\n      - run: npx ts-node --project tools/gates/tsconfig.json tools/gates/source-finding-inventory.ts --write\n',
      'utf8',
    );
    assert.throws(
      () => resolveFindingWriterGovernedPaths(directWorkflowRoot),
      /direct mutation executable/,
    );
  });

  void it('seals the first directory observation and rejects later topology drift', () => {
    const root = fixture();
    const snapshot = createFindingWriterRepositorySnapshot(root);
    const first = snapshot.directoryEntries('tools/gates');
    writeFileSync(join(root, 'tools/gates/late-writer.ts'), 'export {};\n', 'utf8');
    assert.deepEqual(snapshot.directoryEntries('tools/gates'), first);
    assert.throws(() => snapshot.assertCurrent(), /directory generation changed|topology changed/);
  });

  void it('reads each governed file and directory at most once per compiler snapshot', () => {
    const root = fixture();
    const fileReads = new Map<string, number>();
    const directoryReads = new Map<string, number>();
    const snapshot = createFindingWriterRepositorySnapshot(root, {
      onFileRead: (path) => fileReads.set(path, (fileReads.get(path) ?? 0) + 1),
      onDirectoryRead: (path) => directoryReads.set(path, (directoryReads.get(path) ?? 0) + 1),
    });
    const governed = resolveFindingWriterGovernedPaths(root, snapshot);
    for (const path of governed) {
      snapshot.readFile(path);
      snapshot.readText(path);
    }
    assert.equal(Math.max(...fileReads.values()), 1);
    assert.equal(Math.max(...directoryReads.values()), 1);
  });

  void it('keeps the registry, store, source facade, and fence kernel dependency graph acyclic', () => {
    const registry = readFileSync(join(repositoryRoot, 'tools/gates/finding-registry.ts'), 'utf8');
    const store = readFileSync(
      join(repositoryRoot, 'tools/gates/finding-registry-store.ts'),
      'utf8',
    );
    const source = readFileSync(
      join(repositoryRoot, 'tools/gates/source-finding-inventory.ts'),
      'utf8',
    );
    const fence = readFileSync(
      join(repositoryRoot, 'tools/gates/lib/finding-writer-fence.ts'),
      'utf8',
    );
    assert.doesNotMatch(registry, /from ['"]\.\/source-finding-inventory['"]/);
    assert.doesNotMatch(store, /from ['"]\.\/finding-registry['"]/);
    assert.doesNotMatch(
      source,
      /from ['"]\.\/finding-registry-store['"][\s\S]*from ['"]\.\/source-finding-inventory['"]/,
    );
    assert.doesNotMatch(
      fence,
      /from ['"]\.\.\/finding-registry(?:-store)?['"]|from ['"]\.\.\/source-finding-inventory['"]/,
    );
    assert.match(source, /from ['"]\.\/finding-registry['"]/);
    assert.match(store, /from ['"]\.\/lib\/finding-writer-fence['"]/);
  });
});
