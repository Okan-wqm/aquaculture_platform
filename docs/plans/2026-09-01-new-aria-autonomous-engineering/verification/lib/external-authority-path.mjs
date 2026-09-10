import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} path is required`);
  return resolve(value);
}

function descendant(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

function overlaps(left, right) {
  return left === right || descendant(left, right) || descendant(right, left);
}

function repositoryTopLevel(repositoryRoot) {
  const lexical = requiredPath(repositoryRoot, 'repository root');
  const real = realpathSync(lexical);
  let marker;
  try {
    marker = lstatSync(resolve(lexical, '.git'));
  } catch {
    throw new Error('repository root must contain a Git worktree marker');
  }
  if (lexical !== real || marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw new Error('repository root must be its actual Git worktree top-level');
  }
  return { lexical, real };
}

export function resolveExternalAuthority(repositoryRoot, authorityRoot) {
  const repository = repositoryTopLevel(repositoryRoot);
  const lexical = requiredPath(authorityRoot, 'authority root');
  const real = realpathSync(lexical);
  if (overlaps(repository.lexical, lexical) || overlaps(repository.real, real)) {
    throw new Error('authority root must be lexically and physically outside the repository');
  }
  return { lexical, real, repository };
}

export function resolveExternalAuthorityFile(authority, path, label) {
  const lexical = requiredPath(path, label);
  if (!descendant(authority.lexical, lexical)) {
    throw new Error(`${label} lexical path must be under the authority root`);
  }
  const real = realpathSync(lexical);
  if (
    !descendant(authority.real, real) ||
    overlaps(authority.repository.lexical, lexical) ||
    overlaps(authority.repository.real, real)
  ) {
    throw new Error(`${label} must be physically under external authority root`);
  }
  return real;
}
