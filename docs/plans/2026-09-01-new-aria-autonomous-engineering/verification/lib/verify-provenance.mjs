import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseStrictJson, sha256, sha256File } from './canonical.mjs';

const manifestPath = 'verification/verifier-inputs.jsonl';
const designPath = '../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';

function add(errors, message) {
  errors.push({ code: 'VERIFIER_PROVENANCE', message });
}

function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

export function expectedPaths(planRoot) {
  const extensions = ['.md', '.mjs', '.json', '.jsonl', '.raw', '.gitattributes'];
  const paths = filesUnder(planRoot)
    .map((path) => relative(planRoot, path).replaceAll('\\', '/'))
    .filter((path) => extensions.some((extension) => path.endsWith(extension)))
    .filter((path) => path !== manifestPath);
  paths.push(designPath);
  return paths.sort();
}

export function bundleDigest(records) {
  const body = records.map((record) => `${record.path}\0${record.sha256}\n`).join('');
  return sha256(Buffer.from(body, 'utf8'));
}

function verifyRuntime(errors, runtime) {
  if (!/^v(?:2[0-9]|[3-9][0-9])\./u.test(runtime?.node_version ?? ''))
    add(errors, 'unsupported or absent Node version');
  if (!/^[a-f0-9]{64}$/u.test(runtime?.node_executable_sha256 ?? ''))
    add(errors, 'Node executable digest missing');
}

function verifyMetadataIdentity(errors, metadata) {
  const identity = [metadata.schema_version, metadata.kind, metadata.verifier_version];
  if (JSON.stringify(identity) !== JSON.stringify(['1.0.0', 'metadata', '1.0.0']))
    add(errors, 'metadata identity drift');
  if (!metadata.recorded_at_utc) add(errors, 'provenance observation timestamp missing');
  if (metadata.claim !== 'verifier input provenance; not an admission record')
    add(errors, 'provenance claim drift');
}

function verifyMetadata(errors, metadata, records) {
  const expectedArgv = [
    'node',
    'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/verify-d0.mjs',
    '--repo-root',
    '.',
    '--mode',
    'full',
  ];
  verifyMetadataIdentity(errors, metadata);
  verifyRuntime(errors, metadata.runtime);
  if (
    JSON.stringify(metadata.argv) !== JSON.stringify(expectedArgv) ||
    metadata.cwd_contract !== 'repository root'
  )
    add(errors, 'argv/CWD drift');
  if (metadata.input_bundle_sha256 !== bundleDigest(records))
    add(errors, 'input bundle digest mismatch');
}

export function verifyProvenance(planRoot) {
  const errors = [];
  const lines = readFileSync(join(planRoot, manifestPath), 'utf8')
    .trimEnd()
    .split('\n')
    .map(parseStrictJson);
  const metadata = lines[0];
  const records = lines.slice(1);
  const expected = expectedPaths(planRoot);
  if (JSON.stringify(records.map((record) => record.path)) !== JSON.stringify(expected))
    add(errors, 'input path roster drift');
  for (const record of records) {
    const path = resolve(planRoot, record.path);
    if (sha256File(path) !== record.sha256) add(errors, `${record.path}: input digest mismatch`);
  }
  verifyMetadata(errors, metadata, records);
  return errors;
}
