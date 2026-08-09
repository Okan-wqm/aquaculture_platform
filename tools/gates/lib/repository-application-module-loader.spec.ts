import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  testOnlyLoadRepositoryApplicationModuleFromRoot,
  testOnlyReleaseRepositoryApplicationModulesBelowRoot,
} from './repository-application-module-loader';

const fixtureRoots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'repository-application-module-loader-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'apps', 'service', 'src'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    testOnlyReleaseRepositoryApplicationModulesBelowRoot(root);
    rmSync(root, { recursive: true, force: true });
  }
});

void describe('repository application module loader', () => {
  void it('loads one descriptor-bound regular application module', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'module.ts');
    writeFileSync(target, 'module.exports = Object.freeze({ value: 42 });\n', 'utf8');

    assert.deepEqual(testOnlyLoadRepositoryApplicationModuleFromRoot(root, target), { value: 42 });
  });

  void it('separates module identity from a reused descriptor number', () => {
    const root = fixture();
    const first = join(root, 'apps', 'service', 'src', 'first.ts');
    const second = join(root, 'apps', 'service', 'src', 'second.ts');
    const descriptors: number[] = [];
    writeFileSync(first, 'module.exports = Object.freeze({ value: "first" });\n', 'utf8');
    writeFileSync(second, 'module.exports = Object.freeze({ value: "second" });\n', 'utf8');

    assert.deepEqual(
      testOnlyLoadRepositoryApplicationModuleFromRoot(root, first, (descriptor) =>
        descriptors.push(descriptor),
      ),
      { value: 'first' },
    );
    assert.deepEqual(
      testOnlyLoadRepositoryApplicationModuleFromRoot(root, second, (descriptor) =>
        descriptors.push(descriptor),
      ),
      { value: 'second' },
    );
    assert.equal(descriptors.length, 2);
    assert.equal(descriptors[0], descriptors[1]);
  });

  void it('owns same-generation cache reuse and fails closed on content generation drift', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'cached.ts');
    writeFileSync(
      target,
      'module.exports = { value: "first", identity: Object.freeze({}) };\n',
      'utf8',
    );

    const first = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    const second = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    assert.equal(second, first);

    writeFileSync(
      target,
      'module.exports = { value: "other", identity: Object.freeze({}) };\n',
      'utf8',
    );
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target),
      /generation changed after first governed load|cache source.*changed/i,
    );
  });

  void it('rejects a preexisting external CommonJS cache authority', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'externally-cached.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(target, 'module.exports = Object.freeze({ external: true });\n', 'utf8');
    const contract = [
      "const { createRequire } = require('node:module');",
      'const target = process.argv[1];',
      'const repositoryRoot = process.argv[2];',
      'const loaderPath = process.argv[3];',
      'const targetRequire = createRequire(target);',
      'targetRequire(target);',
      'const loader = targetRequire(loaderPath);',
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, target);',
      '} catch (error) {',
      '  rejected = /external CommonJS cache authority/.test(String(error));',
      '}',
      'if (!rejected) throw new Error("governed loader accepted an external cache authority");',
      '',
    ].join('\n');

    execFileSync(
      process.execPath,
      ['--require', 'ts-node/register', '-e', contract, target, root, loaderPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'tools', 'gates', 'tsconfig.json'),
        },
      },
    );
  });

  void it('resolves recursive local dependencies from the canonical target identity', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'recursive.ts');
    writeFileSync(
      join(root, 'apps', 'service', 'src', 'dependency.ts'),
      [
        "const entry = require('./recursive.ts');",
        'module.exports = Object.freeze({ entry, value: 17 });',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      target,
      [
        'module.exports.filename = __filename;',
        'const self = module.exports;',
        "const dependency = require('./dependency.ts');",
        'module.exports.self = self;',
        'module.exports.dependency = dependency;',
        '',
      ].join('\n'),
      'utf8',
    );

    const loaded = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    if (typeof loaded !== 'object' || loaded === null) {
      throw new Error('Recursive module fixture returned no object exports');
    }
    assert.equal(Reflect.get(loaded, 'filename'), target);
    assert.equal(Reflect.get(loaded, 'self'), loaded);
    const dependency: unknown = Reflect.get(loaded, 'dependency');
    if (typeof dependency !== 'object' || dependency === null) {
      throw new Error('Recursive dependency fixture returned no object exports');
    }
    assert.equal(Reflect.get(dependency, 'entry'), loaded);
    assert.equal(Reflect.get(dependency, 'value'), 17);
  });

  void it('rejects oversized source before evaluation', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'oversized.ts');
    writeFileSync(target, Buffer.alloc(0));
    truncateSync(target, 16 * 1024 * 1024 + 1);

    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target),
      /exceeds 16777216 bytes/,
    );
  });

  void it('uses the canonical compiler/path authority and pins compile identity', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'typed.ts');
    const dependency = join(root, 'apps', 'service', 'src', 'typed-dependency.ts');
    writeFileSync(dependency, 'module.exports = Object.freeze({ value: 29 });\n', 'utf8');
    writeFileSync(
      target,
      [
        'const value: number = 23;',
        "const dependency: { readonly value: number } = require('./typed-dependency.ts');",
        'module.exports = Object.freeze({ value, dependency, filename: __filename, dirname: __dirname });',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    assert.deepEqual(loaded, {
      value: 23,
      dependency: { value: 29 },
      filename: target,
      dirname: join(root, 'apps', 'service', 'src'),
    });
  });

  void it('reuses only handler-minted dependency authority on a later public load', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'owned-dependency.ts');
    const entry = join(root, 'apps', 'service', 'src', 'dependency-entry.ts');
    writeFileSync(
      dependency,
      'module.exports = { value: 37, identity: Object.freeze({}) };\n',
      'utf8',
    );
    writeFileSync(entry, "module.exports = require('./owned-dependency.ts');\n", 'utf8');

    const dependencyFirst = testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry);
    const publicSecond = testOnlyLoadRepositoryApplicationModuleFromRoot(root, dependency);
    assert.equal(publicSecond, dependencyFirst);
  });

  void it('preserves descriptor-bound LOADING to LOADED authority across a dependency cycle', () => {
    const root = fixture();
    const first = join(root, 'apps', 'service', 'src', 'cycle-first.ts');
    const second = join(root, 'apps', 'service', 'src', 'cycle-second.ts');
    writeFileSync(
      first,
      [
        "module.exports.name = 'first';",
        "const peer = require('./cycle-second.ts');",
        'module.exports.peer = peer.name;',
        'module.exports.peerObserved = peer.observed;',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      second,
      [
        "module.exports.name = 'second';",
        "const peer = require('./cycle-first.ts');",
        'module.exports.observed = peer.name;',
        '',
      ].join('\n'),
      'utf8',
    );

    assert.deepEqual(testOnlyLoadRepositoryApplicationModuleFromRoot(root, first), {
      name: 'first',
      peer: 'second',
      peerObserved: 'first',
    });
    assert.deepEqual(testOnlyLoadRepositoryApplicationModuleFromRoot(root, second), {
      name: 'second',
      observed: 'first',
    });
  });

  void it('rejects dependency generation tamper before later public reuse', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'tampered-dependency.ts');
    const entry = join(root, 'apps', 'service', 'src', 'tampered-entry.ts');
    writeFileSync(dependency, 'module.exports = { value: "first" };\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./tampered-dependency.ts');\n", 'utf8');
    testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry);

    writeFileSync(dependency, 'module.exports = { value: "other" };\n', 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, dependency),
      /generation changed after first governed load|cache source.*changed/i,
    );
  });

  void it('rejects unrelated public work when any owned dependency generation is stale', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'global-tamper-dependency.ts');
    const entry = join(root, 'apps', 'service', 'src', 'global-tamper-entry.ts');
    const unrelated = join(root, 'apps', 'service', 'src', 'unrelated.ts');
    writeFileSync(dependency, 'module.exports = { value: "first" };\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./global-tamper-dependency.ts');\n", 'utf8');
    writeFileSync(unrelated, 'module.exports = Object.freeze({ unrelated: true });\n', 'utf8');
    testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry);

    writeFileSync(dependency, 'module.exports = { value: "other" };\n', 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, unrelated),
      /cache source.*changed|cache generation changed/i,
    );
  });

  void it('rolls back private and Node cache ownership after dependency handler failure', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'failing-dependency.ts');
    const entry = join(root, 'apps', 'service', 'src', 'failing-entry.ts');
    writeFileSync(dependency, 'throw new Error("dependency handler sentinel");\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./failing-dependency.ts');\n", 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry),
      /dependency handler sentinel/,
    );

    writeFileSync(dependency, 'module.exports = Object.freeze({ recovered: true });\n', 'utf8');
    assert.deepEqual(testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry), {
      recovered: true,
    });
  });

  void it('rejects a repository-local non-TypeScript dependency before native execution', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'native-dependency.js');
    const entry = join(root, 'apps', 'service', 'src', 'native-entry.ts');
    const sentinel = join(root, 'native-dependency-executed');
    writeFileSync(
      dependency,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
      'utf8',
    );
    writeFileSync(entry, "module.exports = require('./native-dependency.js');\n", 'utf8');

    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry),
      /dependency is not governed TypeScript/,
    );
    assert.equal(existsSync(sentinel), false);
  });

  void it('rejects relative, absolute, and symlinked dependencies outside repository authority', () => {
    for (const escapeKind of ['relative', 'absolute', 'symlink'] as const) {
      const root = fixture();
      const outsideRoot = mkdtempSync(join(tmpdir(), 'repository-application-escape-'));
      fixtureRoots.push(outsideRoot);
      const dependency = join(outsideRoot, `${escapeKind}-dependency.js`);
      const sentinel = join(outsideRoot, `${escapeKind}-executed`);
      const entry = join(root, 'apps', 'service', 'src', `${escapeKind}-entry.ts`);
      writeFileSync(
        dependency,
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
        'utf8',
      );
      let request: string;
      if (escapeKind === 'relative') {
        const fromEntry = relative(dirname(entry), dependency).replaceAll('\\', '/');
        request = fromEntry.startsWith('.') ? fromEntry : `./${fromEntry}`;
      } else if (escapeKind === 'absolute') {
        request = dependency;
      } else {
        const link = join(root, 'apps', 'service', 'src', 'outside-link.js');
        symlinkSync(dependency, link);
        request = './outside-link.js';
      }
      writeFileSync(entry, `module.exports = require(${JSON.stringify(request)});\n`, 'utf8');
      assert.throws(
        () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry),
        /dependency escaped its repository authority/,
      );
      assert.equal(existsSync(sentinel), false);
    }
  });

  void it('rejects a repository TypeScript dependency cached before governed evaluation', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'external-first.ts');
    const entry = join(root, 'apps', 'service', 'src', 'external-first-entry.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(dependency, 'module.exports = Object.freeze({ external: true });\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./external-first.ts');\n", 'utf8');
    const contract = [
      "const { createRequire } = require('node:module');",
      'const dependency = process.argv[1];',
      'const entry = process.argv[2];',
      'const repositoryRoot = process.argv[3];',
      'const loaderPath = process.argv[4];',
      'const targetRequire = createRequire(entry);',
      'targetRequire(dependency);',
      'const loader = targetRequire(loaderPath);',
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, entry);',
      '} catch (error) {',
      '  rejected = /external-first cache authority/.test(String(error));',
      '}',
      'if (!rejected) throw new Error("loader accepted an external-first TypeScript cache");',
      '',
    ].join('\n');

    execFileSync(
      process.execPath,
      ['--require', 'ts-node/register', '-e', contract, dependency, entry, root, loaderPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'tools', 'gates', 'tsconfig.json'),
        },
      },
    );
  });

  void it('restores exact handler and resolver generations when path cleanup is a no-op', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'rollback.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(target, 'const value: number = 31; module.exports = { value };\n', 'utf8');
    const contract = [
      "const { createRequire, Module } = require('node:module');",
      "const pathAuthority = require('tsconfig-paths');",
      'const target = process.argv[1];',
      'const repositoryRoot = process.argv[2];',
      'const loaderPath = process.argv[3];',
      'const targetRequire = createRequire(loaderPath);',
      'const loader = targetRequire(loaderPath);',
      "const previousHandler = targetRequire.extensions['.ts'];",
      'const previousResolver = Module._resolveFilename;',
      "Object.defineProperty(pathAuthority, 'register', { configurable: true, value: () => {",
      '  Module._resolveFilename = function (request, parent, isMain, options) {',
      "    if (request === '@aquaculture/backend-common/constants') return '/tmp/untrusted-alias.ts';",
      '    return Reflect.apply(previousResolver, this, [request, parent, isMain, options]);',
      '  };',
      '  return () => undefined;',
      '} });',
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, target);',
      '} catch (error) {',
      '  rejected = /install and rollback failed/.test(String(error));',
      '}',
      'if (!rejected) throw new Error("loader accepted a no-op resolver cleanup");',
      "if (targetRequire.extensions['.ts'] !== previousHandler) {",
      '  throw new Error("loader did not restore the prior TypeScript handler");',
      '}',
      'if (Module._resolveFilename !== previousResolver) {',
      '  throw new Error("loader did not restore the prior CommonJS resolver");',
      '}',
      '',
    ].join('\n');

    execFileSync(
      process.execPath,
      ['--require', 'ts-node/register', '-e', contract, target, root, loaderPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'tools', 'gates', 'tsconfig.json'),
        },
      },
    );
  });

  void it('pins one global extension-handler generation across different targets', () => {
    const root = fixture();
    const first = join(root, 'apps', 'service', 'src', 'first-handler.ts');
    const second = join(root, 'apps', 'service', 'src', 'second-handler.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(first, 'const value: number = 41; module.exports = { value };\n', 'utf8');
    writeFileSync(second, 'const value: number = 43; module.exports = { value };\n', 'utf8');
    const contract = [
      "const { createRequire } = require('node:module');",
      'const first = process.argv[1];',
      'const second = process.argv[2];',
      'const repositoryRoot = process.argv[3];',
      'const loaderPath = process.argv[4];',
      'const targetRequire = createRequire(loaderPath);',
      'const loader = targetRequire(loaderPath);',
      "const original = targetRequire.extensions['.ts'];",
      "if (typeof original !== 'function') throw new Error('missing TypeScript handler');",
      "targetRequire.extensions['.ts'] = (target, filename) => original(target, filename);",
      'loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, first);',
      "targetRequire.extensions['.ts'] = (target, filename) => original(target, filename);",
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, second);',
      '} catch (error) {',
      '  rejected = /execution authority generation changed/.test(String(error));',
      '}',
      'if (!rejected) throw new Error("loader accepted extension handler generation drift");',
      '',
    ].join('\n');
    execFileSync(
      process.execPath,
      ['--require', 'ts-node/register', '-e', contract, first, second, root, loaderPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'tools', 'gates', 'tsconfig.json'),
        },
      },
    );
  });

  void it('rolls back only its own cache entry after evaluation failure', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'retry.ts');
    writeFileSync(target, 'throw new Error("first evaluation failed");\n', 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target),
      /first evaluation failed/,
    );

    writeFileSync(target, 'module.exports = Object.freeze({ value: "recovered" });\n', 'utf8');
    assert.deepEqual(testOnlyLoadRepositoryApplicationModuleFromRoot(root, target), {
      value: 'recovered',
    });
  });

  void it('rejects Module.loaded drift in both LOADING and LOADED states', () => {
    const loadingRoot = fixture();
    const loadingTarget = join(loadingRoot, 'apps', 'service', 'src', 'loading-state.ts');
    writeFileSync(
      join(loadingRoot, 'apps', 'service', 'src', 'loading-cycle.ts'),
      "module.exports = require('./loading-state.ts');\n",
      'utf8',
    );
    writeFileSync(
      loadingTarget,
      ['module.loaded = true;', "require('./loading-cycle.ts');", ''].join('\n'),
      'utf8',
    );
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(loadingRoot, loadingTarget),
      /LOADING (cache state has a loaded Module|authority escaped its graph)/,
    );

    const loadedRoot = fixture();
    const loadedTarget = join(loadedRoot, 'apps', 'service', 'src', 'loaded-state.ts');
    writeFileSync(loadedTarget, 'module.exports = () => { module.loaded = false; };\n', 'utf8');
    const tamper = testOnlyLoadRepositoryApplicationModuleFromRoot(loadedRoot, loadedTarget);
    if (typeof tamper !== 'function') {
      throw new Error('Loaded-state fixture did not export its mutation function');
    }
    Reflect.apply(tamper, undefined, []);
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(loadedRoot, loadedTarget),
      /LOADED (cache state has an unloaded Module|authority is inconsistent)/,
    );
  });

  void it('rejects target and CommonJS-cache mutation performed during evaluation', () => {
    const targetMutationRoot = fixture();
    const target = join(targetMutationRoot, 'apps', 'service', 'src', 'target-mutation.ts');
    const sentinel = join(targetMutationRoot, 'replacement-executed');
    writeFileSync(
      target,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(__filename, ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
        )});`,
        'module.exports = Object.freeze({ source: "captured" });',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(targetMutationRoot, target),
      /changed|content/i,
    );
    assert.equal(existsSync(sentinel), false);

    const cacheMutationRoot = fixture();
    const cacheTarget = join(cacheMutationRoot, 'apps', 'service', 'src', 'cache-mutation.ts');
    writeFileSync(
      cacheTarget,
      [
        'require.cache[__filename] = { exports: Object.freeze({ external: true }) };',
        'module.exports = Object.freeze({ source: "owned" });',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(cacheMutationRoot, cacheTarget),
      /cache authority was replaced or removed|cache generation changed/,
    );
  });

  void it('rejects outside-app, unsupported, symlinked, and non-regular targets', () => {
    const outsideRoot = fixture();
    const outside = join(outsideRoot, 'tools', 'gates', 'lib', 'writer.ts');
    mkdirSync(join(outsideRoot, 'tools', 'gates', 'lib'), { recursive: true });
    writeFileSync(outside, 'module.exports = true;\n', 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(outsideRoot, outside),
      /below .*apps/,
    );

    const extensionRoot = fixture();
    for (const extension of ['.cjs', '.cts', '.js', '.json']) {
      const unsupported = join(extensionRoot, 'apps', 'service', 'src', `module${extension}`);
      writeFileSync(unsupported, '{}\n', 'utf8');
      assert.throws(
        () => testOnlyLoadRepositoryApplicationModuleFromRoot(extensionRoot, unsupported),
        /no governed TypeScript application extension/,
      );
    }

    const symlinkTargetRoot = fixture();
    const realTarget = join(symlinkTargetRoot, 'apps', 'service', 'src', 'real.ts');
    const linkedTarget = join(symlinkTargetRoot, 'apps', 'service', 'src', 'linked.ts');
    writeFileSync(realTarget, 'module.exports = true;\n', 'utf8');
    symlinkSync('real.ts', linkedTarget);
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(symlinkTargetRoot, linkedTarget),
      /ELOOP|symlink|regular file/i,
    );

    const symlinkAncestorRoot = fixture();
    mkdirSync(join(symlinkAncestorRoot, 'apps', 'real-service', 'src'), { recursive: true });
    writeFileSync(
      join(symlinkAncestorRoot, 'apps', 'real-service', 'src', 'module.ts'),
      'module.exports = true;\n',
      'utf8',
    );
    symlinkSync('real-service', join(symlinkAncestorRoot, 'apps', 'linked-service'));
    assert.throws(
      () =>
        testOnlyLoadRepositoryApplicationModuleFromRoot(
          symlinkAncestorRoot,
          join(symlinkAncestorRoot, 'apps', 'linked-service', 'src', 'module.ts'),
        ),
      /symlink|non-directory/i,
    );

    const fifoRoot = fixture();
    const fifo = join(fifoRoot, 'apps', 'service', 'src', 'module.ts');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(fifoRoot, fifo),
      /regular file/i,
    );
  });

  void it('fails before execution when the lexical target is replaced after descriptor open', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'module.ts');
    const original = `${target}.original`;
    const sentinel = join(root, 'replacement-executed');
    writeFileSync(target, 'module.exports = Object.freeze({ generation: "original" });\n', 'utf8');

    assert.throws(
      () =>
        testOnlyLoadRepositoryApplicationModuleFromRoot(root, target, () => {
          renameSync(target, original);
          writeFileSync(
            target,
            `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
            'utf8',
          );
        }),
      /changed|regular file/i,
    );
    assert.equal(existsSync(sentinel), false);
  });
});
