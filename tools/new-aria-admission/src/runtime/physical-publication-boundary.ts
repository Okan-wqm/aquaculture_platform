import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const { code } = error as { readonly code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function canonical(path: string, label: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new TypeError(`${label} must be absolute and canonical`);
  }
}

function physicalPath(path: string): { readonly path: string; readonly exists: boolean } {
  let cursor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return { path: join(realpathSync(cursor), ...suffix), exists: suffix.length === 0 };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function identity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

function nearestExisting(path: string): string {
  let cursor = path;
  while (true) {
    try {
      statSync(cursor);
      return cursor;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

function ancestorIdentities(path: string): ReadonlySet<string> {
  let cursor = nearestExisting(path);
  const result = new Set<string>();
  while (true) {
    result.add(identity(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) return result;
    cursor = parent;
  }
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

interface PhysicalPath {
  readonly path: string;
  readonly exists: boolean;
}

function physicallyContains(parent: PhysicalPath, child: PhysicalPath): boolean {
  return parent.exists && ancestorIdentities(child.path).has(identity(parent.path));
}

function physicalOverlap(left: PhysicalPath, right: PhysicalPath): boolean {
  return (
    contains(left.path, right.path) ||
    contains(right.path, left.path) ||
    physicallyContains(left, right) ||
    physicallyContains(right, left)
  );
}

export function assertPhysicalPathSeparation(
  mutationPaths: readonly string[],
  protectedPaths: readonly string[],
): void {
  const mutations = mutationPaths.map((path) => {
    canonical(path, 'mutation path');
    const resolved = physicalPath(path);
    if (resolved.path !== path) throw new TypeError('mutation path is not physically canonical');
    return resolved;
  });
  const protectedResources = protectedPaths.map((path) => {
    canonical(path, 'protected path');
    return physicalPath(path);
  });
  for (let left = 0; left < mutations.length; left += 1) {
    for (let right = left + 1; right < mutations.length; right += 1) {
      const leftPath = mutations[left];
      const rightPath = mutations[right];
      if (
        leftPath === undefined ||
        rightPath === undefined ||
        physicalOverlap(leftPath, rightPath)
      ) {
        throw new TypeError('mutation paths physically overlap');
      }
    }
  }
  for (const mutation of mutations) {
    if (protectedResources.some((resource) => physicalOverlap(mutation, resource))) {
      throw new TypeError('mutation path physically overlaps a protected resource');
    }
  }
}

export function assertPhysicalMutationBoundary(
  repositoryRoot: string,
  mutationPaths: readonly string[],
): void {
  canonical(repositoryRoot, 'repository root');
  const repository = physicalPath(repositoryRoot);
  if (
    !repository.exists ||
    repository.path !== repositoryRoot ||
    !statSync(repositoryRoot).isDirectory()
  ) {
    throw new TypeError('repository root is not a physical canonical directory');
  }
  const repositoryIdentity = identity(repositoryRoot);
  for (const mutationPath of mutationPaths) {
    canonical(mutationPath, 'mutation path');
    const resolved = physicalPath(mutationPath);
    if (resolved.path !== mutationPath) {
      throw new TypeError('mutation path is not physically canonical');
    }
    if (contains(repositoryRoot, mutationPath)) {
      throw new TypeError('mutation path overlaps repository');
    }
    if (ancestorIdentities(mutationPath).has(repositoryIdentity)) {
      throw new TypeError('mutation path physically overlaps repository');
    }
  }
}

export function assertSafeTemporaryParent(
  temporaryRoot: string,
  protectedRoots: readonly string[],
): void {
  canonical(temporaryRoot, 'temporary root');
  const temporary = physicalPath(temporaryRoot);
  if (!temporary.exists || !statSync(temporary.path).isDirectory()) {
    throw new TypeError('temporary root is not an existing directory');
  }
  const temporaryAncestors = ancestorIdentities(temporary.path);
  for (const protectedRoot of protectedRoots) {
    canonical(protectedRoot, 'temporary protected root');
    const protectedPath = physicalPath(protectedRoot);
    if (
      contains(protectedPath.path, temporary.path) ||
      (protectedPath.exists && temporaryAncestors.has(identity(protectedPath.path)))
    ) {
      throw new TypeError('temporary root physically overlaps a protected root');
    }
  }
}
