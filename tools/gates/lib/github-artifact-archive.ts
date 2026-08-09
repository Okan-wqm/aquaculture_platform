import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const PYTHON_OUTPUT_BYTES = Math.ceil((MAX_TOTAL_BYTES * 4) / 3) + 1024 * 1024;

const ARCHIVE_READER = String.raw`
import base64
import io
import json
import stat
import sys
import zipfile

MAX_ARCHIVE = 8 * 1024 * 1024
MAX_ENTRY = 3 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024

expected = json.loads(sys.argv[1])
if (
    not isinstance(expected, list)
    or not expected
    or len(expected) > 8
    or any(
        not isinstance(name, str)
        or not name
        or "/" in name
        or "\\" in name
        or name in {".", ".."}
        for name in expected
    )
    or len(set(expected)) != len(expected)
):
    raise SystemExit("invalid expected artifact file set")

archive = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
if len(archive) > MAX_ARCHIVE:
    raise SystemExit("artifact archive exceeds byte limit")

try:
    with zipfile.ZipFile(io.BytesIO(archive), "r") as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) != len(expected) or sorted(names) != sorted(expected):
            raise ValueError("artifact archive file set differs from policy")

        total_size = 0
        output = {}
        for entry in entries:
            mode = (entry.external_attr >> 16) & 0xFFFF
            if (
                entry.is_dir()
                or entry.flag_bits & 0x1
                or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
            ):
                raise ValueError(f"artifact entry is not a plain regular file: {entry.filename}")
            if entry.file_size < 0 or entry.file_size > MAX_ENTRY:
                raise ValueError(f"artifact entry exceeds byte limit: {entry.filename}")
            total_size += entry.file_size
            if total_size > MAX_TOTAL:
                raise ValueError("artifact expanded content exceeds byte limit")
            content = bundle.read(entry)
            if len(content) != entry.file_size:
                raise ValueError(f"artifact entry size changed while reading: {entry.filename}")
            content.decode("utf-8", errors="strict")
            output[entry.filename] = base64.b64encode(content).decode("ascii")
except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
    raise SystemExit(str(error))

sys.stdout.write(json.dumps(output, sort_keys=True, separators=(",", ":")))
`;

function canonicalExpectedFiles(expectedFiles: readonly string[]): string[] {
  const canonical = [...expectedFiles];
  if (
    canonical.length === 0 ||
    canonical.length > 8 ||
    new Set(canonical).size !== canonical.length ||
    canonical.some(
      (name) =>
        name.length === 0 ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\'),
    )
  ) {
    throw new Error('Expected artifact file set is invalid');
  }
  return canonical.sort();
}

export function verifyGitHubArtifactArchive(
  archive: Buffer,
  expectedSha256: string,
  expectedFiles: readonly string[],
): ReadonlyMap<string, Buffer> {
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Artifact archive must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Artifact SHA-256 must be a lowercase digest');
  }
  const actualSha256 = createHash('sha256').update(archive).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('Downloaded artifact archive differs from the GitHub API digest');
  }

  const expected = canonicalExpectedFiles(expectedFiles);
  const result = spawnSync('python3', ['-c', ARCHIVE_READER, JSON.stringify(expected)], {
    input: archive,
    encoding: 'utf8',
    maxBuffer: PYTHON_OUTPUT_BYTES,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Artifact archive reader failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Artifact archive is invalid: ${(result.stderr || result.stdout).trim() || 'unknown error'}`,
    );
  }

  let encoded: unknown;
  try {
    encoded = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('Artifact archive reader returned invalid JSON');
  }
  if (typeof encoded !== 'object' || encoded === null || Array.isArray(encoded)) {
    throw new Error('Artifact archive reader returned a non-object');
  }
  const entries = Object.entries(encoded as Record<string, unknown>);
  if (
    entries.length !== expected.length ||
    entries.some(([name, value]) => !expected.includes(name) || typeof value !== 'string')
  ) {
    throw new Error('Artifact archive reader returned an unexpected file set');
  }

  const decoded = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const [name, value] of entries as [string, string][]) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error(`Artifact entry ${name} is not canonical base64`);
    }
    const content = Buffer.from(value, 'base64');
    if (content.toString('base64') !== value) {
      throw new Error(`Artifact entry ${name} is not canonical base64`);
    }
    totalBytes += content.length;
    if (content.length > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Artifact decoded content exceeds its byte limit');
    }
    decoded.set(name, content);
  }
  return decoded;
}
