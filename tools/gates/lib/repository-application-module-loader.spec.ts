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

  void it('seals an entry module against post-evaluation relative loads', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'post-evaluation-entry.ts');
    const dependency = join(root, 'apps', 'service', 'src', 'post-evaluation-target.ts');
    const sentinel = join(root, 'post-evaluation-relative-executed');
    writeFileSync(
      dependency,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
      'utf8',
    );
    writeFileSync(
      target,
      "module.exports = () => require('./post-evaluation-target.ts');\n",
      'utf8',
    );

    const postEvaluationLoad = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    if (typeof postEvaluationLoad !== 'function') {
      throw new Error('Post-evaluation relative-load fixture exported no function');
    }
    assert.throws(
      () => Reflect.apply(postEvaluationLoad, undefined, []),
      /RepositoryApplicationModuleRequireContractV1 enforced DENY for post-evaluation module\.require/,
    );
    assert.equal(existsSync(sentinel), false);
  });

  void it('rejects a direct module.require capability before compilation', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'bound-require-entry.ts');
    const dependency = join(root, 'apps', 'service', 'src', 'bound-require-target.ts');
    const sentinel = join(root, 'bound-module-require-executed');
    writeFileSync(
      dependency,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
      'utf8',
    );
    writeFileSync(
      target,
      [
        'const boundModuleRequire = module.require.bind(module);',
        "module.exports = () => boundModuleRequire('./bound-require-target.ts');",
        '',
      ].join('\n'),
      'utf8',
    );

    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target),
      /RepositoryApplicationTypeScriptSourceAdmissionProfileV1 rejected direct CommonJS module capability/,
    );
    assert.equal(existsSync(sentinel), false);
  });

  void it('rejects the configured direct parallel-loader APIs before compilation', () => {
    for (const [name, source, expected] of [
      [
        'create-require',
        [
          "import { createRequire } from 'node:module';",
          'const escaped = createRequire(__filename);',
          "module.exports = () => escaped('./late.ts');",
        ].join('\n'),
        /loader-module capability "node:module"/,
      ],
      [
        'dynamic-import',
        "module.exports = () => import('./late.ts');\n",
        /rejected runtime dynamic import/,
      ],
      [
        'captured-require',
        "const escaped = require; module.exports = () => escaped('./late.ts');\n",
        /rejected captured CommonJS require capability/,
      ],
      [
        'get-builtin-module',
        "process.getBuiltinModule('node:module'); module.exports = true;\n",
        /rejected process\.getBuiltinModule loader capability/,
      ],
      [
        'prototype-require',
        'Object.getPrototypeOf(module).require.bind(module); module.exports = true;\n',
        /rejected direct CommonJS module capability/,
      ],
    ] as const) {
      const root = fixture();
      const target = join(root, 'apps', 'service', 'src', `${name}.ts`);
      writeFileSync(target, source, 'utf8');
      assert.throws(() => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target), expected);
    }
  });

  void it('denies post-evaluation module.require from every evaluated dependency', () => {
    const root = fixture();
    const entry = join(root, 'apps', 'service', 'src', 'sealed-graph-entry.ts');
    const dependency = join(root, 'apps', 'service', 'src', 'sealed-graph-dependency.ts');
    const lateTarget = join(root, 'apps', 'service', 'src', 'sealed-graph-late-target.ts');
    const sentinel = join(root, 'dependency-lazy-load-executed');
    writeFileSync(
      lateTarget,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`,
      'utf8',
    );
    writeFileSync(
      dependency,
      "module.exports = () => require('./sealed-graph-late-target.ts');\n",
      'utf8',
    );
    writeFileSync(entry, "module.exports = require('./sealed-graph-dependency.ts');\n", 'utf8');

    const postEvaluationLoad = testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry);
    if (typeof postEvaluationLoad !== 'function') {
      throw new Error('Post-evaluation dependency-load fixture exported no function');
    }
    assert.throws(
      () => Reflect.apply(postEvaluationLoad, undefined, []),
      /RepositoryApplicationModuleRequireContractV1 enforced DENY for post-evaluation module\.require/,
    );
    assert.equal(existsSync(sentinel), false);
  });

  void it('denies a post-evaluation rewritten alias through owned module.require', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'post-evaluation-alias.ts');
    writeFileSync(
      target,
      "module.exports = () => require('@aquaculture/backend-common/constants');\n",
      'utf8',
    );

    const postEvaluationLoad = testOnlyLoadRepositoryApplicationModuleFromRoot(root, target);
    if (typeof postEvaluationLoad !== 'function') {
      throw new Error('Post-evaluation alias-load fixture exported no function');
    }
    assert.throws(
      () => Reflect.apply(postEvaluationLoad, undefined, []),
      /RepositoryApplicationModuleRequireContractV1 enforced DENY for post-evaluation module\.require/,
    );
  });

  void it('rejects evaluation-time replacement of the module require capability', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'require-capability-tamper.ts');
    writeFileSync(
      target,
      [
        'module.require = () => Object.freeze({ escaped: true });',
        'module.exports = Object.freeze({ accepted: true });',
        '',
      ].join('\n'),
      'utf8',
    );

    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target),
      /rejected direct CommonJS module capability/,
    );
  });

  void it('governs JSON dependency loading and public cache reuse under one descriptor authority', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'schema.json');
    const entry = join(root, 'apps', 'service', 'src', 'json-entry.ts');
    writeFileSync(dependency, '{"kind":"lakselus","version":1}\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./schema.json');\n", 'utf8');

    const dependencyFirst = testOnlyLoadRepositoryApplicationModuleFromRoot(root, entry);
    const publicSecond = testOnlyLoadRepositoryApplicationModuleFromRoot(root, dependency);
    assert.equal(publicSecond, dependencyFirst);
    assert.deepEqual(publicSecond, { kind: 'lakselus', version: 1 });

    writeFileSync(dependency, '{"kind":"tampered","version":2}\n', 'utf8');
    assert.throws(
      () => testOnlyLoadRepositoryApplicationModuleFromRoot(root, dependency),
      /generation changed after first governed load|cache source.*changed/i,
    );
  });

  void it('restores its scoped process-global hooks before unrelated JSON and TypeScript loads', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'scoped-entry.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    const externalRoot = mkdtempSync(join(tmpdir(), 'repository-application-external-loader-'));
    fixtureRoots.push(externalRoot);
    const externalJson = join(externalRoot, 'external.json');
    const externalTypeScript = join(externalRoot, 'external.ts');
    writeFileSync(target, 'module.exports = Object.freeze({ governed: true });\n', 'utf8');
    writeFileSync(externalJson, '{"scope":"external-json"}\n', 'utf8');
    writeFileSync(
      externalTypeScript,
      'const scope: string = "external-typescript"; module.exports = { scope };\n',
      'utf8',
    );
    const contract = [
      "const { createRequire, Module } = require('node:module');",
      'const target = process.argv[1];',
      'const repositoryRoot = process.argv[2];',
      'const loaderPath = process.argv[3];',
      'const externalJson = process.argv[4];',
      'const externalTypeScript = process.argv[5];',
      'const targetRequire = createRequire(loaderPath);',
      'const loader = targetRequire(loaderPath);',
      "const previousJsonHandler = targetRequire.extensions['.json'];",
      "const previousTypeScriptHandler = targetRequire.extensions['.ts'];",
      'const previousLoader = Module._load;',
      'const previousResolver = Module._resolveFilename;',
      'const governed = loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, target);',
      'if (governed.governed !== true) throw new Error("governed load failed");',
      "if (targetRequire.extensions['.json'] !== previousJsonHandler) throw new Error('JSON handler leaked');",
      "if (targetRequire.extensions['.ts'] !== previousTypeScriptHandler) throw new Error('TypeScript handler leaked');",
      "if (Module._load !== previousLoader) throw new Error('CommonJS loader leaked');",
      "if (Module._resolveFilename !== previousResolver) throw new Error('resolver leaked');",
      'const externalJsonValue = targetRequire(externalJson);',
      'const externalTypeScriptValue = targetRequire(externalTypeScript);',
      "if (externalJsonValue.scope !== 'external-json') throw new Error('external JSON delegation failed');",
      "if (externalTypeScriptValue.scope !== 'external-typescript') throw new Error('external TypeScript delegation failed');",
      '',
    ].join('\n');
    execFileSync(
      process.execPath,
      [
        '--require',
        'ts-node/register',
        '-e',
        contract,
        target,
        root,
        loaderPath,
        externalJson,
        externalTypeScript,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(process.cwd(), 'tools', 'gates', 'tsconfig.json'),
        },
      },
    );
  });

  void it('rolls back partially installed hooks to their exact prior identities', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'partial-install.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(target, 'module.exports = Object.freeze({ unreachable: true });\n', 'utf8');
    const contract = [
      "const { createRequire, Module } = require('node:module');",
      'const target = process.argv[1];',
      'const repositoryRoot = process.argv[2];',
      'const loaderPath = process.argv[3];',
      'const targetRequire = createRequire(loaderPath);',
      'const loader = targetRequire(loaderPath);',
      "const previousJsonHandler = targetRequire.extensions['.json'];",
      "const previousTypeScriptHandler = targetRequire.extensions['.ts'];",
      'const previousLoader = Module._load;',
      'const previousResolver = Module._resolveFilename;',
      "const loadDescriptor = Object.getOwnPropertyDescriptor(Module, '_load');",
      "if (loadDescriptor === undefined) throw new Error('missing loader descriptor');",
      "Object.defineProperty(Module, '_load', { ...loadDescriptor, writable: false });",
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, target);',
      '} catch (error) {',
      '  rejected = error instanceof Error',
      '    && /dependency loader scoped installation was rejected/.test(error.message);',
      '} finally {',
      "  Object.defineProperty(Module, '_load', loadDescriptor);",
      '}',
      'if (!rejected) throw new Error("loader accepted a partial runtime installation");',
      "if (targetRequire.extensions['.json'] !== previousJsonHandler) throw new Error('JSON handler survived rollback');",
      "if (targetRequire.extensions['.ts'] !== previousTypeScriptHandler) throw new Error('TypeScript handler survived rollback');",
      "if (Module._load !== previousLoader) throw new Error('CommonJS loader changed during rollback');",
      "if (Module._resolveFilename !== previousResolver) throw new Error('resolver survived rollback');",
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

  void it('rejects loader-module admission before execution and restores scoped capabilities', () => {
    const root = fixture();
    const target = join(root, 'apps', 'service', 'src', 'runtime-tamper.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(
      target,
      [
        "const { Module } = require('node:module');",
        "Reflect.set(Module, '_load', function escapedLoader() { return undefined; });",
        'module.exports = Object.freeze({ escaped: true });',
        '',
      ].join('\n'),
      'utf8',
    );
    const contract = [
      "const { createRequire, Module } = require('node:module');",
      'const target = process.argv[1];',
      'const repositoryRoot = process.argv[2];',
      'const loaderPath = process.argv[3];',
      'const targetRequire = createRequire(loaderPath);',
      'const loader = targetRequire(loaderPath);',
      "const previousJsonHandler = targetRequire.extensions['.json'];",
      "const previousTypeScriptHandler = targetRequire.extensions['.ts'];",
      'const previousLoader = Module._load;',
      'const previousResolver = Module._resolveFilename;',
      'let rejected = false;',
      'try {',
      '  loader.testOnlyLoadRepositoryApplicationModuleFromRoot(repositoryRoot, target);',
      '} catch (error) {',
      '  rejected = /SourceAdmissionProfileV1 rejected loader-module capability/.test(String(error));',
      '}',
      'if (!rejected) throw new Error("loader accepted a loader-module capability");',
      "if (targetRequire.extensions['.json'] !== previousJsonHandler) throw new Error('JSON handler survived tamper');",
      "if (targetRequire.extensions['.ts'] !== previousTypeScriptHandler) throw new Error('TypeScript handler survived tamper');",
      "if (Module._load !== previousLoader) throw new Error('CommonJS loader survived tamper');",
      "if (Module._resolveFilename !== previousResolver) throw new Error('resolver survived tamper');",
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

  void it('rejects malformed, BOM-prefixed, and non-UTF-8 JSON before exports are installed', () => {
    for (const [name, content, expected] of [
      ['malformed', Buffer.from('{"broken":', 'utf8'), /not valid JSON/],
      ['bom', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), /UTF-8 BOM/],
      ['non-utf8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), /not valid UTF-8/],
    ] as const) {
      const root = fixture();
      const target = join(root, 'apps', 'service', 'src', `${name}.json`);
      writeFileSync(target, content);
      assert.throws(() => testOnlyLoadRepositoryApplicationModuleFromRoot(root, target), expected);
    }
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
      /dependency has no governed application extension/,
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

  void it('rejects a repository JSON dependency cached before governed evaluation', () => {
    const root = fixture();
    const dependency = join(root, 'apps', 'service', 'src', 'external-first.json');
    const entry = join(root, 'apps', 'service', 'src', 'external-first-json-entry.ts');
    const loaderPath = join(dirname(__filename), 'repository-application-module-loader.ts');
    writeFileSync(dependency, '{"external":true}\n', 'utf8');
    writeFileSync(entry, "module.exports = require('./external-first.json');\n", 'utf8');
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
      'if (!rejected) throw new Error("loader accepted an external-first JSON cache");',
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
      "const previousJsonHandler = targetRequire.extensions['.json'];",
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
      '  rejected = error instanceof AggregateError',
      '    && /construction and cleanup failed/.test(error.message)',
      '    && error.errors.some((cause) => cause instanceof Error',
      '      && /path cleanup did not restore the prior resolver generation/.test(cause.message));',
      '}',
      'if (!rejected) throw new Error("loader accepted a no-op resolver cleanup");',
      "if (targetRequire.extensions['.ts'] !== previousHandler) {",
      '  throw new Error("loader did not restore the prior TypeScript handler");',
      '}',
      "if (targetRequire.extensions['.json'] !== previousJsonHandler) {",
      '  throw new Error("loader did not restore the prior JSON handler");',
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
      /LOADING (cache state has a loaded Module|authority escaped its evaluation scope)/,
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
    for (const extension of ['.cjs', '.cts', '.js']) {
      const unsupported = join(extensionRoot, 'apps', 'service', 'src', `module${extension}`);
      writeFileSync(unsupported, '{}\n', 'utf8');
      assert.throws(
        () => testOnlyLoadRepositoryApplicationModuleFromRoot(extensionRoot, unsupported),
        /no governed application extension/,
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
