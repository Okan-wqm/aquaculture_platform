import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseStrictJson, sha256, sha256File } from './canonical.mjs';

const manifestPath = 'verification/verifier-inputs.jsonl';
const designPath = '../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
const formatScopePath = '../../../tools/quality/format-scope.json';

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
  paths.push(formatScopePath);
  return paths.sort();
}

export function bundleDigest(records) {
  const body = records.map((record) => `${record.path}\0${record.sha256}\n`).join('');
  return sha256(Buffer.from(body, 'utf8'));
}

function verifyRuntime(errors, runtime) {
  const actualPath = realpathSync(process.execPath);
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    errors.push({ code: 'VERIFIER_RUNTIME', message: 'Node runtime observation mismatch' });
    return;
  }
  const declaredPath = runtime.node_executable;
  if (
    runtime.node_version !== process.version ||
    typeof declaredPath !== 'string' ||
    !existsSync(declaredPath) ||
    realpathSync(declaredPath) !== actualPath ||
    runtime.node_executable_sha256 !== sha256File(actualPath)
  ) {
    errors.push({ code: 'VERIFIER_RUNTIME', message: 'Node runtime observation mismatch' });
  }
}

function verifyMetadataIdentity(errors, metadata) {
  const identity = [metadata.schema_version, metadata.kind, metadata.verifier_version];
  if (JSON.stringify(identity) !== JSON.stringify(['2.0.0', 'metadata', '2.0.0']))
    add(errors, 'metadata identity drift');
  if (!metadata.recorded_at_utc) add(errors, 'provenance observation timestamp missing');
  if (metadata.claim !== 'verifier input provenance; not an admission record')
    add(errors, 'provenance claim drift');
}

function verifyMetadata(errors, metadata, records) {
  const expectedFlags = [
    '--repo-root',
    '--mode',
    '--base',
    '--head',
    '--reviewed-ref',
    '--base-tree',
    '--head-tree',
    '--diff-sha256',
    '--design-sha256',
    '--format-scope-sha256',
  ];
  verifyMetadataIdentity(errors, metadata);
  verifyRuntime(errors, metadata.runtime);
  if (
    metadata.verifier_script !==
      'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/verify-d0.mjs' ||
    JSON.stringify(metadata.required_flags) !== JSON.stringify(expectedFlags) ||
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
