/**
 * Structural accessors over parsed compose and Kubernetes YAML (ARIA-HIGH-012).
 *
 * WHY here and not in each rule: where a pod spec lives in a CronJob, how a compose
 * `environment:` list differs from its map form, and which Dockerfile a compose `build:`
 * names are facts about the formats, not policy. Every rule owner and the adapter read
 * them through these functions so none re-derives a path by hand.
 */
import { posix } from 'node:path';

import { type YamlPath, readYamlDocuments } from './yaml-documents';

export type YamlMap = Readonly<Record<string, unknown>>;

export function asMap(value: unknown): YamlMap | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as YamlMap)
    : null;
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A scalar as compose/kubectl would stringify it (numbers and booleans included). */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// ---------------------------------------------------------------- compose

export interface ComposeService {
  readonly name: string;
  readonly spec: YamlMap;
  readonly path: YamlPath;
}

export function composeServices(doc: unknown): ComposeService[] {
  const services = asMap(yamlAt(doc, ['services']));
  if (services === null) return [];
  const out: ComposeService[] = [];
  for (const [name, spec] of Object.entries(services)) {
    const map = asMap(spec);
    // `services: { web: }` (a null service) is valid compose: an image-less placeholder
    // extended elsewhere; it carries no settings to judge.
    out.push({ name, spec: map ?? {}, path: ['services', name] });
  }
  return out;
}

export interface EnvEntry {
  readonly key: string;
  /** The literal value; null when the entry has none (pass-through, valueFrom, empty). */
  readonly value: string | null;
  readonly path: YamlPath;
}

export function composeEnvironment(service: ComposeService): EnvEntry[] {
  const env = service.spec.environment;
  const base = [...service.path, 'environment'];
  if (Array.isArray(env)) {
    return env.flatMap((item, index) => {
      const text = scalarText(item);
      if (text === null) return [];
      const eq = text.indexOf('=');
      return [
        eq < 0
          ? { key: text, value: null, path: [...base, index] }
          : { key: text.slice(0, eq), value: text.slice(eq + 1), path: [...base, index] },
      ];
    });
  }
  const map = asMap(env);
  if (map === null) return [];
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: scalarText(value),
    path: [...base, key],
  }));
}

/** Repo-relative Dockerfile a compose service builds, or null (no build / inline Dockerfile). */
export function composeBuildDockerfile(
  service: ComposeService,
  composeRelPath: string,
): string | null {
  const build = service.spec.build;
  const composeDir = posix.dirname(composeRelPath);
  const contextOnly = asString(build);
  if (contextOnly !== null)
    return posix.normalize(posix.join(composeDir, contextOnly, 'Dockerfile'));
  const map = asMap(build);
  if (map === null || map.dockerfile_inline !== undefined) return null;
  const context = asString(map.context);
  const dockerfile = asString(map.dockerfile);
  return posix.normalize(
    posix.join(
      composeDir,
      context === null ? '.' : context,
      dockerfile === null ? 'Dockerfile' : dockerfile,
    ),
  );
}

// ---------------------------------------------------------------- Kubernetes

export interface K8sWorkload {
  readonly kind: string;
  readonly name: string | null;
  readonly namespace: string | null;
  readonly podSpec: YamlMap;
  readonly podSpecPath: YamlPath;
}

/** Where each workload kind keeps its pod spec. */
const POD_SPEC_PATHS: Readonly<Record<string, readonly string[]>> = {
  Pod: ['spec'],
  Deployment: ['spec', 'template', 'spec'],
  StatefulSet: ['spec', 'template', 'spec'],
  DaemonSet: ['spec', 'template', 'spec'],
  ReplicaSet: ['spec', 'template', 'spec'],
  ReplicationController: ['spec', 'template', 'spec'],
  Job: ['spec', 'template', 'spec'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
};

/** Kinds that run to completion: readiness/liveness probes do not apply to them. */
export const RUN_TO_COMPLETION_KINDS: ReadonlySet<string> = new Set(['Job', 'CronJob']);

/** The value at a key path through nested maps; undefined when any step is not a map. */
export function yamlAt(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    const map = asMap(current);
    if (map === null) return undefined;
    current = map[segment];
  }
  return current;
}

export function k8sWorkloads(doc: unknown): K8sWorkload[] {
  const kind = asString(yamlAt(doc, ['kind']));
  if (kind === null) return [];
  const specPath = POD_SPEC_PATHS[kind];
  if (specPath === undefined) return [];
  const podSpec = asMap(yamlAt(doc, specPath));
  if (podSpec === null) return [];
  return [
    {
      kind,
      name: asString(yamlAt(doc, ['metadata', 'name'])),
      namespace: asString(yamlAt(doc, ['metadata', 'namespace'])),
      podSpec,
      podSpecPath: specPath,
    },
  ];
}

