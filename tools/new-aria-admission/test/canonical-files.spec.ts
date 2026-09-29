import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readCanonicalFile,
  writeNewCanonicalFile,
  writeNewOrVerifyCanonicalFile,
} from '../src/runtime/canonical-files';

const mutableFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const temporaryRoots: string[] = [];
const crashChild = join(__dirname, 'fixtures/canonical-output-crash-child.cjs');
const canonicalFilesModule = join(__dirname, '../src/runtime/canonical-files.ts');
const tsNodeProject = join(__dirname, '../tsconfig.spec.json');

async function waitForBarrier(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new TypeError('canonical output crash child exited before its barrier');
    }
    if (Date.now() > deadline) throw new TypeError('canonical output crash barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('canonical durable file publication', () => {
  it.each([0o770, 0o707])('rejects an output parent writable outside its owner (%s)', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    temporaryRoots.push(root);
    chmodSync(root, mode);

    expect(() => writeNewCanonicalFile(join(root, 'result.json'), Buffer.from('{}\n'))).toThrow(
      /owner-controlled/,
    );
    expect(existsSync(join(root, 'result.json'))).toBe(false);
  });

  it('fsyncs the containing directory after publishing a new file', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    temporaryRoots.push(root);
    const directorySyncs: number[] = [];
    const originalFsync = mutableFs.fsyncSync;
    const sync = jest.spyOn(mutableFs, 'fsyncSync').mockImplementation((descriptor) => {
      if (mutableFs.fstatSync(descriptor).isDirectory()) directorySyncs.push(descriptor);
      originalFsync(descriptor);
    });
    try {
      writeNewCanonicalFile(join(root, 'result.json'), Buffer.from('{}\n'));
    } finally {
      sync.mockRestore();
    }

    expect(directorySyncs.length).toBeGreaterThan(0);
  });

  it('leaves no output or temporary artifact if the visible parent identity changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    const displaced = `${root}-displaced`;
    temporaryRoots.push(root, displaced);
    const originalLink = mutableFs.linkSync;
    const link = jest.spyOn(mutableFs, 'linkSync').mockImplementation((source, destination) => {
      mutableFs.renameSync(root, displaced);
      mkdirSync(root, { mode: 0o700 });
      originalLink(source, destination);
    });
    try {
      expect(() => writeNewCanonicalFile(join(root, 'result.json'), Buffer.from('{}\n'))).toThrow();
    } finally {
      link.mockRestore();
    }

    expect(existsSync(join(root, 'result.json'))).toBe(false);
    expect(existsSync(join(displaced, 'result.json'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
  });

  it('accepts only a byte-identical existing output for idempotent recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    temporaryRoots.push(root);
    const output = join(root, 'result.json');
    const bytes = Buffer.from('{"result":"accepted"}\n');
    writeNewCanonicalFile(output, bytes);

    expect(() => writeNewOrVerifyCanonicalFile(output, bytes)).not.toThrow();
    expect(() => writeNewOrVerifyCanonicalFile(output, Buffer.from('{}\n'))).toThrow(/differs/);
  });

  it('rejects an exact existing output that is mutable by another principal', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    temporaryRoots.push(root);
    const output = join(root, 'result.json');
    const bytes = Buffer.from('{"result":"accepted"}\n');
    writeNewCanonicalFile(output, bytes);
    chmodSync(output, 0o666);

    expect(() => writeNewOrVerifyCanonicalFile(output, bytes)).toThrow(/ownership|mode/);
  });

  it('rejects an exact existing output with an external hard-link alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-'));
    temporaryRoots.push(root);
    const output = join(root, 'result.json');
    const bytes = Buffer.from('{"result":"accepted"}\n');
    writeNewCanonicalFile(output, bytes);
    linkSync(output, join(root, 'external-alias.json'));

    expect(() => writeNewOrVerifyCanonicalFile(output, bytes)).toThrow(/ownership|mode/);
  });

  it('recovers an exact owned pending link after a process is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-output-crash-'));
    temporaryRoots.push(root);
    const output = join(root, 'result.json');
    const barrier = join(root, 'unlink-barrier');
    const bytes = Buffer.from('{"result":"accepted"}\n');
    const child = spawn(
      process.execPath,
      [crashChild, canonicalFilesModule, output, bytes.toString('base64'), barrier],
      { env: { ...process.env, TS_NODE_PROJECT: tsNodeProject } },
    );
    try {
      await waitForBarrier(barrier, child);
      expect(lstatSync(output).nlink).toBe(2);
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
      unlinkSync(barrier);

      expect(() => writeNewOrVerifyCanonicalFile(output, bytes)).not.toThrow();
      expect(lstatSync(output).nlink).toBe(1);
      expect(readdirSync(root)).toEqual(['result.json']);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('canonical bounded file reads', () => {
  it('rejects a file larger than its explicit byte budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-'));
    temporaryRoots.push(root);
    const path = join(root, 'input.json');
    writeFileSync(path, '12345');

    expect(() => readCanonicalFile(path, 'bounded input', 4)).toThrow(/byte limit/);
  });

  it('rejects a symlink instead of following it', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-file-'));
    temporaryRoots.push(root);
    const source = join(root, 'source.json');
    const alias = join(root, 'alias.json');
    writeFileSync(source, '{}');
    symlinkSync(source, alias);

    expect(() => readCanonicalFile(alias, 'canonical input', 1024)).toThrow(/canonical/);
  });
});
