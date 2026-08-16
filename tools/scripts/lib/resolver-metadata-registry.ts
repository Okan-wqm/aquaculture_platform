import type { GraphQLSchemaFactory } from '@nestjs/graphql';

export type ResolverConstructorV1 = Parameters<GraphQLSchemaFactory['create']>[0][number];

export interface ResolverModuleSource {
  readonly sourcePath: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

export interface ResolverConstructorRegistration {
  readonly sourcePath: string;
  readonly exportName: string;
  readonly runtimeName: string;
  readonly constructor: ResolverConstructorV1;
}

function isResolverConstructor(value: unknown): value is ResolverConstructorV1 {
  return typeof value === 'function' && /Resolver$/.test(value.name);
}

function canonicalText(value: string, label: string): string {
  const normalized = value.normalize('NFC');
  if (value !== normalized) {
    throw new Error(`${label} is not NFC canonical`);
  }
  return normalized;
}

/** Locale-independent lexicographic ordering over exact UTF-16 code units. */
export function compareCanonicalUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function canonicalResolverSourcePath(sourcePath: string): string {
  const normalized = canonicalText(sourcePath.replaceAll('\\', '/'), 'resolver source path');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment.length === 0 || segment === '..')
  ) {
    throw new Error('resolver source path is not a canonical repository-relative path');
  }
  return normalized;
}

/**
 * Compiles resolver exports into one deterministic, closed constructor registry.
 * Filesystem order and CommonJS export insertion order are explicitly irrelevant.
 */
export function compileResolverConstructorRegistry(
  sources: readonly ResolverModuleSource[],
): readonly ResolverConstructorRegistration[] {
  const sourceByPath = new Map<string, ResolverModuleSource>();
  for (const source of sources) {
    const sourcePath = canonicalResolverSourcePath(source.sourcePath);
    if (sourceByPath.has(sourcePath)) {
      throw new Error(`duplicate resolver source: ${sourcePath}`);
    }
    sourceByPath.set(sourcePath, { sourcePath, exports: source.exports });
  }

  const constructorOwner = new Map<ResolverConstructorV1, string>();
  const runtimeNameOwner = new Map<string, string>();
  const registrations: ResolverConstructorRegistration[] = [];
  for (const source of [...sourceByPath.values()].sort((left, right) =>
    compareCanonicalUtf16(left.sourcePath, right.sourcePath),
  )) {
    const exports = Object.entries(source.exports).sort(([left], [right]) =>
      compareCanonicalUtf16(
        canonicalText(left, 'resolver export name'),
        canonicalText(right, 'resolver export name'),
      ),
    );
    for (const [exportName, exported] of exports) {
      if (!isResolverConstructor(exported)) continue;
      const canonicalExportName = canonicalText(exportName, 'resolver export name');
      const runtimeName = canonicalText(exported.name, 'resolver runtime name');
      const coordinate = `${source.sourcePath}#${canonicalExportName}`;
      const priorConstructorOwner = constructorOwner.get(exported);
      if (priorConstructorOwner) {
        throw new Error(
          `duplicate resolver constructor: ${priorConstructorOwner} and ${coordinate}`,
        );
      }
      const priorRuntimeNameOwner = runtimeNameOwner.get(runtimeName);
      if (priorRuntimeNameOwner) {
        throw new Error(
          `duplicate resolver runtime name ${runtimeName}: ${priorRuntimeNameOwner} and ${coordinate}`,
        );
      }
      constructorOwner.set(exported, coordinate);
      runtimeNameOwner.set(runtimeName, coordinate);
      registrations.push(
        Object.freeze({
          sourcePath: source.sourcePath,
          exportName: canonicalExportName,
          runtimeName,
          constructor: exported,
        }),
      );
    }
  }
  if (registrations.length === 0) {
    throw new Error('resolver source set exports no *Resolver constructor');
  }
  return Object.freeze(registrations);
}
