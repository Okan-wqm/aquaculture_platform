import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  collectFiles,
  readWorkspaceFile,
  readWorkspaceJson,
  resolveInsideWorkspace,
  workspacePathExists,
} from './adapter-fs';
import { analyzeKernelDeadWire } from './kernel-dead-wire-adapter';

// ARIA-LOW-543 — the adapters' shared read helpers followed symlinks.
// readWorkspaceFile was readFileSync and workspacePathExists existsSync, and
// resolveInsideWorkspace checks only the spelling of a path, so a path an
// adapter names explicitly (kernel-dead-wire's policyDir and cliPath, a scan
// root, typeorm's MODULE_SCHEMA_PATH) was read from wherever a symlink at
// that path pointed. containedWorkspace (component lstat walk, O_NOFOLLOW)
// was the containment owner, used by the Rust reader only.
//
// The workspace sits in `base` beside `outside`, which stands for anything
// beyond the checkout; each symlink below is one a checkout can carry.

const base = mkdtempSync(join(tmpdir(), 'aria-adapter-fs-'));
const workspace = join(base, 'repo');
const outside = join(base, 'outside');
const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

write(join(outside, 'policies', 'leaked.json'), JSON.stringify({ outside_tunable: 1 }));
write(
  join(outside, 'cli.py'),
  ['def build_parser(sub):', '    add_subparser(sub, "outside_verb")', ''].join('\n'),
);
write(join(outside, 'kernel', 'outside_module.py'), 'OUTSIDE = "outside_tunable"\n');

write(join(workspace, 'k', 'reader.py'), 'VALUE = "inside_tunable"\n');
write(join(workspace, 'policies', 'inside.json'), JSON.stringify({ inside_tunable: 1 }));
symlinkSync(join(outside, 'policies'), join(workspace, 'linked-policies'));
symlinkSync(join(outside, 'cli.py'), join(workspace, 'linked-cli.py'));
symlinkSync(join(outside, 'kernel'), join(workspace, 'linked-kernel'));

const relativePaths = (paths: readonly string[]): readonly string[] =>
  paths.map((path) => relative(workspace, join(workspace, path)));

try {
  // ---------------------------------------------------------------------
  // An adapter does not read through a symlink it was told to read.
  // ---------------------------------------------------------------------
  {
    const output = analyzeKernelDeadWire(
      { roots: ['k', 'linked-kernel'], policyDir: 'linked-policies', cliPath: 'linked-cli.py' },
      workspace,
    );
    const ids = [...output.observations, ...output.findings].map((row) => row.id);
    assert.deepEqual(
      relativePaths(output.read_paths),
      ['k/reader.py'],
      'nothing behind a symlinked policy dir, CLI path or scan root is read',
    );
    assert.ok(
      ids.every((id) => !id.includes('linked-') && !id.includes('outside')),
      `no verdict cites a file behind a symlink: ${ids.join(', ')}`,
    );
  }

  {
    // The same adapter over the real paths reads them: the containment
    // refuses the symlink, not the request.
    const output = analyzeKernelDeadWire({ roots: ['k'], policyDir: 'policies' }, workspace);
    assert.deepEqual(relativePaths(output.read_paths), ['k/reader.py', 'policies/inside.json']);
  }

  // ---------------------------------------------------------------------
  // The helpers every adapter reads through are containedWorkspace's.
  // ---------------------------------------------------------------------
  {
    const at = (path: string): string => resolveInsideWorkspace(workspace, path);
    // resolveInsideWorkspace names a path; it stays a spelling check.
    assert.equal(at('linked-cli.py'), join(workspace, 'linked-cli.py'));
    assert.throws(() => at('../outside/cli.py'), /path escapes workspace root/);

    assert.equal(readWorkspaceFile(workspace, at('k/reader.py')), 'VALUE = "inside_tunable"\n');
    assert.deepEqual(readWorkspaceJson(workspace, at('policies/inside.json')), {
      inside_tunable: 1,
    });
    for (const path of ['linked-cli.py', 'linked-policies/leaked.json', 'linked-kernel']) {
      assert.throws(() => readWorkspaceFile(workspace, at(path)), /refused workspace read/, path);
    }
    assert.throws(
      () => readWorkspaceJson(workspace, at('linked-policies/leaked.json')),
      /refused workspace read/,
    );
    // A path outside the workspace, however it was built, is refused too.
    assert.throws(
      () => readWorkspaceFile(workspace, join(outside, 'cli.py')),
      /refused workspace read/,
    );

    // Existence is asked without following: what is behind a symlink is
    // not workspace content, so it does not exist for an adapter.
    assert.equal(workspacePathExists(workspace, workspace), true);
    assert.equal(workspacePathExists(workspace, at('k')), true);
    assert.equal(workspacePathExists(workspace, at('k/reader.py')), true);
    assert.equal(workspacePathExists(workspace, at('k/missing.py')), false);
    for (const path of ['linked-cli.py', 'linked-policies', 'linked-policies/leaked.json']) {
      assert.equal(workspacePathExists(workspace, at(path)), false, path);
    }
    assert.equal(workspacePathExists(workspace, join(outside, 'cli.py')), false);
    // A special file is not workspace content either: in the adapter room the
    // cover over an untracked file is one (ARIA-LOW-542), and opening it fails.
    execFileSync('mkfifo', [join(workspace, 'k', 'fifo.py')]);
    assert.equal(workspacePathExists(workspace, at('k/fifo.py')), false);

    // The walk never follows a symlink, its root included: a symlinked root,
    // and a root beneath a symlinked directory, walk nothing.
    assert.deepEqual(collectFiles(workspace, at('linked-kernel'), { extensions: ['.py'] }), []);
    assert.deepEqual(collectFiles(workspace, at('linked-policies'), { extensions: ['.json'] }), []);
    symlinkSync(join(outside), join(workspace, 'linked-outside'));
    assert.deepEqual(
      collectFiles(workspace, at('linked-outside/kernel'), { extensions: ['.py'] }),
      [],
    );
    assert.deepEqual(collectFiles(workspace, outside, { extensions: ['.py'] }), []);
    assert.deepEqual(
      collectFiles(workspace, workspace, { extensions: ['.py', '.json'] }).map((path) =>
        relative(workspace, path),
      ),
      ['k/reader.py', 'policies/inside.json'],
      'a walk from the root lists regular files only: no symlink, no fifo',
    );
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

process.stdout.write('adapter-fs.test.ts OK\n');
