#!/usr/bin/env ts-node
// ARIA-LOW-593 — the compiler host that builds adapter programs answers its
// filesystem questions through containedWorkspace: nothing behind a
// workspace symlink exists for it, paths outside the workspace keep the
// default host's answers, and a program on the host resolves a real
// in-workspace import while a symlinked one resolves to nothing.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Node } from 'typescript';

import { makeFixtureTree } from '../gates/fixture-tree';

import { containedCompilerHost, createContainedProgram } from './adapter-ts';

const base = makeFixtureTree('aria-adapter-ts-');
const workspace = join(base, 'repo');
const outside = join(base, 'outside');
mkdirSync(join(workspace, 'k'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(
  join(workspace, 'k', 'exported.ts'),
  'export const inside = "inside_tunable";\n',
  'utf8',
);
writeFileSync(
  join(workspace, 'k', 'imports-real.ts'),
  "import { inside } from './exported';\nexport const real = inside;\n",
  'utf8',
);
// The linked module names outside content: the inside path is a symlink.
writeFileSync(join(outside, 'leaked.ts'), 'export const inside = "outside_tunable";\n', 'utf8');
symlinkSync(join(outside, 'leaked.ts'), join(workspace, 'k', 'linked-leaked.ts'));
symlinkSync(outside, join(workspace, 'linked-outside'));

{
  const host = containedCompilerHost(
    { kind: 'contained', workspaceRoot: workspace },
    { noEmit: true },
  );
  // Nothing behind a workspace symlink exists for the host.
  assert.equal(host.fileExists(join(workspace, 'k', 'exported.ts')), true);
  assert.equal(host.fileExists(join(workspace, 'k', 'linked-leaked.ts')), false);
  assert.equal(
    host.readFile?.(join(workspace, 'k', 'exported.ts')),
    'export const inside = "inside_tunable";\n',
  );
  assert.equal(host.readFile?.(join(workspace, 'k', 'linked-leaked.ts')), undefined);
  assert.equal(host.directoryExists?.(join(workspace, 'k')), true);
  assert.equal(host.directoryExists?.(join(workspace, 'linked-outside')), false);
  assert.equal(host.directoryExists?.(outside), true, 'outside stays delegated');
  // A workspace path is its own resolution: no symlink is crossed.
  assert.equal(
    host.realpath?.(join(workspace, 'linked-outside')),
    join(workspace, 'linked-outside'),
  );
  assert.notEqual(host.realpath?.(outside), join(workspace, 'linked-outside'));

  // A program on the host reads only contained workspace content: the real
  // import resolves, the symlinked one does not.
  writeFileSync(
    join(workspace, 'k', 'imports-link.ts'),
    "import { inside } from './linked-leaked';\nexport const link = inside;\n",
    'utf8',
  );
  const program = createContainedProgram({ kind: 'contained', workspaceRoot: workspace }, [
    join(workspace, 'k', 'imports-real.ts'),
    join(workspace, 'k', 'imports-link.ts'),
  ]);
  const checker = program.getTypeChecker();
  const valueOf = (file: string, name: string): string => {
    const source = program.getSourceFile(join(workspace, 'k', file));
    assert.ok(source, file);
    let found: string | undefined;
    const walk = (node: Node): void => {
      if (found === undefined && node.getText() === name) {
        found = checker.typeToString(checker.getTypeAtLocation(node));
      }
      node.forEachChild(walk);
    };
    walk(source);
    return found ?? 'not found';
  };
  assert.match(valueOf('imports-real.ts', 'inside'), /inside_tunable/, 'a real import resolves');
  assert.equal(
    valueOf('imports-link.ts', 'inside'),
    'any',
    'a symlinked import resolves to nothing',
  );
}

process.stdout.write('adapter-ts.test.ts OK\n');
