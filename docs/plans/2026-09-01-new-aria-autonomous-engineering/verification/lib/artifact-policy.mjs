import { posix } from 'node:path';

export const planPrefix = 'docs/plans/2026-09-01-new-aria-autonomous-engineering/';
export const verifierInputsPath = `${planPrefix}verification/verifier-inputs.jsonl`;

const externalChangedFiles = new Map([
  ['docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md', 'markdown'],
  ['tools/quality/format-scope.json', 'json'],
]);
const protectedPrefixes = [
  'aria-kernel/',
  'tools/aria-poc/',
  'docs/aria/',
  '.claude/agents/aria-',
  '.github/workflows/',
  'apps/aria-service/',
  'web/modules/aria/',
];
const artifactKinds = new Map([
  ['.md', 'markdown'],
  ['.mjs', 'javascript'],
  ['.json', 'json'],
  ['.jsonl', 'jsonl'],
  ['.graphql', 'graphql'],
  ['.raw', 'raw'],
]);
const attributePaths = new Set([
  `${planPrefix}reviews/c139f40f/source/.gitattributes`,
  `${planPrefix}reviews/source/.gitattributes`,
]);
const disguisedCode =
  /\.(?:c?js|m?ts|tsx|jsx|sh|bash|py|rb|go|rs|java|ya?ml|toml|ini|env)\.(?:md|mjs|json|jsonl|graphql|raw)$/iu;

function portablePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path) &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.startsWith('-') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..')
  );
}

function extension(path) {
  for (const value of artifactKinds.keys()) {
    if (path.endsWith(value)) return value;
  }
  return null;
}

export function classifyPlanArtifact(path) {
  if (!portablePath(path) || !path.startsWith(planPrefix) || path === planPrefix.slice(0, -1)) {
    return null;
  }
  if (attributePaths.has(path)) {
    return { kind: 'gitattributes', authoredCode: false };
  }
  if (path.endsWith('/.gitattributes') || disguisedCode.test(path)) return null;
  const suffix = extension(path);
  if (!suffix) return null;
  return { kind: artifactKinds.get(suffix), authoredCode: suffix === '.mjs' };
}

export function classifyPlanRelativeArtifact(path) {
  return classifyPlanArtifact(`${planPrefix}${path}`);
}

export function classifyChangedPath(path) {
  if (!portablePath(path)) return { accepted: false, code: 'D0_ARTIFACT_POLICY' };
  if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return { accepted: false, code: 'PROTECTED_SCOPE' };
  }
  const externalKind = externalChangedFiles.get(path);
  if (externalKind) return { accepted: true, kind: externalKind, authoredCode: false };
  if (!path.startsWith(planPrefix)) return { accepted: false, code: 'PRODUCT_SCOPE' };
  const artifact = classifyPlanArtifact(path);
  return artifact
    ? { accepted: true, ...artifact }
    : { accepted: false, code: 'D0_ARTIFACT_POLICY' };
}

export function regularArtifactEntry(entry) {
  return entry?.mode === '100644' && entry?.type === 'blob';
}

export function acceptedChangedFiles() {
  return new Set(externalChangedFiles.keys());
}
