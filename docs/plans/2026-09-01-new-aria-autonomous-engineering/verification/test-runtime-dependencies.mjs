#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRuntimeBinding,
  copyVerifiedRuntimeDependencies,
  observeRuntimeDependencies,
  verifyRuntimeDependencies,
} from './lib/runtime-dependencies.mjs';

const names = ['graphql', 'prettier', 'typescript'];

function writeRuntime(root) {
  const packages = {};
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const [index, name] of names.entries()) {
    const version = `1.0.${index}`;
    const packageRoot = join(root, 'node_modules', name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version })}\n`);
    writeFileSync(join(packageRoot, 'index.mjs'), `export const name = '${name}';\n`);
    packages[`node_modules/${name}`] = { name, version };
  }
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages })}\n`,
  );
}

function targetFor(facts) {
  return {
    package_lock_sha256: facts.package_lock_sha256,
    runtime_dependencies: facts.runtime_dependencies,
  };
}

function runtimeLock(root) {
  return readFileSync(join(root, 'package-lock.json'));
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-runtime-dependencies-'));
try {
  const source = join(ownerRoot, 'source');
  const snapshot = join(ownerRoot, 'snapshot');
  mkdirSync(source);
  mkdirSync(snapshot);
  writeRuntime(source);
  writeFileSync(join(snapshot, 'package-lock.json'), runtimeLock(source));

  const facts = observeRuntimeDependencies(source);
  assert.deepEqual(
    facts.runtime_dependencies.map(({ logical_name: name }) => name),
    names,
    'closed dependency roster drifted',
  );
  assert.doesNotThrow(() => verifyRuntimeDependencies(source, targetFor(facts)));
  assert.doesNotThrow(() =>
    assertRuntimeBinding(targetFor(facts), {
      package_lock_sha256: facts.package_lock_sha256,
      dependencies: facts.runtime_dependencies,
    }),
  );

  copyVerifiedRuntimeDependencies(source, snapshot, targetFor(facts));
  writeFileSync(join(source, 'node_modules/graphql/index.mjs'), 'tampered source\n');
  assert.doesNotThrow(
    () => verifyRuntimeDependencies(snapshot, targetFor(facts)),
    'private snapshot reread mutable source packages',
  );
  assert.throws(
    () => verifyRuntimeDependencies(source, targetFor(facts)),
    /runtime dependency facts do not match signed authority/u,
  );

  const omitted = targetFor(facts);
  omitted.runtime_dependencies = omitted.runtime_dependencies.slice(1);
  assert.throws(() => verifyRuntimeDependencies(snapshot, omitted), /roster/u);

  const symlinkRoot = join(ownerRoot, 'symlink-runtime');
  mkdirSync(symlinkRoot);
  writeFileSync(join(symlinkRoot, 'package-lock.json'), runtimeLock(source));
  symlinkSync(join(snapshot, 'node_modules'), join(symlinkRoot, 'node_modules'), 'dir');
  assert.throws(() => observeRuntimeDependencies(symlinkRoot), /symbolic link/u);

  writeFileSync(join(snapshot, 'package-lock.json'), '{}\n');
  assert.throws(() => verifyRuntimeDependencies(snapshot, targetFor(facts)), /package-lock/u);
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS runtime-dependencies tamper=denied symlink=denied snapshot=private\n');
