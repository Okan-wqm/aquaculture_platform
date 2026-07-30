import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { verifyGitHubArtifactArchive } from './github-artifact-archive';

function zipFixture(entries: Readonly<Record<string, string>>, symlinkEntry?: string): Buffer {
  const script = String.raw`
import io
import json
import stat
import sys
import zipfile

entries = json.loads(sys.argv[1])
symlink_entry = sys.argv[2] or None
output = io.BytesIO()
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for name, content in entries.items():
        if name == symlink_entry:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(info, content)
        else:
            bundle.writestr(name, content)
sys.stdout.buffer.write(output.getvalue())
`;
  const result = spawnSync('python3', ['-c', script, JSON.stringify(entries), symlinkEntry ?? ''], {
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8'));
  }
  return result.stdout;
}

describe('GitHub artifact archive verifier', () => {
  it('accepts one exact, digest-bound regular UTF-8 file set', () => {
    const archive = zipFixture({
      'preflight.json': '{"valid":true}\n',
      'operation.txt': 'Added: TEST-HIGH-001\n',
    });
    const digest = createHash('sha256').update(archive).digest('hex');
    const files = verifyGitHubArtifactArchive(archive, digest, ['preflight.json', 'operation.txt']);
    assert.equal(files.get('preflight.json')?.toString('utf8'), '{"valid":true}\n');
    assert.equal(files.get('operation.txt')?.toString('utf8'), 'Added: TEST-HIGH-001\n');
  });

  it('rejects digest drift, extra paths, and symlink entries', () => {
    const archive = zipFixture({ 'result.json': '{}\n' });
    assert.throws(
      () => verifyGitHubArtifactArchive(archive, '0'.repeat(64), ['result.json']),
      /differs from the GitHub API digest/,
    );
    const extra = zipFixture({ 'result.json': '{}\n', 'extra.txt': 'blind spot\n' });
    const extraDigest = createHash('sha256').update(extra).digest('hex');
    assert.throws(
      () => verifyGitHubArtifactArchive(extra, extraDigest, ['result.json']),
      /file set differs from policy/,
    );
    const symlink = zipFixture({ 'result.json': 'target' }, 'result.json');
    const symlinkDigest = createHash('sha256').update(symlink).digest('hex');
    assert.throws(
      () => verifyGitHubArtifactArchive(symlink, symlinkDigest, ['result.json']),
      /not a plain regular file/,
    );
  });
});
