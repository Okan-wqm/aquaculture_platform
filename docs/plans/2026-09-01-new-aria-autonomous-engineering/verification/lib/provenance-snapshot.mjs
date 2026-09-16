import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

function contained(root, path) {
  const offset = relative(root, path);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

function destinationFor(snapshotRoot, planRoot, path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('provenance snapshot path is invalid');
  }
  const destination = resolve(planRoot, path);
  if (!contained(snapshotRoot, destination)) {
    throw new Error(`${path}: provenance snapshot path escapes its private root`);
  }
  return destination;
}

function materialize(files) {
  if (!(files instanceof Map) || files.size === 0) {
    throw new Error('verified provenance file snapshot is required');
  }
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'new-aria-verified-snapshot-'));
  const planRoot = join(snapshotRoot, planPath);
  mkdirSync(planRoot, { recursive: true, mode: 0o700 });
  const destinations = new Set();
  for (const [path, source] of files) {
    if (!(source instanceof Uint8Array)) throw new Error(`${path}: snapshot bytes are invalid`);
    const destination = destinationFor(snapshotRoot, planRoot, path);
    if (destinations.has(destination)) throw new Error(`${path}: snapshot path alias detected`);
    destinations.add(destination);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, Buffer.from(source), { flag: 'wx', mode: 0o400 });
  }
  return { repositoryRoot: snapshotRoot, planRoot };
}

export function withProvenanceSnapshot(files, callback) {
  const roots = materialize(files);
  try {
    return callback(roots);
  } finally {
    rmSync(roots.repositoryRoot, { recursive: true, force: true });
  }
}
