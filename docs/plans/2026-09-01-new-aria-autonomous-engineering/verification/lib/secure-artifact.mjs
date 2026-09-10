import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function invalidPortablePath(path) {
  return (
    typeof path !== 'string' ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0')
  );
}

function escapes(root, candidate) {
  const offset = relative(root, candidate);
  return offset === '' || offset.startsWith('..') || isAbsolute(offset);
}

function resolveArtifact(artifactRoot, artifactPath) {
  if (invalidPortablePath(artifactPath)) {
    throw new Error('artifact path must be a portable relative path');
  }
  const root = realpathSync(artifactRoot);
  const lexicalPath = resolve(root, artifactPath);
  if (escapes(root, lexicalPath)) throw new Error('artifact path escapes the artifact root');
  const candidate = realpathSync(lexicalPath);
  if (escapes(root, candidate)) throw new Error('artifact symlink escapes root');
  return candidate;
}

export function readSecureArtifact(artifactRoot, artifactPath) {
  const candidate = resolveArtifact(artifactRoot, artifactPath);
  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('artifact must be a regular file');
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
