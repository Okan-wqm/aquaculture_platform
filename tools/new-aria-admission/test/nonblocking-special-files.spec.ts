import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryRoots: string[] = [];
const runtimeRoot = join(__dirname, '../src/runtime');

function invokeLoader(moduleName: string, exportName: string, fifoPath: string) {
  const script = [
    "require('ts-node/register/transpile-only');",
    'const subject=require(process.argv[1]);',
    "if(process.argv[2]==='readCanonicalFile')subject.readCanonicalFile(process.argv[3],'fixture',1024);",
    "else if(process.argv[2]==='readPrivateKeyFile')subject.readPrivateKeyFile(process.argv[3]);",
    "else subject.VerifiedExecutableSource.load(process.argv[3],'0'.repeat(64),'fixture');",
  ].join('');
  return spawnSync(
    process.execPath,
    ['-e', script, join(runtimeRoot, moduleName), exportName, fifoPath],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('non-regular input denial', () => {
  it.each([
    ['canonical-files.ts', 'readCanonicalFile'],
    ['private-key-file.ts', 'readPrivateKeyFile'],
    ['verified-executable.ts', 'VerifiedExecutableSource'],
  ])('rejects a FIFO without blocking in %s', (moduleName, exportName) => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-fifo-'));
    temporaryRoots.push(root);
    const fifoPath = join(root, 'input');
    execFileSync('mkfifo', ['-m', '600', fifoPath]);

    const result = invokeLoader(moduleName, exportName, fifoPath);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });
});