export interface K8sContainer {
  readonly name: string | null;
  readonly spec: YamlMap;
  readonly path: YamlPath;
  readonly init: boolean;
}

export function podContainers(workload: K8sWorkload): K8sContainer[] {
  const out: K8sContainer[] = [];
  for (const [field, init] of [
    ['initContainers', true],
    ['containers', false],
  ] as const) {
    asList(workload.podSpec[field]).forEach((item, index) => {
      const spec = asMap(item);
      if (spec === null) return;
      out.push({
        name: asString(spec.name),
        spec,
        path: [...workload.podSpecPath, field, index],
        init,
      });
    });
  }
  return out;
}

export function containerEnv(container: K8sContainer): EnvEntry[] {
  return asList(container.spec.env).flatMap((item, index) => {
    const entry = asMap(item);
    if (entry === null) return [];
    const key = asString(entry.name);
    if (key === null) return [];
    return [
      {
        key,
        value: entry.valueFrom === undefined ? scalarText(entry.value) : null,
        path: [...container.path, 'env', index],
      },
    ];
  });
}

// ---------------------------------------------------------------- kustomize

export interface KustomizePatchTarget {
  /** Kind and name the patch targets; null when only its file can tell. */
  readonly kind: string | null;
  readonly name: string | null;
  /** Repo-relative patch file, or null for an inline patch. */
  readonly file: string | null;
  /** The inline patch's YAML text, or null for a patch file. */
  readonly inline: string | null;
  readonly path: YamlPath;
}

function inlinePatchTarget(patch: string): { kind: string | null; name: string | null } {
  const [first] = readYamlDocuments(patch).docs;
  const value = first === undefined ? null : first.value;
  return {
    kind: asString(yamlAt(value, ['kind'])),
    name: asString(yamlAt(value, ['metadata', 'name'])),
  };
}

/** Every patch a kustomization applies, with the workload it targets when it says so. */
export function kustomizePatchTargets(
  doc: unknown,
  kustomizationRelPath: string,
): KustomizePatchTarget[] {
  const map = asMap(doc);
  if (map === null) return [];
  const dir = posix.dirname(kustomizationRelPath);
  const out: KustomizePatchTarget[] = [];
  for (const field of ['patches', 'patchesJson6902'] as const) {
    asList(map[field]).forEach((item, index) => {
      const entry = asMap(item);
      if (entry === null) return;
      const target = asMap(entry.target);
      const inline = asString(entry.patch);
      const file = asString(entry.path);
      const fromInline = inline === null ? { kind: null, name: null } : inlinePatchTarget(inline);
      out.push({
        kind: target === null ? fromInline.kind : asString(target.kind),
        name: target === null ? fromInline.name : asString(target.name),
        file: file === null ? null : posix.normalize(posix.join(dir, file)),
        inline,
        path: [field, index],
      });
    });
  }
  asList(map.patchesStrategicMerge).forEach((item, index) => {
    const text = asString(item);
    if (text === null) return;
    // An entry is a file path unless it is an inline YAML document.
    const isInline = text.includes('\n');
    const fromInline = isInline ? inlinePatchTarget(text) : { kind: null, name: null };
    out.push({
      kind: fromInline.kind,
      name: fromInline.name,
      file: isInline ? null : posix.normalize(posix.join(dir, text)),
      inline: isInline ? text : null,
      path: ['patchesStrategicMerge', index],
    });
  });
  return out;
}

/** A remote kustomize resource (a git or http URL): not a file of this checkout. */
const REMOTE_RESOURCE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/|gitlab\.com\/|bitbucket\.org\/)/i;

/**
 * Repo-relative paths a kustomization lists under `resources:` (and the deprecated `bases:`):
 * each a manifest file or a directory holding another kustomization. Remote resources are not
 * files of this checkout and are left out.
 */
export function kustomizeResources(doc: unknown, kustomizationRelPath: string): string[] {
  const map = asMap(doc);
  if (map === null) return [];
  const dir = posix.dirname(kustomizationRelPath);
  return (['resources', 'bases'] as const).flatMap((field) =>
    asList(map[field]).flatMap((item) => {
      const entry = asString(item);
      if (entry === null || REMOTE_RESOURCE.test(entry)) return [];
      return [posix.normalize(posix.join(dir, entry)).replace(/\/+$/, '')];
    }),
  );
}
